// The probe behind `ObserveKafka`, `ObserveKafkaTransport` and `ObserveKafkaBrokerLoss`
// (SPEC-ADPKFK-001, -002, -003). Part of the build, inside touches, not shipped.
//
// The throwaway containers (a two-broker KRaft cluster, Toxiproxy, the system's peer) are cluster.mjs's: started
// once per process, removed on exit. Only containers this fixture created, by name, are ever touched.
//
// The SYSTEM under test is the fixture's own client (system-client.cjs). In the observe spec it runs in this process
// on the direct listener. In the transport and broker-loss specs it runs as the peer, inside the Toxiproxy network
// namespace, bootstrapped at the proxy's listen address, where the broker advertises its proxy listener.
//
// NOT_ENOUGH_REPLICAS (founder ruling 2026-11-09, Kafka two-broker B). The adapter creates the topic with replication
// factor 2 and min.insync.replicas 2; arming it takes a second broker that is down, so this probe starts broker 2
// before the adapter creates the topic, waits for the topic to be in sync on both, then stops broker 2 and waits until
// the ISR holds broker 1 alone. Resetting starts broker 2, waits until the ISR holds both again, lets the adapter
// delete the topic, and returns to the baseline in which broker 2 is down (so that no topic of any other scenario is
// ever placed on a broker the instrument has no listener on).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RdKafka } from "@confluentinc/kafka-javascript";
import { createAdapter, KafkaAdapterError } from "../src/index.ts";
import { cluster, containerState, docker, NODE_IMAGE, PORTS, start, track, until } from "./cluster.mjs";

export { KAFKA_IMAGE, NODE_IMAGE, TOXIPROXY_IMAGE } from "./cluster.mjs";
export const CLIENT_VERSION = "1.11.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PEER_DEPS = path.join(ROOT, ".feature", "kafka-peer");
const SYSTEM_DEADLINE_MS = 3000;
const require = createRequire(import.meta.url);
const { makeClient } = require("./system-client.cjs");
const hostSystem = makeClient(RdKafka);

let proxyPromise;
function proxyEnvironment() {
  proxyPromise ??= (async () => {
    const c = await cluster();
    if (!existsSync(path.join(PEER_DEPS, "node_modules", "@confluentinc", "kafka-javascript", "package.json"))) {
      // The host's install carries only the host's binding: the peer needs the linux build of the pinned client.
      mkdirSync(PEER_DEPS, { recursive: true });
      const install = `feat-kafka-test-install-${c.id}`;
      track(install);
      docker(["run", "--rm", "--name", install, "-v", `${PEER_DEPS}:/work`, "-w", "/work", NODE_IMAGE, "npm", "install", "--no-audit", "--no-fund", "--prefix", "/work", `@confluentinc/kafka-javascript@${CLIENT_VERSION}`]);
    }
    const peer = `feat-kafka-test-peer-${c.id}`;
    start(peer, [
      `--network=container:${c.tox}`,
      "-v", `${PEER_DEPS}:/deps:ro`,
      "-v", `${path.join(HERE, "peer-agent.cjs")}:/agent.cjs:ro`,
      "-v", `${path.join(HERE, "system-client.cjs")}:/system-client.cjs:ro`,
      NODE_IMAGE, "node", "/agent.cjs",
    ]);
    await until("the peer agent", () => new Promise((resolve, reject) => {
      const s = net.connect(c.controlPort, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(true); });
      s.on("error", reject);
    }));
    return { peer };
  })();
  return proxyPromise;
}

