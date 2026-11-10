// The throwaway Kafka cluster the scenarios of SPEC-ADPKFK-001, -002 and -003 run against. Part of the build,
// inside touches, not shipped. Founder ruling 2026-11-09, Kafka two-broker B: the test fixture is a TWO-broker
// KRaft cluster, because a single node never answers NOT_ENOUGH_REPLICAS.
//
// Containers (all named feat-kafka-test-<kind>-<id>; only these are ever touched):
//   tox   Toxiproxy (pinned image). It owns the network namespace: both brokers and the peer run with
//         --network=container:<tox>, so the brokers reach each other on loopback and Toxiproxy reaches a broker on
//         loopback. Its API, the instrument's direct port and the peer's control port are published on loopback.
//   b1    broker + controller (node 1, the only voter of the quorum, so stopping broker 2 never costs the quorum).
//         Listeners: INTERNAL (inter-broker), CONTROLLER, DIRECT (advertised at the published host port: the
//         instrument and the observe-mode system), SASL (SASL_PLAINTEXT with PLAIN, advertised at its published host
//         port: the instrument's authenticated path, founder ruling 2026-11-09, spec-gap amendment), PROXY (advertised at the fixed Toxiproxy listen port: the system
//         of the transport and broker-loss specs). Pausing b1 is the loss of the broker (SPEC-ADPKFK-003).
//   b2    broker only (node 2): INTERNAL and DIRECT listeners (no PROXY: the system never talks to it). It is created,
//         and started, the first time a NOT_ENOUGH_REPLICAS fault is armed, and stopped otherwise, so that no topic of
//         any other scenario is placed on it. It has a DIRECT listener because a Metadata response in KRaft names a
//         RANDOM live broker as "the controller", and the admin client sends CreateTopics to that id: with only broker
//         1 reachable, a client told "2" waits for a broker it cannot see until its timeout (ERR__TIMED_OUT -185).
//   peer  (transport specs) shares the Toxiproxy namespace: the system's producer, which must run there on Docker
//         Desktop because a client reaching a published port goes through the runtime's host proxy, which accepts a
//         connection the proxy refused and hides a reset (adapters/fault-proxy/fixtures/probe.mjs says why).
//
// Arming NOT_ENOUGH_REPLICAS: the adapter creates the fault's topic with replication factor 2 and
// min.insync.replicas 2 (both brokers up). The fixture then stops broker 2 and waits until the partition's ISR holds
// broker 1 alone: a stop is a controlled shutdown, so the controller drops broker 2 from the ISR at once and the wait
// does not depend on replica.lag.time.max.ms (lowered anyway, for the same reason as the rest of the timers below).
// Restoring starts broker 2 and waits until the ISR holds both brokers again. Both waits are polls with a ceiling
// (WAIT_MS); neither is a behaviour of the adapter.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { KafkaJS } from "@confluentinc/kafka-javascript";

export const KAFKA_IMAGE = "apache/kafka:3.9.0";
export const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
export const NODE_IMAGE = "node:22.12.0-slim";

export const PORTS = {
  internal1: 19092,
  controller: 19093,
  direct1: 19094,
  /** The PROXY listener of broker 1 as Toxiproxy reaches it (the proxy's upstream). */
  proxyUpstream: 19095,
  /** The Toxiproxy listen port the PROXY listener advertises: what the system bootstraps at. */
  proxyListen: 19096,
  /** The SASL listener of broker 1 (SASL_PLAINTEXT, PLAIN): the instrument's authenticated path (SPEC-ADPKFK-001, auth). */
  sasl1: 19097,
  internal2: 29092,
  direct2: 29094,
  api: 8474,
  control: 19002,
};
const CLUSTER_ID = "MkU3OEVBNTcwNTJENDM2Qg";
const WAIT_MS = 90_000;

const created = [];
let hooked = false;

export function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function removeAll() {
  // One call for every container this fixture created, so a worker killed mid-cleanup cannot leave half.
  // -v: the broker image declares anonymous volumes, which `docker rm` alone leaves behind.
  const names = created.splice(0);
  if (names.length > 0) spawnSync("docker", ["rm", "-f", "-v", ...names], { stdio: "ignore" });
}

export function hook() {
  if (hooked) return;
  hooked = true;
  process.once("exit", removeAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      removeAll();
      process.exit(128);
    });
  }
}

export function start(name, args) {
  hook();
  created.push(name);
  return docker(["run", "-d", "--name", name, ...args]);
}

