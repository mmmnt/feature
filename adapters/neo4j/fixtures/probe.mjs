// The probe behind `ObserveNeo4j` and `ObserveNeo4jTransport` (SPEC-ADPNEO-001, -002). Part of the build,
// inside touches, not shipped.
//
// It starts, once per process, the throwaway containers the scenarios need and removes them on exit:
//   feat-neo4j-test-db-<id>      Neo4j Community (pinned image), bolt published on a free loopback port that is also
//                                its advertised address (so a routing neo4j:// URI resolves), a generated
//                                throwaway password handed to docker through the environment, never an argument
//   feat-neo4j-test-tox-<id>     Toxiproxy (pinned image), API and control port published (transport only)
//   feat-neo4j-test-peer-<id>    shares the Toxiproxy network namespace: the system's driver (peer-agent.cjs).
//                                A client of a proxied path must run there: Docker Desktop's host proxy
//                                accepts a connection the proxy refused and hides a TCP reset.
//   feat-neo4j-test-install-<id> a one-off container that installs the pinned driver for linux into
//                                .feature/neo4j-peer
// Only containers this probe created, by name, are ever touched.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import neo4j from "neo4j-driver";
import { createAdapter, Neo4jAdapterError } from "../src/index.ts";

export const NEO4J_IMAGE = "neo4j:2026.01.4-community";
export const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
export const NODE_IMAGE = "node:22.12.0-slim";
export const DRIVER_VERSION = "6.3.0";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PEER_DEPS = path.join(ROOT, ".feature", "neo4j-peer");
const AGENT_FILE = path.join(HERE, "peer-agent.cjs");
const CONTROL_PORT = 19002;
const KEYS = { Order: "orderId", Customer: "customerId" };
const USER = "neo4j";
const TRANSPORT_CODES = new Set(["ServiceUnavailable", "SessionExpired"]);

const created = [];
let hooked = false;

function docker(args, env) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) }).trim();
}

function removeAll() {
  // One call for every container this probe created, so a worker killed mid-cleanup cannot leave half.
  const names = created.splice(0);
  if (names.length > 0) spawnSync("docker", ["rm", "-f", "-v", ...names], { stdio: "ignore" });
}

