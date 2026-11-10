// @mmmnt/feat-adapter-kms (SPEC-ADPKMS-001, SPEC-ADPKMS-002) — a KMS endpoint's key state becomes a
// capture window by comparing two snapshots. Nothing in KMS (or in local-kms) emits changes, so the
// diff is a snapshot: ListKeys, DescribeKey, ListResourceTags, GetKeyRotationStatus and ListAliases,
// restricted to the keys that carry the namespace tag or an alias under the namespace.
//
// What a snapshot sees: a key created, its state (disabled, pending deletion), description, rotation,
// tags and aliases. What it cannot see: any cryptographic use (Encrypt, Decrypt, Sign,
// GenerateDataKey), which leaves no state behind. AWS documents KMS as eventually consistent, so
// settle() vouches only for a declared emulator, whose reads follow its writes.
//
// The adapter observes on its own client, which never goes through the fault proxy (SPEC-FPX-001).
import {
  CancelKeyDeletionCommand,
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  EnableKeyCommand,
  GetKeyRotationStatusCommand,
  KMSClient,
  ListAliasesCommand,
  ListKeysCommand,
  ListResourceTagsCommand,
  ScheduleKeyDeletionCommand,
  UntagResourceCommand,
  type KeyMetadata,
} from "@aws-sdk/client-kms";
import { createFaultProxy } from "@mmmnt/feat-fault-proxy";
import type { FaultProxy } from "@mmmnt/feat-fault-proxy";
import type { CapturedRecord, FaultArm, FaultCatalog, FeatServiceAdapter, ObservationSupport, ReadQuery, SeedRecord } from "@mmmnt/feat-types";

export type KmsErrorCode = "NAMESPACE_INVALID" | "KMS_UNREACHABLE" | "FAULT_TARGET_MISSING" | "FAULT_UNSUPPORTED";

export class KmsAdapterError extends Error {
  constructor(
    readonly code: KmsErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "KmsAdapterError";
  }
}

export interface ProxyOptions {
  /** Toxiproxy API base URL. */
  api: string;
  /** host:port of the KMS endpoint as Toxiproxy reaches it. */
  upstream: string;
  /** The endpoint's container, for BrokerLoss (not offered by this adapter, but the library takes it). */
  container?: string;
  metrics?: string;
  runtime?: string;
}

export interface KmsAdapterConfig {
  key?: string;
  /** Delivered by the runner (SPEC-RT-006); never an option. */
  namespace?: string;
  options?: {
    /** KMS API origin, literally. At most one of `endpoint` / `endpointEnv`; absent = the SDK default (not exercised here). */
    endpoint?: string;
    endpointEnv?: string;
    region?: string;
    /** Env-var NAMES holding static credentials — never the values. Absent = the SDK default chain. */
    auth?: { accessKeyIdEnv: string; secretAccessKeyEnv: string; sessionTokenEnv?: string };
    /** "local-kms": the endpoint is a single-process emulator whose reads follow its writes, so settle() may vouch. */
    emulator?: "local-kms";
    /** Accepted for parity with the other product adapters; an emulator needs no wait. */
    settleTimeoutMs?: number;
    /** Transport faults on the system's path (SPEC-ADPKMS-002); without it the catalog has no Connection entry. */
    proxy?: ProxyOptions;
  };
}

const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;
const NAMESPACE_TAG = "feat:namespace";
const PRODUCT = "kms";
const CONCURRENCY = 8;

const USE_KEY_FAULTS = ["DISABLED", "PENDING_DELETION", "ALIAS_NOT_FOUND"] as const;
type UseKeyFault = (typeof USE_KEY_FAULTS)[number];
const CONNECTION_FAULTS = ["Timeout", "ConnectionReset", "Partition"] as const;

interface KeyRecord {
  key: string;
  keyId: string;
  payload: {
    keyState: string | undefined;
    enabled: boolean | undefined;
    keySpec: string | undefined;
    keyUsage: string | undefined;
    description: string | undefined;
    rotationEnabled: boolean;
    tags: Record<string, string>;
    aliases: string[];
  };
}

interface Faulted {
  kind: UseKeyFault;
  alias: string;
  keyId: string;
}

async function mapLimited<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "";
}

