// @mmmnt/feat-adapter-dynamodb — a DynamoDB table becomes a capture window via
// DynamoDB Streams CDC. startCapture pins LATEST shard iterators; stopCapture
// drains the stream — every write in the window becomes a CapturedRecord
// {type: INSERT|MODIFY|REMOVE, key, payload}, so an unpredicted table write
// fails the suite by prediction inversion.
//
// The table must have Streams enabled (StreamViewType NEW_AND_OLD_IMAGES, or
// NEW_IMAGE); a table without a stream is a configuration error at setup().
// Declare the service `eventual` with a convergenceTimeout — stream delivery
// lags the writes that cause it. Credentials come from the standard AWS chain
// (never from config); `endpoint` points the adapter at DynamoDB Local.
// AWS SDK v3 clients are real dependencies: DynamoDB requires SigV4 signing,
// which is not reasonably hand-rolled the way a bearer-token REST surface is.
import {
  DynamoDBClient,
  DescribeTableCommand,
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
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { CapturedRecord, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";

interface DynamoAdapterConfig {
  options?: {
    /** Table name, literally. Exactly one of `table` / `tableEnv` is required. */
    table?: string;
    /** Env var holding the table name (per-environment deploys). */
    tableEnv?: string;
    /** AWS region; defaults to the SDK chain (AWS_REGION). */
    region?: string;
    /** API origin override — DynamoDB Local (e.g. http://127.0.0.1:8000). */
    endpoint?: string;
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

class DynamoAdapter implements FeatServiceAdapter {
  private readonly table: string;
  private readonly ddb: DynamoDBClient;
  private readonly streams: DynamoDBStreamsClient;
  private streamArn: string | null = null;
  private iterators: string[] | null = null;

  constructor(config: DynamoAdapterConfig) {
    const opts = config.options ?? {};
    const fromEnv = opts.tableEnv ? process.env[opts.tableEnv] : undefined;
    const table = opts.table ?? fromEnv;
    if (!table)
      throw new Error(
        "@mmmnt/feat-adapter-dynamodb: no table name — set options.table or options.tableEnv (env var unset?) — configuration error.",
      );
    this.table = table;
    const clientOpts: Record<string, unknown> = {};
    if (opts.region) clientOpts.region = opts.region;
    if (opts.endpoint) clientOpts.endpoint = opts.endpoint;
    this.ddb = new DynamoDBClient(clientOpts);
    this.streams = new DynamoDBStreamsClient(clientOpts);
  }

  async setup(): Promise<void> {
    const out = await this.ddb.send(new DescribeTableCommand({ TableName: this.table }));
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
    this.ddb.destroy();
    this.streams.destroy();
  }

  async reset(): Promise<void> {
    this.iterators = null;
  }

  async startCapture(): Promise<void> {
    if (!this.streamArn) throw new Error("Adapter used before setup() — configuration error.");
    const desc = await this.streams.send(new DescribeStreamCommand({ StreamArn: this.streamArn }));
    const shards = desc.StreamDescription?.Shards ?? [];
    const iterators: string[] = [];
    for (const shard of shards) {
      // LATEST pins the window open at "now" per shard; closed shards simply
      // drain empty. New shards created mid-window are outside it (windows are
      // test-scale — seconds, not hours).
      const it = await this.streams.send(
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
    const out: CapturedRecord[] = [];
    for (let iterator of this.iterators) {
      let emptyBatches = 0;
      for (let i = 0; i < 25 && emptyBatches < 2; i++) {
        const resp = await this.streams.send(
          new GetRecordsCommand({ ShardIterator: iterator, Limit: 1000 }),
        );
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
    const items: CapturedRecord[] = [];
    let startKey: Record<string, AttributeValue> | undefined;
    do {
      const resp = await this.ddb.send(
        new ScanCommand({ TableName: this.table, ExclusiveStartKey: startKey }),
      );
      for (const item of resp.Items ?? []) {
        items.push({ type: "ITEM", payload: unmarshall(item), timestamp: 0 });
      }
      startKey = resp.LastEvaluatedKey;
    } while (startKey);
    return items;
  }

  async seed(records: SeedRecord[]): Promise<void> {
    for (const r of records) {
      try {
        await this.ddb.send(
          new PutItemCommand({ TableName: this.table, Item: marshall(r.values) }),
        );
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
