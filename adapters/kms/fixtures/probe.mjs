// The probe behind `ObserveKms` (SPEC-ADPKMS-001). Part of the build, not shipped.
//
// It starts, once per process, one throwaway local-kms container and removes it on exit:
//   feat-kms-test-kms-<id>   nsmithuk/local-kms, pinned by digest, one random loopback port published
// Fake static credentials and a localhost endpoint only; nothing here reaches AWS.
// Only containers this probe created, by name, are ever touched.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateAliasCommand,
  CreateKeyCommand,
  DeleteAliasCommand,
  DescribeKeyCommand,
  DisableKeyCommand,
  EnableKeyRotationCommand,
  EncryptCommand,
  KMSClient,
  ScheduleKeyDeletionCommand,
  TagResourceCommand,
} from "@aws-sdk/client-kms";
import { faultProblem } from "@mmmnt/feat-runtime";
import { createAdapter, KmsAdapterError } from "../src/index.ts";

process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.FEAT_KMS_TEST_ACCESS_KEY_ID = "local";
process.env.FEAT_KMS_TEST_SECRET_ACCESS_KEY = "local";

// The newest local-kms build (2026-02-28; the same digest `latest` and `circleci` carry). It has no
// version tag, so it is pinned by digest.
export const LOCAL_KMS_IMAGE = "nsmithuk/local-kms@sha256:e070866476b20973a9e23a9b636204b7a222e4169a6e03198d27b80d47ed28e3";

const REGION = "eu-west-2";
const AUTH = { accessKeyIdEnv: "FEAT_KMS_TEST_ACCESS_KEY_ID", secretAccessKeyEnv: "FEAT_KMS_TEST_SECRET_ACCESS_KEY" };
const UNREACHABLE = "http://127.0.0.1:1";