function resolveEndpoint(opts: { endpoint?: string; endpointEnv?: string }): string | undefined {
  if (opts.endpoint !== undefined && opts.endpointEnv !== undefined) {
    throw new Error("@mmmnt/feat-adapter-kms: options.endpoint and options.endpointEnv are mutually exclusive — configuration error.");
  }
  if (opts.endpointEnv !== undefined) {
    const value = process.env[opts.endpointEnv];
    if (!value) {
      throw new Error(`@mmmnt/feat-adapter-kms: environment variable ${opts.endpointEnv} is not set (options.endpointEnv) — configuration error.`);
    }
    return value;
  }
  return opts.endpoint;
}

function resolveCredentials(auth: NonNullable<KmsAdapterConfig["options"]>["auth"]): { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | undefined {
  if (auth === undefined) return undefined;
  const read = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`@mmmnt/feat-adapter-kms: environment variable ${name} is not set (options.auth) — configuration error.`);
    return value;
  };
  return {
    accessKeyId: read(auth.accessKeyIdEnv),
    secretAccessKey: read(auth.secretAccessKeyEnv),
    ...(auth.sessionTokenEnv !== undefined ? { sessionToken: read(auth.sessionTokenEnv) } : {}),
  };
}

class KmsAdapter implements FeatServiceAdapter {
  readonly observes: ObservationSupport = { diff: "snapshot", state: true };
  readonly faults: FaultCatalog;

  private readonly options: NonNullable<KmsAdapterConfig["options"]>;
  private readonly namespace: string;
  private readonly aliasPrefix: string;
  private client: KMSClient | undefined;
  private proxy: FaultProxy | undefined;
  private window: Map<string, KeyRecord> | undefined;
  private faulted: Faulted[] = [];

  constructor(config: KmsAdapterConfig) {
    const ns = config.namespace;
    if (ns === undefined || !NAMESPACE_PATTERN.test(ns)) {
      throw new KmsAdapterError("NAMESPACE_INVALID", `the namespace '${String(ns)}' does not match ${NAMESPACE_PATTERN.source}`);
    }
    this.namespace = ns;
    this.aliasPrefix = `alias/${ns}/`;
    this.options = config.options ?? {};
    const useKey: Record<string, readonly ["reset"]> = {};
    for (const f of USE_KEY_FAULTS) useKey[f] = ["reset"];
    const catalog: Record<string, Record<string, readonly ["reset"]>> = { UseKey: useKey };
    if (this.options.proxy !== undefined) {
      const connection: Record<string, readonly ["reset"]> = {};
      for (const f of CONNECTION_FAULTS) connection[f] = ["reset"];
      catalog.Connection = connection;
    }
    this.faults = catalog;
  }

  reportedNamespace(): string {
    return this.namespace;
  }

  /** The address the system under test should use for the endpoint when a proxy is configured (host:port form Toxiproxy reports). */
  async proxyListen(): Promise<string | undefined> {
    if (this.proxy === undefined) return undefined;
    return (await this.proxy.open()).listen;
  }

  private kms(): KMSClient {
    if (this.client === undefined) throw new Error("@mmmnt/feat-adapter-kms: setup() has not run.");
    return this.client;
  }

