// @mmmnt/feat-adapter-dynamodb — a DynamoDB table becomes a capture window via
// DynamoDB Streams CDC. startCapture pins LATEST shard iterators; stopCapture
// drains the stream — every write in the window becomes a CapturedRecord
// {type: INSERT|MODIFY|REMOVE, key, payload}, so an unpredicted table write
// fails the suite by prediction inversion.
//
// ACCESS MODEL (the adapter-access convention):
// - Shared/live environments are OBSERVE-ONLY. The adapter never creates or
//   mutates infrastructure it evidences; a missing stream is a configuration
//   error naming the fix, and the docs ship the read-only observer policy.
// - `options.auth` carries credential REFERENCES, never values (config is
//   committed and hashed into generated suites): exactly one of a named
//   profile, an assume-role ARN (OIDC-compatible), or env-var NAMES for
//   static keys. Absent = the SDK default chain.
// - `options.ephemeral` scaffolds a private instrument instead: a DynamoDB
//   Local container + table + stream, zero credentials, zero IaC — for teams
//   with no cloud access at all. Ephemeral is mutually exclusive with
//   table/auth/endpoint options.
//
// Declare the service `eventual` with a convergenceTimeout — stream delivery
// lags the writes that cause it. AWS SDK v3 clients are real dependencies:
// DynamoDB requires SigV4 signing.
import { execFile as execFileCb, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import {
  DynamoDBClient,
  CreateTableCommand,
  DescribeTableCommand,
  ListTablesCommand,
  PutItemCommand,
  ScanCommand,
  GetItemCommand,
  QueryCommand,
  DeleteItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBStreamsClient,
  DescribeStreamCommand,
  GetShardIteratorCommand,
  GetRecordsCommand,
} from "@aws-sdk/client-dynamodb-streams";
import { fromIni, fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type {
  CapturedRecord,
  FaultArm,
  FaultCatalog,
  FeatServiceAdapter,
  ObservationSupport,
  ReadQuery,
  SeedRecord,
} from "@mmmnt/feat-types";
import type { FaultProxy } from "@mmmnt/feat-fault-proxy";

const execFile = promisify(execFileCb);

export interface AuthOptions {
  /** Named AWS profile (local development). */
  profile?: string;
  /** Role to assume over the base chain (enterprise CI; OIDC web identity compatible). */
  roleArn?: string;
  roleSessionName?: string;
  /** Env-var NAMES holding static keys (escape hatch) — never the values. */
  accessKeyIdEnv?: string;
  secretAccessKeyEnv?: string;
  sessionTokenEnv?: string;
}

export interface EphemeralOptions {
  /** Table name inside the scaffolded instrument (default feat-ephemeral). */
  table?: string;
  /** Partition key attribute (string type). Default "PK". */
  partitionKey?: string;
  /** Sort key attribute (string type). Default "SK"; null for a HASH-only table. */
  sortKey?: string | null;
  /** Container image override (default amazon/dynamodb-local). */
  image?: string;
  /**
   * Env-var NAMES to publish the scaffolded instrument's coordinates under,
   * so in-process handlers read table/endpoint from the environment exactly
   * as the deployed code will (12-factor parity). Restored on teardown.
   */
  exposeEnv?: { tableEnv?: string; endpointEnv?: string };
}

interface DynamoAdapterConfig {
  options?: {
    /** Table name, literally. Exactly one of `table` / `tableEnv` (unless ephemeral). */
    table?: string;
    /** Env var holding the table name (per-environment deploys). */
    tableEnv?: string;
    /** AWS region; defaults to the SDK chain (AWS_REGION). */
    region?: string;
    /** API origin override, literally (e.g. http://127.0.0.1:8000). */
    endpoint?: string;
    /**
     * Env var holding the API origin — endpoints belong to the ENVIRONMENT
     * (an emulator edge, a VPC endpoint URL, DynamoDB Local), so per-tier
     * configs reference them like tableEnv references the table. Exactly one
     * of `endpoint` / `endpointEnv`; absent = the real regional endpoint.
     */
    endpointEnv?: string;
    auth?: AuthOptions;
    ephemeral?: EphemeralOptions;
    /**
     * ADR-0021: let settle() vouch for the capture by writing a sentinel row and draining the
     * stream until it arrives. Sound only where the stream is a single ordered sequence — one
     * open shard and one writer (DynamoDB Local, the feat run lane). Off by default; with more
     * than one open shard settle() declines to vouch even when on.
     */
    fence?: boolean;
    /**
     * SPEC-ADPDDB-001: false = snapshot diff (two consistent reads of the namespace compared by primary key; no
     * Streams permission needed). Default true = native diff from the stream.
     */
    stream?: boolean;
    /** SPEC-ADPDDB-001: how a namespace is carried. Only "keyPrefix" (stored partition key `<ns>#<pk>`). */
    namespaceMode?: "keyPrefix";
    /**
     * SPEC-ADPDDB-002: Toxiproxy in front of the product, for the `Connection` faults. `api` is the Toxiproxy API,
     * `name` the product label of the proxy (default "dynamodb"; the proxy is `feat-<ns>-<name>`), `upstream` the
     * host:port of DynamoDB as Toxiproxy reaches it (default: the host of `endpoint`). The adapter's own clients never
     * use the proxy; the system under test is pointed at the proxy's listen address.
     */
    proxy?: { api: string; name?: string; upstream?: string; container?: string; metrics?: string; runtime?: string };
  };
  /** SPEC-RT-006: the runner's namespace, handed to every adapter as the config's top-level `namespace`. */
  namespace?: string;
}

export type DynamoAdapterErrorCode =
  | "NAMESPACE_INVALID"
  | "NAMESPACE_KEY_NOT_STRING"
  | "STREAM_NOT_ENABLED"
  | "FAULT_UNSUPPORTED";

/** A refusal the adapter makes by name (SPEC-ADPDDB-001): `code` is stable, `detail` names the offender. */
export class DynamoAdapterError extends Error {
  constructor(
    readonly code: DynamoAdapterErrorCode,
    readonly detail: string,
  ) {
    super(`@mmmnt/feat-adapter-dynamodb: ${code}: ${detail}`);
    this.name = "DynamoAdapterError";
  }
}

/** The pattern the runner derives namespaces to (SPEC-RT-006). */
const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;

/**
 * Resolve the API origin: literal `endpoint`, or the value of the env var
 * named by `endpointEnv` (both set = configuration error; named var unset =
 * configuration error). Undefined = the SDK's real regional endpoint.
 * Exported for unit testing — makes no AWS calls.
 */
export function resolveEndpoint(opts: { endpoint?: string; endpointEnv?: string }): string | undefined {
  if (opts.endpoint !== undefined && opts.endpointEnv !== undefined)
    throw new Error(
      "@mmmnt/feat-adapter-dynamodb: options.endpoint and options.endpointEnv are mutually exclusive — configuration error.",
    );
  if (opts.endpointEnv !== undefined) {
    const value = process.env[opts.endpointEnv];
    if (!value)
      throw new Error(
        `@mmmnt/feat-adapter-dynamodb: environment variable ${opts.endpointEnv} is not set (options.endpointEnv) — configuration error.`,
      );
    return value;
  }
  return opts.endpoint;
}

/**
 * Resolve `options.auth` to a credential descriptor. Exactly one form may be
 * present; several at once is a configuration error (precedence rules hide
 * mistakes). Exported for unit testing — makes no AWS calls.
 */
export function resolveAuth(
  auth: AuthOptions | undefined,
): { kind: "default" } | { kind: "profile" | "role" | "static-env"; credentials: AwsCredentialIdentityProvider } {
  if (!auth) return { kind: "default" };
  const forms = [
    auth.profile !== undefined,
    auth.roleArn !== undefined,
    auth.accessKeyIdEnv !== undefined || auth.secretAccessKeyEnv !== undefined,
  ].filter(Boolean).length;
  if (forms === 0) return { kind: "default" };
  if (forms > 1)
    throw new Error(
      "@mmmnt/feat-adapter-dynamodb: options.auth must carry exactly ONE of profile | roleArn | " +
        "accessKeyIdEnv+secretAccessKeyEnv — configuration error.",
    );
  if (auth.profile !== undefined) {
    return { kind: "profile", credentials: fromIni({ profile: auth.profile }) };
  }
  if (auth.roleArn !== undefined) {
    return {
      kind: "role",
      credentials: fromTemporaryCredentials({
        params: { RoleArn: auth.roleArn, RoleSessionName: auth.roleSessionName ?? "feat-adapter-dynamodb" },
      }),
    };
  }
  const { accessKeyIdEnv, secretAccessKeyEnv, sessionTokenEnv } = auth;
  if (!accessKeyIdEnv || !secretAccessKeyEnv)
    throw new Error(
      "@mmmnt/feat-adapter-dynamodb: env-named credentials need BOTH accessKeyIdEnv and secretAccessKeyEnv — configuration error.",
    );
  return {
    kind: "static-env",
    credentials: async () => {
      const accessKeyId = process.env[accessKeyIdEnv];
      const secretAccessKey = process.env[secretAccessKeyEnv];
      if (!accessKeyId || !secretAccessKey)
        throw new Error(
          `@mmmnt/feat-adapter-dynamodb: environment variable ${!accessKeyId ? accessKeyIdEnv : secretAccessKeyEnv} is not set — configuration error.`,
        );
      const sessionToken = sessionTokenEnv ? process.env[sessionTokenEnv] : undefined;
      return sessionToken !== undefined ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
    },
  };
}

interface StreamImageRecord {
  eventName?: string;
  dynamodb?: {
    Keys?: Record<string, unknown>;
    NewImage?: Record<string, unknown>;
    OldImage?: Record<string, unknown>;
    SequenceNumber?: string;
    ApproximateCreationDateTime?: Date;
  };
}

/** Pure mapping: one stream record → the CapturedRecord the matcher diffs. */
export function mapStreamRecord(r: StreamImageRecord): CapturedRecord {
  const image = r.dynamodb?.NewImage ?? r.dynamodb?.OldImage ?? r.dynamodb?.Keys ?? {};
  const keys = r.dynamodb?.Keys ?? {};
  const keyObj = unmarshall(keys as Record<string, AttributeValue>);
  const key = Object.keys(keyObj)
    .sort()
    .map((k) => `${k}=${String(keyObj[k])}`)
    .join("|");
  return {
    type: r.eventName ?? "UNKNOWN",
    key,
    payload: unmarshall(image as Record<string, AttributeValue>),
    timestamp: r.dynamodb?.ApproximateCreationDateTime?.getTime() ?? 0,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (typeof address === "object" && address) {
        const port = address.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not allocate a port")));
      }
    });
    srv.on("error", reject);
  });
}

