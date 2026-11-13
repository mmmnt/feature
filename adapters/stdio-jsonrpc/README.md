# @mmmnt/feat-adapter-stdio-jsonrpc

**Verify a product in any language.** This package speaks the **Feat Host
Protocol** (version 2) to a *spec host*: a small program you write, in any
language, that drives your product and reports what it did. The protocol is
JSON-RPC 2.0, one line of JSON each way, over the host's stdin and stdout.

Feature's execution layer lives in adapters. The adapters for HTTP, handlers,
DynamoDB and the rest run inside Node. If your product is a Rust service, a Go
binary or a Python job, you do not port an adapter. You write a host that
answers the protocol, and this package becomes both the **response adapter**
and the **service adapters** of your project.

```jsonc
// feat.config.json
{
  "featVersion": "1.0",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "@mmmnt/feat-adapter-stdio-jsonrpc",
    "invoke": { "host": { "command": ["./target/debug/my-spec-host"] } },
    "commands": { "Place": {} }
  },
  "services": {
    "store": {
      "adapter": "@mmmnt/feat-adapter-stdio-jsonrpc",
      "consistency": "strong",
      "options": {
        "host": { "command": ["./target/debug/my-spec-host"] },
        "faults": { "Place": { "Reject": ["once", "times"] } }
      }
    }
  },
  "specs": { "dir": ".", "pattern": "*.feat", "contractPattern": "*.contract.json", "outputPattern": "{name}.test.ts" }
}
```

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-stdio-jsonrpc
```

Requirements:

- Node 20 or later, for the adapter and the runner. The host can be anything
  that reads and writes stdio.
- `@mmmnt/feature` and `@mmmnt/feat-runtime` in the project (the runner loads
  the adapter by the name in `feat.config.json`).

Dependencies: `@mmmnt/feat-types`, `ajv` and `ajv-formats`. The package ships
`dist/` and `schemas/`.

## How it works

One host process serves **one spec file**.

- The first role of the file to set up (the response role or any service role)
  spawns the host and sends `setup`. Later roles of the same file join the open
  host and send their own `setup`.
- Setup is additive: each role opens its own services and never closes another
  role's.
- Each role's teardown sends `teardown` for its own services and leaves. The
  last role out ends the host: the adapter closes stdin, then kills the process
  after a 2 second grace period.
- Separate spec files never share a host. A vitest worker runs one file, so the
  adapter's module-scoped registry is exactly one file's registry.
- The host sees one request at a time. The adapter queues calls, so a host can
  be single-threaded.

A role whose host configuration (`command`, `cwd`, `env`) differs from the host
already open for its file is refused with `HOST_CONFIG_MISMATCH`. Give the
response role and every service role the same `host` block.

The runner starts the host with `FEAT_NAMESPACE` in its environment, set to the
file's namespace. The same value arrives in `setup`.

## `feat.config.json`

The response role and each service role name the host. The two entries differ
only in where the block sits.

| Role | Key | Value |
|---|---|---|
| Response | `response.adapter` | `"@mmmnt/feat-adapter-stdio-jsonrpc"` |
| Response | `response.invoke.host` | The host: `{ command, cwd?, env? }`. Required. |
| Response | `response.commands` | Command names the specs may use, each `{}`. At least one. The adapter forwards every command to the host's `invoke`. |
| Service | `services.<key>.adapter` | `"@mmmnt/feat-adapter-stdio-jsonrpc"` |
| Service | `services.<key>.consistency` | `acid`, `strong` or `eventual`. |
| Service | `services.<key>.convergenceTimeout` | Milliseconds. Required when `consistency` is `eventual`. |
| Service | `services.<key>.options.host` | The host: `{ command, cwd?, env? }`. Required. |
| Service | `services.<key>.options.faults` | The fault catalog this service offers. Optional. See [Faults](#faults). |

The `host` block:

| Field | Type | Meaning |
|---|---|---|
| `command` | `string[]` | Program and arguments, run without a shell. Required, at least one element. |
| `cwd` | `string` | Working directory. Default: the runner's. |
| `env` | `Record<string, string>` | Added to the runner's environment. `FEAT_NAMESPACE` is always set and wins over a same-named entry. |

A missing or empty `command` is a configuration error: the adapter throws
`@mmmnt/feat-adapter-stdio-jsonrpc: response.invoke.host must name { command: [...] }`
(or `services.<key>.options.host` for a service).

`<key>` is the service key your specs use (`store has [ ... ]`). The adapter
sends it to the host as `service` on every service request. A service reports
`observes: { diff: "native", state: true }`: the host captures what the product
did, and `read` reports state.

## The protocol

Each line is one JSON object, terminated by `\n`. The client writes a request
and reads one answer line. Requests carry `"jsonrpc": "2.0"`, an integer `id`
of 1 or more, a `method` and `params`. An answer carries the same `id` and
either `result` or `error`.

The host writes **only protocol lines** to stdout. Its stderr is discarded. The
client attributes the next line it reads to the outstanding request, so a stray
line on stdout is a `PROTOCOL_VIOLATION`.

### Methods

| Method | `params` | `result` | Used by |
|---|---|---|---|
| `setup` | `{ protocol: 2, services: string[], namespace }` | `{ protocol, namespace }` | every role |
| `teardown` | `{ services: string[] }` | `{}` | every role |
| `reset` | `{}` | `{}` | service roles, before each case |
| `setClock` | `{ clock: string \| null }` | `{}` | every role, each case |
| `invoke` | `{ command, input, actor? }` | `{ status, body, headers?, metadata? }` | response role |
| `seed` | `{ service, records: [{ type, schemaName?, values }] }` | `{}` | service roles |
| `startCapture` | `{ service, specType? }` | `{}` | service roles |
| `peekCapture` | `{ service }` | `CapturedRecord[]` | service roles |
| `stopCapture` | `{ service }` | `CapturedRecord[]` | service roles |
| `settle` | `{ service }` | `{ settled: boolean }` | service roles |
| `read` | `{ service, query }` | `null` or an array of objects | service roles |
| `deliver` | `{ service, event, payload }` | `{}` | service roles |
| `fault` | `{ service, kind, times? \| untilReset?, detail? }` | `{}` | service roles |

- A `CapturedRecord` is `{ type, key?, payload, timestamp, metadata? }`.
  `timestamp` is a number.
- `invoke`'s `status` is an integer or a string. `body` is an object or `null`.
- `invoke`'s `input`, the `seed` values, the `read` query, the `deliver`
  payload and the capture payload and metadata are carried as opaque objects.
  Everything else is **closed**: an unknown property is a violation.

### The closed schemas

The contract is `schemas/feat-host-protocol.schema.json` (JSON Schema
draft-07). It holds every request as `#/definitions/requests/<method>` and every
result as `#/definitions/results/<method>`. A result is typed by the method of
the request it answers, so the client applies `results/<method>` to the request
it sent.

