// The probe behind `ObserveRedis` (SPEC-ADPRDS-001). Part of the build, inside touches, not shipped.
//
// It starts, once per process, one throwaway container and removes it on exit:
//   feat-redis-test-db-<id>   Redis (pinned by digest), a generated throwaway `requirepass` handed to docker through the
//                             environment and written into a config file inside the container, never an argument; the
//                             port published on a free loopback port. An ACL user whose password starts with a space and
//                             has one inside is created after start (the credential-file trim check).
//   feat-redis-test-tls-<id>  the same image serving TLS only (founder ruling 2026-11-15, "Add TLS test now"), with a
//                             server certificate for 127.0.0.1 and localhost signed by a throwaway CA the probe mints
//                             (@peculiar/x509, a dev dependency); the certificate and key reach the container through
//                             the environment, never a mount. A second throwaway CA signs nothing the server holds.
// Only containers this probe created, by name, are ever touched.
import { execFile, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { webcrypto } from "node:crypto";
// @peculiar/x509 resolves its providers through tsyringe, which needs the Reflect metadata polyfill loaded first.
import "reflect-metadata";
import * as x509 from "@peculiar/x509";
import { createClient } from "redis";
import { createAdapter, RedisAdapterError } from "../src/index.ts";
import { seedTransformOption, transformCalls } from "../../stdio-jsonrpc/fixtures/seed-host.mjs";

// Every container this file starts carries the pid of the run that owns it (ci-local's, passed in as
// FEAT_CI_LOCAL_PID, else this process; scripts/test-owner.mjs adds the container it runs in), so scripts/docker-sweep.sh can remove what a killed run left.
import { OWNER } from "../../../scripts/test-owner.mjs";

// redis 7.4.12, the index digest (linux/amd64 and linux/arm64).
export const REDIS_IMAGE = "redis@sha256:2e3eb11462c4e3759e6972678dd051d150ff54b1e60714b3c33b701260172a90";
// An ACL user whose password starts with a space and has one inside, so a trim beyond the line ending would show.
const SPACED = ["spaced", " spaced pass-1"];

const created = [];
let hooked = false;

// Every docker call a worker makes is asynchronous: one that blocks the event loop past vitest's 60 s RPC timeout ends
// the run with "Timeout calling onTaskUpdate". The one synchronous call left is the removal on exit.
function docker(args, env) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { encoding: "utf8", ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args.slice(0, 2).join(" ")} failed: ${String(stderr).trim() || error.message}`));
      else resolve(stdout.trim());
    });
  });
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
  return docker(["run", "-d", ...OWNER, "--name", name, ...args], env);
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

let serverPromise;
function redisServer() {
  serverPromise ??= (async () => {
    const id = randomBytes(4).toString("hex");
    const name = `feat-redis-test-db-${id}`;
    const password = randomBytes(18).toString("hex");
    const port = await freePort();
    await start(
      name,
      [
        "--rm",
        "-p", `127.0.0.1:${port}:6379`,
        "-e", "FEAT_REDIS_PASS",
        "--entrypoint", "sh",
        REDIS_IMAGE,
        "-c",
        'umask 077; printf "requirepass %s\\nsave \\"\\"\\nappendonly no\\n" "$FEAT_REDIS_PASS" > /tmp/r.conf; unset FEAT_REDIS_PASS; exec redis-server /tmp/r.conf',
      ],
      { FEAT_REDIS_PASS: password },
    );
    await until("Redis", async () => {
      const c = createClient({ url: `redis://127.0.0.1:${port}`, password, socket: { reconnectStrategy: false, connectTimeout: 2000 } });
      c.on("error", () => {});
      try {
        await c.connect();
        await c.sendCommand(["ACL", "SETUSER", SPACED[0], "on", `>${SPACED[1]}`, "~*", "+@all"]);
      } finally {
        if (c.isOpen) await c.quit().catch(() => {});
      }
    });
    return { id, name, port, password };
  })();
  return serverPromise;
}

x509.cryptoProvider.set(webcrypto);
const EC = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };

function pemKey(der) {
  const b64 = Buffer.from(der).toString("base64").replace(/.{64}/g, "$&\n");
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
}

