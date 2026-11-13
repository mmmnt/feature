# @mmmnt/feat-adapter-neo4j

Service adapter for Feat that turns **a Neo4j graph into a capture window by
snapshot diff**: the adapter snapshots the namespace's nodes and relationships
when the window opens and compares at the end, so every node or relationship the
system created, changed or removed becomes a captured `INSERT`, `MODIFY` or
`REMOVE` record. An unpredicted change fails the suite by prediction inversion.
The adapter is built on the official `neo4j-driver`.

```jsonc
// feat.config.json
"services": {
  "graph": {
    "adapter": "@mmmnt/feat-adapter-neo4j",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "uriEnv": "FEAT_NEO4J_URI",                      // or "uri": "bolt://localhost:7687"
      "keys": { "Order": "orderId", "Customer": "customerId" }
    }
  }
}
```

```
predict success:
  response 201 OrderCreated { orderId: @when.orderId }
  graph has [ INSERT with OrderNode { orderId: @when.orderId, status: "placed" } ]
```

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## What it observes, and how

The adapter declares `observes = { diff: "snapshot", state: true }`. Neo4j
Change Data Capture is an Enterprise Edition and Aura feature, and the adapter's
target is a Community server, which has no change feed. So the window is a
**snapshot comparison**, not a log read.

- **Namespace graph.** A node is in the namespace when it carries the label
  `ns_<ns>`. A relationship is in the namespace when both of its nodes do. The
  namespace label is stripped from everything the adapter reports.
- **Diff.** `startCapture()` snapshots the namespace in a read transaction.
  `peekCapture()` and `stopCapture()` snapshot again and diff by identity: a node
  that is new is `INSERT`, one whose properties or labels changed is `MODIFY`, one
  that is gone is `REMOVE`. The same holds for relationships.
- **Identity.** A node is `(first declared label, value of that label's key
  property)`, from `options.keys`. A relationship is `(start identity, type, end
  identity)`; parallel equal relationships collapse into one record with a
  `count`. Neo4j's `elementId` is not used, because it can be reused after a
  delete and would turn a delete plus a create into a `MODIFY`.
- **State.** `read()` reports the namespace's nodes and relationships, or a keyed
  `MATCH` when the hints allow it.
- **Settle.** `settle()` answers `true` on a direct (`bolt://`) connection once
  `SHOW TRANSACTIONS` lists no transaction except the instrument's own, which the
  adapter tags with transaction metadata `app: feat-instrument-<ns>` and ignores.
  A committed transaction is visible to a later read on the same server; an open
  one is an effect that is not yet decided, so settle polls until it ends and
  answers `false` if one is still running after `settleTimeoutMs`. It answers
  `false` with no window open, and **always `false` for a routing URI**
  (`neo4j://`, `neo4j+s://`, `neo4j+ssc://`), because another cluster member may
  serve the read. An empty window settles `true`, which is how an absence is
  proven. It writes nothing.
- **No `deliver()`.**

Declare the service `eventual`: `settle()` ends the convergence wait on proof,
and `convergenceTimeout` is the ceiling when it cannot vouch. `eventual`
services compare predictions unordered by default.

### The captured record

A node:

```
{ type: INSERT | MODIFY | REMOVE, key: "<Label>:<keyValue>",
  payload: { ...properties, labels: [<labels, namespace label removed, sorted>] },
  timestamp: <capture time> }
```

A relationship:

```
{ type: INSERT | MODIFY | REMOVE, key: "<node key>-[<TYPE>]-><node key>",
  payload: { ...properties, from: "<node key>", to: "<node key>", relType: "<TYPE>", count: <n> },
  timestamp: <capture time> }
```

`REMOVE` carries the last known properties. Nodes come before relationships,
each sorted by key. Driver integers become numbers (or strings outside the safe
range) and temporal and spatial values become strings, so payloads compare as
plain JSON. `read()` returns the same shape without the diff type: `type` is the
node's identity label, or the relationship type.

## Install

```sh
npm install --save-dev @mmmnt/feature @mmmnt/feat-adapter-neo4j
```

- Node 20 or later (`engines.node` is `>=20`). The adapter is ESM.
- No peer dependencies. `neo4j-driver` (pinned at 6.3.0) and
  `@mmmnt/feat-fault-proxy` are regular dependencies.
- The supported product is Neo4j **Community**, with one user database. The
  adapter's tests run against `neo4j:2026.01.4-community` over a direct `bolt://`
  connection, with `ghcr.io/shopify/toxiproxy:2.12.0` for the transport specs.
  Against that image the driver connects, `SHOW TRANSACTIONS` works, and an
  uncommitted node is invisible to other sessions. Other server versions and
  Enterprise are not exercised. A deployment with CDC on could one day get a
  native binding, but none exists.