function hook() {
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

function start(name, args, env) {
  hook();
  created.push(name);
  return docker(["run", "-d", "--name", name, ...args], env);
}

function hostPort(name, inner) {
  return Number(docker(["port", name, `${inner}/tcp`]).split("\n")[0].split(":").pop());
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function until(what, fn, ms = 120_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(`${what} did not come up: ${last instanceof Error ? last.message : last}`);
}

let dbPromise;
function neo4jServer() {
  dbPromise ??= (async () => {
    const id = randomBytes(4).toString("hex");
    const name = `feat-neo4j-test-db-${id}`;
    const password = randomBytes(18).toString("hex");
    const port = await freePort();
    start(
      name,
      [
        "--rm",
        "--tmpfs", "/data", "--tmpfs", "/logs",
        "-p", `127.0.0.1:${port}:7687`,
        "-e", "NEO4J_AUTH",
        "-e", `NEO4J_server_bolt_advertised__address=127.0.0.1:${port}`,
        "-e", "NEO4J_server_memory_heap_initial__size=256m",
        "-e", "NEO4J_server_memory_heap_max__size=512m",
        "-e", "NEO4J_server_memory_pagecache_size=128m",
        NEO4J_IMAGE,
      ],
      { NEO4J_AUTH: `${USER}/${password}` },
    );
    await until("Neo4j", async () => {
      const d = neo4j.driver(`bolt://127.0.0.1:${port}`, neo4j.auth.basic(USER, password));
      try {
        await d.verifyConnectivity();
      } finally {
        await d.close().catch(() => {});
      }
    });
    return { id, name, port, password };
  })();
  return dbPromise;
}

let proxyPromise;
function proxyEnvironment() {
  proxyPromise ??= (async () => {
    const db = await neo4jServer();
    if (!existsSync(path.join(PEER_DEPS, "node_modules", "neo4j-driver", "package.json"))) {
      mkdirSync(PEER_DEPS, { recursive: true });
      const install = `feat-neo4j-test-install-${db.id}`;
      hook();
      created.push(install);
      docker(["run", "--rm", "--name", install, "-v", `${PEER_DEPS}:/work`, "-w", "/work", NODE_IMAGE, "npm", "install", "--no-audit", "--no-fund", "--prefix", "/work", `neo4j-driver@${DRIVER_VERSION}`]);
    }
    const tox = `feat-neo4j-test-tox-${db.id}`;
    const peer = `feat-neo4j-test-peer-${db.id}`;
    start(tox, ["--rm", "-p", "127.0.0.1:0:8474", "-p", `127.0.0.1:0:${CONTROL_PORT}`, TOXIPROXY_IMAGE, "-host=0.0.0.0", "-proxy-metrics"]);
    start(peer, ["--rm", `--network=container:${tox}`, "-v", `${PEER_DEPS}:/deps:ro`, "-v", `${AGENT_FILE}:/agent.cjs:ro`, NODE_IMAGE, "node", "/agent.cjs"]);
    const api = `http://127.0.0.1:${hostPort(tox, 8474)}`;
    const controlPort = hostPort(tox, CONTROL_PORT);
    await until("the Toxiproxy API", async () => {
      const r = await fetch(`${api}/version`);
      if (!r.ok) throw new Error(String(r.status));
    });
    await until("the peer agent", () => new Promise((resolve, reject) => {
      const s = net.connect(controlPort, "127.0.0.1");
      s.on("connect", () => { s.destroy(); resolve(); });
      s.on("error", reject);
    }));
    return { tox, peer, api, controlPort };
  })();
  return proxyPromise;
}

/** One request to the peer agent: the system creates a node through `uri`, returns "ok" or the driver's error code. */
function peerCreate(env, request) {
  return new Promise((resolve, reject) => {
    const s = net.connect(env.controlPort, "127.0.0.1");
    let buf = "";
    const timer = setTimeout(() => { s.destroy(); reject(new Error("the peer agent did not answer")); }, 30_000);
    s.on("connect", () => s.write(JSON.stringify(request) + "\n"));
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        clearTimeout(timer);
        s.destroy();
        const r = JSON.parse(buf.trim());
        resolve(r.ok ? "ok" : { code: r.err, message: r.message });
      }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// A script label (a, b) is mapped to `s` + 12 hex of a sha256 that also covers a per-call salt. The container is
// shared by every scenario of a test file, and a fault leaves a constraint and a placeholder in its namespace until a
// reset: a fresh namespace per call isolates the scenarios from each other.
const SALT = randomBytes(4).toString("hex");
let calls = 0;
const namespaceOf = (label, call) => `s${createHash("sha256").update(`${label}:${SALT}:${call}`).digest("hex").slice(0, 12)}`;
const quote = (name) => "`" + name.replace(/`/g, "``") + "`";

// ServiceUnavailable and SessionExpired, and the driver's own deadline: a stalled handshake (the Timeout fault) ends as
// "Connection acquisition timed out", an error the driver gives the code "N/A".
const isTransport = (e) => TRANSPORT_CODES.has(e.code) || (e.code === "N/A" && /timed out/i.test(String(e.message)));

function outcomeOf(e) {
  if (e && e.code === "Neo.ClientError.Schema.ConstraintValidationFailed") return "CONSTRAINT_VIOLATION";
  if (e && isTransport(e)) return "TRANSPORT_FAILURE";
  throw e;
}

async function run(input, mode) {
  const db = await neo4jServer();
  const env = mode === "observe" ? undefined : await proxyEnvironment();
  if (env !== undefined) {
    const all = await (await fetch(`${env.api}/proxies`)).json();
    for (const n of Object.keys(all)) await fetch(`${env.api}/proxies/${n}`, { method: "DELETE" });
  }

  const steps = input.script.trim().split(/\s+/);
  const direct = `bolt://127.0.0.1:${db.port}`;
  const uri = input.uri === "routing" ? `neo4j://127.0.0.1:${db.port}` : input.uri === "unreachable" ? "bolt://127.0.0.1:1" : direct;
  process.env.FEAT_NEO4J_TEST_URI = uri;
  process.env.FEAT_NEO4J_TEST_USER = USER;
  process.env.FEAT_NEO4J_TEST_PASSWORD = db.password;

  const adapters = new Map();
  const call = ++calls;
  const nsOf = (l) => (l.startsWith("raw=") ? l.slice(4) : namespaceOf(l, call));
  const make = (l) => {
    const options = {
      uriEnv: "FEAT_NEO4J_TEST_URI",
      auth: { username: "FEAT_NEO4J_TEST_USER", password: "FEAT_NEO4J_TEST_PASSWORD" },
      keys: KEYS,
      ...(input.settleTimeoutMs !== undefined ? { settleTimeoutMs: input.settleTimeoutMs } : {}),
      ...(env !== undefined ? { proxy: { api: env.api, upstream: `host.docker.internal:${db.port}` } } : {}),
    };
    return createAdapter({ key: "neo4j", namespace: nsOf(l), options });
  };
  const adapter = (l) => {
    let a = adapters.get(l);
    if (a === undefined) {
      a = make(l);
      adapters.set(l, a);
    }
    return a;
  };

  // The system's own driver: direct to the product (the adapter's instrument is another driver).
  let system;
  const sys = () => (system ??= neo4j.driver(direct, neo4j.auth.basic(USER, db.password)));
  const open = new Map();
  const write = async (cypher, params) => {
    const session = sys().session();
    try {
      await session.run(cypher, params);
    } finally {
      await session.close();
    }
  };

  const trace = [];
  const body = {};
  let last;
  let lastPeek;
  let peekEqualsStop;
  const records = (rs) => rs.map((r) => `${r.type}:${r.key}`).join(",");
  try {
    for (const step of steps) {
      const [kind, l, a, b, c, d, e] = step.split(":");
      const ns = kind === "createraw" ? undefined : nsOf(l);
      switch (kind) {
        case "setup":
          await adapter(l).setup();
          trace.push(`setup:${l}`);
          break;
        case "observes": {
          const o = adapter(l).observes;
          trace.push(`observes:${l}=${o.diff}/${o.state}`);
          break;
        }
        case "seed":
          await adapter(l).seed([{ type: a, values: { [KEYS[a]]: b } }]);
          trace.push(`seed:${l}`);
          break;
        case "create": {
          let outcome = "ok";
          if (env !== undefined) {
            const listen = adapter(l).proxyListen();
            const r = await peerCreate(env, {
              uri: `bolt://127.0.0.1:${listen.slice(listen.lastIndexOf(":") + 1)}`,
              user: USER,
              pass: db.password,
              label: a,
              keyprop: KEYS[a],
              key: b,
              ns,
            });
            if (r !== "ok") outcome = isTransport(r) ? "TRANSPORT_FAILURE" : r.code;
          } else {
            try {
              await write(`CREATE (n:${quote(a)}:${quote(`ns_${ns}`)} {${quote(KEYS[a])}: $key})`, { key: b });
            } catch (err) {
              outcome = outcomeOf(err);
            }
          }
          trace.push(outcome === "ok" ? `create:${l}` : `create:${l}!${outcome}`);
          break;
        }
        case "setprop":
          await write(`MATCH (n:${quote(a)}:${quote(`ns_${ns}`)} {${quote(KEYS[a])}: $key}) SET n.v = $val`, { key: b, val: c });
          trace.push(`setprop:${l}`);
          break;
        case "remove":
          await write(`MATCH (n:${quote(a)}:${quote(`ns_${ns}`)} {${quote(KEYS[a])}: $key}) DETACH DELETE n`, { key: b });
          trace.push(`remove:${l}`);
          break;
        case "link":
          await write(
            `MATCH (x:${quote(a)}:${quote(`ns_${ns}`)} {${quote(KEYS[a])}: $k1}), (y:${quote(d)}:${quote(`ns_${ns}`)} {${quote(KEYS[d])}: $k2}) CREATE (x)-[:${quote(c)}]->(y)`,
            { k1: b, k2: e },
          );
          trace.push(`link:${l}`);
          break;
        case "linkout":
          await write(`MATCH (x:${quote(a)}:${quote(`ns_${ns}`)} {${quote(KEYS[a])}: $key}) CREATE (x)-[:${quote(c)}]->(:Outside)`, { key: b });
          trace.push(`linkout:${l}`);
          break;
        case "createraw":
          await write(`CREATE (n:${quote(l)} {${quote(KEYS[l])}: $key})`, { key: a });
          trace.push("createraw");
          break;
        case "createmystery":
          await write(`CREATE (n:Mystery:${quote(`ns_${ns}`)} {x: 1})`, {});
          trace.push(`createmystery:${l}`);
          break;
        case "txopen": {
          const session = sys().session();
          const tx = session.beginTransaction();
          await tx.run(`CREATE (n:${quote(a)}:${quote(`ns_${ns}`)} {${quote(KEYS[a])}: $key})`, { key: b });
          open.set(l, { session, tx });
          trace.push(`txopen:${l}`);
          break;
        }
        case "txclose": {
          const t = open.get(l);
          open.delete(l);
          await t.tx.commit();
          await t.session.close();
          trace.push(`txclose:${l}`);
          break;
        }
        case "start":
          await adapter(l).startCapture();
          trace.push(`start:${l}`);
          break;
        case "peek": {
          lastPeek = await adapter(l).peekCapture();
          last = records(lastPeek);
          trace.push(`peek:${l}=${lastPeek.length}`);
          break;
        }
        case "stop": {
          const rs = await adapter(l).stopCapture();
          last = records(rs);
          if (lastPeek !== undefined) peekEqualsStop = JSON.stringify(lastPeek.map(({ timestamp, ...r }) => r)) === JSON.stringify(rs.map(({ timestamp, ...r }) => r));
          lastPeek = undefined;
          trace.push(`stop:${l}=${rs.length}`);
          break;
        }
        case "settle":
          trace.push(`settle:${l}=${await adapter(l).settle()}`);
          break;
        case "reset":
          await adapter(l).reset();
          trace.push(`reset:${l}`);
          break;
        case "read": {
          const x = adapter(l);
          const rs = await x.read(a === undefined ? {} : { expect: [{ type: a, key: { [KEYS[a]]: b } }] });
          trace.push(`read:${l}${a === undefined ? "" : `:${a}:${b}`}=${rs.length}`);
          body.readVia = x.lastReadVia;
          break;
        }
        case "fault": {
          const [operation, fault] = a.split(".");
          const isConnection = operation === "Connection";
          let detail;
          let count = c;
          if (isConnection) count = b;
          else if (b !== undefined) {
            const eq = b.indexOf("=");
            detail = eq < 0 ? { property: b } : { property: b.slice(0, eq), value: b.slice(eq + 1) };
          }
          const times = count === undefined || count === "reset" ? "reset" : count === "once" ? 1 : Number(count.replace("times", ""));
          await adapter(l).fault({ operation, fault, ...(detail !== undefined ? { detail } : {}), times });
          trace.push(`fault:${l}:${a}`);
          break;
        }
        case "fired": {
          const x = adapter(l);
          const fired = typeof x.firedFaults === "function" ? JSON.stringify(await x.firedFaults()) : "unobserved";
          trace.push(`fired:${l}=${fired}`);
          break;
        }
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    body.trace = trace.join(" ");
    if (last) body.last = last;
    if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
    return { status: "OK", body };
  } catch (e) {
    if (e instanceof Neo4jAdapterError) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    // Roll back what the system left open, clear what the faults left, then let each adapter close what it opened.
    for (const t of open.values()) {
      await t.tx.rollback().catch(() => {});
      await t.session.close().catch(() => {});
    }
    for (const x of adapters.values()) await x.reset().catch(() => {});
    for (const x of adapters.values()) await x.teardown().catch(() => {});
    if (system !== undefined) await system.close().catch(() => {});
  }
}

export const observe = (input) => run(input, "observe");
export const observeTransport = (input) => run(input, "transport");