/** A throwaway CA, and (with `server`) a server certificate for 127.0.0.1 and localhost it signs. */
async function mintCa(cn) {
  const keys = await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(8).toString("hex"),
    name: `CN=${cn}`,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    keys,
    signingAlgorithm: EC,
    extensions: [
      new x509.BasicConstraintsExtension(true, undefined, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  return { keys, cert, pem: cert.toString("pem") + "\n" };
}

async function mintServer(ca) {
  const keys = await webcrypto.subtle.generateKey(EC, true, ["sign", "verify"]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: randomBytes(8).toString("hex"),
    subject: "CN=127.0.0.1",
    issuer: ca.cert.subject,
    notBefore: new Date(now - 60_000),
    notAfter: new Date(now + 86_400_000),
    signingKey: ca.keys.privateKey,
    publicKey: keys.publicKey,
    signingAlgorithm: EC,
    extensions: [
      new x509.SubjectAlternativeNameExtension([{ type: "ip", value: "127.0.0.1" }, { type: "dns", value: "localhost" }]),
      new x509.ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      await x509.AuthorityKeyIdentifierExtension.create(ca.keys.publicKey),
    ],
  });
  return { pem: cert.toString("pem") + "\n", key: pemKey(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey)) };
}

let tlsPromise;
function tlsServer() {
  tlsPromise ??= (async () => {
    const db = await redisServer();
    const ca = await mintCa("feat-redis-test-ca");
    const other = await mintCa("feat-redis-test-other-ca");
    const server = await mintServer(ca);
    const name = `feat-redis-test-tls-${db.id}`;
    const port = await freePort();
    await start(
      name,
      [
        "--rm",
        "-p", `127.0.0.1:${port}:6379`,
        "-e", "FEAT_REDIS_PASS", "-e", "FEAT_TLS_CERT", "-e", "FEAT_TLS_KEY", "-e", "FEAT_TLS_CA",
        "--entrypoint", "sh",
        REDIS_IMAGE,
        "-c",
        'umask 077; printf "%s" "$FEAT_TLS_CERT" > /tmp/s.crt; printf "%s" "$FEAT_TLS_KEY" > /tmp/s.key; printf "%s" "$FEAT_TLS_CA" > /tmp/ca.crt; ' +
          'printf "port 0\ntls-port 6379\ntls-cert-file /tmp/s.crt\ntls-key-file /tmp/s.key\ntls-ca-cert-file /tmp/ca.crt\ntls-auth-clients no\nrequirepass %s\nsave \"\"\nappendonly no\n" "$FEAT_REDIS_PASS" > /tmp/r.conf; ' +
          "unset FEAT_REDIS_PASS FEAT_TLS_KEY; exec redis-server /tmp/r.conf",
      ],
      { FEAT_REDIS_PASS: db.password, FEAT_TLS_CERT: server.pem, FEAT_TLS_KEY: server.key, FEAT_TLS_CA: ca.pem },
    );
    await until("Redis over TLS", async () => {
      const c = createClient({ url: `rediss://127.0.0.1:${port}`, password: db.password, socket: { tls: true, ca: ca.pem, reconnectStrategy: false, connectTimeout: 2000 } });
      c.on("error", () => {});
      try {
        await c.connect();
        await c.sendCommand(["PING"]);
      } finally {
        if (c.isOpen) await c.quit().catch(() => {});
      }
    });
    return { port, ca: ca.pem, other: other.pem };
  })();
  return tlsPromise;
}

// A script label (a, b) is mapped to `s` + 12 hex of a sha256 that also covers a per-call salt: the container is shared
// by every scenario of a test file, so a fresh namespace per call isolates the scenarios from each other.
const SALT = randomBytes(4).toString("hex");
let calls = 0;
const namespaceOf = (label, call) => `s${createHash("sha256").update(`${label}:${SALT}:${call}`).digest("hex").slice(0, 12)}`;

/**
 * The connection options of a credentials case, with the files written into `dir` (a fresh temporary directory the caller
 * removes). The secret goes only into a file, never into the options or the trace.
 */
