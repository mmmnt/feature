// @mmmnt/feat-adapter-neo4j (SPEC-ADPNEO-001, -002) — Neo4j as a Feat service.
//
// Neo4j Change Data Capture is an Enterprise/Aura feature, so a Community server has no change feed: the
// capture window is a SNAPSHOT of the namespace's graph taken at start and compared at peek/stop. The
// namespace is a node label, `ns_<namespace>`, that every node the system writes carries; a relationship
// belongs to the namespace when both of its nodes do. Settle is truthful on a direct bolt:// connection once
// SHOW TRANSACTIONS lists no transaction but the instrument's own; a routing URI answers false.
//
// The adapter's own (instrument) driver is connected to the product directly and never through a proxy;
// transport faults (Connection.*) are armed on a Toxiproxy proxy in front of the SYSTEM's path through
// @mmmnt/feat-fault-proxy (SPEC-FPX-001).

import neo4j from "neo4j-driver";
import type { Driver, QueryResult, Session } from "neo4j-driver";
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

export type Neo4jAdapterErrorCode =
  | "NAMESPACE_INVALID"
  | "NEO4J_UNREACHABLE"
  | "NODE_KEY_UNDECLARED"
  | "NAMESPACE_BREACH"
  | "FAULT_UNSUPPORTED";

export class Neo4jAdapterError extends Error {
  constructor(
    readonly code: Neo4jAdapterErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "Neo4jAdapterError";
  }
}

export interface Neo4jProxyOptions {
  /** Toxiproxy API base URL. */
  api: string;
  /** host:port of the product as Toxiproxy reaches it (it can differ from the instrument's address). */
  upstream: string;
  /** The product label of the proxy name `feat-<ns>-<name>`. Default "neo4j". */
  name?: string;
  container?: string;
  metrics?: string;
  runtime?: string;
}

export interface Neo4jOptions {
  uri?: string;
  /** Name of the environment variable holding the URI. */
  uriEnv?: string;
  /** Names of the environment variables holding the instrument's credentials. Omit for a server without auth. */
  auth?: { username: string; password: string };
  /** Label -> the property that identifies a node of that label. Required for every label the system writes. */
  keys: Record<string, string>;
  settleTimeoutMs?: number;
  proxy?: Neo4jProxyOptions;
}

interface Neo4jConfig {
  key?: string;
  namespace?: string;
  options?: Neo4jOptions;
}

type Props = Record<string, unknown>;

interface NodeState {
  label: string;
  value: unknown;
  labels: string[];
  props: Props;
}

interface RelState {
  from: string;
  to: string;
  relType: string;
  props: Props;
  count: number;
}

interface Snapshot {
  nodes: Map<string, NodeState>;
  rels: Map<string, RelState>;
}

const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Marks the placeholder a fault leaves in the namespace; never reported. */
const FAULT_MARK = "__feat_fault";
const POLL_MS = 50;
const BATCH = 1000;
const CONNECTION_FAULTS = ["Timeout", "ConnectionReset", "Partition"] as const;

const quote = (name: string): string => `\`${name.replace(/`/g, "``")}\``;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Plain JSON-comparable values: the driver's Integer, temporal and spatial types become numbers and strings. */
function plain(v: unknown): unknown {
  if (neo4j.isInt(v)) return v.inSafeRange() ? v.toNumber() : v.toString();
  if (Array.isArray(v)) return v.map(plain);
  if (v !== null && typeof v === "object") {
    if (neo4j.isDate(v) || neo4j.isDateTime(v) || neo4j.isLocalDateTime(v) || neo4j.isTime(v) || neo4j.isLocalTime(v) || neo4j.isDuration(v) || neo4j.isPoint(v)) {
      return String(v);
    }
    return Object.fromEntries(Object.entries(v as Props).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Props).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  );
}

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** A URI without any credentials in it, for a message. */
function redact(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, "//");
}