export function track(name) {
  hook();
  created.push(name);
}

export function hostPort(name, inner) {
  return Number(docker(["port", name, `${inner}/tcp`]).split("\n")[0].split(":").pop());
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(what, fn, ms = WAIT_MS, every = 200) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value !== false) return value;
      last = new Error("not yet");
    } catch (e) {
      last = e;
    }
    await sleep(every);
  }
  throw new Error(`${what} did not come up: ${last}`);
}

export function containerState(name) {
  const state = docker(["inspect", "--format", "{{.State.Status}}", name]);
  return state === "exited" ? "stopped" : state;
}

// Timers lowered so that a loss is noticed in seconds, not tens of seconds. Applies to both brokers.
const COMMON_ENV = [
  "-e", `CLUSTER_ID=${CLUSTER_ID}`,
  "-e", "KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL",
  "-e", "KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER",
  "-e", "KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT,DIRECT:PLAINTEXT,PROXY:PLAINTEXT,SASL:SASL_PLAINTEXT",
  "-e", `KAFKA_CONTROLLER_QUORUM_VOTERS=1@127.0.0.1:${PORTS.controller}`,
  "-e", "KAFKA_AUTO_CREATE_TOPICS_ENABLE=true",
  "-e", "KAFKA_NUM_PARTITIONS=1",
  "-e", "KAFKA_DEFAULT_REPLICATION_FACTOR=1",
  "-e", "KAFKA_MIN_INSYNC_REPLICAS=1",
  "-e", "KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1",
  "-e", "KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1",
  "-e", "KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1",
  "-e", "KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0",
  "-e", "KAFKA_REPLICA_LAG_TIME_MAX_MS=3000",
  "-e", "KAFKA_BROKER_SESSION_TIMEOUT_MS=6000",
  "-e", "KAFKA_DELETE_TOPIC_ENABLE=true",
  "-e", "KAFKA_HEAP_OPTS=-Xmx384m -Xms128m",
];

const startedCount = (name) => (docker(["logs", name]).match(/Kafka Server started/g) ?? []).length;

function logs(name) {
  const r = spawnSync("docker", ["logs", name], { encoding: "utf8" });
  return `${r.stdout}${r.stderr}`;
}

export function quietKafka(brokers, extra = {}) {
  return new KafkaJS.Kafka({ kafkaJS: { brokers, logLevel: KafkaJS.logLevel.NOTHING, ...extra } });
}