The adapter validates **both directions**:

- A request that does not validate is refused as `INVALID_REQUEST` before
  anything is spawned or written.
- An answer that is not JSON, does not validate, carries another `id`, or has a
  result that breaks its method's closed shape is a `PROTOCOL_VIOLATION`.

The file is a language-neutral contract: a host written in another language can
validate its own answers against it. The package's `exports` map does not expose
it as a subpath, so read it by path:

```js
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve("@mmmnt/feat-adapter-stdio-jsonrpc/package.json"));
const schema = JSON.parse(readFileSync(path.join(root, "schemas", "feat-host-protocol.schema.json"), "utf8"));
console.log(Object.keys(schema.definitions.requests)); // the 13 methods
```

### Errors on the wire

A host answers a failure with a JSON-RPC `error`: `{ code, message, data? }`.
`id` is `null` only when the host could not read the request line well enough to
know its id: code `-32700` (the line is not JSON) or `-32600` (the line is JSON
but not a usable request). An error whose request id is known carries that id.

The client turns any `error` answer into `HOST_ERROR` and relays the code and
message.

### Setup: version, namespace and echo

```json
{"jsonrpc":"2.0","id":1,"method":"setup","params":{"protocol":2,"services":["store"],"namespace":"s0599e33863c1"}}
{"jsonrpc":"2.0","id":1,"result":{"protocol":2,"namespace":"s0599e33863c1"}}
```

- **Version.** The request names exactly `2`. The unversioned wire protocol
  was 1. The host answers the version it speaks. Any other value is
  `PROTOCOL_MISMATCH`, raised before any case runs.