class Neo4jAdapter implements FeatServiceAdapter {
  readonly observes = { diff: "snapshot", state: true } as const;
  readonly faults: FaultCatalog;

  private readonly namespace: string;
  private readonly options: Neo4jOptions;
  private readonly settleTimeoutMs: number;
  private readonly tag: string;
  private driver: Driver | undefined;
  private proxy: FaultProxy | undefined;
  private opened: OpenProxy | undefined;

  private baseline: Snapshot | undefined;
  /** How the last read() found its records: "KeyedMatch" or "NamespaceScan". */
  lastReadVia: "KeyedMatch" | "NamespaceScan" | null = null;

  constructor(config: Neo4jConfig) {
    const ns = config.namespace;
    if (typeof ns !== "string" || !NAMESPACE_PATTERN.test(ns)) {
      throw new Neo4jAdapterError(
        "NAMESPACE_INVALID",
        `'${String(ns)}' does not match ${NAMESPACE_PATTERN.source}, the pattern the runner derives`,
      );
    }
    this.namespace = ns;
    this.options = config.options ?? { keys: {} };
    this.settleTimeoutMs = this.options.settleTimeoutMs ?? 5000;
    this.tag = `feat-instrument-${ns}`;

    const catalog: Record<string, Record<string, readonly ("once" | "times" | "reset")[]>> = {
      Write: { UNIQUE_CONSTRAINT_VIOLATION: ["reset"] },
    };
    const proxy = this.options.proxy;
    if (proxy !== undefined) {
      this.proxy = createFaultProxy({
        api: proxy.api,
        product: proxy.name ?? "neo4j",
        upstream: proxy.upstream,
        namespace: ns,
        ...(proxy.container !== undefined ? { container: proxy.container } : {}),
        ...(proxy.metrics !== undefined ? { metrics: proxy.metrics } : {}),
        ...(proxy.runtime !== undefined ? { runtime: proxy.runtime } : {}),
      });
      catalog.Connection = Object.fromEntries(CONNECTION_FAULTS.map((f) => [f, ["reset" as const]]));
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

  private get nsLabel(): string {
    return `ns_${this.namespace}`;
  }

  // ── the instrument connection ─────────────────────────────────────────────

  private uri(): string {
    const o = this.options;
    const raw = o.uri ?? (o.uriEnv !== undefined ? process.env[o.uriEnv] : undefined);
    if (raw === undefined || raw === "") {
      throw new Error("the neo4j service has no uri (or uriEnv naming a set variable)");
    }
    return raw;
  }

  private routing(): boolean {
    return /^neo4j(\+s|\+ssc)?:\/\//.test(this.uri());
  }

  private db(): Driver {
    if (this.driver === undefined) {
      const auth = this.options.auth;
      let token;
      if (auth !== undefined) {
        const user = process.env[auth.username];
        const pass = process.env[auth.password];
        if (user === undefined || pass === undefined) {
          throw new Error(`options.auth names the variables ${auth.username} and ${auth.password}, which are not both set`);
        }
        token = neo4j.auth.basic(user, pass);
      }
      this.driver = neo4j.driver(this.uri(), token, { connectionTimeout: 10_000, connectionAcquisitionTimeout: 15_000 });
    }
    return this.driver;
  }

  /** One auto-commit statement on a fresh session, tagged as the instrument's own transaction. */
  private async run(query: string, params: Props = {}, mode: "READ" | "WRITE" = "WRITE"): Promise<QueryResult> {
    const session: Session = this.db().session({ defaultAccessMode: mode === "READ" ? neo4j.session.READ : neo4j.session.WRITE });
    try {
      return await session.run(query, params, { metadata: { app: this.tag } });
    } finally {
      await session.close();
    }
  }

  async setup(): Promise<void> {
    const uri = this.uri();
    try {
      await this.db().verifyConnectivity();
    } catch (e) {
      await this.closeDriver();
      const message = e instanceof Error ? e.message : String(e);
      throw new Neo4jAdapterError("NEO4J_UNREACHABLE", `the server at ${redact(uri)} did not answer: ${message}`);
    }
    if (this.proxy !== undefined) this.opened = await this.proxy.open();
  }

  private async closeDriver(): Promise<void> {
    const d = this.driver;
    this.driver = undefined;
    if (d !== undefined) await d.close().catch(() => {});
  }

  async teardown(): Promise<void> {
    this.baseline = undefined;
    try {
      if (this.proxy !== undefined) await this.proxy.close();
    } finally {
      this.opened = undefined;
      await this.closeDriver();
    }
  }

  // ── the snapshot ──────────────────────────────────────────────────────────

  private identify(labels: string[], props: Props): { label: string; value: unknown } {
    const keys = this.options.keys ?? {};
    const label = Object.keys(keys).find((l) => labels.includes(l));
    if (label === undefined) {
      throw new Neo4jAdapterError(
        "NODE_KEY_UNDECLARED",
        `a node of the namespace carries the labels ${labels.join(", ") || "(none)"}, none of which declares a key property (options.keys)`,
      );
    }
    const value = props[keys[label] as string];
    if (value === undefined || value === null) {
      throw new Neo4jAdapterError(
        "NODE_KEY_UNDECLARED",
        `a ${label} node of the namespace has no value for its declared key property '${keys[label]}'`,
      );
    }
    return { label, value };
  }

  private nodeFrom(rawLabels: string[], rawProps: unknown): NodeState {
    const labels = rawLabels.filter((l) => l !== this.nsLabel);
    const props = plain(rawProps) as Props;
    const { label, value } = this.identify(labels, props);
    return { label, value, labels: [...labels].sort(byKey), props };
  }

  private async snapshot(): Promise<Snapshot> {
    const ns = quote(this.nsLabel);
    const session = this.db().session({ defaultAccessMode: neo4j.session.READ });
    let rows: { nodes: QueryResult; rels: QueryResult; breach: QueryResult };
    try {
      rows = await session.executeRead(
        async (tx) => ({
          nodes: await tx.run(`MATCH (n:${ns}) WHERE n.${FAULT_MARK} IS NULL RETURN elementId(n) AS id, labels(n) AS labels, properties(n) AS props`),
          rels: await tx.run(
            `MATCH (a:${ns})-[r]->(b:${ns}) WHERE a.${FAULT_MARK} IS NULL AND b.${FAULT_MARK} IS NULL RETURN elementId(a) AS a, elementId(b) AS b, type(r) AS type, properties(r) AS props`,
          ),
          breach: await tx.run(`MATCH (a:${ns})-[r]-(b) WHERE NOT b:${ns} RETURN type(r) AS type LIMIT 1`),
        }),
        { metadata: { app: this.tag } },
      );
    } finally {
      await session.close();
    }

    const breach = rows.breach.records[0];
    if (breach !== undefined) {
      throw new Neo4jAdapterError(
        "NAMESPACE_BREACH",
        `a ${String(breach.get("type"))} relationship joins a node of the namespace and a node outside it`,
      );
    }

    const nodes = new Map<string, NodeState>();
    const identity = new Map<string, string>();
    for (const record of rows.nodes.records) {
      const node = this.nodeFrom(record.get("labels") as string[], record.get("props"));
      const key = `${node.label}:${String(node.value)}`;
      nodes.set(key, node);
      identity.set(String(record.get("id")), key);
    }
    const rels = new Map<string, RelState>();
    for (const record of rows.rels.records) {
      const from = identity.get(String(record.get("a")));
      const to = identity.get(String(record.get("b")));
      if (from === undefined || to === undefined) continue;
      const relType = String(record.get("type"));
      const key = `${from}-[${relType}]->${to}`;
      const seen = rels.get(key);
      if (seen !== undefined) seen.count += 1;
      else rels.set(key, { from, to, relType, props: plain(record.get("props")) as Props, count: 1 });
    }
    return { nodes, rels };
  }

  private nodeRecord(type: string, key: string, n: NodeState, timestamp: number): CapturedRecord {
    return { type, key, payload: { ...n.props, labels: n.labels }, timestamp };
  }

  private relRecord(type: string, key: string, r: RelState, timestamp: number): CapturedRecord {
    return { type, key, payload: { ...r.props, from: r.from, to: r.to, relType: r.relType, count: r.count }, timestamp };
  }

  private diff(before: Snapshot, after: Snapshot): CapturedRecord[] {
    const timestamp = Date.now();
    const out: CapturedRecord[] = [];
    const walk = <T>(a: Map<string, T>, b: Map<string, T>, make: (type: string, key: string, v: T) => CapturedRecord) => {
      for (const key of [...new Set([...a.keys(), ...b.keys()])].sort(byKey)) {
        const was = a.get(key);
        const is = b.get(key);
        if (was === undefined && is !== undefined) out.push(make("INSERT", key, is));
        else if (was !== undefined && is === undefined) out.push(make("REMOVE", key, was));
        else if (was !== undefined && is !== undefined && stable(was) !== stable(is)) out.push(make("MODIFY", key, is));
      }
    };
    walk(before.nodes, after.nodes, (t, k, v) => this.nodeRecord(t, k, v, timestamp));
    walk(before.rels, after.rels, (t, k, v) => this.relRecord(t, k, v, timestamp));
    return out;
  }

  // ── the window ────────────────────────────────────────────────────────────

  async startCapture(): Promise<void> {
    this.baseline = await this.snapshot();
  }

  async peekCapture(): Promise<CapturedRecord[]> {
    if (this.baseline === undefined) return [];
    return this.diff(this.baseline, await this.snapshot());
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    if (this.baseline === undefined) return [];
    const before = this.baseline;
    const records = this.diff(before, await this.snapshot());
    this.baseline = undefined;
    return records;
  }

  /** True once SHOW TRANSACTIONS lists nothing but the instrument's own transactions. */
  private async quiet(): Promise<boolean> {
    const result = await this.run("SHOW TRANSACTIONS YIELD transactionId, metaData RETURN metaData", {}, "READ");
    return result.records.every((r) => {
      const meta = r.get("metaData") as { app?: unknown } | null;
      return typeof meta?.app === "string" && meta.app.startsWith("feat-instrument-");
    });
  }

  async settle(): Promise<boolean> {
    if (this.baseline === undefined) return false;
    if (this.routing()) return false;
    const deadline = Date.now() + this.settleTimeoutMs;
    try {
      for (;;) {
        if (await this.quiet()) return true;
        if (Date.now() >= deadline) return false;
        await sleep(POLL_MS);
      }
    } catch {
      return false;
    }
  }

  // ── state ─────────────────────────────────────────────────────────────────

  async read(query: ReadQuery): Promise<unknown | null> {
    const keys = this.options.keys ?? {};
    const hints = query.expect?.map((e) => {
      if (typeof e.type !== "string" || e.type === "" || e.type === "*" || e.key === undefined) return undefined;
      const entries = Object.entries(e.key);
      const prop = keys[e.type] ?? (entries.length === 1 ? entries[0]?.[0] : undefined);
      if (prop === undefined || e.key[prop] === undefined) return undefined;
      return { label: e.type, prop, value: e.key[prop] };
    });
    const timestamp = Date.now();
    if (hints !== undefined && hints.length > 0 && hints.every((h) => h !== undefined)) {
      this.lastReadVia = "KeyedMatch";
      const records: CapturedRecord[] = [];
      const ns = quote(this.nsLabel);
      for (const h of hints as { label: string; prop: string; value: unknown }[]) {
        const result = await this.run(
          `MATCH (n:${quote(h.label)}:${ns}) WHERE n.${quote(h.prop)} = $value AND n.${FAULT_MARK} IS NULL RETURN labels(n) AS labels, properties(n) AS props`,
          { value: h.value },
          "READ",
        );
        for (const r of result.records) {
          const node = this.nodeFrom(r.get("labels") as string[], r.get("props"));
          records.push(this.nodeRecord(node.label, `${node.label}:${String(node.value)}`, node, timestamp));
        }
      }
      return records;
    }
    this.lastReadVia = "NamespaceScan";
    const snap = await this.snapshot();
    return [
      ...[...snap.nodes].sort(([a], [b]) => byKey(a, b)).map(([k, n]) => this.nodeRecord(n.label, k, n, timestamp)),
      ...[...snap.rels].sort(([a], [b]) => byKey(a, b)).map(([k, r]) => this.relRecord(r.relType, k, r, timestamp)),
    ];
  }

  async seed(records: SeedRecord[]): Promise<void> {
    const session = this.db().session({ defaultAccessMode: neo4j.session.WRITE });
    try {
      await session.executeWrite(
        async (tx) => {
          for (const r of records) {
            await tx.run(`CREATE (n:${quote(r.type)}:${quote(this.nsLabel)}) SET n = $values`, { values: r.values });
          }
        },
        { metadata: { app: this.tag } },
      );
    } finally {
      await session.close();
    }
  }

  // ── faults ────────────────────────────────────────────────────────────────

  async fault(arm: FaultArm): Promise<void> {
    const where = `${arm.operation}.${arm.fault}`;
    const entry = (this.faults[arm.operation] as Record<string, readonly string[]> | undefined)?.[arm.fault];
    if (entry === undefined) {
      throw new Neo4jAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' is not in the catalog (${this.describeCatalog()})`);
    }
    if (arm.times !== "reset") {
      const asked = arm.times === 1 ? "once" : `times ${arm.times}`;
      throw new Neo4jAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' declares only until reset, not ${asked}`);
    }
    if (arm.operation === "Connection") {
      await this.proxy!.arm(arm.fault);
      return;
    }
    const property = arm.detail?.property;
    const value = arm.detail?.value;
    if (typeof property !== "string" || !IDENTIFIER.test(property)) {
      throw new Neo4jAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' needs a detail { property, value } whose property is an identifier`);
    }
    if (value === undefined || value === null || typeof value === "object") {
      throw new Neo4jAdapterError("FAULT_UNSUPPORTED", `the fault '${where}' needs a detail { property, value } naming the value the placeholder holds; detail.value is missing`);
    }
    const name = `feat_${this.namespace}_${property}`;
    await this.run(`CREATE CONSTRAINT ${quote(name)} IF NOT EXISTS FOR (n:${quote(this.nsLabel)}) REQUIRE n.${quote(property)} IS UNIQUE`);
    await this.run(`MERGE (n:${quote(this.nsLabel)} {${quote(property)}: $value, ${FAULT_MARK}: true})`, { value });
  }

  private describeCatalog(): string {
    return Object.entries(this.faults)
      .flatMap(([op, faults]) => Object.keys(faults).map((f) => `${op}.${f}`))
      .join(", ");
  }

  async reset(): Promise<void> {
    if (this.proxy !== undefined && this.opened !== undefined) await this.proxy.disarm();
    const constraints = await this.run("SHOW CONSTRAINTS YIELD name WHERE name STARTS WITH $prefix RETURN name", { prefix: `feat_${this.namespace}_` }, "READ");
    for (const r of constraints.records) await this.run(`DROP CONSTRAINT ${quote(String(r.get("name")))} IF EXISTS`);
    for (;;) {
      const result = await this.run(`MATCH (n:${quote(this.nsLabel)}) WITH n LIMIT ${BATCH} DETACH DELETE n RETURN count(*) AS deleted`);
      const deleted = result.records[0]?.get("deleted");
      if (deleted === undefined || Number(plain(deleted)) === 0) break;
    }
    this.baseline = undefined;
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new Neo4jAdapter(config as Neo4jConfig);
}