- The instrument's user must be allowed to run `SHOW TRANSACTIONS` (the default
  admin can), create and drop constraints (faults and reset), and read and write
  the namespace.
- The package ships `dist/` only. Its `fixtures/` helpers are internal.

## Configuration

A complete service entry. `uri` or `uriEnv` and `keys` are required; every other
option is optional.

```jsonc
"services": {
  "graph": {
    "adapter": "@mmmnt/feat-adapter-neo4j",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "uriEnv": "FEAT_NEO4J_URI",                        // name of the variable holding the URI
      // "uri": "bolt://localhost:7687",                 // or a literal; wins over uriEnv
      "auth": {                                          // env-var NAMES, never values; omit for a server without auth
        "username": "FEAT_NEO4J_USER",
        "password": "FEAT_NEO4J_PASSWORD"
      },
      "keys": {                                          // label -> the property that identifies a node of that label
        "Order": "orderId",
        "Customer": "customerId"
      },
      "settleTimeoutMs": 5000,                           // default 5000
      "proxy": {                                         // transport faults on the system's path
        "api": "http://127.0.0.1:8474",                  // Toxiproxy API
        "upstream": "127.0.0.1:7687",                    // host:port of the server, as Toxiproxy reaches it
        "name": "neo4j",                                 // product label of the proxy name feat-<ns>-<name>; default "neo4j"
        "container": "neo4j",                            // accepted, but BrokerLoss is not offered by this adapter
        "metrics": "http://127.0.0.1:8474/metrics",      // Toxiproxy /metrics URL
        "runtime": "docker"                              // container runtime CLI; default "docker"
      }
    }
  }
}
```

| Option | Meaning |
| --- | --- |
| `uri` | A Bolt URI. `bolt://` direct is the supported shape. |
| `uriEnv` | The name of an environment variable holding the URI. Used when `uri` is absent. Neither set, or the variable unset or empty, is a configuration error. |
| `uriFile` | The path of a file whose content is the URI (SPEC-ADPNEO-003). Never given with `uri` or `uriEnv` (`OPTIONS_INVALID`); `uri` and `uriEnv` together still mean the literal wins. |
| `auth` | Either `{ username, password }`: the **names** of two environment variables, both of which must be set; or `{ user, passwordFile }` (SPEC-ADPNEO-003): the login name itself and the path of a file whose content is the password. The two forms are never mixed, and the file form needs both keys (`OPTIONS_INVALID`). Omit it for a server without authentication. |

A file option holds a path, never a secret. A relative path is resolved against the working directory of the run. The file is
read at `setup()`, before any connection: exactly one trailing LF or CRLF is removed and nothing else, so a password with spaces
is kept as written. The driver takes the password as an auth token, so it is never decoded or re-encoded. A file that is missing,
is a directory, cannot be read, or is empty after the line ending is removed is refused with `CREDENTIAL_FILE_UNREADABLE`, whose
detail names the option, the path and the cause and never the content.
| `keys` | **Required** (a config without it is refused at `setup()` with `OPTIONS_INVALID`) for every label the system writes: label to key property. A namespaced node whose labels declare no key, or that has no value for its key property, makes the snapshot fail with `NODE_KEY_UNDECLARED`. If a node has several declared labels, the first one in this object's order is its identity. |
| `settleTimeoutMs` | How long `settle()` may wait for other transactions to finish. Default 5000. Keep `convergenceTimeout` at or above it. |
| `proxy` | A Toxiproxy in front of the server for `Connection` faults. `api` and `upstream` are required. See below. |

The adapter does not reject unknown keys under `options`; a misspelled option is
ignored. The adapter's own driver (snapshots, settle, seeds, faults, reset)
connects to the server **directly** and never through the proxy.

## A minimal spec

```
feat 1.0

spec SPEC-ORD-030 "PlaceOrder writes an Order node"
context Orders
aggregate Order
type command
status agreed

construct:
  handler at features/place-order/handler.ts
  touches features/place-order/**

enforce:
  create an Order node carrying the namespace label
  rejects DUPLICATE_ORDER when the graph refuses a repeated orderId

contract:
  input PlaceOrderInput
  response OrderCreated
  record CustomerNode
  record OrderNode
  error Refusal

scenario "an order is created for a seeded customer":
  given:
    The customer c-1 exists already.
    seed graph [ Customer with CustomerNode { customerId: "c-1", name: "Ada" } ]
  when: PlaceOrder { orderId: "o-1", customerId: "c-1" }
  predict success:
    response 201 OrderCreated { orderId: @when.orderId }
    graph has [ INSERT with OrderNode { orderId: @when.orderId, status: "placed" } ]

scenario "a repeated orderId is refused by the graph":
  given:
    fault graph Write UNIQUE_CONSTRAINT_VIOLATION { property: "orderId", value: "o-2" } until reset
  when: PlaceOrder { orderId: "o-2", customerId: "c-1" }
  predict rejection DUPLICATE_ORDER:
    response 409 Refusal { code: "DUPLICATE_ORDER" }
    graph has []
```