const created = [];
let hooked = false;

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function removeAll() {
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

export function start(name, args) {
  hook();
  created.push(name);
  return docker(["run", "-d", "--name", name, ...args]);
}

export function hostPort(name, inner) {
  return Number(docker(["port", name, `${inner}/tcp`]).split("\n")[0].split(":").pop());
}

export function containerIp(name) {
  return docker(["inspect", "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name]);
}

export async function until(what, fn) {
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

export function systemClient(endpoint, extra = {}) {
  return new KMSClient({ endpoint, region: REGION, credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 1, ...extra });
}

let envPromise;

export function kmsEnvironment() {
  envPromise ??= (async () => {
    const id = randomBytes(4).toString("hex");
    const name = `feat-kms-test-kms-${id}`;
    start(name, ["--rm", "-p", "127.0.0.1:0:8080", LOCAL_KMS_IMAGE]);
    const endpoint = `http://127.0.0.1:${hostPort(name, 8080)}`;
    const probe = systemClient(endpoint);
    const { ListKeysCommand } = await import("@aws-sdk/client-kms");
    await until("local-kms", () => probe.send(new ListKeysCommand({ Limit: 1 })));
    probe.destroy();
    return { name, endpoint };
  })();
  return envPromise;
}

// A script label maps to the namespace the runner would derive: `s` + 12 hex of sha256(label).
// `raw=<value>` passes a value as is (for the scenarios that refuse a malformed one).
export function namespaceOf(label) {
  return label.startsWith("raw=") ? label.slice(4) : `s${createHash("sha256").update(label).digest("hex").slice(0, 12)}`;
}

const FAILURES = { DisabledException: "DISABLED", KMSInvalidStateException: "KMS_INVALID_STATE", NotFoundException: "NOT_FOUND" };

function summarize(records) {
  return records
    .map((r) => `${r.type}:${r.key}`)
    .sort((a, b) => a.split(":")[1].localeCompare(b.split(":")[1]))
    .join(",");
}

// What the read sent to KMS, to tell a DescribeKey read from a ListKeys one. Scoped to one read.
let sentLog;
function installCommandLog() {
  if (KMSClient.prototype.__featLogged) return;
  const original = KMSClient.prototype.send;
  KMSClient.prototype.send = function send(command, ...rest) {
    sentLog?.push(command.constructor.name);
    return original.call(this, command, ...rest);
  };
  KMSClient.prototype.__featLogged = true;
}

export async function observe(input) {
  const env = await kmsEnvironment();
  installCommandLog();
  const endpoint = input.emulator === "unreachable" ? UNREACHABLE : env.endpoint;
  const system = systemClient(env.endpoint);
  const adapters = new Map();
  const trace = [];
  let last;
  let peekEqualsStop;
  let lastPeek;
  let readVia;

  const same = (a, b) => JSON.stringify(a.map(({ timestamp, ...rest }) => rest)) === JSON.stringify(b.map(({ timestamp, ...rest }) => rest));
  const adapterOf = (label) => {
    const a = adapters.get(label);
    if (a === undefined) throw new Error(`the script uses '${label}' before setup:${label}`);
    return a;
  };
  const aliasOf = (label, alias) => `alias/${namespaceOf(label)}/${alias}`;
  const keyIdOf = async (label, alias) => (await system.send(new DescribeKeyCommand({ KeyId: aliasOf(label, alias) }))).KeyMetadata.KeyId;

  try {
    for (const step of input.script.trim().split(/\s+/)) {
      const parts = step.split(":");
      const [kind, a, b, c, d] = parts;
      switch (kind) {
        case "setup": {
          const adapter = createAdapter({
            key: "kms",
            namespace: namespaceOf(a),
            options: {
              endpoint,
              region: REGION,
              auth: AUTH,
              ...(input.emulator === "local-kms" ? { emulator: "local-kms" } : {}),
              ...(input.settleTimeoutMs !== undefined ? { settleTimeoutMs: input.settleTimeoutMs } : {}),
            },
          });
          adapters.set(a, adapter);
          await adapter.setup();
          // What the harness does before every case.
          await adapter.reset();
          trace.push(`setup:${a}`);
          break;
        }
        case "observes": {
          const o = adapterOf(a).observes;
          trace.push(`observes:${a}=${o.diff}/${o.state}`);
          break;
        }
        case "seed":
          await adapterOf(a).seed([{ type: "Key", values: { alias: b } }]);
          trace.push(`seed:${a}`);
          break;
        case "createkey": {
          const k = (await system.send(new CreateKeyCommand({}))).KeyMetadata.KeyId;
          await system.send(new CreateAliasCommand({ AliasName: aliasOf(a, b), TargetKeyId: k }));
          trace.push(`createkey:${a}`);
          break;
        }
        case "createkeyraw":
          await system.send(new CreateKeyCommand({ Description: `feat-kms-test raw ${a}` }));
          trace.push("createkeyraw");
          break;
        case "disable":
          await system.send(new DisableKeyCommand({ KeyId: await keyIdOf(a, b) }));
          trace.push(`disable:${a}`);
          break;
        case "schedule":
          await system.send(new ScheduleKeyDeletionCommand({ KeyId: await keyIdOf(a, b), PendingWindowInDays: 7 }));
          trace.push(`schedule:${a}`);
          break;
        case "rotate":
          await system.send(new EnableKeyRotationCommand({ KeyId: await keyIdOf(a, b) }));
          trace.push(`rotate:${a}`);
          break;
        case "tag":
          await system.send(new TagResourceCommand({ KeyId: await keyIdOf(a, b), Tags: [{ TagKey: c, TagValue: d }] }));
          trace.push(`tag:${a}`);
          break;
        case "deletealias":
          await system.send(new DeleteAliasCommand({ AliasName: aliasOf(a, b) }));
          trace.push(`deletealias:${a}`);
          break;
        case "encrypt":
          try {
            await system.send(new EncryptCommand({ KeyId: aliasOf(a, b), Plaintext: Buffer.from("feat") }));
            trace.push(`encrypt:${a}`);
          } catch (e) {
            trace.push(`encrypt:${a}!${FAILURES[e.name] ?? e.name}`);
          }
          break;
        case "start":
          await adapterOf(a).startCapture();
          trace.push(`start:${a}`);
          break;
        case "peek": {
          lastPeek = await adapterOf(a).peekCapture();
          last = summarize(lastPeek);
          trace.push(`peek:${a}=${lastPeek.length}`);
          break;
        }
        case "stop": {
          const records = await adapterOf(a).stopCapture();
          last = summarize(records);
          if (lastPeek !== undefined) peekEqualsStop = same(lastPeek, records);
          lastPeek = undefined;
          trace.push(`stop:${a}=${records.length}`);
          break;
        }
        case "settle":
          trace.push(`settle:${a}=${await adapterOf(a).settle()}`);
          break;
        case "reset":
          await adapterOf(a).reset();
          trace.push(`reset:${a}`);
          break;
        case "read": {
          sentLog = [];
          const query = b === undefined ? {} : { expect: [{ type: "Key", key: { alias: b } }] };
          const records = await adapterOf(a).read(query);
          readVia = sentLog.includes("ListKeysCommand") ? "ListKeys" : "DescribeKey";
          sentLog = undefined;
          trace.push(`read:${a}${b === undefined ? "" : `:${b}`}=${records.length}`);
          break;
        }
        case "fault": {
          // fault:<ns>:UseKey.<FAULT>:<alias>[:once|:times<n>|:reset]
          const [operation, fault] = b.split(".");
          const times = d === "once" ? 1 : /^times\d+$/.test(d ?? "") ? Number(d.slice(5)) : "reset";
          const detail = { alias: c };
          const problem = faultProblem(adapterOf(a), { service: "kms", operation, fault, times, detail });
          if (problem !== undefined) throw new KmsAdapterError("FAULT_UNSUPPORTED", problem);
          await adapterOf(a).fault({ operation, fault, detail, times });
          trace.push(`fault:${a}:${b}`);
          break;
        }
        case "fired": {
          const adapter = adapterOf(a);
          if (typeof adapter.firedFaults !== "function") trace.push(`fired:${a}=unobserved`);
          else trace.push(`fired:${a}=${JSON.stringify(await adapter.firedFaults())}`);
          break;
        }
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    const body = { trace: trace.join(" ") };
    if (last) body.last = last;
    if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
    if (readVia !== undefined) body.readVia = readVia;
    return { status: "OK", body };
  } catch (e) {
    if (e instanceof KmsAdapterError) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    sentLog = undefined;
    for (const adapter of adapters.values()) {
      await adapter.reset().catch(() => {});
      await adapter.teardown().catch(() => {});
    }
    system.destroy();
  }
}

// ── SPEC-ADPKMS-002: transport faults on the system's path ───────────────────
// Adds, once per process, beside the local-kms container:
//   feat-kms-test-tox-<id>    Toxiproxy (pinned), API and the agent's control port published on loopback
//   feat-kms-test-peer-<id>   shares the Toxiproxy network namespace: system-agent.mjs, the real SDK as "the system"
// The proxy's upstream is local-kms's container address, which Toxiproxy reaches on the bridge network.
export const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
export const NODE_IMAGE = "node:22.12.0-slim";
const CONTROL_PORT = 19002;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let transportPromise;

function transportEnvironment() {
  transportPromise ??= (async () => {
    const kms = await kmsEnvironment();
    const id = randomBytes(4).toString("hex");
    const tox = `feat-kms-test-tox-${id}`;
    const peer = `feat-kms-test-peer-${id}`;
    start(tox, ["--rm", "-p", "127.0.0.1:0:8474", "-p", `127.0.0.1:0:${CONTROL_PORT}`, TOXIPROXY_IMAGE, "-host=0.0.0.0", "-proxy-metrics"]);
    start(peer, ["--rm", `--network=container:${tox}`, "-v", `${ROOT}:${ROOT}:ro`, "-e", `FEAT_KMS_CONTROL_PORT=${CONTROL_PORT}`, NODE_IMAGE, "node", `${ROOT}/adapters/kms/fixtures/system-agent.mjs`]);
    const api = `http://127.0.0.1:${hostPort(tox, 8474)}`;
    const controlPort = hostPort(tox, CONTROL_PORT);
    await until("the Toxiproxy API", async () => {
      const r = await fetch(`${api}/version`);
      if (!r.ok) throw new Error(String(r.status));
    });
    await until("the system agent", () => control(controlPort, "ping"));
    return { api, controlPort, upstream: `${containerIp(kms.name)}:8080`, endpoint: kms.endpoint };
  })();
  return transportPromise;
}

function control(port, line) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, "127.0.0.1");
    let buf = "";
    s.on("connect", () => s.write(`${line}\n`));
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

export async function observeTransport(input) {
  const env = await transportEnvironment();
  const adapters = new Map();
  const trace = [];
  let last;
  const adapterOf = (label) => {
    const a = adapters.get(label);
    if (a === undefined) throw new Error(`the script uses '${label}' before setup:${label}`);
    return a;
  };
  try {
    for (const step of input.script.trim().split(/\s+/)) {
      const [kind, a, b, c] = step.split(":");
      switch (kind) {
        case "setup": {
          const adapter = createAdapter({
            key: "kms",
            namespace: namespaceOf(a),
            options: {
              endpoint: env.endpoint,
              region: REGION,
              auth: AUTH,
              emulator: "local-kms",
              ...(input.settleTimeoutMs !== undefined ? { settleTimeoutMs: input.settleTimeoutMs } : {}),
              proxy: { api: env.api, upstream: env.upstream },
            },
          });
          adapters.set(a, adapter);
          await adapter.setup();
          await adapter.reset();
          trace.push(`setup:${a}`);
          break;
        }
        case "start":
          await adapterOf(a).startCapture();
          trace.push(`start:${a}`);
          break;
        case "stop": {
          const records = await adapterOf(a).stopCapture();
          last = summarize(records);
          trace.push(`stop:${a}=${records.length}`);
          break;
        }
        case "settle":
          trace.push(`settle:${a}=${await adapterOf(a).settle()}`);
          break;
        case "reset":
          await adapterOf(a).reset();
          trace.push(`reset:${a}`);
          break;
        case "fired": {
          const adapter = adapterOf(a);
          trace.push(typeof adapter.firedFaults === "function" ? `fired:${a}=${JSON.stringify(await adapter.firedFaults())}` : `fired:${a}=unobserved`);
          break;
        }
        case "fault": {
          // fault:<ns>:Connection.<Fault>[:once|:times<n>]
          const [operation, fault] = b.split(".");
          const times = c === "once" ? 1 : /^times\d+$/.test(c ?? "") ? Number(c.slice(5)) : "reset";
          const problem = faultProblem(adapterOf(a), { service: "kms", operation, fault, times });
          if (problem !== undefined) throw new KmsAdapterError("FAULT_UNSUPPORTED", problem);
          await adapterOf(a).fault({ operation, fault, times });
          trace.push(`fault:${a}:${b}`);
          break;
        }
        case "createkey": {
          const listen = await adapterOf(a).proxyListen();
          const outcome = await control(env.controlPort, `createkey ${listen.slice(listen.lastIndexOf(":") + 1)} ${namespaceOf(a)} ${b}`);
          trace.push(outcome === "ok" ? `createkey:${a}` : `createkey:${a}!${outcome === "transport" ? "TRANSPORT_FAILURE" : outcome}`);
          break;
        }
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    const body = { trace: trace.join(" ") };
    if (last) body.last = last;
    return { status: "OK", body };
  } catch (e) {
    if (e instanceof KmsAdapterError) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    for (const adapter of adapters.values()) {
      await adapter.reset().catch(() => {});
      await adapter.teardown().catch(() => {});
    }
  }
}
