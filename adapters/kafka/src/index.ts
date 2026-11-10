// @mmmnt/feat-adapter-kafka (SPEC-ADPKFK-001, -002, -003) — Kafka as a Feat service.
//
// The log is the change feed. A record's offset orders it within its partition, and nothing orders records of
// different partitions. A window starts at each namespaced partition's last stable offset (the READ_COMMITTED end);
// a consumer that is assigned by hand (no group join, no commit) and reads at read_committed never sees the records
// of an aborted transaction or a transaction marker. That is also the whole of settle: an open transaction holds the
// last stable offset below the high watermark, so while the two differ somewhere the adapter cannot see an effect
// that may still commit, and it declines; otherwise it consumes to the last stable offset and vouches. Nothing is
// written to the product by the observation.
//
// The adapter's own (instrument) clients are connected to the brokers directly and never through a proxy; transport
// faults (Connection.*) are armed on a Toxiproxy proxy in front of the SYSTEM's path through
// @mmmnt/feat-fault-proxy (SPEC-FPX-001).
//
// Logical faults are made by creating the topic the fault names: MESSAGE_TOO_LARGE with a small max.message.bytes,
// NOT_ENOUGH_REPLICAS with replication factor 2 and min.insync.replicas 2. The topic answers NOT_ENOUGH_REPLICAS to an
// acks=all producer while fewer than two replicas are in sync; bringing that about on the cluster (a second broker
// that is down) is the cluster's affair, not the adapter's (founder ruling 2026-11-09, Kafka two-broker B).

import { KafkaJS, RdKafka } from "@confluentinc/kafka-javascript";
import { createFaultProxy } from "@mmmnt/feat-fault-proxy";
import type { FaultProxy, OpenProxy } from "@mmmnt/feat-fault-proxy";
import type {
  CapturedRecord,
  FaultArm,
  FaultCatalog,
  FeatServiceAdapter,
  ReadQuery,
  SeedRecord,
} from "@mmmnt/feat-types";

export type KafkaAdapterErrorCode =
  | "NAMESPACE_INVALID"
  | "BROKER_UNREACHABLE"
  | "FAULT_TARGET_EXISTS"
  | "FAULT_UNSUPPORTED";

export class KafkaAdapterError extends Error {
  constructor(
    readonly code: KafkaAdapterErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "KafkaAdapterError";
  }
}

export interface KafkaProxyOptions {
  /** Toxiproxy API base URL. */
  api: string;
  /** host:port of the broker's proxied listener as Toxiproxy reaches it (it can differ from the instrument's address). */
  upstream: string;
  /** The product label of the proxy name `feat-<ns>-<name>`. Default "kafka". */
  name?: string;
  /** The product's container, for BrokerLoss. Without it BrokerLoss is not in the catalog. */
  container?: string;
  metrics?: string;
  runtime?: string;
}

export interface KafkaAuthOptions {
  mechanism: "plain" | "scram-sha-256" | "scram-sha-512";
  /** Name of the environment variable holding the user name. */
  username: string;
  /** Name of the environment variable holding the password. */
  password: string;
  /** TLS to the brokers. Default true. */
  ssl?: boolean;
}

export interface KafkaOptions {
  /** Comma-separated host:port list. */
  bootstrapServers?: string;
  /** Name of the environment variable holding the bootstrap servers. */
  bootstrapServersEnv?: string;
  auth?: KafkaAuthOptions;
  settleTimeoutMs?: number;
  proxy?: KafkaProxyOptions;
}

interface KafkaConfig {
  key?: string;
  namespace?: string;
  options?: KafkaOptions;
}

