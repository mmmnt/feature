// @mmmnt/feat-adapter-kurrent (SPEC-ADPKUR-001, -002, -003) — KurrentDB as a Feat service.
//
// The `$all` log is the change feed: it is totally ordered by log position, and the position of an
// append (AppendResult.position) is a position in that same log. That is the whole of settle: append a
// fence marker after the system's writes returned, read `$all` until an event at or beyond the marker's
// position is seen, and every earlier write is visible to the capture. It proves absence too.
//
// The adapter's own (instrument) client is connected to the product directly and never through a
// proxy; transport faults (Connection.*) are armed on a Toxiproxy proxy in front of the SYSTEM's path
// through @mmmnt/feat-fault-proxy (SPEC-FPX-001).

import {
  ANY,
  KurrentDBClient,
  START,
  jsonEvent,
  streamNameFilter,
} from "@kurrent/kurrentdb-client";
import { createFaultProxy } from "@mmmnt/feat-fault-proxy";
import type { FaultProxy, OpenProxy } from "@mmmnt/feat-fault-proxy";
import type { ReadPosition } from "@kurrent/kurrentdb-client";
import type {
  CapturedRecord,
  FaultArm,
  FaultCatalog,
  FeatServiceAdapter,
  ReadQuery,
  SeedRecord,
} from "@mmmnt/feat-types";

export type KurrentAdapterErrorCode = "NAMESPACE_INVALID" | "ALL_READ_DENIED" | "FAULT_UNSUPPORTED";

export class KurrentAdapterError extends Error {
  constructor(
    readonly code: KurrentAdapterErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "KurrentAdapterError";
  }
}

export interface KurrentProxyOptions {
  /** Toxiproxy API base URL. */
  api: string;
  /** host:port of the product as Toxiproxy reaches it (it can differ from the instrument's address). */
  upstream: string;
  /** The product label of the proxy name `feat-<ns>-<name>`. Default "kurrent". */
  name?: string;
  /** The product's container, for BrokerLoss. Without it BrokerLoss is not in the catalog. */
  container?: string;
  metrics?: string;
  runtime?: string;
}

export interface KurrentOptions {
  connectionString?: string;
  /** Name of the environment variable holding the connection string. */
  connectionStringEnv?: string;
  /** Names of the environment variables holding the instrument's credentials. */
  system?: { username: string; password: string };
  settleTimeoutMs?: number;
  proxy?: KurrentProxyOptions;
}

interface KurrentConfig {
  key?: string;
  namespace?: string;
  options?: KurrentOptions;
}

type Position = { commit: bigint; prepare: bigint };

const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;
const INSTRUMENT_MARKER = { feat: "instrument" };
const WHOLE_LOG = Number.MAX_SAFE_INTEGER;
const POLL_MS = 25;
/** Event types a capture keeps from the system's own stream-level events. */
const KEPT_SYSTEM_TYPES = new Set(["$streamDeleted", "$metadata"]);
/** 9223372036854775807 as the JSON number a JS client delivers: 2^63. */
const INT64_MAX_AS_NUMBER = 2 ** 63;
const CONNECTION_FAULTS = ["Timeout", "ConnectionReset", "Partition"] as const;

function after(a: Position, b: Position): boolean {
  return a.commit > b.commit || (a.commit === b.commit && a.prepare > b.prepare);
}

/**
 * The `$metadata` record the server writes on the first append after a soft delete: a body that is exactly
 * `{ $tb: n }` with n below the Int64 maximum (founder ruling 2026-11-09, Kurrent $tb A). A soft delete by the
 * system writes the maximum, which the client delivers as the JSON number 2^63, and is the system's effect.
 */
function isServerTruncateBefore(type: string, data: unknown): boolean {
  if (type !== "$metadata" || typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== "$tb") return false;
  const n = (data as { $tb: unknown }).$tb;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < INT64_MAX_AS_NUMBER;
}

