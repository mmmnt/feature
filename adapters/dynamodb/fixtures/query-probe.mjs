// The probe behind `ObserveDynamoQuery` (SPEC-ADPDDB-001) and `ObserveDynamoTransport` (SPEC-ADPDDB-002).
// Part of the build, not shipped.
//
// It starts, once per process, the throwaway containers the scenarios need and removes them on exit:
//   feat-dynamodb-test-<id>        DynamoDB Local (pinned image), the API published on a random loopback port
//   feat-dynamodb-test-tox-<id>    Toxiproxy, in the DynamoDB Local container's network namespace   (transport only)
//   feat-dynamodb-test-peer-<id>   the same namespace: plays "the system under test" with a bundled AWS SDK  (transport only)
// The system's client runs in the Toxiproxy namespace on purpose (the fault-proxy library's test-environment
// note): a client that reaches a published port goes through the container runtime's host proxy, which hides a
// refused or reset connection; in the shared namespace it sees what a real client of the product would see.
// The adapter's own clients use the published port directly, never the proxy. Only containers this probe
// created, by name, are ever touched. Credentials are fake and static; no real AWS endpoint is ever named.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CreateTableCommand,
  DeleteItemCommand,
  DescribeTableCommand,
  DynamoDBClient,
  PutItemCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { createAdapter, DynamoAdapterError } from "../src/index.ts";

// Every container this file starts carries the pid of the run that owns it (ci-local's, passed in as
// FEAT_CI_LOCAL_PID, else this process), so scripts/docker-sweep.sh can remove what a killed run left.
const OWNER = ["--label", `feat-test.owner-pid=${process.env.FEAT_CI_LOCAL_PID ?? process.pid}`];

export const DYNAMODB_IMAGE = "amazon/dynamodb-local:2.6.1";
export const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
export const NODE_IMAGE = "node:22.12.0-slim";

process.env.AWS_EC2_METADATA_DISABLED = "true";
process.env.FEAT_DDB_TEST_KEY = "local";
process.env.FEAT_DDB_TEST_SECRET = "local";

const here = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.resolve(here, "..");
const REGION = "us-east-1";
const PRODUCT = "dynamodb";
const TABLES = ["default", "numeric", "nostream"];

// The system's PutItem, bundled with the AWS SDK so the peer container needs nothing installed.
const PUT_AGENT = `
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const [port, table, pk, sk, v] = process.argv.slice(2);
const client = new DynamoDBClient({
  region: "${REGION}",
  endpoint: "http://127.0.0.1:" + port,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
  maxAttempts: 1,
  requestHandler: { requestTimeout: 1500, connectionTimeout: 1500, throwOnRequestTimeout: true },
});
const done = (line) => { console.log(line); process.exit(0); };
client
  .send(new PutItemCommand({ TableName: table, Item: { PK: { S: pk }, SK: { S: sk }, v: { S: v } } }))
  .then(() => done("ok"), (e) => done(e && e.$metadata && e.$metadata.httpStatusCode ? "error:" + e.name : "TRANSPORT_FAILURE"));
`;

const created = [];
let hooked = false;
let bundleDir;