const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;
/** The ceiling of one request to the brokers (an admin call, a connect, a wait for a topic to appear or go). */
const REQUEST_TIMEOUT_MS = 5000;
/** The ceiling of a request that changes the cluster (create or delete topics, truncate): the controller answers after it committed. */
const CHANGE_TIMEOUT_MS = 30_000;
const POLL_MS = 50;
const CONSUME_POLL_MS = 100;
const BATCH = 500;
const MESSAGE_TOO_LARGE_BYTES = "1024";
const FAULT_REPLICATION_FACTOR = 2;
const FAULT_MIN_INSYNC_REPLICAS = "2";
const READ_UNCOMMITTED = KafkaJS.IsolationLevel.READ_UNCOMMITTED;
const READ_COMMITTED = KafkaJS.IsolationLevel.READ_COMMITTED;

type Count = "once" | "times" | "reset";

interface PartitionEnds {
  topic: string;
  partition: number;
  low: bigint;
  high: bigint;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject after `ms` so a call into a broker that no longer answers (a paused container) cannot hang the harness. */
function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const keyOf = (topic: string, partition: number): string => `${topic}\u0000${partition}`;

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function decode(value: Buffer | null): Record<string, unknown> {
  if (value === null) return {};
  const text = value.toString("utf8");
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { value: text };
  }
}

function headersOf(headers: RdKafka.MessageHeader[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    for (const [k, v] of Object.entries(h)) out[k] = Buffer.isBuffer(v) ? v.toString("utf8") : String(v);
  }
  return out;
}

class KafkaAdapter implements FeatServiceAdapter {
  readonly observes = { diff: "native", state: true } as const;
  readonly faults: FaultCatalog;

  private readonly namespace: string;
  private readonly options: KafkaOptions;
  private readonly settleTimeoutMs: number;
  private kafka: InstanceType<typeof KafkaJS.Kafka> | undefined;
  private adminClient: KafkaJS.Admin | undefined;
  private producerClient: ReturnType<InstanceType<typeof KafkaJS.Kafka>["producer"]> | undefined;
  private consumerClient: RdKafka.KafkaConsumer | undefined;
  private proxy: FaultProxy | undefined;
  private opened: OpenProxy | undefined;

  /** The window: per partition the exclusive cursor, and what has been captured since. */
  private cursor = new Map<string, bigint>();
  private captured: CapturedRecord[] = [];
  private windowOpen = false;
  /** Topics a fault created: reset deletes exactly these. */
  private readonly faultTopics = new Set<string>();