function credentialOptions(input, db, dir, direct, tls) {
  const source = input.source;
  const content = input.content ?? "exact";
  const login = content === "innerSpace" ? SPACED : ["default", db.password];
  const subject = source === "urlFile" ? direct : source === "tlsCAFile" ? tls.ca : source === "tlsCAFileOther" ? tls.other : login[1];
  const body = { exact: subject, innerSpace: subject, lf: `${subject}\n`, crlf: `${subject}\r\n`, empty: "", lfOnly: "\n" }[content];
  const file = path.join(dir, "subject");
  writeFileSync(file, body);
  const where = input.path ?? "absolute";
  const named =
    where === "relative" ? path.relative(process.cwd(), file) : where === "missing" ? path.join(dir, "absent") : where === "directory" ? dir : file;
  const passwordFile = path.join(dir, "password");
  writeFileSync(passwordFile, db.password);
  const fileAuth = { user: "default", passwordFile };
  switch (source) {
    case "passwordFile":
      return { url: direct, auth: { user: login[0], passwordFile: named } };
    case "authNoUser":
      return { url: direct, auth: { passwordFile: named } };
    case "urlFile":
      return { urlFile: named, auth: fileAuth };
    case "urlAndFile":
      return { url: direct, urlFile: named, auth: fileAuth };
    case "urlEnvAndFile":
      return { urlEnv: "FEAT_REDIS_TEST_URL", urlFile: named, auth: fileAuth };
    case "authMixed":
      return { url: direct, auth: { password: "FEAT_REDIS_TEST_PASSWORD", passwordFile: named } };
    case "urlWithCredentials":
      return { url: `redis://:secret@127.0.0.1:${db.port}`, auth: fileAuth };
    case "tlsCAFilePlain":
      return { url: direct, tlsCAFile: named, auth: fileAuth };
    case "tlsCAFile":
    case "tlsCAFileOther":
      return { url: `rediss://127.0.0.1:${tls.port}`, tlsCAFile: named, auth: fileAuth };
    default:
      throw new Error(`unknown credentials source '${source}'`);
  }
}

export const observe = (input) => run(input, "observe");
export const observeSeedTransform = (input) => run(input, "seedtransform");