- **Namespace.** The runner derives a namespace per spec file: `s` plus 12
  lowercase hex characters (SPEC-RT-006). The host applies it to every key,
  stream, topic, label, alias or tag it writes, and **echoes it** in the setup
  result. Parallel files then never see each other's data.
- **Echo.** An answer with no namespace, or a malformed one, is a
  `PROTOCOL_VIOLATION`. A well-formed namespace that differs from the one sent
  is `NAMESPACE_NOT_HONOURED`. A host should keep the first namespace it is given
  and refuse a later `setup` that names another with `-32602`, which surfaces as
  `HOST_ERROR`.

The adapter leaves the host (and ends it, if it was the only role) when setup
fails, so a refused setup leaves no process running.

### Capture, `peekCapture`, `settle`

A service's capture window opens with `startCapture` and closes with
`stopCapture`, which returns the records and clears the window.

- `peekCapture` returns the records so far **without consuming them**.
- `settle` returns `{ settled: true }` only when the host can prove that every
  task the scenario spawned has finished and written. Return `false` whenever
  you cannot vouch. The runner then falls back to polling `peekCapture` within
  the service's `convergenceTimeout`. A host with no background work returns
  `true`.
- The adapter relays the host's answer to `settle` unchanged.

### `setClock`

The runner calls `setClock` on every role at the start of every case, after the
resets. A string freezes the scenario clock; `null` unfreezes it (the host's
wall clock), so one case's freeze never reaches the next. The adapter accepts
only an ISO-8601 instant **with a zone designator** (`2026-11-10T12:00:00Z`,
`2026-11-10T12:00:00+02:00`). Anything else is `INVALID_CLOCK`, refused before
the host is called.

## Faults

The protocol's `fault` request is `{ service, kind, times? | untilReset?, detail? }`
(fault shape C). The adapter maps a harness arm onto it:

```
fault store Place Reject once                     ->  { "service": "store", "kind": "Place.Reject", "times": 1 }
fault store Place Reject times 3                  ->  { "service": "store", "kind": "Place.Reject", "times": 3 }
fault store Place Reject until reset              ->  { "service": "store", "kind": "Place.Reject", "untilReset": true }
fault log Append Conflict { stream: "a" } once    ->  { "service": "log", "kind": "Append.Conflict", "times": 1, "detail": { "stream": "a" } }
```

`kind` is `"<operation>.<fault>"`. The operation and fault names are your
vocabulary, declared in `options.faults`. `times` and `untilReset` never travel
together. The detail is carried as is (`acceptsFaultDetail` is `true`): what it
means is the host's business, for example applying the fault only to the stream
the detail names. The harness refuses an arm outside the catalog, or with a
count the catalog does not declare for that fault, with `FAULT_UNSUPPORTED`
before the case has any effect:

```
[FAULT_UNSUPPORTED] ... the fault 'Place/Reject' of 'store' declares only once | times n, not until reset.
```

`options.faults` has two forms:

```jsonc
"faults": { "Place": { "Reject": ["once", "times", "reset"] } }   // fault -> counts
"faults": { "Place": ["Reject", "Timeout"] }                      // fault names: all counts
```

The counts are carried as declared; the array form offers all three.

The host arms the fault, applies it to the next `times` calls (or to every call
until the next `reset` when `untilReset` is set), and clears it on `reset`. The adapter has no `firedFaults`, so the harness does not check that the
fault was consumed.

Called directly rather than through the harness, `fault()` sends the arm as is;
a request carrying both a count and `untilReset` is `INVALID_REQUEST`.
`FAULT_UNSUPPORTED` is the harness's code.

## Writing a host

A host is a loop: read a line, parse it, answer one line. Rules:

1. **One answer line per request line**, in order, flushed. Write nothing else
   to stdout. Log to stderr.
2. **Echo the request `id`.** On a line you cannot parse, answer
   `id: null` with `-32700`. On JSON that is not a request, `id: null` with
   `-32600`.
3. **Answer `setup` with `protocol: 2` and the namespace you were sent.** Keep
   the namespace and apply it to everything you write.
4. **Close the shapes.** Results are closed: `reset`, `setClock`, `seed` and the
   other empty results are `{}`, not `null`.
5. **Exit when stdin closes.** That is how the adapter ends the host. It sends
   SIGKILL after a grace period if you do not.
6. **Be quick.** The adapter waits 30 seconds for an answer to any request and
   then fails with `HOST_TIMEOUT`. The limit is not configurable on a shared host.