function docker(args) {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function removeAll() {
  // One call for every container this probe created, so a worker killed mid-cleanup cannot leave half.
  const names = created.splice(0);
  if (names.length > 0) spawnSync("docker", ["rm", "-f", "-v", ...names], { stdio: "ignore" });
  if (bundleDir !== undefined) {
    rmSync(bundleDir, { recursive: true, force: true });
    bundleDir = undefined;
  }
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

/** A watchdog for the case the process is killed without running any hook: it removes the named containers once the parent is gone. */
function watchdog(names) {
  const script = `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; docker rm -f -v ${names.join(" ")} >/dev/null 2>&1`;
  spawn("sh", ["-c", script], { detached: true, stdio: "ignore" }).unref();
}

function track(name) {
  hook();
  created.push(name);
}

async function until(what, fn) {
  const deadline = Date.now() + 60_000;
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

function hostPort(name, inner) {
  return Number(docker(["port", name, `${inner}/tcp`]).split("\n")[0].split(":").pop());
}

const KEY = (name, type) => [{ AttributeName: name, AttributeType: type }];

async function createTables(client) {
  const defs = [
    { name: "default", pkType: "S", stream: true },
    { name: "numeric", pkType: "N", stream: true },
    { name: "nostream", pkType: "S", stream: false },
  ];
  for (const d of defs) {
    await client.send(
      new CreateTableCommand({
        TableName: d.name,
        AttributeDefinitions: [...KEY("PK", d.pkType), ...KEY("SK", "S")],
        KeySchema: [
          { AttributeName: "PK", KeyType: "HASH" },
          { AttributeName: "SK", KeyType: "RANGE" },
        ],
        BillingMode: "PAY_PER_REQUEST",
        ...(d.stream ? { StreamSpecification: { StreamEnabled: true, StreamViewType: "NEW_AND_OLD_IMAGES" } } : {}),
      }),
    );
    await until(`table ${d.name}`, async () => {
      const t = await client.send(new DescribeTableCommand({ TableName: d.name }));
      if (t.Table?.TableStatus !== "ACTIVE") throw new Error(String(t.Table?.TableStatus));
    });
    if (d.stream) {
      // DynamoDB Local answers TrimmedDataAccessException to the first read of a LATEST iterator taken on a shard that
      // has never held a record. One write and delete primes it; a real table does not behave so (observed on 2.6.1).
      const key = { PK: d.pkType === "N" ? { N: "0" } : { S: "prime" }, SK: { S: "prime" } };
      await client.send(new PutItemCommand({ TableName: d.name, Item: key }));
      await client.send(new DeleteItemCommand({ TableName: d.name, Key: key }));
    }
  }
}

const sysClient = (endpoint) =>
  new DynamoDBClient({ region: REGION, endpoint, credentials: { accessKeyId: "local", secretAccessKey: "local" }, maxAttempts: 1 });

const environments = new Map();

function environment(withProxy) {
  if (!environments.has(withProxy)) {
    environments.set(
      withProxy,
      (async () => {
        const id = randomBytes(4).toString("hex");
        const ddb = `feat-dynamodb-test-${id}`;
        const tox = `feat-dynamodb-test-tox-${id}`;
        const peer = `feat-dynamodb-test-peer-${id}`;
        const names = withProxy ? [ddb, tox, peer] : [ddb];
        names.forEach(track);
        watchdog(names);
        docker([
          "run", "-d", "--rm", ...OWNER, "--name", ddb, "-p", "127.0.0.1:0:8000", ...(withProxy ? ["-p", "127.0.0.1:0:8474"] : []),
          DYNAMODB_IMAGE, "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb",
        ]);
        const endpoint = `http://127.0.0.1:${hostPort(ddb, 8000)}`;
        const client = sysClient(endpoint);
        await until("DynamoDB Local", () => client.send(new ScanCommand({ TableName: "absent" })).catch((e) => {
          if (e.name !== "ResourceNotFoundException") throw e;
        }));
        await createTables(client);
        const env = { ddb, endpoint, client, tox: undefined, peer: undefined, api: undefined };
        if (withProxy) {
          docker(["run", "-d", "--rm", ...OWNER, "--name", tox, `--network=container:${ddb}`, TOXIPROXY_IMAGE, "-host=0.0.0.0"]);
          const api = `http://127.0.0.1:${hostPort(ddb, 8474)}`;
          await until("the Toxiproxy API", async () => {
            const r = await fetch(`${api}/version`);
            if (!r.ok) throw new Error(String(r.status));
          });
          const { build } = await import("esbuild");
          bundleDir = mkdtempSync(path.join(os.tmpdir(), "feat-dynamodb-test-"));
          await build({
            stdin: { contents: PUT_AGENT, resolveDir: ADAPTER_DIR, loader: "js" },
            bundle: true,
            platform: "node",
            format: "cjs",
            target: "node22",
            outfile: path.join(bundleDir, "put.cjs"),
            logLevel: "silent",
          });
          docker(["create", ...OWNER, "--name", peer, `--network=container:${ddb}`, NODE_IMAGE, "sleep", "900"]);
          docker(["cp", path.join(bundleDir, "put.cjs"), `${peer}:/put.cjs`]);
          docker(["start", peer]);
          Object.assign(env, { tox, peer, api });
        }
        return env;
      })(),
    );
  }
  return environments.get(withProxy);
}

/** Every table emptied: a call starts from nothing, whatever the previous one left (fence rows, raw keys, other namespaces). */
async function wipe(env) {
  for (const table of TABLES) {
    let startKey;
    do {
      const page = await env.client.send(new ScanCommand({ TableName: table, ExclusiveStartKey: startKey }));
      for (const item of page.Items ?? []) {
        await env.client.send(new DeleteItemCommand({ TableName: table, Key: { PK: item.PK, SK: item.SK } }));
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
  }
}

const namespaceOf = (label) =>
  label.startsWith("raw=") ? label.slice(4) : `s${createHash("sha256").update(label, "utf8").digest("hex").slice(0, 12)}`;

const KNOWN_ERRORS = new Set(["NAMESPACE_INVALID", "NAMESPACE_KEY_NOT_STRING", "STREAM_NOT_ENABLED", "FAULT_UNSUPPORTED"]);

const countOf = (word) => (word === undefined || word === "reset" ? "reset" : word === "once" ? 1 : Number(word.replace(/^times/, "")));

const keyOf = (r) => `${r.type}:${r.payload.PK}/${r.payload.SK}`;

async function run(input, { transport }) {
  const env = await environment(transport);
  await wipe(env);

  const adapters = new Map();
  const trace = [];
  const body = {};
  let lastPeek;
  const tableName = input.table ?? "default";

  const adapterFor = (label) => {
    const a = adapters.get(label);
    if (a === undefined) throw new Error(`the script uses '${label}' before setup:${label}`);
    return a;
  };

  try {
    for (const step of input.script.trim().split(/\s+/)) {
      const [kind, label, ...rest] = step.split(":");
      const ns = namespaceOf(label ?? "");
      switch (kind) {
        case "setup": {
          const proxied = transport && rest[0] !== "noproxy";
          const options = {
            table: tableName,
            region: REGION,
            endpoint: env.endpoint,
            auth: { accessKeyIdEnv: "FEAT_DDB_TEST_KEY", secretAccessKeyEnv: "FEAT_DDB_TEST_SECRET" },
            ...(proxied
              ? { fence: true, proxy: { api: env.api, name: PRODUCT, upstream: "127.0.0.1:8000" } }
              : { ...(input.fence === true ? { fence: true } : {}), ...(input.stream === "off" ? { stream: false } : {}) }),
          };
          const adapter = createAdapter({ key: "database", options, namespace: ns });
          adapters.set(label, adapter);
          await adapter.setup();
          trace.push(`setup:${label}`);
          break;
        }
        case "observes": {
          const o = adapterFor(label).observes;
          trace.push(`observes:${label}=${o.diff}/${o.state}`);
          break;
        }
        case "seed": {
          const [pk, sk, v] = rest;
          await adapterFor(label).seed([{ type: "ITEM", values: { PK: pk, SK: sk, v } }]);
          trace.push(`seed:${label}`);
          break;
        }
        case "put":
        case "update": {
          const [pk, sk = "1", v = "x"] = rest;
          if (transport) {
            const listen = (await (await fetch(`${env.api}/proxies/feat-${ns}-${PRODUCT}`)).json()).listen;
            const out = docker([
              "exec", env.peer, "node", "/put.cjs", listen.slice(listen.lastIndexOf(":") + 1), tableName, `${ns}#${pk}`, sk, v,
            ]);
            trace.push(out === "ok" ? `put:${label}` : `put:${label}!${out === "TRANSPORT_FAILURE" ? out : `UNEXPECTED(${out})`}`);
          } else if (kind === "put") {
            await env.client.send(new PutItemCommand({ TableName: tableName, Item: { PK: { S: `${ns}#${pk}` }, SK: { S: sk }, v: { S: v } } }));
            trace.push(`put:${label}`);
          } else {
            await env.client.send(
              new UpdateItemCommand({
                TableName: tableName,
                Key: { PK: { S: `${ns}#${pk}` }, SK: { S: sk } },
                UpdateExpression: "SET v = :v",
                ExpressionAttributeValues: { ":v": { S: v } },
              }),
            );
            trace.push(`update:${label}`);
          }
          break;
        }
        case "delete": {
          const [pk, sk] = rest;
          await env.client.send(new DeleteItemCommand({ TableName: tableName, Key: { PK: { S: `${ns}#${pk}` }, SK: { S: sk } } }));
          trace.push(`delete:${label}`);
          break;
        }
        case "putcond": {
          // `label` is the namespace label here too; the system builds its key from the namespace it was given.
          const [pk, sk, v] = rest;
          try {
            await env.client.send(
              new PutItemCommand({
                TableName: tableName,
                Item: { PK: { S: `${ns}#${pk}` }, SK: { S: sk }, v: { S: v } },
                ConditionExpression: "attribute_not_exists(PK)",
              }),
            );
            trace.push(`putcond:${label}`);
          } catch (e) {
            if (e.name !== "ConditionalCheckFailedException") throw e;
            trace.push(`putcond:${label}!CONDITIONAL_CHECK_FAILED`);
          }
          break;
        }
        case "putraw": {
          // No namespace segment: the first field after the kind is the partition key itself.
          const [pk, sk, v] = [label, ...rest];
          await env.client.send(new PutItemCommand({ TableName: tableName, Item: { PK: { S: pk }, SK: { S: sk }, v: { S: v } } }));
          trace.push("putraw");
          break;
        }
        case "start":
          await adapterFor(label).startCapture();
          trace.push(`start:${label}`);
          break;
        case "peek":
        case "stop": {
          const records = await (kind === "peek" ? adapterFor(label).peekCapture() : adapterFor(label).stopCapture());
          trace.push(`${kind}:${label}=${records.length}`);
          if (records.length > 0) body.last = transport ? records.map((r) => r.type).join(",") : records.map(keyOf).join(",");
          else delete body.last;
          const signature = JSON.stringify(records.map((r) => [r.type, r.key]));
          if (kind === "peek") lastPeek = signature;
          else if (lastPeek !== undefined) body.peekEqualsStop = lastPeek === signature;
          break;
        }
        case "settle":
          trace.push(`settle:${label}=${await adapterFor(label).settle()}`);
          break;
        case "reset":
          await adapterFor(label).reset();
          trace.push(`reset:${label}`);
          break;
        case "read": {
          const [pk, sk] = rest;
          const key = {};
          if (pk !== undefined) key.PK = pk;
          if (sk !== undefined) key.SK = sk;
          const adapter = adapterFor(label);
          const out = await adapter.read(pk === undefined ? {} : { expect: [{ type: "ITEM", key }] });
          trace.push(`${step}=${out.length}`);
          body.readVia = adapter.lastReadVia;
          break;
        }
        case "fault": {
          const [opFault, ...more] = rest;
          const [operation, fault] = opFault.split(".");
          const isConnection = operation === "Connection";
          const [pk, sk, count] = isConnection ? [undefined, undefined, more[0]] : more;
          await adapterFor(label).fault({
            operation,
            fault,
            ...(isConnection ? {} : { detail: { pk, sk } }),
            times: countOf(count),
          });
          trace.push(`fault:${label}:${opFault}`);
          break;
        }
        case "fired": {
          const a = adapterFor(label);
          trace.push(`fired:${label}=${typeof a.firedFaults === "function" ? "observed" : "unobserved"}`);
          break;
        }
        default:
          throw new Error(`unknown probe step '${step}'`);
      }
    }
    body.trace = trace.join(" ");
    return { status: "OK", body };
  } catch (e) {
    if (e instanceof DynamoAdapterError && KNOWN_ERRORS.has(e.code)) return { status: "ERR", body: { code: e.code, detail: e.detail } };
    throw e;
  } finally {
    for (const a of adapters.values()) await a.teardown().catch(() => {});
  }
}

export const observe = (input) => run(input, { transport: false });
export const observeTransport = (input) => run(input, { transport: true });

// SPEC-ADPHND-003 (founder ruling ba21abb2, "Transport envs start at load"): every one-time start-up of this
// probe, DynamoDB Local, and the transport environment (its own DynamoDB Local, Toxiproxy and the peer), runs when the module is evaluated. The handler adapter imports the module in setup(), in the
// suite's beforeAll under the hook timeout, so none of it is charged to the first case's test timeout.
await Promise.all([environment(false), environment(true)]);