async function run(input, mode) {
  const db = await redisServer();
  // SPEC-ADPRDS-002: the fake transform host in mode input.host, its requests counted in a log of this run.
  const transform = mode === "seedtransform" ? seedTransformOption(input.host, ["key"]) : undefined;
  const credentialDir = input.source !== undefined ? mkdtempSync(path.join(os.tmpdir(), "feat-redis-cred-")) : undefined;
  const tls = input.source === "tlsCAFile" || input.source === "tlsCAFileOther" ? await tlsServer() : undefined;
  const steps = input.script.trim().split(/\s+/);
  const direct = `redis://127.0.0.1:${db.port}`;
  process.env.FEAT_REDIS_TEST_URL = input.url === "unreachable" ? "redis://127.0.0.1:1" : direct;
  process.env.FEAT_REDIS_TEST_PASSWORD = db.password;

  const adapters = new Map();
  const call = ++calls;
  const nsOf = (l) => (l.startsWith("raw=") ? l.slice(4) : namespaceOf(l, call));
  const make = (l) => {
    const options =
      credentialDir !== undefined
        ? credentialOptions(input, db, credentialDir, direct, tls)
        : { urlEnv: "FEAT_REDIS_TEST_URL", auth: { password: "FEAT_REDIS_TEST_PASSWORD" } };
    if (transform?.option !== undefined) options.seedTransform = transform.option;
    return createAdapter({ key: "cache", namespace: nsOf(l), options });
  };
  const adapter = (l) => {
    let a = adapters.get(l);
    if (a === undefined) {
      a = make(l);
      adapters.set(l, a);
    }
    return a;
  };

  // The system's own client: direct to the product (the adapter's instrument is another client).
  let system;
  const sys = async () => {
    if (system === undefined) {
      system = createClient({ url: direct, password: db.password, socket: { reconnectStrategy: false } });
      system.on("error", () => {});
      await system.connect();
    }
    return system;
  };
  const write = async (args) => (await sys()).sendCommand(args);

  const trace = [];
  const body = {};
  let last;
  let lastPeek;
  let peekEqualsStop;
  const records = (rs) => rs.map((r) => `${r.type}:${r.key}`).join(",");
  try {
    for (const raw of steps) {
      // SPEC-ADPRDS-002: a step written with a trailing `!` records its refusal in the trace and the script goes on.
      const tolerant = raw.endsWith("!");
      const step = tolerant ? raw.slice(0, -1) : raw;
      const [kind, l] = step.split(":");
      if (!tolerant) {
        await runStep(step);
        continue;
      }
      try {
        await runStep(step);
      } catch (err) {
        if (!(err instanceof RedisAdapterError)) throw err;
        trace.push(`${kind}:${l}!${err.code}`);
      }
    }
    async function runStep(step) {
      const [kind, l, a, b, c] = step.split(":");
      const ns = kind === "setraw" ? undefined : nsOf(l);
      const k = (key) => `${ns}:${key}`;
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
        case "seed": {
          const value = { string: "v0", set: ["m0"], list: ["i0"], hash: { f0: "v0" }, zset: [{ member: "m0", score: 1 }], bogus: "x" }[a];
          await adapter(l).seed([{ type: a, values: b === "nokey" ? { value } : { key: b, value } }]);
          trace.push(`seed:${l}`);
          break;
        }
        // SPEC-ADPRDS-001 (founder ruling 0c5cae75): a seed whose value does not fit its kind.
        case "seedmisfit": {
          const value = { string: 1, set: [1], list: [], hash: { f0: 1 }, zset: [{ member: "m0" }] }[a];
          await adapter(l).seed([{ type: a, values: { key: b, value } }]);
          trace.push(`seedmisfit:${l}`);
          break;
        }
        case "set":
          await write(["SET", k(a), b]);
          trace.push(`set:${l}`);
          break;
        case "sadd":
          await write(["SADD", k(a), b]);
          trace.push(`sadd:${l}`);
          break;
        case "hset":
          await write(["HSET", k(a), b, c]);
          trace.push(`hset:${l}`);
          break;
        case "rpush":
          await write(["RPUSH", k(a), b]);
          trace.push(`rpush:${l}`);
          break;
        case "zadd":
          await write(["ZADD", k(a), c, b]);
          trace.push(`zadd:${l}`);
          break;
        case "xadd":
          await write(["XADD", k(a), "*", "f", "v"]);
          trace.push(`xadd:${l}`);
          break;
        case "del":
          await write(["DEL", k(a)]);
          trace.push(`del:${l}`);
          break;
        case "setraw":
          await write(["SET", l, a]);
          trace.push("setraw");
          break;
        case "start":
          await adapter(l).startCapture();
          trace.push(`start:${l}`);
          break;
        case "peek":
          lastPeek = await adapter(l).peekCapture();
          last = records(lastPeek);
          trace.push(`peek:${l}=${lastPeek.length}`);
          break;
        case "stop": {
          const rs = await adapter(l).stopCapture();
          last = records(rs);
          // SPEC-ADPRDS-001's answer only (founder ruling c786e54d): SPEC-ADPRDS-002's result does not carry it.
          if (mode === "observe") body.payloads = JSON.stringify(rs.map((r) => r.payload));
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
          const rs = await x.read(a === undefined ? {} : { expect: [{ type: "*", key: { key: a } }] });
          trace.push(`read:${l}${a === undefined ? "" : `:${a}`}=${rs.length}`);
          body.readVia = x.lastReadVia;
          body.read = records(rs);
          body.readPayloads = JSON.stringify(rs.map((r) => r.payload));
          break;
        }
        case "count": {
          // keys of the namespace as the system sees them (a reset leaves none)
          const n = ((await write(["KEYS", `${ns}:*`])) ?? []).length;
          trace.push(`count:${l}=${n}`);
          break;
        }
        case "fault": {
          const [operation, fault] = a.split(".");
          await adapter(l).fault({ operation, fault, times: "reset" });
          trace.push(`fault:${l}:${a}`);
          break;
        }
        // SPEC-ADPRDS-002: seeds whose values the fake transform host rewrites, plain seeds that do not fit their kind,
        // and the number of transformSeed requests the host received.
        case "seedenc": {
          const enc = { encode: c };
          const value = { string: enc, set: [enc], list: [enc], hash: { f: enc } }[a];
          await adapter(l).seed([{ type: a, values: { key: b, value } }]);
          trace.push(`seedenc:${l}`);
          break;
        }
        case "seedmix":
          await adapter(l).seed([
            { type: "string", values: { key: "k1", value: { encode: "a" } } },
            { type: "string", values: { key: "k2", value: { encode: "b" } } },
          ]);
          trace.push(`seedmix:${l}`);
          break;
        case "seedraw": {
          const r = {
            strnum: { type: "string", values: { key: "k1", value: 1 } },
            setempty: { type: "set", values: { key: "k1", value: [] } },
            setnum: { type: "set", values: { key: "k1", value: [1] } },
            hashnum: { type: "hash", values: { key: "k1", value: { f: 1 } } },
            zsetnoscore: { type: "zset", values: { key: "k1", value: [{ member: "m" }] } },
            nokind: { type: "blob", values: { key: "k1", value: "x" } },
            nokey: { type: "string", values: { value: "x" } },
          }[a];
          await adapter(l).seed([r]);
          trace.push(`seedraw:${l}`);
          break;
        }
        case "calls":
          trace.push(`calls:${l}=${transformCalls(transform)}`);
          break;
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    body.trace = trace.join(" ");
    if (last) body.last = last;
    if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
    return { status: "OK", body };
  } catch (e) {
    if (e instanceof RedisAdapterError) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    for (const x of adapters.values()) await x.reset().catch(() => {});
    for (const x of adapters.values()) await x.teardown().catch(() => {});
    if (system !== undefined && system.isOpen) await system.quit().catch(() => {});
    if (credentialDir !== undefined) rmSync(credentialDir, { recursive: true, force: true });
    transform?.cleanup();
  }
}