  async setup(): Promise<void> {
    const endpoint = resolveEndpoint(this.options);
    const credentials = resolveCredentials(this.options.auth);
    this.client = new KMSClient({
      ...(endpoint !== undefined ? { endpoint } : {}),
      ...(this.options.region !== undefined ? { region: this.options.region } : {}),
      ...(credentials !== undefined ? { credentials } : {}),
      maxAttempts: 2,
    });
    try {
      await this.client.send(new ListKeysCommand({ Limit: 1 }));
    } catch (e) {
      const answered = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== undefined;
      if (answered) throw e;
      throw new KmsAdapterError("KMS_UNREACHABLE", `the KMS endpoint ${endpoint ?? "(SDK default)"} did not answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.options.proxy !== undefined) {
      const p = this.options.proxy;
      this.proxy = createFaultProxy({
        api: p.api,
        product: PRODUCT,
        upstream: p.upstream,
        namespace: this.namespace,
        ...(p.container !== undefined ? { container: p.container } : {}),
        ...(p.metrics !== undefined ? { metrics: p.metrics } : {}),
        ...(p.runtime !== undefined ? { runtime: p.runtime } : {}),
      });
      await this.proxy.open();
    }
  }

  async teardown(): Promise<void> {
    try {
      if (this.proxy !== undefined) await this.proxy.close();
    } finally {
      this.proxy = undefined;
      this.client?.destroy();
      this.client = undefined;
    }
  }

  // ── snapshot ────────────────────────────────────────────────────────────────

  private async listAllKeyIds(): Promise<string[]> {
    const ids: string[] = [];
    let marker: string | undefined;
    do {
      const r = await this.kms().send(new ListKeysCommand({ ...(marker !== undefined ? { Marker: marker } : {}) }));
      for (const k of r.Keys ?? []) if (k.KeyId !== undefined) ids.push(k.KeyId);
      marker = r.Truncated ? r.NextMarker : undefined;
    } while (marker !== undefined);
    return ids;
  }

  private async aliasesByKey(): Promise<Map<string, string[]>> {
    const byKey = new Map<string, string[]>();
    let marker: string | undefined;
    do {
      const r = await this.kms().send(new ListAliasesCommand({ ...(marker !== undefined ? { Marker: marker } : {}) }));
      for (const a of r.Aliases ?? []) {
        if (a.TargetKeyId === undefined || a.AliasName === undefined) continue;
        const list = byKey.get(a.TargetKeyId) ?? [];
        list.push(a.AliasName);
        byKey.set(a.TargetKeyId, list);
      }
      marker = r.Truncated ? r.NextMarker : undefined;
    } while (marker !== undefined);
    return byKey;
  }

  private async tagsOf(keyId: string): Promise<Record<string, string> | undefined> {
    const tags: Record<string, string> = {};
    let marker: string | undefined;
    try {
      do {
        const r = await this.kms().send(new ListResourceTagsCommand({ KeyId: keyId, ...(marker !== undefined ? { Marker: marker } : {}) }));
        for (const t of r.Tags ?? []) if (t.TagKey !== undefined) tags[t.TagKey] = t.TagValue ?? "";
        marker = r.Truncated ? r.NextMarker : undefined;
      } while (marker !== undefined);
    } catch (e) {
      if (errorName(e) === "NotFoundException") return undefined;
      throw e;
    }
    return tags;
  }

  private async rotationOf(keyId: string): Promise<boolean> {
    try {
      const r = await this.kms().send(new GetKeyRotationStatusCommand({ KeyId: keyId }));
      return r.KeyRotationEnabled === true;
    } catch (e) {
      // KMS refuses the status for asymmetric keys and for keys in some states; that is "not rotating", not a failure.
      if (["UnsupportedOperationException", "KMSInvalidStateException", "NotFoundException"].includes(errorName(e))) return false;
      throw e;
    }
  }

  private build(meta: KeyMetadata, allTags: Record<string, string>, allAliases: string[], rotationEnabled: boolean): KeyRecord {
    const mine = allAliases.filter((a) => a.startsWith(this.aliasPrefix)).map((a) => a.slice(this.aliasPrefix.length)).sort();
    const userTags: Record<string, string> = {};
    for (const k of Object.keys(allTags).sort()) if (!k.startsWith("feat:")) userTags[k] = allTags[k] as string;
    const keyId = meta.KeyId as string;
    return {
      key: mine[0] ?? userTags.Name ?? keyId,
      keyId,
      payload: {
        keyState: meta.KeyState,
        enabled: meta.Enabled,
        keySpec: meta.KeySpec,
        keyUsage: meta.KeyUsage,
        description: meta.Description,
        rotationEnabled,
        tags: userTags,
        aliases: mine,
      },
    };
  }

  private async describe(keyId: string): Promise<KeyMetadata | undefined> {
    try {
      return (await this.kms().send(new DescribeKeyCommand({ KeyId: keyId }))).KeyMetadata;
    } catch (e) {
      if (errorName(e) === "NotFoundException") return undefined;
      throw e;
    }
  }

  private async recordOf(keyId: string, aliases: string[], tags: Record<string, string>): Promise<KeyRecord | undefined> {
    const meta = await this.describe(keyId);
    if (meta === undefined) return undefined;
    return this.build(meta, tags, aliases, await this.rotationOf(keyId));
  }

  /** Every key in the namespace: tagged with it, or aliased under it. */
  private async snapshot(): Promise<Map<string, KeyRecord>> {
    const [ids, aliases] = await Promise.all([this.listAllKeyIds(), this.aliasesByKey()]);
    const found = await mapLimited(ids, async (id) => {
      const tags = await this.tagsOf(id);
      if (tags === undefined) return undefined;
      const mine = aliases.get(id) ?? [];
      const inNamespace = tags[NAMESPACE_TAG] === this.namespace || mine.some((a) => a.startsWith(this.aliasPrefix));
      if (!inNamespace) return undefined;
      return this.recordOf(id, mine, tags);
    });
    const out = new Map<string, KeyRecord>();
    for (const r of found) if (r !== undefined) out.set(r.key, r);
    return out;
  }

  private diff(before: Map<string, KeyRecord>, after: Map<string, KeyRecord>): CapturedRecord[] {
    const now = Date.now();
    const out: CapturedRecord[] = [];
    for (const [key, rec] of after) {
      const was = before.get(key);
      if (was === undefined) out.push({ type: "INSERT", key, payload: { ...rec.payload }, timestamp: now });
      else if (JSON.stringify(was.payload) !== JSON.stringify(rec.payload)) out.push({ type: "MODIFY", key, payload: { ...rec.payload }, timestamp: now });
    }
    for (const [key, rec] of before) if (!after.has(key)) out.push({ type: "REMOVE", key, payload: { ...rec.payload }, timestamp: now });
    return out.sort((a, b) => (a.key as string).localeCompare(b.key as string));
  }

  async startCapture(): Promise<void> {
    this.window = await this.snapshot();
  }

  async peekCapture(): Promise<CapturedRecord[]> {
    if (this.window === undefined) return [];
    return this.diff(this.window, await this.snapshot());
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    if (this.window === undefined) return [];
    const records = this.diff(this.window, await this.snapshot());
    this.window = undefined;
    return records;
  }

  async settle(): Promise<boolean> {
    if (this.window === undefined || this.options.emulator !== "local-kms") return false;
    // An in-process-style yield, as ADR-0021 asks of an instrument whose writes may still be in flight.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return true;
  }

  // ── state ───────────────────────────────────────────────────────────────────

  async read(query: ReadQuery): Promise<unknown | null> {
    const aliases: string[] = [];
    let narrowed = (query.expect ?? []).length > 0;
    for (const e of query.expect ?? []) {
      const alias = e.key?.alias;
      if (typeof alias === "string") aliases.push(alias);
      else narrowed = false;
    }
    let records: KeyRecord[];
    if (narrowed) {
      const found: KeyRecord[] = [];
      for (const alias of aliases) {
        const meta = await this.describe(`${this.aliasPrefix}${alias}`);
        if (meta?.KeyId === undefined) continue;
        const [tags, all] = await Promise.all([this.tagsOf(meta.KeyId), this.aliasesOf(meta.KeyId)]);
        found.push(this.build(meta, tags ?? {}, all, await this.rotationOf(meta.KeyId)));
      }
      records = found;
    } else {
      records = [...(await this.snapshot()).values()];
    }
    const now = Date.now();
    return records
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((r) => ({ type: "Key", key: r.key, payload: { ...r.payload }, timestamp: now }));
  }

  private async aliasesOf(keyId: string): Promise<string[]> {
    const out: string[] = [];
    let marker: string | undefined;
    do {
      const r = await this.kms().send(new ListAliasesCommand({ KeyId: keyId, ...(marker !== undefined ? { Marker: marker } : {}) }));
      for (const a of r.Aliases ?? []) if (a.AliasName !== undefined) out.push(a.AliasName);
      marker = r.Truncated ? r.NextMarker : undefined;
    } while (marker !== undefined);
    return out;
  }

  // ── seed ────────────────────────────────────────────────────────────────────

  async seed(records: SeedRecord[]): Promise<void> {
    for (const r of records) {
      const alias = r.values.alias;
      if (typeof alias !== "string" || alias === "") {
        throw new Error("@mmmnt/feat-adapter-kms: a seeded key needs values.alias (relative to the namespace) — configuration error.");
      }
      const tags = [{ TagKey: NAMESPACE_TAG, TagValue: this.namespace }];
      for (const [k, v] of Object.entries((r.values.tags as Record<string, string> | undefined) ?? {})) tags.push({ TagKey: k, TagValue: v });
      const created = await this.kms().send(
        new CreateKeyCommand({
          Tags: tags,
          ...(typeof r.values.description === "string" ? { Description: r.values.description } : {}),
        }),
      );
      await this.kms().send(new CreateAliasCommand({ AliasName: `${this.aliasPrefix}${alias}`, TargetKeyId: created.KeyMetadata?.KeyId as string }));
    }
  }

  // ── faults ──────────────────────────────────────────────────────────────────

  async fault(arm: FaultArm): Promise<void> {
    const unsupported = (why: string): KmsAdapterError => new KmsAdapterError("FAULT_UNSUPPORTED", `${arm.operation}/${arm.fault}: ${why}`);
    if (arm.times !== "reset") {
      throw unsupported(`holds until reset; ${arm.times === 1 ? "once" : `times ${arm.times}`} is not offered`);
    }
    if (arm.operation === "Connection") {
      if (this.proxy === undefined) throw unsupported("no options.proxy is configured");
      if (!(CONNECTION_FAULTS as readonly string[]).includes(arm.fault)) throw unsupported("not in the catalog");
      await this.proxy.arm(arm.fault);
      return;
    }
    if (arm.operation !== "UseKey" || !(USE_KEY_FAULTS as readonly string[]).includes(arm.fault)) throw unsupported("not in the catalog");
    const alias = arm.detail?.alias;
    if (typeof alias !== "string" || alias === "") {
      throw new KmsAdapterError("FAULT_TARGET_MISSING", `${arm.operation}/${arm.fault} names no alias (detail.alias)`);
    }
    const meta = await this.describe(`${this.aliasPrefix}${alias}`);
    if (meta?.KeyId === undefined) {
      throw new KmsAdapterError("FAULT_TARGET_MISSING", `the alias '${alias}' does not exist in the namespace`);
    }
    const kind = arm.fault as UseKeyFault;
    const keyId = meta.KeyId;
    if (kind === "DISABLED") await this.kms().send(new DisableKeyCommand({ KeyId: keyId }));
    else if (kind === "PENDING_DELETION") await this.kms().send(new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: 7 }));
    else await this.kms().send(new DeleteAliasCommand({ AliasName: `${this.aliasPrefix}${alias}` }));
    this.faulted.push({ kind, alias, keyId });
  }

  private async restoreFaults(): Promise<void> {
    const pending = this.faulted.splice(0).reverse();
    let first: unknown;
    for (const f of pending) {
      try {
        if (f.kind === "DISABLED") await this.kms().send(new EnableKeyCommand({ KeyId: f.keyId }));
        else if (f.kind === "PENDING_DELETION") {
          await this.kms().send(new CancelKeyDeletionCommand({ KeyId: f.keyId }));
          // AWS returns the key Disabled; local-kms returns it Enabled. EnableKey is idempotent, so both end Enabled.
          await this.kms().send(new EnableKeyCommand({ KeyId: f.keyId }));
        } else await this.kms().send(new CreateAliasCommand({ AliasName: `${this.aliasPrefix}${f.alias}`, TargetKeyId: f.keyId }));
      } catch (e) {
        first ??= e;
      }
    }
    if (first !== undefined) throw first;
  }

  // ── reset ───────────────────────────────────────────────────────────────────

  async reset(): Promise<void> {
    this.window = undefined;
    // Faults first: a key pending deletion cannot be untagged, a missing alias cannot be recreated later.
    await this.restoreFaults();
    if (this.proxy !== undefined) await this.proxy.disarm();
    const members = await this.snapshot();
    for (const rec of members.values()) {
      if (rec.payload.keyState === "PendingDeletion") {
        // Scheduled by the system, not by a fault: tag calls fail while pending, so return the key first.
        await this.kms().send(new CancelKeyDeletionCommand({ KeyId: rec.keyId }));
      }
      for (const a of rec.payload.aliases) {
        await this.kms().send(new DeleteAliasCommand({ AliasName: `${this.aliasPrefix}${a}` }));
      }
      await this.kms().send(new UntagResourceCommand({ KeyId: rec.keyId, TagKeys: [NAMESPACE_TAG] }));
      await this.kms().send(new ScheduleKeyDeletionCommand({ KeyId: rec.keyId, PendingWindowInDays: 7 }));
    }
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new KmsAdapter(config as KmsAdapterConfig);
}
