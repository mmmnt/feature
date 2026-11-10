// The probe behind `ObserveKurrent`, `ObserveKurrentTransport` and `ObserveKurrentBrokerLoss`
// (SPEC-ADPKUR-001, -002, -003). Part of the build, inside touches, not shipped.
//
// It starts, once per process, the throwaway containers the scenarios need and removes them on exit:
//   feat-kurrent-test-kdb-<id>   KurrentDB (pinned image), single node, dev certificate (secure: ACLs and
//                                users exist only on a secure node), projections off, in-memory database,
//                                its HTTP/gRPC port published on a random loopback port
//   feat-kurrent-test-tox-<id>   Toxiproxy (pinned image), API and control port published (transport only)
//   feat-kurrent-test-peer-<id>  shares the Toxiproxy network namespace: the system's client (peer-agent.cjs).
//                                A client of a proxied path must run there: Docker Desktop's host proxy
//                                accepts a connection the proxy refused and hides a TCP reset.
//   feat-kurrent-test-install-<id>  a one-off container that installs the pinned client for linux into
//                                .feature/kurrent-peer (the host's install carries only the host's binding)
// Only containers this probe created, by name, are ever touched. Fixture users: admin (the instrument and
// the system's default), `writer` (non-admin: the system that an ACL can deny) and `reader` (cannot read $all).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANY, jsonEvent, KurrentDBClient, NO_STREAM, START, streamNameFilter } from "@kurrent/kurrentdb-client";
import { createAdapter, KurrentAdapterError } from "../src/index.ts";

export const KURRENTDB_IMAGE = "kurrentplatform/kurrentdb:26.2.3";
export const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
export const NODE_IMAGE = "node:22.12.0-slim";
export const CLIENT_VERSION = "1.3.2";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const PEER_DEPS = path.join(ROOT, ".feature", "kurrent-peer");
const CONTROL_PORT = 19002;
const SYSTEM_DEADLINE_MS = 2000;
const USERS = { admin: ["admin", "changeit"], writer: ["writer", "Writer-pw-1"], reader: ["reader", "Reader-pw-1"] };
// UNAVAILABLE, DEADLINE_EXCEEDED and CANCELLED from the client. A broken connection arrives from this client as an
// error of type "unknown" carrying the gRPC status (14 UNAVAILABLE, 4 DEADLINE_EXCEEDED, 1 CANCELLED), so both count.
const TRANSPORT_TYPES = new Set(["unavailable", "deadline-exceeded", "cancelled"]);
const TRANSPORT_CODES = new Set([14, 4, 1]);
const isTransport = (o) => TRANSPORT_TYPES.has(o.type) || TRANSPORT_CODES.has(o.code);