function errorType(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "type" in e && typeof (e as { type: unknown }).type === "string"
    ? (e as { type: string }).type
    : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject after `ms` so a call into a product that no longer answers (a paused container) cannot hang the harness. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

class KurrentAdapter implements FeatServiceAdapter {
  readonly observes = { diff: "native", state: true } as const;
  readonly faults: FaultCatalog;

  private readonly namespace: string;
  private readonly options: KurrentOptions;
  private readonly settleTimeoutMs: number;
  private client: KurrentDBClient | undefined;
  private proxy: FaultProxy | undefined;
  private opened: OpenProxy | undefined;

  /** The window: the last position read (exclusive cursor) and what has been captured since. */
  private cursor: Position | undefined;
  private captured: CapturedRecord[] = [];
  private windowOpen = false;

  constructor(config: KurrentConfig) {
    const ns = config.namespace;
    if (typeof ns !== "string" || !NAMESPACE_PATTERN.test(ns)) {
      throw new KurrentAdapterError(
        "NAMESPACE_INVALID",
        `'${String(ns)}' does not match ${NAMESPACE_PATTERN.source}, the pattern the runner derives`,
      );
    }
    this.namespace = ns;
    this.options = config.options ?? {};
    this.settleTimeoutMs = this.options.settleTimeoutMs ?? 5000;

    const catalog: Record<string, Record<string, readonly ("once" | "times" | "reset")[]>> = {
      AppendToStream: { WRONG_EXPECTED_VERSION: ["reset"], ACCESS_DENIED: ["reset"] },
    };
    const proxy = this.options.proxy;
    if (proxy !== undefined) {
      this.proxy = createFaultProxy({
        api: proxy.api,
        product: proxy.name ?? "kurrent",
        upstream: proxy.upstream,
        namespace: ns,
        ...(proxy.container !== undefined ? { container: proxy.container } : {}),
        ...(proxy.metrics !== undefined ? { metrics: proxy.metrics } : {}),
        ...(proxy.runtime !== undefined ? { runtime: proxy.runtime } : {}),
      });
      catalog.Connection = Object.fromEntries(this.proxy.catalog.map((f: string) => [f, ["reset" as const]]));
    }
    this.faults = catalog;
  }

  reportedNamespace(): string {
    return this.namespace;
  }

  /** The address the system under test connects to when `options.proxy` is configured (host side of the proxy). */
  proxyListen(): string | undefined {
    return this.opened?.listen;
  }

  // ── naming ────────────────────────────────────────────────────────────────

  private get prefix(): string {
    return `${this.namespace}.`;
  }
  private get metaPrefix(): string {
    return `$$${this.namespace}.`;
  }
  private get fenceStream(): string {
    return `feat-fence.${this.namespace}`;
  }
  private full(stream: string): string {
    return `${this.prefix}${stream}`;
  }
  /** The namespace-relative key of a stream name, or undefined outside the namespace. */
  private relative(streamId: string): string | undefined {
    if (streamId.startsWith(this.prefix)) return streamId.slice(this.prefix.length);
    if (streamId.startsWith(this.metaPrefix)) return `$$${streamId.slice(this.metaPrefix.length)}`;
    return undefined;
  }

  // ── the instrument connection ─────────────────────────────────────────────

  private connectionString(): string {
    const o = this.options;
    const raw = o.connectionString ?? (o.connectionStringEnv !== undefined ? process.env[o.connectionStringEnv] : undefined);
    if (raw === undefined || raw === "") {
      throw new Error(`the kurrent service '${"key"}' has no connectionString (or connectionStringEnv naming a set variable)`);
    }
    if (o.system === undefined) return raw;
    const user = process.env[o.system.username];
    const pass = process.env[o.system.password];
    if (user === undefined || pass === undefined) {
      throw new Error(`options.system names the variables ${o.system.username} and ${o.system.password}, which are not both set`);
    }
    const url = new URL(raw);
    url.username = user;
    url.password = pass;
    return url.toString();
  }

  private db(): KurrentDBClient {
    if (this.client === undefined) this.client = KurrentDBClient.connectionString(this.connectionString());
    return this.client;
  }

  async setup(): Promise<void> {
    const db = this.db();
    try {
      for await (const _ of db.readAll({ fromPosition: START, maxCount: 1 })) break;
    } catch (e) {
      if (errorType(e) === "access-denied") {
        throw new KurrentAdapterError("ALL_READ_DENIED", "the instrument credentials cannot read the $all stream");
      }
      throw e;
    }
    if (this.proxy !== undefined) this.opened = await this.proxy.open();
  }

  async teardown(): Promise<void> {
    this.windowOpen = false;
    this.cursor = undefined;
    try {
      if (this.proxy !== undefined) await this.proxy.close();
    } finally {
      this.opened = undefined;
      const client = this.client;
      this.client = undefined;
      if (client !== undefined) await client.dispose().catch(() => {});
    }
  }

  // ── reading $all ──────────────────────────────────────────────────────────

  /**
   * Read `$all` forwards from the cursor with a server-side stream-name prefix filter. Namespace events are
   * accumulated as captured records (instrument events and system events other than the kept ones are
   * dropped); the cursor advances past everything seen. Returns the position of the last event seen
   * (the fence stream included when asked for), if any.
   */
  private async drain(withFence: boolean, deadlineMs?: number): Promise<Position | undefined> {
    const db = this.db();
    const prefixes = withFence ? [this.prefix, this.metaPrefix, this.fenceStream] : [this.prefix, this.metaPrefix];
    const from = this.cursor;
    const fromPosition: ReadPosition = from ?? START;
    const options = {
      fromPosition,
      maxCount: WHOLE_LOG,
      filter: streamNameFilter({ prefixes }),
      ...(deadlineMs !== undefined ? { deadline: deadlineMs } : {}),
    };
    let last: Position | undefined;
    for await (const resolved of db.readAll(options)) {
      const event = resolved.event;
      if (event === undefined) continue;
      const position = event.position;
      // fromPosition is inclusive: skip what the cursor already passed.
      if (from !== undefined && !after(position, from)) continue;
      last = position;
      this.cursor = position;
      const key = this.relative(event.streamId);
      if (key === undefined) continue;
      if (this.isInstrument(event.metadata)) continue;
      if (event.type.startsWith("$") && !KEPT_SYSTEM_TYPES.has(event.type)) continue;
      if (isServerTruncateBefore(event.type, event.data)) continue;
      if (event.isJson === false) continue;
      this.captured.push({
        type: event.type,
        key,
        payload: (event.data ?? {}) as Record<string, unknown>,
        timestamp: new Date(event.created).getTime(),
        metadata: { revision: Number(event.revision), commitPosition: Number(position.commit) },
      });
    }
    return last;
  }

  private isInstrument(metadata: unknown): boolean {
    return typeof metadata === "object" && metadata !== null && (metadata as { feat?: unknown }).feat === "instrument";
  }

  private async appendMarker(stream: string, deadline?: number): Promise<Position> {
    const result = await this.db().appendToStream(
      stream,
      jsonEvent({ type: "feat.marker", data: {}, metadata: INSTRUMENT_MARKER }),
      { streamState: ANY, ...(deadline !== undefined ? { deadline } : {}) },
    );
    if (result.position === undefined) throw new Error(`the append to '${stream}' reported no log position`);
    return result.position;
  }

  // ── the window ────────────────────────────────────────────────────────────

  async startCapture(): Promise<void> {
    this.cursor = await this.appendMarker(this.fenceStream);
    this.captured = [];
    this.windowOpen = true;
  }

  async peekCapture(): Promise<CapturedRecord[]> {
    if (!this.windowOpen) return [];
    await this.drain(false);
    return [...this.captured];
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    if (!this.windowOpen) return [];
    await this.drain(false);
    const records = this.captured;
    this.captured = [];
    this.windowOpen = false;
    this.cursor = undefined;
    return records;
  }

  async settle(): Promise<boolean> {
    if (!this.windowOpen) return false;
    const deadline = Date.now() + this.settleTimeoutMs;
    try {
      const marker = await within(this.appendMarker(this.fenceStream, Math.max(this.settleTimeoutMs, 1)), Math.max(this.settleTimeoutMs, 1));
      while (Date.now() < deadline) {
        const remaining = Math.max(deadline - Date.now(), 1);
        const seen = await within(this.drain(true, remaining), remaining);
        if (seen !== undefined && !after(marker, seen)) return true;
        await sleep(POLL_MS);
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────

  /** Every stream the namespace has ever held, found by an `$all` prefix scan (projections are not required). */
  private async namespaceStreams(): Promise<{ streams: string[]; withMetadata: Set<string> }> {
    const seen = new Set<string>();
    const withMetadata = new Set<string>();
    for await (const resolved of this.db().readAll({
      fromPosition: START,
      maxCount: WHOLE_LOG,
      filter: streamNameFilter({ prefixes: [this.prefix, this.metaPrefix] }),
    })) {
      const id = resolved.event?.streamId;
      if (id === undefined) continue;
      if (id.startsWith(this.metaPrefix)) {
        const stream = `${this.prefix}${id.slice(this.metaPrefix.length)}`;
        withMetadata.add(stream);
        seen.add(stream);
      } else if (id.startsWith(this.prefix)) seen.add(id);
    }
    return { streams: [...seen], withMetadata };
  }

  async read(query: ReadQuery): Promise<unknown | null> {
    const hinted = query.expect?.map((e) => e.key?.stream);
    const names =
      hinted !== undefined && hinted.length > 0 && hinted.every((s) => typeof s === "string")
        ? [...new Set(hinted as string[])].map((s) => this.full(s))
        : (await this.namespaceStreams()).streams;
    const records: CapturedRecord[] = [];
    for (const name of names) {
      try {
        for await (const resolved of this.db().readStream(name, { maxCount: WHOLE_LOG })) {
          const event = resolved.event;
          if (event === undefined || this.isInstrument(event.metadata)) continue;
          if (event.type.startsWith("$") || event.isJson === false) continue;
          records.push({
            type: event.type,
            key: name.slice(this.prefix.length),
            payload: (event.data ?? {}) as Record<string, unknown>,
            timestamp: new Date(event.created).getTime(),
            metadata: { revision: Number(event.revision) },
          });
        }
      } catch (e) {
        // A soft-deleted (or never written) stream reads as empty; state is not resurrected from $all.
        const t = errorType(e);
        if (t !== "stream-not-found" && t !== "stream-deleted") throw e;
      }
    }
    return records;
  }

  /** The stream of a seed: `values.stream` when the record names one, else its type. */
  async seed(records: SeedRecord[]): Promise<void> {
    for (const r of records) {
      const stream = typeof r.values.stream === "string" ? r.values.stream : r.type;
      await this.db().appendToStream(this.full(stream), jsonEvent({ type: r.type, data: r.values as never }), { streamState: ANY });
    }
  }

  // ── faults ────────────────────────────────────────────────────────────────

  async fault(arm: FaultArm): Promise<void> {
    const where = `${arm.operation}.${arm.fault}`;
    const entry = (this.faults[arm.operation] as Record<string, readonly string[]> | undefined)?.[arm.fault];
    if (entry === undefined) {
      throw new KurrentAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' is not in the catalog (${this.describeCatalog()})`);
    }
    if (arm.times !== "reset") {
      const asked = arm.times === 1 ? "once" : `times ${arm.times}`;
      throw new KurrentAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' declares only until reset, not ${asked}`);
    }
    if (arm.operation === "Connection") {
      await this.proxy!.arm(arm.fault);
      return;
    }
    const stream = arm.detail?.stream;
    if (typeof stream !== "string" || stream === "") {
      throw new KurrentAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' needs a detail { stream } naming the stream it applies to`);
    }
    const name = this.full(stream);
    if (arm.fault === "WRONG_EXPECTED_VERSION") {
      // A stream the system expects NOT to exist must exist: the instrument's placeholder is never a record.
      await this.db().appendToStream(name, jsonEvent({ type: "feat.fault", data: {}, metadata: INSTRUMENT_MARKER }), { streamState: ANY });
    } else {
      // The write role of the stream names a role nobody holds. $admins bypass ACLs, so the system must not be admin.
      await this.db().setStreamMetadata(name, { acl: { writeRoles: ["nobody"] } });
    }
  }

  private describeCatalog(): string {
    return Object.entries(this.faults)
      .flatMap(([op, faults]) => Object.keys(faults).map((f) => `${op}.${f}`))
      .join(", ");
  }

  async reset(): Promise<void> {
    if (this.proxy !== undefined && this.opened !== undefined) await this.proxy.disarm();
    const { streams, withMetadata } = await this.namespaceStreams();
    for (const name of streams) {
      if (withMetadata.has(name)) await this.db().setStreamMetadata(name, {});
      try {
        await this.db().deleteStream(name);
      } catch (e) {
        if (errorType(e) !== "stream-not-found") throw e;
      }
    }
    this.windowOpen = false;
    this.cursor = undefined;
    this.captured = [];
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new KurrentAdapter(config as KurrentConfig);
}
