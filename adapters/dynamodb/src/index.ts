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
import type { CapturedRecord, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";

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
  };
}

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
  private container: string | null = null;
  private exposedEnv: { name: string; prior: string | undefined }[] = [];

  constructor(config: DynamoAdapterConfig) {
    this.opts = config.options ?? {};
    const { table, tableEnv, endpoint, endpointEnv, auth, ephemeral } = this.opts;
    if (ephemeral) {
      if (table || tableEnv || endpoint || endpointEnv || auth)
        throw new Error(
          "@mmmnt/feat-adapter-dynamodb: options.ephemeral is mutually exclusive with table/tableEnv/endpoint/auth " +
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
    if (!arn || !enabled)
      throw new Error(
        `@mmmnt/feat-adapter-dynamodb: table '${this.table}' has no active stream — enable Streams ` +
          "(StreamViewType NEW_AND_OLD_IMAGES) so writes are observable — configuration error.",
      );
    if (view === "KEYS_ONLY")
      throw new Error(
        `@mmmnt/feat-adapter-dynamodb: table '${this.table}' stream is KEYS_ONLY — predictions need images; ` +
          "use NEW_AND_OLD_IMAGES (or NEW_IMAGE) — configuration error.",
      );
    this.streamArn = arn;
  }

  async teardown(): Promise<void> {
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
  }

  async startCapture(): Promise<void> {
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
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    if (!this.iterators) return [];
    const { streams } = this.clients();
    const out: CapturedRecord[] = [];
    for (let iterator of this.iterators) {
      let emptyBatches = 0;
      for (let i = 0; i < 25 && emptyBatches < 2; i++) {
        const resp = await streams.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 1000 }));
        const records = resp.Records ?? [];
        for (const r of records) out.push(mapStreamRecord(r as StreamImageRecord));
        if (records.length === 0) emptyBatches++;
        else emptyBatches = 0;
        if (!resp.NextShardIterator) break;
        iterator = resp.NextShardIterator;
      }
    }
    this.iterators = null;
    out.sort((a, b) => a.timestamp - b.timestamp);
    return out;
  }

  async read(_query: Record<string, unknown>): Promise<unknown | null> {
    const { ddb } = this.clients();
    const items: CapturedRecord[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await ddb.send(new ScanCommand({ TableName: this.table, ExclusiveStartKey: startKey }));
      for (const item of resp.Items ?? []) {
        items.push({ type: "ITEM", payload: unmarshall(item), timestamp: 0 });
      }
      startKey = resp.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  async seed(records: SeedRecord[]): Promise<void> {
    const { ddb } = this.clients();
    for (const r of records) {
      try {
        await ddb.send(new PutItemCommand({ TableName: this.table, Item: marshall(r.values) }));
      } catch (e) {
        throw new Error(
          `@mmmnt/feat-adapter-dynamodb: seeding '${r.type}' failed (${(e as Error).message}) — ` +
            "seed values must include the table's key attributes — configuration error.",
        );
      }
    }
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new DynamoAdapter(config as DynamoAdapterConfig);
}