/** One request to the peer agent: the system produces through the proxy and answers "ok" or the client's error name. */
function peerProduce(c, request) {
  return new Promise((resolve, reject) => {
    const s = net.connect(c.controlPort, "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => { s.destroy(); reject(new Error("the peer agent did not answer")); }, 60_000);
    s.on("connect", () => s.write(JSON.stringify(request) + "\n"));
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        clearTimeout(timer);
        s.destroy();
        resolve(JSON.parse(buf.trim()));
      }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// A script label (a, b) is mapped to `s` + 12 hex of a sha256 that also covers a per-call salt. The cluster is shared
// by every scenario of a test file, and a namespace reused after a case that did not reset it is not empty: a fresh
// namespace per call isolates the scenarios from each other.
const SALT = randomBytes(4).toString("hex");
let calls = 0;
const namespaceOf = (label, call) => `s${createHash("sha256").update(`${label}:${SALT}:${call}`).digest("hex").slice(0, 12)}`;

const STATE_NAMES = { paused: "paused", running: "running" };

function transactional(bootstrap) {
  const producer = new RdKafka.Producer({
    "bootstrap.servers": bootstrap,
    "transactional.id": `feat-${randomBytes(6).toString("hex")}`,
    "enable.idempotence": true,
    dr_cb: true,
  });
  const call = (fn, ...args) => new Promise((resolve, reject) => fn.call(producer, ...args, (e) => (e ? reject(e) : resolve())));
  return {
    async begin() {
      await new Promise((resolve, reject) => producer.connect({}, (e) => (e ? reject(e) : resolve())));
      await call(producer.initTransactions, 10_000);
      await call(producer.beginTransaction);
    },
    async send(topic, key, value) {
      producer.produce(topic, null, Buffer.from(value), key);
      await new Promise((resolve) => producer.flush(10_000, resolve));
    },
    commit: () => call(producer.commitTransaction, 10_000),
    abort: () => call(producer.abortTransaction, 10_000),
    close: () => new Promise((resolve) => producer.disconnect(() => resolve())),
  };
}

async function run(input, mode) {
  const c = await cluster();
  const env = mode === "observe" ? undefined : await proxyEnvironment();
  if (containerState(c.b1) === "paused") docker(["unpause", c.b1]);
  if (env !== undefined) {
    const all = await (await fetch(`${c.api}/proxies`)).json();
    for (const n of Object.keys(all)) await fetch(`${c.api}/proxies/${n}`, { method: "DELETE" });
  }

  const steps = input.script.trim().split(/\s+/);
  // `auth` points the INSTRUMENT at the SASL listener with the cluster's throwaway credentials ("correct") or the same
  // user with another password ("wrong"). They travel only through process.env, named by options.auth, as in production.
  const bootstrap = input.bootstrap === "unreachable" ? "127.0.0.1:1" : input.auth !== undefined ? c.saslBootstrap : c.bootstrap;
  process.env.FEAT_KAFKA_TEST_BOOTSTRAP = bootstrap;
  if (input.auth !== undefined) {
    process.env.FEAT_KAFKA_TEST_USER = c.sasl.username;
    process.env.FEAT_KAFKA_TEST_PASSWORD = input.auth === "correct" ? c.sasl.password : `x${randomBytes(9).toString("hex")}`;
  }

  const call = ++calls;
  const nsOf = (l) => (l.startsWith("raw=") ? l.slice(4) : namespaceOf(l, call));
  const adapters = new Map();
  const make = (l) => {
    const options = {
      bootstrapServersEnv: "FEAT_KAFKA_TEST_BOOTSTRAP",
      ...(input.settleTimeoutMs !== undefined ? { settleTimeoutMs: input.settleTimeoutMs } : {}),
      ...(input.auth !== undefined
        ? { auth: { mechanism: "plain", username: "FEAT_KAFKA_TEST_USER", password: "FEAT_KAFKA_TEST_PASSWORD", ssl: false } }
        : {}),
      ...(env !== undefined
        ? {
            proxy: {
              api: c.api,
              upstream: `127.0.0.1:${PORTS.proxyUpstream}`,
              ...(mode === "broker-loss" ? { container: c.b1 } : {}),
            },
          }
        : {}),
    };
    return createAdapter({ key: "kafka", namespace: nsOf(l), options });
  };
  const adapter = (l) => {
    let a = adapters.get(l);
    if (a === undefined) {
      a = make(l);
      adapters.set(l, a);
    }
    return a;
  };

  /** The proxy the broker advertises, created before the adapter opens it: its fixed listen port is what the broker's proxy listener advertises. */
  const ensureProxy = async (l) => {
    if (env === undefined || l.startsWith("raw=")) return;
    const res = await fetch(`${c.api}/proxies`, {
      method: "POST",
      body: JSON.stringify({ name: `feat-${nsOf(l)}-kafka`, listen: `0.0.0.0:${PORTS.proxyListen}`, upstream: `127.0.0.1:${PORTS.proxyUpstream}` }),
    });
    if (!res.ok) throw new Error(`could not create the proxy: ${res.status} ${await res.text()}`);
  };

  /** The SYSTEM produces: its own client, acks=all. Returns "ok" or the client's error name. */
  const systemProduce = async (topic, key, value, partition) => {
    const request = {
      topic,
      key,
      value,
      ...(partition !== undefined ? { partition } : {}),
      messageTimeoutMs: env === undefined ? 10_000 : SYSTEM_DEADLINE_MS,
    };
    const answer =
      env === undefined
        ? await hostSystem.produce({ bootstrap: c.bootstrap, ...request })
        : await peerProduce(c, { bootstrap: `127.0.0.1:${PORTS.proxyListen}`, ...request });
    return answer.ok ? "ok" : answer.err;
  };

  const trace = [];
  let last;
  let lastPeek;
  let peekEqualsStop;
  const open = new Map();
  let armedReplicas = false;
  const faultTopics = [];
  const format = (rs) => {
    if (rs.every((r) => r.metadata.partition === 0)) return rs.map((r) => `${r.type}/${r.key}`).join(",");
    const by = new Map();
    for (const r of rs) by.set(r.metadata.partition, [...(by.get(r.metadata.partition) ?? []), `${r.type}/${r.key}`]);
    return [...by.keys()].sort((x, y) => x - y).map((p) => `${p}=${by.get(p).join(",")}`).join(";");
  };
  const body = (label) => JSON.stringify({ label });

  try {
    for (const step of steps) {
      const [kind, l, a, b, d] = step.split(":");
      switch (kind) {
        case "setup":
          await ensureProxy(l);
          await adapter(l).setup();
          trace.push(`setup:${l}`);
          break;
        case "seed":
          await adapter(l).seed([{ type: a, values: { key: b, label: b } }]);
          trace.push(`seed:${l}`);
          break;
        case "topic": {
          const name = `${nsOf(l)}.${a}`;
          await c.admin.createTopics({ topics: [{ topic: name, numPartitions: Number(b) }] });
          await until(`the topic ${name}`, async () => (await c.admin.listTopics()).includes(name) && (await c.admin.fetchTopicOffsets(name)).length === Number(b));
          trace.push(`topic:${l}`);
          break;
        }
        case "produce":
        case "producep":
        case "producebig": {
          const topic = `${nsOf(l)}.${a}`;
          const outcome =
            kind === "produce"
              ? await systemProduce(topic, b, body(b))
              : kind === "producep"
                ? await systemProduce(topic, d, body(d), Number(b))
                : await systemProduce(topic, "big", "x".repeat(2048));
          trace.push(outcome === "ok" ? `${kind}:${l}` : `${kind}:${l}!${outcome}`);
          break;
        }
        case "produceraw": {
          const outcome = await systemProduce(`elsewhere.${l}`, a, body(a));
          trace.push(outcome === "ok" ? "produceraw" : `produceraw!${outcome}`);
          break;
        }
        case "txcommit":
        case "txabort":
        case "txopen": {
          const tx = transactional(c.bootstrap);
          await tx.begin();
          await tx.send(`${nsOf(l)}.${a}`, b, body(b));
          if (kind === "txcommit") { await tx.commit(); await tx.close(); }
          else if (kind === "txabort") { await tx.abort(); await tx.close(); }
          else open.set(l, tx);
          trace.push(`${kind}:${l}`);
          break;
        }
        case "txclose": {
          const tx = open.get(l);
          await tx.commit();
          await tx.close();
          open.delete(l);
          trace.push(`txclose:${l}`);
          break;
        }
        case "start":
          await adapter(l).startCapture();
          trace.push(`start:${l}`);
          break;
        case "peek": {
          lastPeek = await adapter(l).peekCapture();
          last = format(lastPeek);
          trace.push(`peek:${l}=${lastPeek.length}`);
          break;
        }
        case "stop": {
          const rs = await adapter(l).stopCapture();
          last = format(rs);
          if (lastPeek !== undefined) peekEqualsStop = JSON.stringify(lastPeek) === JSON.stringify(rs);
          lastPeek = undefined;
          trace.push(`stop:${l}=${rs.length}`);
          break;
        }
        case "settle":
          trace.push(`settle:${l}=${await adapter(l).settle()}`);
          break;
        case "reset": {
          if (armedReplicas) {
            // Restore broker 2 and wait until every fault topic is in sync on both brokers again, then let the adapter delete them.
            await c.startSecond();
            for (const t of faultTopics) await until(`the ISR of ${t}`, async () => (await c.partitions(t)).every((p) => p.isr.length === 2));
          }
          await adapter(l).reset();
          if (armedReplicas) {
            c.stopSecond();
            armedReplicas = false;
            faultTopics.length = 0;
          }
          trace.push(`reset:${l}`);
          break;
        }
        case "read": {
          const rs = await adapter(l).read(a === undefined ? {} : { expect: [{ type: a }] });
          trace.push(`read:${l}${a === undefined ? "" : `:${a}`}=${rs.length}`);
          break;
        }
        case "fault": {
          const [operation, fault] = a.split(".");
          const isConnection = operation === "Connection";
          const topic = isConnection ? undefined : b;
          const count = isConnection ? b : d;
          const times = count === undefined || count === "reset" ? "reset" : count === "once" ? 1 : Number(count.replace("times", ""));
          const needsReplicas = operation === "Produce" && fault === "NOT_ENOUGH_REPLICAS" && times === "reset";
          if (needsReplicas) await c.startSecond();
          await adapter(l).fault({ operation, fault, ...(topic !== undefined ? { detail: { topic } } : {}), times });
          if (needsReplicas) {
            const name = `${nsOf(l)}.${topic}`;
            faultTopics.push(name);
            await until(`the ISR of ${name}`, async () => (await c.partitions(name)).every((p) => p.isr.length === 2));
            c.stopSecond();
            await c.waitIsr(name, 1);
            armedReplicas = true;
          }
          trace.push(`fault:${l}:${a}`);
          break;
        }
        case "fired": {
          const fired = typeof adapter(l).firedFaults === "function" ? JSON.stringify(await adapter(l).firedFaults()) : "unobserved";
          trace.push(`fired:${l}=${fired}`);
          break;
        }
        case "container":
          trace.push(`container=${STATE_NAMES[containerState(c.b1)] ?? containerState(c.b1)}`);
          break;
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    const result = { trace: trace.join(" ") };
    if (last) result.last = last;
    if (peekEqualsStop !== undefined) result.peekEqualsStop = peekEqualsStop;
    return { status: "OK", body: result };
  } catch (e) {
    if (e instanceof KafkaAdapterError) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    // Put the product back before anything else touches it, then let each adapter close what it opened.
    if (containerState(c.b1) === "paused") docker(["unpause", c.b1]);
    // Baseline after any case: broker 2 down, so that no topic of the next case is placed on it.
    c.stopSecond();
    for (const tx of open.values()) await tx.close().catch(() => {});
    for (const adapterInstance of adapters.values()) await adapterInstance.teardown().catch(() => {});
  }
}

export const observe = (input) => run(input, "observe");
export const observeTransport = (input) => run(input, "transport");
export const observeBrokerLoss = (input) => run(input, "broker-loss");