7. **Unknown method:** answer `-32601`.
8. **Make `reset` total.** It clears captured records, capture windows and armed
   faults, because the runner calls it before every case.

### A complete host in Node

This host keeps one in-memory log per service. `invoke` of `Place` appends a
`Placed` record to `store`, with the namespace in its key. A `Place.Reject` fault
makes the next `times` calls answer `STORE_REJECTED`.

```js
#!/usr/bin/env node
// A minimal Feat Host Protocol v2 host: JSON-RPC 2.0, one JSON line in, one JSON line out.
import { createInterface } from "node:readline";

const PROTOCOL = 2;
let namespace;                 // the runner namespace, kept from the first setup
let clock = null;              // the frozen scenario clock, or null
const services = new Set();    // services opened by setup
const logs = new Map();        // service -> captured records
const windows = new Map();     // service -> index where its capture window opened
let faults = [];               // { service, kind, left }

const records = (service) => logs.get(service) ?? [];
const now = () => (clock === null ? Date.now() : Date.parse(clock));
const append = (service, type, key, payload) =>
  logs.set(service, [...records(service), { type, key, payload, timestamp: now() }]);
const windowOf = (service) => records(service).slice(windows.get(service) ?? 0);

const answer = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...body }) + "\n");
const ok = (id, result) => answer(id, { result });
const fail = (id, code, message) => answer(id, { error: { code, message } });

function handle(id, method, p) {
  switch (method) {
    case "setup":
      if (namespace !== undefined && namespace !== p.namespace) return fail(id, -32602, "another namespace");
      namespace = p.namespace;
      for (const s of p.services) services.add(s);
      return ok(id, { protocol: PROTOCOL, namespace });
    case "teardown":
      for (const s of p.services) services.delete(s);
      return ok(id, {});
    case "reset":
      logs.clear(); windows.clear(); faults = [];
      return ok(id, {});
    case "setClock":
      clock = p.clock;
      return ok(id, {});
    case "invoke": {
      if (p.command !== "Place") return ok(id, { status: "ERR", body: { code: "UNKNOWN_COMMAND" } });
      const f = faults.find((x) => x.kind === "Place.Reject" && x.left > 0);
      if (f) {
        f.left--;
        return ok(id, { status: "ERR", body: { code: "STORE_REJECTED" } });
      }
      const key = `${namespace}:order:${p.input.id}`;     // every key carries the namespace
      append("store", "Placed", key, { id: p.input.id });
      return ok(id, { status: "OK", body: { id: p.input.id } });
    }
    case "seed":
      for (const r of p.records) append(p.service, r.type, undefined, r.values);
      return ok(id, {});
    case "startCapture":
      windows.set(p.service, records(p.service).length);
      return ok(id, {});
    case "peekCapture":                                     // does not consume
      return ok(id, windowOf(p.service));
    case "stopCapture": {                                   // returns the window and closes it
      const w = windowOf(p.service);
      windows.set(p.service, records(p.service).length);
      return ok(id, w);
    }
    case "settle":
      return ok(id, { settled: true });                     // nothing here is asynchronous
    case "read":
      return ok(id, records(p.service));
    case "deliver":
      append(p.service, p.event, undefined, p.payload);
      return ok(id, {});
    case "fault":
      faults.push({ service: p.service, kind: p.kind, left: p.times ?? 1 });
      return ok(id, {});
    default:
      return fail(id, -32601, `no such method: ${method}`);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return fail(null, -32700, "not JSON");                  // the only null-id errors: -32700 and -32600
  }
  if (typeof req?.id !== "number" || typeof req.method !== "string") return fail(null, -32600, "not a request");
  try {
    handle(req.id, req.method, req.params ?? {});
  } catch (e) {
    fail(req.id, -32603, String(e));
  }
});
```

### The same host in Python