class DynamoAdapter implements FeatServiceAdapter {
  private readonly opts: NonNullable<DynamoAdapterConfig["options"]>;
  private table: string;
  private ddb: DynamoDBClient | null = null;
  private streams: DynamoDBStreamsClient | null = null;
  private streamArn: string | null = null;
  private iterators: string[] | null = null;
  private captured: CapturedRecord[] = [];
  private keySchema: { name: string; type: string }[] = [];
  private container: string | null = null;
  private exposedEnv: { name: string; prior: string | undefined }[] = [];
  private hashKey = "";
  private rangeKey: string | null = null;
  private baseline: Map<string, SnapshotItem> | null = null;
  private proxy: FaultProxy | null = null;
  private readonly namespace: string | undefined;
  private readonly snapshotMode: boolean;
  readonly observes: ObservationSupport;
  readonly faults: FaultCatalog;
  /** The DynamoDB operation the last read() used (SPEC-ADPDDB-001); a probe reads it, the harness does not. */
  lastReadVia: "GetItem" | "Query" | "Scan" | null = null;

  constructor(config: DynamoAdapterConfig) {
    this.opts = config.options ?? {};
    const { table, tableEnv, endpoint, endpointEnv, auth, ephemeral } = this.opts;
    // SPEC-RT-006: the namespace is the runner's, never an option; a value off the pattern is refused before anything runs.
    if (config.namespace !== undefined && !NAMESPACE_PATTERN.test(config.namespace))
      throw new DynamoAdapterError("NAMESPACE_INVALID", config.namespace);
    this.namespace = config.namespace;
    this.snapshotMode = this.opts.stream === false;
    this.observes = { diff: this.snapshotMode ? "snapshot" : "native", state: true };
    this.faults = {
      PutItem: { CONDITIONAL_CHECK_FAILED: ["reset"] },
      ...(this.opts.proxy !== undefined
        ? { Connection: { Timeout: ["reset"], ConnectionReset: ["reset"], Partition: ["reset"] } }
        : {}),
    };
    if (ephemeral) {
      if (table || tableEnv || endpoint || endpointEnv || auth || this.opts.proxy)
        throw new Error(
          "@mmmnt/feat-adapter-dynamodb: options.ephemeral is mutually exclusive with table/tableEnv/endpoint/auth/proxy " +
            "(the scaffolded instrument is private and credential-free) — configuration error.",
        );
      this.table = ephemeral.table ?? "feat-ephemeral";
      return;
    }
    resolveAuth(auth); // validate the form early; providers are rebuilt at setup
    const fromEnv = tableEnv ? process.env[tableEnv] : undefined;
    const resolved = table ?? fromEnv;
    if (!resolved)
      throw new Error(
        "@mmmnt/feat-adapter-dynamodb: no table name — set options.table or options.tableEnv (env var unset?) — configuration error.",
      );
    this.table = resolved;
  }