The seed record's `type` is the node's label; `values` are its properties, set
with `CREATE (n:<type>:ns_<ns>) SET n = $values` in one transaction before the
window, so seeds are never in a capture. Include the key property, or the node
cannot be identified later. **Seeds create nodes only**; a relationship is made
by the system or by a fixture of your own. The fault line must say
`until reset` (see the fault table).

## Namespaces

The runner derives a namespace per spec file, exactly `^s[0-9a-f]{12}$`
(SPEC-RT-006), and hands it to the adapter as the config's top-level
`namespace`. It is never an option. Community has one user database, so the
namespace is a **label**:

- Every node the system writes must carry `ns_<ns>`. A node without it is
  nobody's effect, and is neither captured nor read.
- A relationship belongs to the namespace when both ends carry the label.
  A relationship with **exactly one** namespaced end is a `NAMESPACE_BREACH`:
  the snapshot refuses rather than reporting a silent effect.
- The label is stripped from the `labels` the adapter reports.
- `reset()` deletes the whole namespace graph (`DETACH DELETE` of every node with
  the label, in batches of 1000), seeds included, and drops the constraints its
  faults created. It leaves other namespaces alone.

## Read

`read()` takes hints from `contains` assertions: an entry that gives a label (the
record type) and a key literal makes a keyed `MATCH (n:<Label>:ns_<ns>)` on the
key property from `options.keys` (or on the entry's single key property when the
label is not declared). A hint may return a superset, never fewer. Without usable
hints the adapter reads the namespace graph (nodes, then relationships, each by
key). The fault placeholder is never returned.

## Faults

All faults are armed `until reset`. The server reports no write it refused, so
`firedFaults` is not implemented and evidence is `unobserved`. A fault line with
any other count is refused with `FAULT_UNSUPPORTED` before it has an effect.

| Fault | Operation | Counts | Detail | What the system sees |
| --- | --- | --- | --- | --- |
| `UNIQUE_CONSTRAINT_VIOLATION` | `Write` | `until reset` | `{ property, value }` (both required) | The adapter creates a uniqueness constraint `feat_<ns>_<property>` on the namespace label itself (`FOR (n:ns_<ns>) REQUIRE n.<property> IS UNIQUE`) and a placeholder node holding `<property> = <value>`, marked `__feat_fault` and never reported. A write by the system of a namespaced node with the same value is refused by Neo4j with a constraint-validation error. The constraint is on the namespace label, so it cannot touch another namespace. |
| `Timeout` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy stalls the stream and never delivers; the system's call runs into its own deadline. Armed downstream (the library default; the adapter passes no direction), so an established connection can have a request applied whose answer the system never hears. |
| `ConnectionReset` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy resets the connection (default direction upstream, on the request path). |
| `Partition` | `Connection` | `until reset` | none | Needs `options.proxy`. The proxy is disabled: the system's connections fail. |

`detail.property` must be an identifier (`^[A-Za-z_][A-Za-z0-9_]*$`).
`detail.value` must be a string, number or boolean; a missing, null or object
value is refused, with `FAULT_UNSUPPORTED`, before any effect. `reset()` drops the
constraint and the placeholder.

Not offered: deadlock and lock-timeout faults (the default lock timeout is
unbounded and would hang), a read-only mode (database access control is not
assumed in Community), `BrokerLoss`, and `once` or `times` counts for every
fault.

### Transport faults

Set `options.proxy` and the catalog gains `Connection.Timeout`,
`Connection.ConnectionReset` and `Connection.Partition`. The mechanism is
[`@mmmnt/feat-fault-proxy`](https://github.com/mmmnt/feature/blob/main/adapters/fault-proxy/README.md) (SPEC-FPX-001): one
Toxiproxy proxy per namespace and product, named `feat-<ns>-<name>`.

- A transport fault is on the **system's path only**. The adapter observes on its
  own direct connection, so under a fault the capture, the settle and the state
  read still work, and an absence under a fault is still provable.
- Point the system at the proxy's listen address (`proxyListen()` on the
  adapter) with a **direct `bolt://` URI**. A routing driver follows the
  addresses the server advertises, past the proxy.
- Whether a fault was consumed is unobserved: the proxy reports bytes, not
  activations.
