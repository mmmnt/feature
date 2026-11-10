// The probe behind `ProbeFaultProxy` (SPEC-FPX-001). Part of the build, not shipped.
//
// It starts, once per process, the throwaway containers the scenarios need and removes them on exit:
//   feat-fpx-test-tox-<id>     Toxiproxy (pinned image), API and control port published on loopback
//   feat-fpx-test-peer-<id>    shares the Toxiproxy network namespace: the TCP echo server (counts the
//                              messages it receives) and the client that plays "the system under test"
//   feat-fpx-test-broker-<id>  a `sleep` container: the broker BrokerLoss pauses or stops
// The client runs in the Toxiproxy namespace on purpose. A client reaching a published port goes
// through the container runtime's host proxy, which accepts a connection the proxy has refused and
// hides a TCP reset behind a plain close; in the shared namespace the client sees what a real client
// of the product would: ECONNREFUSED, ECONNRESET, silence.
// Only containers this probe created, by name, are ever touched.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { createFaultProxy, FaultProxyError } from "../src/index.ts";
import { dockerAsync } from "./docker-async.mjs";

export const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
export const NODE_IMAGE = "node:22.12.0-slim";

const ECHO_PORT = 19001;
const CONTROL_PORT = 19002;
const PRODUCT = "echo";

const AGENT = `
const net = require("net");
let count = 0;
net.createServer((s) => { s.on("data", (d) => { count++; s.write(d); }); s.on("error", () => {}); }).listen(${ECHO_PORT}, "127.0.0.1");
function send(port, text, reply) {
  let done = false;
  const s = net.connect(Number(port), "127.0.0.1");
  const fin = (r) => { if (done) return; done = true; try { s.destroy(); } catch {} reply(r); };
  s.on("connect", () => s.write(text));
  s.on("data", () => fin("echo"));
  s.on("error", (e) => fin(e.code === "ECONNREFUSED" ? "refused" : e.code === "ECONNRESET" ? "reset" : "error:" + e.code));
  s.on("close", () => fin("closed"));
  setTimeout(() => fin("timeout"), 300);
}
net.createServer((c) => {
  let buf = "";
  c.on("error", () => {});
  c.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line === "count") c.write(count + "\\n");
      else if (line.startsWith("send ")) {
        const [, port, ...rest] = line.split(" ");
        send(port, rest.join(" "), (r) => c.write(r + "\\n"));
      }
    }
  });
}).listen(${CONTROL_PORT}, "0.0.0.0");
`;

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

let envPromise;

async function until(what, fn) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`${what} did not come up: ${last}`);
}

function control(port, line) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    s.on("connect", () => s.write(line + "\n"));
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\n")) {
        s.destroy();
        resolve(buf.trim());
      }
    });
    s.on("error", reject);
    s.on("close", () => buf.includes("\n") || reject(new Error("control connection closed")));
  });
}

function hostPort(name, inner) {
  return Number(docker(["port", name, `${inner}/tcp`]).split("\n")[0].split(":").pop());
}

function environment() {
  envPromise ??= (async () => {
    const id = randomBytes(4).toString("hex");
    const tox = `feat-fpx-test-tox-${id}`;
    const peer = `feat-fpx-test-peer-${id}`;
    const broker = `feat-fpx-test-broker-${id}`;
    start(tox, ["--rm", "-p", "127.0.0.1:0:8474", "-p", `127.0.0.1:0:${CONTROL_PORT}`, TOXIPROXY_IMAGE, "-host=0.0.0.0", "-proxy-metrics"]);
    start(peer, ["--rm", `--network=container:${tox}`, NODE_IMAGE, "node", "-e", AGENT]);
    start(broker, [NODE_IMAGE, "sleep", "900"]);
    const apiPort = hostPort(tox, 8474);
    const controlPort = hostPort(tox, CONTROL_PORT);
    const api = `http://127.0.0.1:${apiPort}`;
    await until("the Toxiproxy API", async () => {
      const r = await fetch(`${api}/version`);
      if (!r.ok) throw new Error(String(r.status));
    });
    await until("the echo peer", () => control(controlPort, "count"));
    return { tox, peer, broker, api, controlPort };
  })();
  return envPromise;
}

async function restoreBroker(env) {
  const state = await dockerAsync(["inspect", "--format", "{{.State.Status}}", env.broker]);
  if (state === "paused") await dockerAsync(["unpause", env.broker]);
  else if (state !== "running") await dockerAsync(["start", env.broker]);
}