  constructor(config: KafkaConfig) {
    const ns = config.namespace;
    if (typeof ns !== "string" || !NAMESPACE_PATTERN.test(ns)) {
      throw new KafkaAdapterError(
        "NAMESPACE_INVALID",
        `'${String(ns)}' does not match ${NAMESPACE_PATTERN.source}, the pattern the runner derives`,
      );
    }
    this.namespace = ns;
    this.options = config.options ?? {};
    this.settleTimeoutMs = this.options.settleTimeoutMs ?? 5000;

    const catalog: Record<string, Record<string, readonly Count[]>> = {
      Produce: { MESSAGE_TOO_LARGE: ["reset"], NOT_ENOUGH_REPLICAS: ["reset"] },
    };
    const proxy = this.options.proxy;
    if (proxy !== undefined) {
      this.proxy = createFaultProxy({
        api: proxy.api,
        product: proxy.name ?? "kafka",
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
  private full(topic: string): string {
    return `${this.prefix}${topic}`;
  }
  private relative(topic: string): string {
    return topic.slice(this.prefix.length);
  }

  // ── the instrument connection ─────────────────────────────────────────────

  private bootstrap(): string {
    const o = this.options;
    const raw = o.bootstrapServers ?? (o.bootstrapServersEnv !== undefined ? process.env[o.bootstrapServersEnv] : undefined);
    if (raw === undefined || raw === "") {
      throw new Error("the kafka service has no bootstrapServers (or bootstrapServersEnv naming a set variable)");
    }
    return raw;
  }

  private describeBootstrap(): string {
    try {
      return this.bootstrap();
    } catch (e) {
      return describe(e);
    }
  }

  private credentials(): { username: string; password: string } | undefined {
    const auth = this.options.auth;
    if (auth === undefined) return undefined;
    const username = process.env[auth.username];
    const password = process.env[auth.password];
    if (username === undefined || password === undefined) {
      throw new Error(`options.auth names the variables ${auth.username} and ${auth.password}, which are not both set`);
    }
    return { username, password };
  }

  /** The librdkafka properties every client of the instrument shares. */
  private clientConf(): Record<string, string> {
    const conf: Record<string, string> = { "bootstrap.servers": this.bootstrap() };
    const auth = this.options.auth;
    const credentials = this.credentials();
    if (auth !== undefined && credentials !== undefined) {
      conf["security.protocol"] = auth.ssl === false ? "sasl_plaintext" : "sasl_ssl";
      conf["sasl.mechanism"] = auth.mechanism === "plain" ? "PLAIN" : auth.mechanism === "scram-sha-256" ? "SCRAM-SHA-256" : "SCRAM-SHA-512";
      conf["sasl.username"] = credentials.username;
      conf["sasl.password"] = credentials.password;
    }
    return conf;
  }

  private client(): InstanceType<typeof KafkaJS.Kafka> {
    if (this.kafka === undefined) {
      this.kafka = new KafkaJS.Kafka({ ...this.clientConf(), kafkaJS: { logLevel: KafkaJS.logLevel.NOTHING } } as never);
    }
    return this.kafka;
  }

  private async admin(): Promise<KafkaJS.Admin> {
    if (this.adminClient === undefined) {
      const admin = this.client().admin();
      await admin.connect();
      this.adminClient = admin;
    }
    return this.adminClient;
  }

  async setup(): Promise<void> {
    try {
      const admin = await this.admin();
      await admin.listTopics({ timeout: REQUEST_TIMEOUT_MS });
    } catch (e) {
      this.discard();
      throw new KafkaAdapterError(
        "BROKER_UNREACHABLE",
        `no bootstrap server answered within ${REQUEST_TIMEOUT_MS} ms (${this.describeBootstrap()}): ${describe(e)}`,
      );
    }
    if (this.proxy !== undefined) this.opened = await this.proxy.open();
  }

  /** Drop the clients without waiting for brokers that may not answer; the next call builds new ones. */
  private discard(): void {
    const admin = this.adminClient;
    const producer = this.producerClient;
    const consumer = this.consumerClient;
    this.adminClient = undefined;
    this.producerClient = undefined;
    this.consumerClient = undefined;
    this.kafka = undefined;
    if (admin !== undefined) void admin.disconnect().catch(() => {});
    if (producer !== undefined) void producer.disconnect().catch(() => {});
    if (consumer !== undefined) {
      try {
        consumer.disconnect(() => {});
      } catch {
        /* nothing to close */
      }
    }
  }

  async teardown(): Promise<void> {
    this.windowOpen = false;
    this.cursor = new Map();
    this.captured = [];
    try {
      if (this.proxy !== undefined) await this.proxy.close();
    } finally {
      this.opened = undefined;
      this.discard();
    }
  }

  // ── offsets ───────────────────────────────────────────────────────────────

  /** The topics of the namespace, in name order. */
  private async namespacedTopics(): Promise<string[]> {
    const admin = await this.admin();
    const all = await admin.listTopics({ timeout: REQUEST_TIMEOUT_MS });
    return all.filter((t) => t.startsWith(this.prefix)).sort();
  }

  private async ends(topics: string[], level: number): Promise<PartitionEnds[]> {
    const admin = await this.admin();
    const out: PartitionEnds[] = [];
    for (const topic of topics) {
      let rows: Awaited<ReturnType<KafkaJS.Admin["fetchTopicOffsets"]>>;
      try {
        rows = await admin.fetchTopicOffsets(topic, { isolationLevel: level, timeout: REQUEST_TIMEOUT_MS } as never);
      } catch (e) {
        if (await this.vanished(topic)) continue;
        throw e;
      }
      for (const row of [...rows].sort((a, b) => a.partition - b.partition)) {
        out.push({ topic, partition: row.partition, low: BigInt(row.low), high: BigInt(row.high) });
      }
    }
    return out;
  }

  /** A topic that was listed and then deleted (a reset of another host) is not an error of the observation. */
  private async vanished(topic: string): Promise<boolean> {
    const admin = await this.admin();
    return !(await admin.listTopics({ timeout: REQUEST_TIMEOUT_MS })).includes(topic);
  }

  // ── consuming ─────────────────────────────────────────────────────────────

  private async consumer(): Promise<RdKafka.KafkaConsumer> {
    if (this.consumerClient !== undefined) return this.consumerClient;
    const consumer = new RdKafka.KafkaConsumer(
      {
        ...this.clientConf(),
        "group.id": `feat-${this.namespace}`,
        "enable.auto.commit": false,
        "isolation.level": "read_committed",
      },
      { "auto.offset.reset": "earliest" },
    );
    await new Promise<void>((resolve, reject) => {
      consumer.connect({}, (err) => (err ? reject(err) : resolve()));
    });
    consumer.setDefaultConsumeTimeout(CONSUME_POLL_MS);
    this.consumerClient = consumer;
    return consumer;
  }

  /**
   * Consume every listed partition from `from` to `to` (exclusive) at read_committed and return the records in
   * (topic, partition, offset) order. A partition is done when the consumer's position reaches `to`: the position moves
   * past the transaction markers and the records of aborted transactions, which are never delivered.
   */
  private async consumeRanges(ranges: { topic: string; partition: number; from: bigint; to: bigint }[], ms: number): Promise<CapturedRecord[]> {
    const live = ranges.filter((r) => r.from < r.to);
    if (live.length === 0) return [];
    const deadline = Date.now() + ms;
    const consumer = await this.consumer();
    const wanted = new Map(live.map((r) => [keyOf(r.topic, r.partition), r]));
    const found: { topic: string; partition: number; offset: number; record: CapturedRecord }[] = [];
    try {
      consumer.assign(live.map((r) => ({ topic: r.topic, partition: r.partition, offset: Number(r.from) })));
      for (;;) {
        const position = new Map(consumer.position().map((p) => [keyOf(p.topic, p.partition), p.offset]));
        const pending = live.filter((r) => BigInt(position.get(keyOf(r.topic, r.partition)) ?? -1) < r.to);
        if (pending.length === 0) break;
        if (Date.now() >= deadline) throw new Error(`could not consume to the last stable offset within ${ms} ms`);
        const messages = await new Promise<RdKafka.Message[]>((resolve, reject) => {
          consumer.consume(BATCH, (err, ms2) => (err ? reject(err) : resolve(ms2)));
        });
        for (const m of messages) {
          const range = wanted.get(keyOf(m.topic, m.partition));
          if (range === undefined || BigInt(m.offset) >= range.to || BigInt(m.offset) < range.from) continue;
          found.push({
            topic: m.topic,
            partition: m.partition,
            offset: m.offset,
            record: {
              type: this.relative(m.topic),
              key: m.key === null || m.key === undefined ? "" : Buffer.from(m.key as Buffer).toString("utf8"),
              payload: decode(m.value),
              timestamp: m.timestamp ?? 0,
              metadata: { partition: m.partition, offset: m.offset, headers: headersOf(m.headers) },
            },
          });
        }
      }
    } catch (e) {
      // A consumer that failed is not trusted again: the next call builds a new one.
      this.consumerClient = undefined;
      try {
        consumer.disconnect(() => {});
      } catch {
        /* nothing to close */
      }
      throw e;
    }
    return found
      .sort((a, b) => (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : a.partition - b.partition || a.offset - b.offset))
      .map((f) => f.record);
  }

  /** Move the window to `ends` (the READ_COMMITTED end offsets) and keep what was between. */
  private async drain(ends: PartitionEnds[], ms: number): Promise<void> {
    const ranges = ends.map((e) => {
      const at = this.cursor.get(keyOf(e.topic, e.partition));
      // A topic that appears later starts at its low offset; a cursor outside the log (truncated or recreated) restarts there too.
      const from = at === undefined || at < e.low || at > e.high ? e.low : at;
      return { topic: e.topic, partition: e.partition, from, to: e.high };
    });
    const records = await this.consumeRanges(ranges, ms);
    this.captured.push(...records);
    for (const r of ranges) this.cursor.set(keyOf(r.topic, r.partition), r.to);
  }

  // ── the window ────────────────────────────────────────────────────────────

  async startCapture(): Promise<void> {
    const ends = await this.ends(await this.namespacedTopics(), READ_COMMITTED);
    this.cursor = new Map(ends.map((e) => [keyOf(e.topic, e.partition), e.high]));
    this.captured = [];
    this.windowOpen = true;
  }

  private async catchUp(): Promise<void> {
    await this.drain(await this.ends(await this.namespacedTopics(), READ_COMMITTED), REQUEST_TIMEOUT_MS);
  }

  async peekCapture(): Promise<CapturedRecord[]> {
    if (!this.windowOpen) return [];
    await this.catchUp();
    return [...this.captured];
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    if (!this.windowOpen) return [];
    await this.catchUp();
    const records = this.captured;
    this.captured = [];
    this.windowOpen = false;
    this.cursor = new Map();
    return records;
  }

  async settle(): Promise<boolean> {
    if (!this.windowOpen) return false;
    const deadline = Date.now() + this.settleTimeoutMs;
    try {
      while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        const settled = await within(this.settleOnce(remaining), remaining);
        if (settled) return true;
        await sleep(Math.min(POLL_MS, Math.max(deadline - Date.now(), 0)));
      }
      return false;
    } catch {
      return false;
    }
  }

  /** One attempt: true when no transaction is open and the window was consumed to the last stable offset. */
  private async settleOnce(ms: number): Promise<boolean> {
    const topics = await this.namespacedTopics();
    const committed = await this.ends(topics, READ_COMMITTED);
    const uncommitted = await this.ends(topics, READ_UNCOMMITTED);
    const high = new Map(uncommitted.map((e) => [keyOf(e.topic, e.partition), e.high]));
    // An open transaction holds the last stable offset below the high watermark.
    if (committed.some((e) => high.get(keyOf(e.topic, e.partition)) !== e.high)) return false;
    await this.drain(committed, ms);
    return true;
  }

  // ── state ─────────────────────────────────────────────────────────────────

  async read(query: ReadQuery): Promise<unknown | null> {
    const hinted = query.expect?.map((e) => e.type);
    const listed = await this.namespacedTopics();
    const topics =
      hinted !== undefined && hinted.length > 0 && hinted.every((t) => typeof t === "string")
        ? [...new Set(hinted.map((t) => this.full(t)))].filter((t) => listed.includes(t)).sort()
        : listed;
    const ends = await this.ends(topics, READ_COMMITTED);
    return this.consumeRanges(
      ends.map((e) => ({ topic: e.topic, partition: e.partition, from: e.low, to: e.high })),
      REQUEST_TIMEOUT_MS,
    );
  }

  /** Produce each record to `<ns>.<type>` with acks=all and idempotence on; `values.key`, when a string, is the record key. */
  async seed(records: SeedRecord[]): Promise<void> {
    if (this.producerClient === undefined) {
      const producer = this.client().producer({ kafkaJS: { acks: -1, idempotent: true } } as never);
      await producer.connect();
      this.producerClient = producer;
    }
    for (const r of records) {
      const { key, ...payload } = r.values;
      await this.producerClient.send({
        topic: this.full(r.type),
        messages: [{ ...(typeof key === "string" ? { key } : {}), value: JSON.stringify(payload) }],
      });
    }
  }

  // ── faults ────────────────────────────────────────────────────────────────

  async fault(arm: FaultArm): Promise<void> {
    const where = `${arm.operation}.${arm.fault}`;
    const entry = (this.faults[arm.operation] as Record<string, readonly string[]> | undefined)?.[arm.fault];
    if (entry === undefined) {
      throw new KafkaAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' is not in the catalog (${this.describeCatalog()})`);
    }
    if (arm.times !== "reset") {
      const asked = arm.times === 1 ? "once" : `times ${arm.times}`;
      throw new KafkaAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' declares only until reset, not ${asked}`);
    }
    if (arm.operation === "Connection") {
      await this.proxy!.arm(arm.fault);
      return;
    }
    const topic = arm.detail?.topic;
    if (typeof topic !== "string" || topic === "") {
      throw new KafkaAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' needs a detail { topic } naming the topic it applies to`);
    }
    const name = this.full(topic);
    const admin = await this.admin();
    if ((await admin.listTopics({ timeout: REQUEST_TIMEOUT_MS })).includes(name)) {
      throw new KafkaAdapterError("FAULT_TARGET_EXISTS", `the topic '${topic}' (${name}) already exists; a ${where} fault needs it created by the fault`);
    }
    const created = await admin.createTopics({
      timeout: CHANGE_TIMEOUT_MS,
      topics: [
        arm.fault === "MESSAGE_TOO_LARGE"
          ? { topic: name, numPartitions: 1, configEntries: [{ name: "max.message.bytes", value: MESSAGE_TOO_LARGE_BYTES }] }
          : {
              topic: name,
              numPartitions: 1,
              replicationFactor: FAULT_REPLICATION_FACTOR,
              configEntries: [{ name: "min.insync.replicas", value: FAULT_MIN_INSYNC_REPLICAS }],
            },
      ],
    });
    if (!created) {
      throw new KafkaAdapterError("FAULT_TARGET_EXISTS", `the topic '${topic}' (${name}) already exists; a ${where} fault needs it created by the fault`);
    }
    this.faultTopics.add(name);
    // The listing lags the creation: the fault is armed once the topic can be seen.
    await this.waitForListing(name, true);
  }

  private describeCatalog(): string {
    return Object.entries(this.faults)
      .flatMap(([op, faults]) => Object.keys(faults).map((f) => `${op}.${f}`))
      .join(", ");
  }

  private async waitForListing(topic: string, present: boolean): Promise<void> {
    const admin = await this.admin();
    const deadline = Date.now() + CHANGE_TIMEOUT_MS;
    for (;;) {
      const listed = (await admin.listTopics({ timeout: REQUEST_TIMEOUT_MS })).includes(topic);
      if (listed === present) return;
      if (Date.now() >= deadline) throw new Error(`the topic '${topic}' did not ${present ? "appear" : "go"} within ${CHANGE_TIMEOUT_MS} ms`);
      await sleep(POLL_MS);
    }
  }

  async reset(): Promise<void> {
    if (this.proxy !== undefined && this.opened !== undefined) await this.proxy.disarm();
    const admin = await this.admin();
    if (this.faultTopics.size > 0) {
      const created = [...this.faultTopics];
      await admin.deleteTopics({ topics: created, timeout: CHANGE_TIMEOUT_MS });
      for (const topic of created) await this.waitForListing(topic, false);
      this.faultTopics.clear();
    }
    // Empty what is left: truncating to the high watermark keeps the topic and its configuration.
    for (const topic of await this.namespacedTopics()) {
      const partitions = await this.ends([topic], READ_UNCOMMITTED);
      if (partitions.length === 0) continue;
      await admin.deleteTopicRecords({
        topic,
        partitions: partitions.map((p) => ({ partition: p.partition, offset: "-1" })),
        timeout: CHANGE_TIMEOUT_MS,
      });
    }
    this.windowOpen = false;
    this.cursor = new Map();
    this.captured = [];
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new KafkaAdapter(config as KafkaConfig);
}