const created = [];
let hooked = false;

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function removeAll() {
  // One call for every container this probe created, so a worker killed mid-cleanup cannot leave half.
  const names = created.splice(0);
  if (names.length > 0) spawnSync("docker", ["rm", "-f", ...names], { stdio: "ignore" });
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

function start(name, args) {
  hook();
  created.push(name);
  return docker(["run", "-d", "--name", name, ...args]);
}

function hostPort(name, inner) {
  return Number(docker(["port", name, `${inner}/tcp`]).split("\n")[0].split(":").pop());
}

async function until(what, fn, ms = 60_000) {
  const deadline = Date.now() + ms;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error(`${what} did not come up: ${last}`);
}

function createUser(port, [login, password], groups) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ loginName: login, fullName: login, password, groups });
    const req = https.request(
      {
        host: "127.0.0.1",
        port,
        path: "/users",
        method: "POST",
        rejectUnauthorized: false,
        auth: `${USERS.admin[0]}:${USERS.admin[1]}`,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      },
      (res) => {
        res.resume();
        res.on("end", () => (res.statusCode === 201 || res.statusCode === 200 ? resolve() : reject(new Error(`create user ${login}: HTTP ${res.statusCode}`))));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const connectionString = (port, user, host = "127.0.0.1", extra = "") =>
  `kurrentdb://${encodeURIComponent(user[0])}:${encodeURIComponent(user[1])}@${host}:${port}?tls=true&tlsVerifyCert=false${extra}`;

let kdbPromise;
function kurrent() {
  kdbPromise ??= (async () => {
    const id = randomBytes(4).toString("hex");
    const name = `feat-kurrent-test-kdb-${id}`;
    start(name, [
      "--rm",
      "-p", "127.0.0.1:0:2113",
      "-e", "KURRENTDB_DEV=true",
      "-e", "KURRENTDB_RUN_PROJECTIONS=None",
      "-e", "KURRENTDB_START_STANDARD_PROJECTIONS=false",
      "-e", "KURRENTDB_MEM_DB=true",
      "-e", "KURRENTDB_ENABLE_ATOM_PUB_OVER_HTTP=true",
      KURRENTDB_IMAGE,
    ]);
    const port = hostPort(name, 2113);
    // A fresh client per attempt: one that failed while the node was starting keeps its failed channel.
    await until("KurrentDB", async () => {
      const probeClient = KurrentDBClient.connectionString(connectionString(port, USERS.admin));
      try {
        for await (const _ of probeClient.readAll({ fromPosition: START, maxCount: 1, deadline: 2000 })) break;
      } finally {
        await probeClient.dispose().catch(() => {});
      }
    });
    const admin = KurrentDBClient.connectionString(connectionString(port, USERS.admin));
    await until("the fixture users", async () => {
      await createUser(port, USERS.writer, []).catch((e) => { if (!/HTTP 409/.test(String(e))) throw e; });
      await createUser(port, USERS.reader, []).catch((e) => { if (!/HTTP 409/.test(String(e))) throw e; });
    });
    return { id, name, port, admin };
  })();
  return kdbPromise;
}

const AGENT_FILE = path.join(HERE, "peer-agent.cjs");

let proxyPromise;
function proxyEnvironment() {
  proxyPromise ??= (async () => {
    const kdb = await kurrent();
    if (!existsSync(path.join(PEER_DEPS, "node_modules", "@kurrent", "kurrentdb-client", "package.json"))) {
      mkdirSync(PEER_DEPS, { recursive: true });
      const install = `feat-kurrent-test-install-${kdb.id}`;
      hook();
      created.push(install);
      docker(["run", "--rm", "--name", install, "-v", `${PEER_DEPS}:/work`, "-w", "/work", NODE_IMAGE, "npm", "install", "--no-audit", "--no-fund", "--prefix", "/work", `@kurrent/kurrentdb-client@${CLIENT_VERSION}`]);
    }
    const tox = `feat-kurrent-test-tox-${kdb.id}`;
    const peer = `feat-kurrent-test-peer-${kdb.id}`;
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

/** One request to the peer agent: the system appends through `connect`, returns "ok" or the client's error type. */
function peerAppend(env, request) {
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
        resolve(r.ok ? "ok" : { type: r.err, code: r.code });
      }
    });
    s.on("error", (e) => { clearTimeout(timer); reject(e); });
  });
}

// A script label (a, b) is mapped to `s` + 12 hex of a sha256 that also covers a per-call salt. The containers are
// shared by every scenario of a test file, and a namespace reused after a reset is not clean on this product: a
// stream that was soft-deleted gets a server-written `$metadata` event ({"$tb": n}) from its next append, which a
// capture keeps (see the report on SPEC-ADPKUR-001). A fresh namespace per call isolates the scenarios from each other.
const SALT = randomBytes(4).toString("hex");
let calls = 0;
const namespaceOf = (label, call) => `s${createHash("sha256").update(`${label}:${SALT}:${call}`).digest("hex").slice(0, 12)}`;
const upperSnake = (type) => type.toUpperCase().replace(/-/g, "_");

async function containerState(name) {
  const state = docker(["inspect", "--format", "{{.State.Status}}", name]);
  return state === "exited" ? "stopped" : state;
}