```python
#!/usr/bin/env python3
"""A minimal Feat Host Protocol v2 host: JSON-RPC 2.0, one JSON line in, one JSON line out."""
import json, sys, time
from datetime import datetime

PROTOCOL = 2
state = {"namespace": None, "clock": None, "logs": {}, "windows": {}, "faults": []}

def now():
    c = state["clock"]
    return int(time.time() * 1000) if c is None else int(datetime.fromisoformat(c.replace("Z", "+00:00")).timestamp() * 1000)

def records(service): return state["logs"].setdefault(service, [])
def append(service, type_, key, payload):
    rec = {"type": type_, "payload": payload, "timestamp": now()}
    if key is not None: rec["key"] = key
    records(service).append(rec)
def window(service): return records(service)[state["windows"].get(service, 0):]

def handle(method, p):
    """Return a result; raise ValueError(code, message) for a JSON-RPC error."""
    if method == "setup":
        if state["namespace"] not in (None, p["namespace"]): raise ValueError(-32602, "another namespace")
        state["namespace"] = p["namespace"]
        return {"protocol": PROTOCOL, "namespace": state["namespace"]}
    if method in ("teardown", "startCapture", "seed", "deliver", "fault", "reset", "setClock"):
        if method == "reset": state.update(logs={}, windows={}, faults=[])
        if method == "setClock": state["clock"] = p["clock"]
        if method == "startCapture": state["windows"][p["service"]] = len(records(p["service"]))
        if method == "seed":
            for r in p["records"]: append(p["service"], r["type"], None, r["values"])
        if method == "deliver": append(p["service"], p["event"], None, p["payload"])
        if method == "fault": state["faults"].append({"kind": p["kind"], "left": p.get("times", 1)})
        return {}
    if method == "invoke":
        for f in state["faults"]:
            if f["kind"] == "Place.Reject" and f["left"] > 0:
                f["left"] -= 1
                return {"status": "ERR", "body": {"code": "STORE_REJECTED"}}
        append("store", "Placed", f'{state["namespace"]}:order:{p["input"]["id"]}', {"id": p["input"]["id"]})
        return {"status": "OK", "body": {"id": p["input"]["id"]}}
    if method == "peekCapture": return window(p["service"])
    if method == "stopCapture":
        w = window(p["service"]); state["windows"][p["service"]] = len(records(p["service"])); return w
    if method == "settle": return {"settled": True}
    if method == "read": return records(p["service"])
    raise ValueError(-32601, "no such method: " + method)

for line in sys.stdin:
    try:
        req = json.loads(line)
    except json.JSONDecodeError:
        out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "not JSON"}}
    else:
        if not isinstance(req.get("id"), int) or not isinstance(req.get("method"), str):
            out = {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "not a request"}}
        else:
            try:
                out = {"jsonrpc": "2.0", "id": req["id"], "result": handle(req["method"], req.get("params", {}))}
            except ValueError as e:
                out = {"jsonrpc": "2.0", "id": req["id"], "error": {"code": e.args[0], "message": e.args[1]}}
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
```

### Trying it by hand

Pipe lines into the host and read the answers:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"setup","params":{"protocol":2,"services":["store"],"namespace":"s0599e33863c1"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"startCapture","params":{"service":"store"}}' \
  '{"jsonrpc":"2.0","id":3,"method":"invoke","params":{"command":"Place","input":{"id":"42"}}}' \
  '{"jsonrpc":"2.0","id":4,"method":"stopCapture","params":{"service":"store"}}' \
  | node host.mjs
```

```
{"jsonrpc":"2.0","id":1,"result":{"protocol":2,"namespace":"s0599e33863c1"}}
{"jsonrpc":"2.0","id":2,"result":{}}
{"jsonrpc":"2.0","id":3,"result":{"status":"OK","body":{"id":"42"}}}
{"jsonrpc":"2.0","id":4,"result":[{"type":"Placed","key":"s0599e33863c1:order:42","payload":{"id":"42"},"timestamp":1794354004130}]}
```

### Using it from a spec

With the config at the top of this file and `host.mjs` as the host
(`"command": ["node", "host.mjs"]`), this spec passes:

```
feat 1.0

spec SPEC-PLC-001 "Place an order"
context Orders
aggregate Order
type command
status agreed

construct:
  handler at host.mjs
  touches **

enforce:
  append Placed to the store
  rejects STORE_REJECTED when the store rejects

contract:
  input PlaceInput
  response Placed
  event PlacedEvent
  error Refusal

scenario "places an order":
  when: Place { id: "42" }
  predict success:
    response OK Placed { id: @when.id }
    store has [ Placed with PlacedEvent { id: @when.id } ]

scenario "the store rejects once":
  given:
    fault store Place Reject once
  when: Place { id: "43" }
  predict rejection STORE_REJECTED:
    response ERR Refusal { code: "STORE_REJECTED" }
    store has []