- A `Connection` fault without `options.proxy` is not in the catalog and is
  refused with `FAULT_UNSUPPORTED`. `options.proxy.container` is passed to the
  library, but this adapter's catalog never offers `BrokerLoss`.

## Errors and refusals

Adapter errors are `Neo4jAdapterError`, with a `code` and a `detail`.

| Code | Raised by | When |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The namespace does not match `^s[0-9a-f]{12}$`. Defensive: the runner never passes another. |
| `NEO4J_UNREACHABLE` | `setup()` | The server did not answer `verifyConnectivity`. The detail names the URI with any credentials removed. |
| `OPTIONS_INVALID` | `setup()` | `options.keys` is missing, is not an object, or maps a label to something other than a non-empty string. Also `uriFile` given with `uri` or `uriEnv`, an `auth` that mixes the variable names with `user`/`passwordFile`, or an `auth` with only one of `user` and `passwordFile` (SPEC-ADPNEO-003). Refused before any file is read or any connection. An empty object is accepted (nothing is declared yet; a namespaced node then fails with `NODE_KEY_UNDECLARED`). |
| `CREDENTIAL_FILE_UNREADABLE` | `setup()` | A file named by `uriFile` or `auth.passwordFile` is missing, is a directory, cannot be read, or is empty after one trailing line ending is removed. Refused before any connection; the detail never carries the content. |
| `NODE_KEY_UNDECLARED` | snapshot: `startCapture()`, `peekCapture()`, `stopCapture()`, and `read()` | A namespaced node carries no label that declares a key in `options.keys`, or has no value for its key property. |
| `NAMESPACE_BREACH` | snapshot: `startCapture()`, `peekCapture()`, `stopCapture()`, and an unhinted `read()` | A relationship joins a namespaced node and a node outside the namespace. |
| `FAULT_UNSUPPORTED` | `fault()` | The fault is not in the catalog (including `Connection` without `options.proxy`), the count is not `until reset`, or the detail is missing `property` (an identifier) or `value` (a scalar). The detail lists the catalog. |

`NODE_KEY_UNDECLARED` and `NAMESPACE_BREACH` surface when the snapshot is taken,
not at `setup()`; a missing `options.keys` is refused at `setup()`, as `OPTIONS_INVALID`. Plain `Error`s (no code) report a missing `uri` (or `uriEnv`, or `uriFile`) and
`options.auth` naming variables that are not both set. Errors from the Toxiproxy
layer keep the codes of `@mmmnt/feat-fault-proxy` (`PROXY_UNREACHABLE`,
`PROXY_NOT_OPEN`, `FAULT_UNSUPPORTED`, `CONTAINER_NOT_FOUND`,
`CONTAINER_RUNTIME_UNAVAILABLE`).

## Limitations

- **A snapshot diff has blind spots.** A node created and removed inside the
  window is invisible, and so is a write that leaves the properties unchanged.
  The diff is exact for what is still there at the end.
- **Identity needs `options.keys`.** Every label the system writes must declare a
  key property, and the value must be present and stable.
- **Settle waits for every other transaction on the server**, not only the
  namespace's: any open transaction that is not the instrument's keeps it from
  vouching, until `settleTimeoutMs`. It is truthful only on a direct `bolt://`
  single-server connection, and does not prove the system's work after its
  handler returned.
- **Cost.** Each snapshot reads the whole namespace graph, and `read()` without
  hints does the same. Keep a namespace small.
- The `UNIQUE_CONSTRAINT_VIOLATION` value must not already be held by a namespaced
  node, or the constraint or the placeholder cannot be created.
- Seeds create nodes only.
- The system must put the `ns_<ns>` label on every node it writes; how the
  namespace reaches the system is the host's business.
- Server versions other than the tested Community image, and Enterprise, are not
  exercised. The adapter never uses CDC.
- The `options.proxy` block needs a Toxiproxy server you run; the adapter does
  not start one.
- Options are validated only for `keys`: unknown keys are ignored.

## Specs and design

- [`observe.feat`](https://github.com/mmmnt/feature/blob/main/adapters/neo4j/observe.feat): SPEC-ADPNEO-001, snapshot diff, namespaced
  graph, settle, reset and faults.
- [`transport.feat`](https://github.com/mmmnt/feature/blob/main/adapters/neo4j/transport.feat): SPEC-ADPNEO-002, transport faults on the
  system's path (integration tier).
- [`DESIGN.md`](https://github.com/mmmnt/feature/blob/main/adapters/neo4j/DESIGN.md): the client choice, why the diff is a snapshot, the
  settle proof, the namespace and the faults, with sources.

The generated suites run under `feat run` against throwaway containers that the
fixture starts and removes on exit. They are not part of the package's `test`
script.

## License

MIT. Docs: https://github.com/mmmnt/feature/wiki