async function run(input, mode) {
  const kdb = await kurrent();
  const env = mode === "observe" ? undefined : await proxyEnvironment();
  if ((await containerState(kdb.name)) === "paused") docker(["unpause", kdb.name]);
  if (env !== undefined) {
    const all = await (await fetch(`${env.api}/proxies`)).json();
    for (const n of Object.keys(all)) await fetch(`${env.api}/proxies/${n}`, { method: "DELETE" });
  }

  const steps = input.script.trim().split(/\s+/);

  const credentials = input.credentials === "reader" ? USERS.reader : USERS.admin;
  process.env.FEAT_KURRENT_TEST_USER = credentials[0];
  process.env.FEAT_KURRENT_TEST_PASSWORD = credentials[1];
  process.env.FEAT_KURRENT_TEST_CONNECTION = connectionString(kdb.port, USERS.admin).replace(/\/\/[^@]*@/, "//");
  process.env.AWS_EC2_METADATA_DISABLED = "true";

  const adapters = new Map();
  const writers = new Map();
  const writerFor = (user) => {
    if (!writers.has(user)) writers.set(user, KurrentDBClient.connectionString(connectionString(kdb.port, USERS[user])));
    return writers.get(user);
  };
  const call = ++calls;
  const nsOf = (l) => (l.startsWith("raw=") ? l.slice(4) : namespaceOf(l, call));
  const make = (l) => {
    const options = {
      connectionStringEnv: "FEAT_KURRENT_TEST_CONNECTION",
      system: { username: "FEAT_KURRENT_TEST_USER", password: "FEAT_KURRENT_TEST_PASSWORD" },
      ...(input.settleTimeoutMs !== undefined ? { settleTimeoutMs: input.settleTimeoutMs } : {}),
      ...(env !== undefined
        ? {
            proxy: {
              api: env.api,
              upstream: `host.docker.internal:${kdb.port}`,
              ...(mode === "broker-loss" ? { container: kdb.name } : {}),
            },
          }
        : {}),
    };
    return createAdapter({ key: "kurrent", namespace: nsOf(l), options });
  };
  const adapter = (l) => {
    let a = adapters.get(l);
    if (a === undefined) {
      a = make(l);
      adapters.set(l, a);
    }
    return a;
  };

  const trace = [];
  let last;
  let lastPeek;
  let peekEqualsStop;
  const records = (rs) => rs.map((r) => `${r.key}/${r.type}`).join(",");
  try {
    for (const step of steps) {
      const [kind, l, a, b, c] = step.split(":");
      switch (kind) {
        case "setup":
          await adapter(l).setup();
          trace.push(`setup:${l}`);
          break;
        case "seed":
          await adapter(l).seed([{ type: b, values: { stream: a } }]);
          trace.push(`seed:${l}`);
          break;
        case "write":
        case "writenew":
        case "writeuser": {
          const stream = `${nsOf(l)}.${a}`;
          const state = kind === "writenew" ? "nostream" : "any";
          let outcome;
          if (env !== undefined) {
            const listen = adapter(l).proxyListen();
            const cs = connectionString(listen.slice(listen.lastIndexOf(":") + 1), USERS.admin, "127.0.0.1", `&defaultDeadline=${SYSTEM_DEADLINE_MS}`);
            outcome = await peerAppend(env, { cs, stream, type: b, state });
          } else {
            try {
              await writerFor(kind === "writeuser" ? "writer" : "admin").appendToStream(stream, jsonEvent({ type: b, data: {} }), { streamState: state === "nostream" ? NO_STREAM : ANY });
              outcome = "ok";
            } catch (e) {
              outcome = { type: e.type ?? "unknown", code: e.code };
            }
          }
          if (outcome === "ok") trace.push(`${kind}:${l}`);
          else trace.push(`${kind}:${l}!${isTransport(outcome) ? "TRANSPORT_FAILURE" : upperSnake(outcome.type)}`);
          break;
        }
        case "writeraw":
          await kdb.admin.appendToStream(`elsewhere.${l}`, jsonEvent({ type: a, data: {} }), { streamState: ANY });
          trace.push("writeraw");
          break;
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
          if (lastPeek !== undefined) peekEqualsStop = JSON.stringify(lastPeek) === JSON.stringify(rs);
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
          const rs = await adapter(l).read(a === undefined ? {} : { expect: [{ type: "*", key: { stream: a } }] });
          trace.push(`read:${l}${a === undefined ? "" : `:${a}`}=${rs.length}`);
          break;
        }
        case "fault": {
          const [operation, fault] = a.split(".");
          const isConnection = operation === "Connection";
          const stream = isConnection ? undefined : b;
          const count = isConnection ? b : c;
          const times = count === undefined || count === "reset" ? "reset" : count === "once" ? 1 : Number(count.replace("times", ""));
          await adapter(l).fault({ operation, fault, ...(stream !== undefined ? { detail: { stream } } : {}), times });
          trace.push(`fault:${l}:${a}`);
          break;
        }
        case "fired": {
          const fired = typeof adapter(l).firedFaults === "function" ? JSON.stringify(await adapter(l).firedFaults()) : "unobserved";
          trace.push(`fired:${l}=${fired}`);
          break;
        }
        case "container":
          trace.push(`container=${await containerState(kdb.name)}`);
          break;
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    const body = { trace: trace.join(" ") };
    if (last) body.last = last;
    if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
    return { status: "OK", body };
  } catch (e) {
    if (e instanceof KurrentAdapterError) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    // Put the product back before anything else touches it, then let each adapter close what it opened.
    if ((await containerState(kdb.name).catch(() => "")) === "paused") docker(["unpause", kdb.name]);
    for (const a of adapters.values()) await a.teardown().catch(() => {});
    for (const w of writers.values()) await w.dispose().catch(() => {});
  }
}

export const observe = (input) => run(input, "observe");
export const observeTransport = (input) => run(input, "transport");
export const observeBrokerLoss = (input) => run(input, "broker-loss");