async function wipeProxies(env) {
  const all = await (await fetch(`${env.api}/proxies`)).json();
  for (const name of Object.keys(all)) await fetch(`${env.api}/proxies/${name}`, { method: "DELETE" });
}

const UNREACHABLE_API = "http://127.0.0.1:1";

export async function probe(input) {
  const env = await environment();
  await restoreBroker(env);
  await wipeProxies(env);

  const api = input.api === "unreachable" ? UNREACHABLE_API : env.api;
  let container = env.broker;
  if (input.container === "none") container = undefined;
  else if (input.container === "missing") {
    container = "feat-missing";
    // The scenario names a container that must not exist; refuse to run it against one that does.
    const exists = await dockerAsync(["inspect", container]).then(() => true, () => false);
    if (exists) throw new Error(`the container '${container}' exists, so the CONTAINER_NOT_FOUND scenario cannot run`);
  }
  const runtime = input.runtime === "missing" ? "feat-fpx-test-no-such-runtime" : (input.runtime ?? "docker");
  const metrics = input.metrics === "on" ? `${env.api}/metrics` : undefined;

  const libs = new Map();
  const listens = [];
  const lib = (ns) => {
    let l = libs.get(ns);
    if (!l) {
      l = createFaultProxy({
        api,
        product: PRODUCT,
        upstream: `127.0.0.1:${ECHO_PORT}`,
        namespace: ns,
        ...(container !== undefined ? { container } : {}),
        ...(metrics !== undefined ? { metrics } : {}),
        runtime,
      });
      libs.set(ns, { lib: l, listen: undefined });
      l = libs.get(ns);
    }
    return l;
  };
  const proxyName = (ns) => `feat-${ns}-${PRODUCT}`;

  const countAt = async () => Number(await control(env.controlPort, "count"));
  const before = await countAt();
  const trace = [];
  let lastIsOpen = false;
  try {
    for (const step of input.script.trim().split(/\s+/)) {
      const [kind, a, b, c] = step.split(":");
      lastIsOpen = false;
      switch (kind) {
        case "open": {
          const entry = lib(a);
          const opened = await entry.lib.open();
          entry.listen = opened.listen;
          listens.push(opened.listen);
          trace.push(`open:${a}`);
          lastIsOpen = true;
          break;
        }
        case "send": {
          const entry = lib(a);
          const port = entry.listen.slice(entry.listen.lastIndexOf(":") + 1);
          const text = step.slice(kind.length + a.length + 2);
          const outcome = await control(env.controlPort, `send ${port} ${text}`);
          trace.push(`send:${a}=${outcome}`);
          break;
        }
        case "arm": {
          const detail = {};
          if (b === "BrokerLoss") detail.mode = c ?? "pause";
          else if (c !== undefined) detail.stream = c;
          await lib(a).lib.arm(b, detail);
          trace.push(`arm:${a}`);
          break;
        }
        case "disarm":
          await lib(a).lib.disarm();
          trace.push(`disarm:${a}`);
          break;
        case "armed":
          trace.push(`armed:${a}=${lib(a).lib.armed().join(",")}`);
          break;
        case "toxics": {
          const rows = await (await fetch(`${env.api}/proxies/${proxyName(a)}/toxics`)).json();
          trace.push(`toxics:${a}=${rows.length}`);
          break;
        }
        case "enabled": {
          const p = await (await fetch(`${env.api}/proxies/${proxyName(a)}`)).json();
          trace.push(`enabled:${a}=${p.enabled}`);
          break;
        }
        case "container": {
          const state = await dockerAsync(["inspect", "--format", "{{.State.Status}}", env.broker]);
          trace.push(`container=${state === "exited" ? "stopped" : state}`);
          break;
        }
        case "traffic": {
          const t = await lib(a).lib.traffic();
          trace.push(`traffic:${a}=${t === "unobserved" ? "unobserved" : t.received + t.sent > 0 ? "seen" : "none"}`);
          break;
        }
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    if (lastIsOpen && listens.length > 1) {
      trace.push(`listen=${listens[listens.length - 1] === listens[listens.length - 2] ? "same" : "distinct"}`);
    }
    const upstreamSaw = (await countAt()) - before;
    return { status: "OK", body: { trace: trace.join(" "), upstreamSaw } };
  } catch (e) {
    if (e instanceof FaultProxyError) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    for (const { lib: l } of libs.values()) await l.close().catch(() => {});
    await restoreBroker(env).catch(() => {});
  }
}