```

The same project with `"command": ["python3", "host.py"]` passes the same
scenarios.

## API

```ts
import {
  createAdapter,
  StdioResponseAdapter,
  StdioServiceAdapter,
  PROTOCOL_VERSION,
  exchange,
  exchangeOnce,
  ExchangeError,
  DEFAULT_TIMEOUT_MS,
  HostConnection,
  HostRegistry,
  defaultRegistry,
  type ExchangeInput,
  type HostConfig,
} from "@mmmnt/feat-adapter-stdio-jsonrpc";
```

You rarely call these yourself: the runner loads the adapter from
`feat.config.json`. They are exported for tests, tooling and custom runners.

### Adapters

| Export | Meaning |
|---|---|
| `createAdapter(config)` | The adapter factory the runner calls. With no `config.key` it returns a response role built from `config.invoke.host`. With a `key` it returns that service role, built from `config.options.host` and `config.options.faults`. Throws a configuration error when the host has no `command`. |
| `StdioResponseAdapter` | The response role: `setup()`, `invoke(command, input, actor?)`, `setClock()`, `teardown()`. |
| `StdioServiceAdapter` | A service role: `setup()`, `reset()`, `startCapture()`, `peekCapture()`, `stopCapture()`, `settle()`, `read()`, `seed()`, `deliver()`, `fault()`, `setClock()`, `teardown()`. Exposes `faults` and `acceptsFaultDetail`. |
| `PROTOCOL_VERSION` | `2`. |

Both roles accept `namespace` (the runner's, default `""`) and an optional
`registry` in their config. A test can hand each simulated spec file its own
`HostRegistry`.

```ts
import { createAdapter, HostRegistry, type StdioResponseAdapter, type StdioServiceAdapter } from "@mmmnt/feat-adapter-stdio-jsonrpc";

const host = { command: ["node", "host.mjs"] };
const namespace = "s0599e33863c1";
const registry = new HostRegistry();

const response = createAdapter({ invoke: { host }, namespace, registry }) as StdioResponseAdapter;
const store = createAdapter({
  key: "store",
  options: { host, faults: { Place: { Reject: ["once", "times"] } } },
  namespace,
  registry,
}) as StdioServiceAdapter;

await response.setup();
await store.setup();               // joins the host the response role spawned
await store.reset();
await response.setClock("2026-11-10T12:00:00Z");
await store.setClock("2026-11-10T12:00:00Z");
await store.startCapture({ specType: "command" });
console.log(await response.invoke("Place", { id: "1" }));   // { status: "OK", body: { id: "1" } }
console.log(await store.settle(), await store.stopCapture());
await response.teardown();
await store.teardown();            // the last role out ends the host
```

### One exchange

| Export | Meaning |
|---|---|
| `exchange(input)` | Runs one request and answers `{ status: "OK", body }` or `{ status: "ERR", body: { code, detail, hostSpawned, hostAlive, rpcCode?, message? } }`. Never throws an `ExchangeError`. |
| `exchangeOnce(input)` | The same, but resolves with the result and rejects with an `ExchangeError`. |
| `ExchangeInput` | `{ host: { command: string[] }, method, params, timeoutMs? }`. |
| `DEFAULT_TIMEOUT_MS` | `30000`. |
| `ExchangeError` | `Error` with `code`, `detail`, `hostSpawned` and `extra` (`rpcCode`, `message`). Its message is `"<code>: <detail>"`. |

An exchange validates the request **before** spawning, spawns the host, writes
one line, reads one line, checks the answer against the closed shape of its
method, kills the host and returns. It never retries and leaves nothing running.
`hostAlive` is always `false` after an exchange.

```ts
import { exchange } from "@mmmnt/feat-adapter-stdio-jsonrpc";