let clusterPromise;
export function cluster() {
  clusterPromise ??= (async () => {
    const id = randomBytes(4).toString("hex");
    const tox = `feat-kafka-test-tox-${id}`;
    const b1 = `feat-kafka-test-b1-${id}`;
    const b2 = `feat-kafka-test-b2-${id}`;
    start(tox, [
      "--rm",
      "-p", `127.0.0.1:0:${PORTS.api}`,
      "-p", `127.0.0.1:0:${PORTS.direct1}`,
      "-p", `127.0.0.1:0:${PORTS.direct2}`,
      "-p", `127.0.0.1:0:${PORTS.sasl1}`,
      "-p", `127.0.0.1:0:${PORTS.control}`,
      TOXIPROXY_IMAGE,
      "-host=0.0.0.0",
      "-proxy-metrics",
    ]);
    const api = `http://127.0.0.1:${hostPort(tox, PORTS.api)}`;
    const directPort = hostPort(tox, PORTS.direct1);
    const directPort2 = hostPort(tox, PORTS.direct2);
    const saslPort = hostPort(tox, PORTS.sasl1);
    // Throwaway credentials of this cluster only: generated here, held in memory, handed to the broker's environment and
    // to the probe, never printed and never written to a file.
    const sasl = { username: `u${randomBytes(6).toString("hex")}`, password: randomBytes(18).toString("hex") };
    const controlPort = hostPort(tox, PORTS.control);
    start(b1, [
      `--network=container:${tox}`,
      ...COMMON_ENV,
      "-e", "KAFKA_NODE_ID=1",
      "-e", "KAFKA_PROCESS_ROLES=broker,controller",
      "-e", `KAFKA_LISTENERS=INTERNAL://127.0.0.1:${PORTS.internal1},CONTROLLER://127.0.0.1:${PORTS.controller},DIRECT://0.0.0.0:${PORTS.direct1},PROXY://0.0.0.0:${PORTS.proxyUpstream},SASL://0.0.0.0:${PORTS.sasl1}`,
      "-e", `KAFKA_ADVERTISED_LISTENERS=INTERNAL://127.0.0.1:${PORTS.internal1},DIRECT://127.0.0.1:${directPort},PROXY://127.0.0.1:${PORTS.proxyListen},SASL://127.0.0.1:${saslPort}`,
      "-e", "KAFKA_LISTENER_NAME_SASL_SASL_ENABLED_MECHANISMS=PLAIN",
      "-e", `KAFKA_LISTENER_NAME_SASL_PLAIN_SASL_JAAS_CONFIG=org.apache.kafka.common.security.plain.PlainLoginModule required user_${sasl.username}="${sasl.password}";`,
      KAFKA_IMAGE,
    ]);
    const bootstrap = `127.0.0.1:${directPort}`;
    await until("the Toxiproxy API", async () => {
      const r = await fetch(`${api}/version`);
      if (!r.ok) throw new Error(String(r.status));
    });
    const admin = quietKafka([bootstrap]).admin();
    await admin.connect();
    await until("Kafka", () => admin.listTopics({ timeout: 2000 }));

    const self = {
      id, tox, b1, b2, api, directPort, controlPort, bootstrap,
      /** The authenticated listener: its bootstrap address and the throwaway credentials (never printed). */
      saslBootstrap: `127.0.0.1:${saslPort}`,
      sasl,
      admin,
      secondCreated: false,
      /**
       * The partitions of one topic as the cluster has them: [{ partition, leader, replicas, isr }]. Read through the
       * INTERNAL listener by the broker's own tool, not through the instrument, so that it reads the same while broker 2
       * is going up or down.
       */
      async partitions(topic) {
        const out = docker(["exec", b1, "/opt/kafka/bin/kafka-topics.sh", "--bootstrap-server", `127.0.0.1:${PORTS.internal1}`, "--describe", "--topic", topic]);
        const list = (v) => (v === undefined || v === "" || v === "none" ? [] : v.split(",").map(Number));
        return out
          .split("\n")
          .map((line) => /Partition:\s*(\d+)\s+Leader:\s*(-?\d+|none)\s+Replicas:\s*([\d,]*)\s+Isr:\s*([\d,]*)/.exec(line))
          .filter((m) => m !== null)
          .map((m) => ({ partition: Number(m[1]), leader: m[2] === "none" ? -1 : Number(m[2]), replicas: list(m[3]), isr: list(m[4]) }));
      },
      /** Start (creating it the first time) broker 2 and wait until it is registered and unfenced. */
      async startSecond() {
        if (!self.secondCreated) {
          start(b2, [
            `--network=container:${tox}`,
            ...COMMON_ENV,
            "-e", "KAFKA_NODE_ID=2",
            "-e", "KAFKA_PROCESS_ROLES=broker",
            "-e", `KAFKA_LISTENERS=INTERNAL://127.0.0.1:${PORTS.internal2},DIRECT://0.0.0.0:${PORTS.direct2}`,
            "-e", `KAFKA_ADVERTISED_LISTENERS=INTERNAL://127.0.0.1:${PORTS.internal2},DIRECT://127.0.0.1:${directPort2}`,
            KAFKA_IMAGE,
          ]);
          self.secondCreated = true;
          await until("broker 2", () => {
            if (startedCount(b2) >= 1) return true;
            if (containerState(b2) !== "running") throw new Error(`broker 2 exited: ${logs(b2).slice(-1500)}`);
            return false;
          });
          return;
        }
        const before = startedCount(b2);
        docker(["start", b2]);
        await until("broker 2", () => startedCount(b2) > before);
      },
      /** A stop is a controlled shutdown: the broker leaves the ISRs before it exits. */
      stopSecond() {
        if (self.secondCreated && containerState(b2) === "running") docker(["stop", "--time", "30", b2]);
      },
      async waitIsr(topic, size) {
        return until(`the ISR of ${topic} to hold ${size} replica(s)`, async () => {
          const ps = await self.partitions(topic);
          return ps.length > 0 && ps.every((p) => p.isr.length === size && p.leader === 1) ? ps : false;
        });
      },
      /** Whether a NOT_ENOUGH_REPLICAS fault is armed (broker 2 stopped under a topic that needs it). */
      secondRunning: () => self.secondCreated && containerState(b2) === "running",
      async close() {
        await admin.disconnect().catch(() => {});
      },
    };
    return self;
  })();
  return clusterPromise;
}