  private clients(): { ddb: DynamoDBClient; streams: DynamoDBStreamsClient } {
    if (!this.ddb || !this.streams) throw new Error("Adapter used before setup() — configuration error.");
    return { ddb: this.ddb, streams: this.streams };
  }

  private async scaffoldEphemeral(): Promise<void> {
    const eph = this.opts.ephemeral!;
    try {
      execFileSync("docker", ["version"], { stdio: "ignore" });
    } catch {
      throw new Error(
        "@mmmnt/feat-adapter-dynamodb: options.ephemeral needs docker for the scaffolded DynamoDB Local instrument " +
          "(install docker, or point options.endpoint at an existing DynamoDB Local) — configuration error.",
      );
    }
    const port = await freePort();
    this.container = `feat-ddb-${randomBytes(4).toString("hex")}`;
    await execFile("docker", [
      "run", "-d", "--rm", "--name", this.container, "-p", `${port}:8000`, eph.image ?? "amazon/dynamodb-local",
    ]);
    const clientOpts = {
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${port}`,
      // Dummy identity for the private instrument; DynamoDB Local's header
      // parsing rejects non-alphanumeric access key ids.
      credentials: async () => ({ accessKeyId: "featlocal", secretAccessKey: "featlocal" }),
    };
    this.ddb = new DynamoDBClient(clientOpts);
    this.streams = new DynamoDBStreamsClient(clientOpts);
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        await this.ddb.send(new ListTablesCommand({}));
        break;
      } catch (e) {
        if (Date.now() > deadline)
          throw new Error(`@mmmnt/feat-adapter-dynamodb: ephemeral instrument never became ready (${(e as Error).message})`);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    const expose = eph.exposeEnv;
    if (expose) {
      const endpoint = `http://127.0.0.1:${port}`;
      for (const [name, value] of [
        [expose.tableEnv, this.table],
        [expose.endpointEnv, endpoint],
      ] as const) {
        if (!name) continue;
        this.exposedEnv.push({ name, prior: process.env[name] });
        process.env[name] = value;
      }
    }
    const pk = eph.partitionKey ?? "PK";
    const sk = eph.sortKey === null ? null : (eph.sortKey ?? "SK");
    await this.ddb.send(
      new CreateTableCommand({
        TableName: this.table,
        AttributeDefinitions: [
          { AttributeName: pk, AttributeType: "S" },
          ...(sk ? [{ AttributeName: sk, AttributeType: "S" as const }] : []),
        ],
        KeySchema: [
          { AttributeName: pk, KeyType: "HASH" },
          ...(sk ? [{ AttributeName: sk, KeyType: "RANGE" as const }] : []),
        ],
        BillingMode: "PAY_PER_REQUEST",
        StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" },
      }),
    );
    const tableDeadline = Date.now() + 30_000;
    for (;;) {
      const d = await this.ddb.send(new DescribeTableCommand({ TableName: this.table }));
      if (d.Table?.TableStatus === "ACTIVE") break;
      if (Date.now() > tableDeadline)
        throw new Error("@mmmnt/feat-adapter-dynamodb: ephemeral table never became ACTIVE");
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async setup(): Promise<void> {
    if (this.opts.ephemeral) {
      await this.scaffoldEphemeral();
    } else {
      const resolved = resolveAuth(this.opts.auth);
      const clientOpts: Record<string, unknown> = {};
      if (this.opts.region) clientOpts.region = this.opts.region;
      const endpoint = resolveEndpoint(this.opts);
      if (endpoint) clientOpts.endpoint = endpoint;
      if (resolved.kind !== "default") clientOpts.credentials = resolved.credentials;
      this.ddb = new DynamoDBClient(clientOpts);
      this.streams = new DynamoDBStreamsClient(clientOpts);
    }
    const { ddb } = this.clients();
    const out = await ddb.send(new DescribeTableCommand({ TableName: this.table }));
    const arn = out.Table?.LatestStreamArn;
    const enabled = out.Table?.StreamSpecification?.StreamEnabled;
    const view = out.Table?.StreamSpecification?.StreamViewType;
    // Snapshot diff reads the base table and needs no stream (SPEC-ADPDDB-001).
    if (!this.snapshotMode) {
      if (!arn || !enabled)
        throw new DynamoAdapterError(
          "STREAM_NOT_ENABLED",
          `table '${this.table}' has no active stream — enable Streams ` +
            "(StreamViewType NEW_AND_OLD_IMAGES) so writes are observable — configuration error.",
        );
      if (view === "KEYS_ONLY")
        throw new Error(
          `@mmmnt/feat-adapter-dynamodb: table '${this.table}' stream is KEYS_ONLY — predictions need images; ` +
            "use NEW_AND_OLD_IMAGES (or NEW_IMAGE) — configuration error.",
        );
      this.streamArn = arn ?? null;
    }
    const types = new Map((out.Table?.AttributeDefinitions ?? []).map((d) => [d.AttributeName, d.AttributeType]));
    this.keySchema = (out.Table?.KeySchema ?? []).map((k) => ({
      name: String(k.AttributeName),
      type: String(types.get(k.AttributeName) ?? "")
    }));
    const hash = (out.Table?.KeySchema ?? []).find((k) => k.KeyType === "HASH");
    const range = (out.Table?.KeySchema ?? []).find((k) => k.KeyType === "RANGE");
    this.hashKey = String(hash?.AttributeName ?? "");
    this.rangeKey = range?.AttributeName !== undefined ? String(range.AttributeName) : null;
    if (this.namespace !== undefined) {
      const hashType = this.keySchema.find((k) => k.name === this.hashKey)?.type;
      if (hashType !== "S")
        throw new DynamoAdapterError(
          "NAMESPACE_KEY_NOT_STRING",
          `the partition key '${this.hashKey}' of table '${this.table}' is not a string, so a key-prefix namespace cannot be carried`,
        );
    }
    const proxy = this.opts.proxy;
    if (proxy !== undefined) {
      if (this.namespace === undefined)
        throw new Error("@mmmnt/feat-adapter-dynamodb: options.proxy needs the runner's namespace (SPEC-RT-006) — configuration error.");
      const upstream = proxy.upstream ?? (this.opts.endpoint !== undefined ? new URL(this.opts.endpoint).host : undefined);
      if (upstream === undefined)
        throw new Error("@mmmnt/feat-adapter-dynamodb: options.proxy needs an upstream (or an options.endpoint to derive it from) — configuration error.");
      const { createFaultProxy } = await import("@mmmnt/feat-fault-proxy");
      this.proxy = createFaultProxy({
        api: proxy.api,
        product: proxy.name ?? "dynamodb",
        upstream,
        namespace: this.namespace,
        ...(proxy.container !== undefined ? { container: proxy.container } : {}),
        ...(proxy.metrics !== undefined ? { metrics: proxy.metrics } : {}),
        ...(proxy.runtime !== undefined ? { runtime: proxy.runtime } : {}),
      });
      await this.proxy.open();
    }
  }

  private prefix(): string {
    return this.namespace !== undefined ? `${this.namespace}#` : "";
  }

  /** Is this attribute map one of the instrument's own rows (fence sentinel or fault placeholder)? */
  private static isInstrumentRow(img: Record<string, unknown> | undefined): boolean {
    return img !== undefined && (FENCE_ATTR in img || FAULT_ATTR in img);
  }

  /** A stream record restricted to the namespace, its partition key stripped; null when it is nobody's effect here. */
  private scopeStreamRecord(r: StreamImageRecord): StreamImageRecord | null {
    if (this.namespace === undefined) return r;
    const pre = this.prefix();
    const keyValue = (r.dynamodb?.Keys?.[this.hashKey] as { S?: string } | undefined)?.S;
    if (keyValue === undefined || !keyValue.startsWith(pre)) return null;
    const strip = (img: Record<string, unknown>): Record<string, unknown> => {
      const v = img[this.hashKey] as { S?: string } | undefined;
      return v?.S !== undefined ? { ...img, [this.hashKey]: { S: v.S.slice(pre.length) } } : img;
    };
    const d = r.dynamodb ?? {};
    return {
      ...r,
      dynamodb: {
        ...d,
        ...(d.Keys !== undefined ? { Keys: strip(d.Keys) } : {}),
        ...(d.NewImage !== undefined ? { NewImage: strip(d.NewImage) } : {}),
        ...(d.OldImage !== undefined ? { OldImage: strip(d.OldImage) } : {}),
      },
    };
  }

  /** An item as stored -> the item as the spec names it (prefix stripped); null for the instrument's rows. */
  private scopeItem(item: Record<string, AttributeValue>): Record<string, AttributeValue> | null {
    if (DynamoAdapter.isInstrumentRow(item)) return null;
    const pre = this.prefix();
    if (pre === "") return item;
    const v = item[this.hashKey];
    if (v?.S === undefined || !v.S.startsWith(pre)) return null;
    return { ...item, [this.hashKey]: { S: v.S.slice(pre.length) } };
  }

  private canonicalKey(item: Record<string, AttributeValue>): string {
    const keyObj = unmarshall(
      Object.fromEntries(Object.entries(item).filter(([k]) => k === this.hashKey || k === this.rangeKey)),
    );
    return Object.keys(keyObj)
      .sort()
      .map((k) => `${k}=${String(keyObj[k])}`)
      .join("|");
  }

  /** Every stored item of the namespace (or of the table, with no namespace), read consistently, as stored. */
  private async scanStored(): Promise<Record<string, AttributeValue>[]> {
    const { ddb } = this.clients();
    const out: Record<string, AttributeValue>[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await ddb.send(
        new ScanCommand({
          TableName: this.table,
          ConsistentRead: true,
          ExclusiveStartKey: startKey,
          ...(this.namespace !== undefined
            ? {
                FilterExpression: "begins_with(#h, :p)",
                ExpressionAttributeNames: { "#h": this.hashKey },
                ExpressionAttributeValues: { ":p": { S: this.prefix() } },
              }
            : {}),
        }),
      );
      out.push(...(resp.Items ?? []));
      startKey = resp.LastEvaluatedKey;
    } while (startKey);
    return out;
  }

  private async snapshot(): Promise<Map<string, SnapshotItem>> {
    const map = new Map<string, SnapshotItem>();
    for (const stored of await this.scanStored()) {
      const item = this.scopeItem(stored);
      if (item === null) continue;
      const payload = unmarshall(item);
      map.set(this.canonicalKey(item), { payload, signature: stableStringify(payload) });
    }
    return map;
  }

  private async diffSnapshot(): Promise<CapturedRecord[]> {
    const before = this.baseline;
    if (before === null) return [];
    const now = await this.snapshot();
    const at = Date.now();
    const rows: CapturedRecord[] = [];
    for (const [key, item] of now) {
      const old = before.get(key);
      if (old === undefined) rows.push({ type: "INSERT", key, payload: item.payload, timestamp: at });
      else if (old.signature !== item.signature) rows.push({ type: "MODIFY", key, payload: item.payload, timestamp: at });
    }
    for (const [key, item] of before) if (!now.has(key)) rows.push({ type: "REMOVE", key, payload: item.payload, timestamp: at });
    rows.sort((a, b) => (a.key! < b.key! ? -1 : a.key! > b.key! ? 1 : 0));
    return rows;
  }

  private async clearNamespace(): Promise<void> {
    const { ddb } = this.clients();
    for (const stored of await this.scanStored()) {
      const Key = Object.fromEntries(Object.entries(stored).filter(([k]) => k === this.hashKey || k === this.rangeKey));
      await ddb.send(new DeleteItemCommand({ TableName: this.table, Key }));
    }
  }

  async teardown(): Promise<void> {
    if (this.proxy !== null) {
      await this.proxy.close().catch(() => {});
      this.proxy = null;
    }
    this.ddb?.destroy();
    this.streams?.destroy();
    this.ddb = null;
    this.streams = null;
    if (this.container) {
      try {
        await execFile("docker", ["rm", "-f", this.container]);
      } catch {
        // best-effort: --rm cleans up if the daemon already reaped it
      }
      this.container = null;
    }
    for (const { name, prior } of this.exposedEnv) {
      if (prior === undefined) delete process.env[name];
      else process.env[name] = prior;
    }
    this.exposedEnv = [];
  }

  async reset(): Promise<void> {
    this.iterators = null;
    this.baseline = null;
    this.captured = [];
    // A namespace owns its items: every case starts from none of them (fault placeholders included).
    if (this.namespace !== undefined && this.ddb !== null) await this.clearNamespace();
    if (this.proxy !== null) await this.proxy.disarm();
  }

  async startCapture(): Promise<void> {
    if (this.snapshotMode) {
      this.baseline = await this.snapshot();
      this.captured = [];
      return;
    }
    if (!this.streamArn) throw new Error("Adapter used before setup() — configuration error.");
    const { streams } = this.clients();
    const desc = await streams.send(new DescribeStreamCommand({ StreamArn: this.streamArn }));
    const shards = desc.StreamDescription?.Shards ?? [];
    const iterators: string[] = [];
    for (const shard of shards) {
      // LATEST pins the window open at "now" per shard; closed shards simply
      // drain empty. New shards created mid-window are outside it (windows are
      // test-scale — seconds, not hours).
      const it = await streams.send(
        new GetShardIteratorCommand({
          StreamArn: this.streamArn,
          ShardId: shard.ShardId!,
          ShardIteratorType: "LATEST",
        }),
      );
      if (it.ShardIterator) iterators.push(it.ShardIterator);
    }
    this.iterators = iterators;
    this.captured = []; // a fresh window never inherits a stale accumulation
  }

  /** One accumulating drain pass: records land in this.captured and the
   * shard iterators advance in place, so repeated peeks and the final stop
   * see each record exactly once (ADR-0020). */
  private async drainOnce(): Promise<void> {
    if (!this.iterators) return;
    const { streams } = this.clients();
    for (let s = 0; s < this.iterators.length; s++) {
      let iterator: string | undefined = this.iterators[s];
      let emptyBatches = 0;
      for (let i = 0; i < 25 && emptyBatches < 2 && iterator; i++) {
        const resp = await streams.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 1000 }));
        const records = resp.Records ?? [];
        for (const r of records) {
          // A fence sentinel (ADR-0021) is the instrument's own mark, never the system's effect.
          if (isFenceRecord(r as StreamImageRecord)) {
            this.fenceSeen.add(fenceToken(r as StreamImageRecord));
            continue;
          }
          if (DynamoAdapter.isInstrumentRow(fenceImage(r as StreamImageRecord))) continue; // a fault placeholder
          const scoped = this.scopeStreamRecord(r as StreamImageRecord);
          if (scoped === null) continue; // nobody's effect in this namespace
          this.captured.push(mapStreamRecord(scoped));
        }
        if (records.length === 0) emptyBatches++;
        else emptyBatches = 0;
        iterator = resp.NextShardIterator ?? undefined;
      }
      if (iterator) this.iterators[s] = iterator;
    }
  }

  private fenceSeen = new Set<string>();

  /**
   * ADR-0021: prove the capture has caught up. A sentinel row is written AFTER every write the
   * system has made (the harness calls this once the stimulus has returned); on a single ordered
   * stream, the sentinel's arrival means everything before it has arrived too. Declines (false)
   * when the fence is off, the stream has more than one open shard, or the key schema is not
   * string-keyed — the harness then keeps the ceiling, exactly as before.
   */
  async settle(): Promise<boolean> {
    // Snapshot diff: a consistent read of the base table sees every acknowledged write (SPEC-ADPDDB-001).
    if (this.snapshotMode) return this.baseline !== null;
    if (!this.opts.fence || !this.iterators) return false;
    if (this.iterators.length !== 1) return false;
    if (this.keySchema.length === 0 || this.keySchema.some((k) => k.type !== "S")) return false;
    // Let any write the system queued but has not yet issued leave the event loop first.
    await new Promise((r) => setImmediate(r));
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const item: Record<string, AttributeValue> = { [FENCE_ATTR]: { S: token } };
    for (const k of this.keySchema) item[k.name] = { S: `${FENCE_ATTR}#${token}` };
    const { ddb } = this.clients();
    await ddb.send(new PutItemCommand({ TableName: this.table, Item: item }));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && this.iterators) {
      await this.drainOnce();
      if (this.fenceSeen.has(token)) {
        this.fenceSeen.delete(token);
        return true;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  /** ADR-0020: the harness's early-exit window peeks without consuming. */
  async peekCapture(): Promise<CapturedRecord[]> {
    if (this.snapshotMode) return this.diffSnapshot();
    if (!this.iterators) return [...this.captured];
    await this.drainOnce();
    return [...this.captured];
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    if (this.snapshotMode) {
      const rows = await this.diffSnapshot();
      this.baseline = null;
      return rows;
    }
    if (!this.iterators) return [];
    await this.drainOnce();
    this.iterators = null;
    const out = [...this.captured];
    this.captured = [];
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  /**
   * SPEC-ADPDDB-001: a full primary key given as literals -> GetItem, the partition key alone -> Query, anything else
   * (or no hint) -> a Scan of the namespace; every read consistent. The hint may return a superset, never fewer.
   */
  async read(query: ReadQuery): Promise<unknown | null> {
    const { ddb } = this.clients();
    const pre = this.prefix();
    const typeOf = (name: string) => this.keySchema.find((k) => k.name === name)?.type ?? "S";
    const keyAttr = (name: string, v: unknown): AttributeValue =>
      typeOf(name) === "N" ? { N: String(v) } : { S: name === this.hashKey ? `${pre}${String(v)}` : String(v) };
    const given = (key: Record<string, unknown> | undefined, name: string | null): boolean =>
      name !== null && key !== undefined && key[name] !== undefined && key[name] !== null;
    const expect = query?.expect ?? [];
    const plans = expect.map((e) =>
      !given(e.key, this.hashKey) ? "Scan" : this.rangeKey === null || given(e.key, this.rangeKey) ? "GetItem" : "Query",
    );
    const stored: Record<string, AttributeValue>[] = [];
    if (expect.length === 0 || plans.includes("Scan")) {
      this.lastReadVia = "Scan";
      stored.push(...(await this.scanStored()));
    } else {
      this.lastReadVia = plans.includes("Query") ? "Query" : "GetItem";
      for (let n = 0; n < expect.length; n++) {
        const key = expect[n]!.key as Record<string, unknown>;
        if (plans[n] === "GetItem") {
          const Key: Record<string, AttributeValue> = { [this.hashKey]: keyAttr(this.hashKey, key[this.hashKey]) };
          if (this.rangeKey !== null) Key[this.rangeKey] = keyAttr(this.rangeKey, key[this.rangeKey]);
          const got = await ddb.send(new GetItemCommand({ TableName: this.table, Key, ConsistentRead: true }));
          if (got.Item) stored.push(got.Item);
        } else {
          let startKey: Record<string, AttributeValue> | undefined;
          do {
            const resp = await ddb.send(
              new QueryCommand({
                TableName: this.table,
                ConsistentRead: true,
                KeyConditionExpression: "#h = :h",
                ExpressionAttributeNames: { "#h": this.hashKey },
                ExpressionAttributeValues: { ":h": keyAttr(this.hashKey, key[this.hashKey]) },
                ExclusiveStartKey: startKey,
              }),
            );
            stored.push(...(resp.Items ?? []));
            startKey = resp.LastEvaluatedKey;
          } while (startKey);
        }
      }
    }
    const seen = new Set<string>();
    const items: CapturedRecord[] = [];
    for (const raw of stored) {
      const item = this.scopeItem(raw); // the fence and fault rows are the instrument's, never the system's state
      if (item === null) continue;
      const id = this.keySchema.length > 0 ? this.canonicalKey(item) : JSON.stringify(item);
      if (seen.has(id)) continue;
      seen.add(id);
      items.push({ type: "ITEM", payload: unmarshall(item), timestamp: 0 });
    }
    return items;
  }

  async seed(records: SeedRecord[]): Promise<void> {
    const { ddb } = this.clients();
    const pre = this.prefix();
    for (const r of records) {
      try {
        const values = { ...r.values };
        const k = values[this.hashKey];
        if (pre !== "" && typeof k === "string") values[this.hashKey] = `${pre}${k}`;
        await ddb.send(new PutItemCommand({ TableName: this.table, Item: marshall(values) }));
      } catch (e) {
        throw new Error(
          `@mmmnt/feat-adapter-dynamodb: seeding '${r.type}' failed (${(e as Error).message}) — ` +
            "seed values must include the table's key attributes — configuration error.",
        );
      }
    }
  }

  /**
   * SPEC-ADPDDB-001/002. PutItem.CONDITIONAL_CHECK_FAILED {pk, sk}: an instrument item at the key, so DynamoDB itself
   * refuses the system's attribute_not_exists put. Connection.*: the shared fault-proxy library, on the system's path
   * only. Both until reset; nothing reports a refusal, so there is no firedFaults.
   */
  async fault(arm: FaultArm): Promise<void> {
    const entry = Object.hasOwn(this.faults, arm.operation)
      ? (this.faults[arm.operation] as Record<string, readonly string[]>)
      : undefined;
    const counts = entry !== undefined && Object.hasOwn(entry, arm.fault) ? entry[arm.fault] : undefined;
    const offered = Object.entries(this.faults).flatMap(([op, f]) => Object.keys(f).map((n) => `${op}.${n}`));
    if (counts === undefined)
      throw new DynamoAdapterError("FAULT_UNSUPPORTED", `the fault '${arm.operation}.${arm.fault}' is not in the catalog (${offered.join(", ")})`);
    if (arm.times !== "reset")
      throw new DynamoAdapterError(
        "FAULT_UNSUPPORTED",
        `the fault '${arm.operation}.${arm.fault}' declares only until reset, not ${arm.times === 1 ? "once" : `times ${arm.times}`}`,
      );
    if (arm.operation === "Connection") {
      // Timeout drops the request on its way up, so the product never applies it: the write is absent and provably so.
      await this.proxy!.arm(arm.fault, arm.fault === "Timeout" ? { stream: "upstream" } : {});
      return;
    }
    const { ddb } = this.clients();
    const pk = arm.detail?.pk;
    const sk = arm.detail?.sk;
    if (typeof pk !== "string" || (this.rangeKey !== null && typeof sk !== "string"))
      throw new DynamoAdapterError("FAULT_UNSUPPORTED", `the fault '${arm.operation}.${arm.fault}' needs a detail { pk, sk } of strings`);
    const item: Record<string, AttributeValue> = {
      [this.hashKey]: { S: `${this.prefix()}${pk}` },
      [FAULT_ATTR]: { S: "1" },
    };
    if (this.rangeKey !== null) item[this.rangeKey] = this.keySchema.find((k) => k.name === this.rangeKey)?.type === "N" ? { N: String(sk) } : { S: String(sk) };
    try {
      // Never over a real item: when the key is taken the system's own conditional put is refused anyway.
      await ddb.send(
        new PutItemCommand({
          TableName: this.table,
          Item: item,
          ConditionExpression: "attribute_not_exists(#h)",
          ExpressionAttributeNames: { "#h": this.hashKey },
        }),
      );
    } catch (e) {
      if ((e as Error).name !== "ConditionalCheckFailedException") throw e;
    }
  }
}

/** One item of a snapshot: the unmarshalled payload (namespace stripped) and a stable signature to compare. */
interface SnapshotItem {
  payload: Record<string, unknown>;
  signature: string;
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v instanceof Set) return `set(${[...v].map(stableStringify).sort().join(",")})`;
  if (v !== null && typeof v === "object" && !(v instanceof Uint8Array))
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return typeof v === "bigint" ? `${v}n` : JSON.stringify(v) ?? String(v);
}

/** SPEC-ADPDDB-001: the attribute that marks a fault placeholder row (the instrument's, never the system's). */
export const FAULT_ATTR = "__feat_fault";

/** ADR-0021: the attribute that marks a fence sentinel row. */
export const FENCE_ATTR = "__feat_fence";

function fenceImage(r: StreamImageRecord): Record<string, AttributeValue> | undefined {
  const d = (r as { dynamodb?: { NewImage?: Record<string, AttributeValue>; OldImage?: Record<string, AttributeValue> } }).dynamodb;
  return d?.NewImage ?? d?.OldImage;
}
export function isFenceRecord(r: StreamImageRecord): boolean {
  const img = fenceImage(r);
  return Boolean(img && FENCE_ATTR in img);
}
function fenceToken(r: StreamImageRecord): string {
  const v = fenceImage(r)?.[FENCE_ATTR] as { S?: string } | undefined;
  return String(v?.S ?? "");
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new DynamoAdapter(config as DynamoAdapterConfig);
}