const r = await exchange({
  host: { command: ["node", "host.mjs"] },
  method: "setup",
  params: { protocol: 2, services: ["store"], namespace: "s0599e33863c1" },
});
// { status: "OK", body: { method: "setup", sent: {...}, hostSpawned: true, hostAlive: false,
//                         result: { protocol: 2, namespace: "s0599e33863c1" } } }
```

### The shared host

| Export | Meaning |
|---|---|
| `HostConnection` | A long-lived host process. `HostConnection.spawn(config, namespace, timeoutMs?)`, `request(method, params)`, `close()`, `pid`, `ended`, `crashed`. Calls are serialised. |
| `HostRegistry` | The open host of one spec file. `join(config, namespace)` and `leave(host)`. The last role to leave ends the host. |
| `defaultRegistry` | The module-scoped registry the adapters use by default. |
| `HostConfig` | `{ command: string[], cwd?: string, env?: Record<string, string> }`. |

When the host process exits without being asked to, every pending call and every
later call of every role of that file fails with `HOST_CRASHED`. No other file is
affected.

## Errors

Every refusal is an `ExchangeError` with a `code` and a `detail`.

| Code | Meaning |
|---|---|
| `INVALID_REQUEST` | The request does not validate against the protocol schema, or names a method outside it. No host was spawned and nothing was written. |
| `HOST_SPAWN_FAILED` | The host command could not be started. |
| `HOST_EXITED` | In a one-shot exchange, the host exited before it answered. |
| `HOST_CRASHED` | The shared host process exited. Every pending and later call of the file fails with it. |
| `HOST_TIMEOUT` | No answer within the timeout (30 seconds by default). |
| `HOST_ERROR` | The host answered with a JSON-RPC error. The code and message are relayed verbatim (`rpcCode`, `message`). |
| `PROTOCOL_VIOLATION` | The host's line is not JSON, does not validate against the protocol schema, carries another `id`, uses a null `id` outside `-32700` and `-32600`, or carries a result that breaks the closed shape of the method. Includes a `setup` answer with no namespace echo. |
| `PROTOCOL_MISMATCH` | The host's `setup` result names a protocol version other than 2. |
| `NAMESPACE_NOT_HONOURED` | The host's `setup` result names a namespace other than the one sent. |
| `INVALID_CLOCK` | `setClock` was given a string that is not an ISO-8601 instant with a zone designator. |
| `HOST_CONFIG_MISMATCH` | A role's host configuration differs from the host already open for its file. |
| `FAULT_UNSUPPORTED` | The harness refuses an arm outside the service's fault catalog, or with a count the catalog does not declare for that fault. Raised by the runner before the case has any effect. |

## This release (0.2.0)

- **Fault shape C** (SPEC-RPC-001 amended, founder ruling 2026-11-13). The
  `fault` request gains `untilReset` and `detail`, both optional; `times` and
  `untilReset` are exclusive. The adapter carries `until reset` and a fault
  detail to the host, and its catalog is offered as declared, so a line such as
  `fault log AppendToStream WRONG_EXPECTED_VERSION { stream: "x" } until reset`
  reaches a spec host exactly as a native adapter takes it. The protocol
  version stays 2: a request without the new fields is unchanged.

## 0.1.0 (Feature v0.1.48)

New package, specified by SPEC-RPC-001 (one exchange) and SPEC-RPC-002 (one
shared host per spec file). Amendments it carries:

- **Protocol version 2.** `setup` carries `protocol`, the `services` and the
  runner `namespace`, and the host echoes the namespace (SPEC-RT-006).
- **Fault shape B.** The `fault` request stays `{ service, kind, times }`. The
  adapter maps the harness arm onto `kind = "<operation>.<fault>"`, and its
  catalog declares only `once` and `times n`.
- **Files keyed by name** in the RPC-002 evidence: per-file facts are an object
  keyed by file name, so a scenario asserts only the facts it lists.
- The scenario clock reaches every role through `setClock`, and the host's
  answer to `settle` is relayed unchanged.

## Specs and design

- [`transport.feat`](https://github.com/mmmnt/feature/blob/main/adapters/stdio-jsonrpc/transport.feat): SPEC-RPC-001.
- [`host-sharing.feat`](https://github.com/mmmnt/feature/blob/main/adapters/stdio-jsonrpc/host-sharing.feat): SPEC-RPC-002.
- [`schemas/feat-host-protocol.schema.json`](https://github.com/mmmnt/feature/blob/main/schemas/feat-host-protocol.schema.json): the protocol contract. This package ships a copy.
- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2: observation modes, the scenario clock, fault injection.
- [Draft ADR](https://github.com/mmmnt/feature/blob/main/drafts/stdio-jsonrpc-adapter/ADR-DRAFT.md) for this adapter.
- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md): the `fault` and `clock at` lines.

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## License

MIT
