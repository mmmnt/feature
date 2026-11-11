# @mmmnt/feat-adapter-kurrent

Service adapter for Feat that turns a **KurrentDB `$all` log into a capture
window**: every event the system appends to a namespaced stream during a
scenario becomes a captured record, in log order. An unpredicted append fails
the suite by prediction inversion. The adapter is built on the official
`@kurrent/kurrentdb-client`.

```jsonc
// feat.config.json
"services": {
  "orderStore": {
    "adapter": "@mmmnt/feat-adapter-kurrent",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "connectionStringEnv": "FEAT_KURRENT_URL"   // or "connectionString": literal
    }
  }
}
```

```
predict success:
  response 202 OrderAccepted { orderId: @when.orderId }
  orderStore has [ OrderPlaced with OrderPlacedEvent { orderId: @when.orderId } ]
```

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## What it observes, and how

The adapter declares `observes = { diff: "native", state: true }`.

- **Diff (native).** The `$all` log is the change feed. `startCapture()`
  appends a marker to the fence stream `feat-fence.<ns>` and keeps the marker's
  commit position as an exclusive cursor, so there is no inclusive or exclusive
  ambiguity at the start of the window. `peekCapture()` and `stopCapture()` read
  `$all` forwards from that cursor with a server-side stream-name prefix filter
  (`<ns>.` and `$$<ns>.`) and return what the system wrote, in commit-position
  order. The order is the log's: total, even across streams.
- **State.** `read()` reads the namespace's streams forwards, so `contains`
  assertions see what is stored, not only what changed.
- **Settle (a proof, not a timeout).** After the system's writes returned,
  `settle()` appends a fence marker, reads `$all` from the cursor until an event
  at or beyond the marker's position is seen, and answers `true`. Every write
  committed before the marker is then visible to the capture. It also proves an
  absence: an empty window settles `true`. It answers `false` when no window is
  open, when the marker is not read back within `settleTimeoutMs`, or when the
  append or the read fails (a paused or unreachable node answers `false`, never
  `true`). The fence marker is never in a capture.
- **No `deliver()`.** KurrentDB has no inbound trigger; a stimulus is the
  system's own append.

Declare the service `eventual`: `settle()` ends the convergence wait on proof,
and `convergenceTimeout` is the ceiling when it cannot vouch. `eventual`
services compare predictions unordered by default; write `has ordered [ ... ]`
when the log order is part of the prediction.

### The captured record

```
{ type: <event type>, key: <stream, without the namespace prefix>,
  payload: <the event's JSON data>, timestamp: <created time, ms>,
  metadata: { revision, commitPosition } }
```

What a capture keeps and drops:

- Events of streams outside the namespace are nobody's effect and are not
  captured.
- Events the adapter itself wrote (metadata `{ "feat": "instrument" }`: fence
  markers and fault placeholders) are never captured, peeked or read.
- Server-written system events (types starting with `$`) are dropped, except
  `$streamDeleted` and `$metadata`. A soft delete or a metadata change by the
  system is therefore captured, with key `$$<stream>` and type `$metadata`.
- Events that are not JSON are dropped.

### The `$tb` metadata rule

On KurrentDB 26.2.3 the first append to a stream after a soft delete makes the
server write `$$<stream>/$metadata` with a body of exactly `{ "$tb": n }`, where
`n` is below the Int64 maximum. That record is the server's, not the system's,
so the capture drops it. A soft delete by the system writes the same body with
`n` equal to the Int64 maximum (`9223372036854775807`; the client delivers it as
the JSON number 2^63). That is the system's effect and is captured. A body with
any other key, or an `n` that is not a non-negative integer below the maximum,
is captured. (Founder ruling 2026-11-09, "Kurrent $tb A".)

## Install

```sh
npm install --save-dev @mmmnt/feature @mmmnt/feat-adapter-kurrent
```

- Node 20 or later (`engines.node` is `>=20`). The adapter is ESM.
- No peer dependencies. `@kurrent/kurrentdb-client` (pinned at 1.3.2) and
  `@mmmnt/feat-fault-proxy` are regular dependencies.
- The supported product is KurrentDB. The adapter's tests run against
  `kurrentplatform/kurrentdb:26.2.3`, a single secure dev node
  (`KURRENTDB_DEV=true`, projections off, `tlsVerifyCert=false`) with an
  admin user and non-admin `writer` and `reader` users. The adapter does not
  need projections: streams are found by an `$all` prefix scan, not `$streams`.
  Kurrent Cloud works through `connectionString`; nothing here needs AWS.
- **A cluster is not verified.** Commit positions are positions in one node's
  log, so `settle()` is a proof only when the append and the read go to the same
  node. A single node is the tested shape.
- The instrument identity must be able to read `$all`, which KurrentDB allows
  for an admin identity. Any other identity is refused at `setup()` with
  `ALL_READ_DENIED`.
- The package ships `dist/` only. Its `fixtures/` helpers are internal.

## Configuration

A complete service entry. Every key under `options` is optional except that a
connection string must be supplied one way or the other.

```jsonc
"services": {
  "orderStore": {
    "adapter": "@mmmnt/feat-adapter-kurrent",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "connectionStringEnv": "FEAT_KURRENT_URL",        // name of the variable holding the connection string
      // "connectionString": "kurrentdb://localhost:2113?tls=false",   // or a literal; wins over connectionStringEnv
      "system": {                                        // env-var NAMES for the instrument's credentials
        "username": "FEAT_KURRENT_USER",
        "password": "FEAT_KURRENT_PASSWORD"
      },
      "settleTimeoutMs": 5000,                           // default 5000
      "nodeMajor": 24,                                   // the Node major the TLS host rule judges by; default the running Node's
      "proxy": {                                         // transport faults on the system's path
        "api": "http://127.0.0.1:8474",                  // Toxiproxy API
        "upstream": "127.0.0.1:2113",                    // host:port of the node, as Toxiproxy reaches it
        "name": "kurrent",                               // product label of the proxy name feat-<ns>-<name>; default "kurrent"
        "container": "kurrentdb",                        // the node's container; without it BrokerLoss is not offered
        "metrics": "http://127.0.0.1:8474/metrics",      // Toxiproxy /metrics URL
        "runtime": "docker"                              // container runtime CLI; default "docker"
      }
    }
  }
}
```

| Option | Meaning |
| --- | --- |
| `connectionString` | A literal `kurrentdb://` or `kurrentdb+discover://` string. |
| `connectionStringEnv` | The name of an environment variable holding the string. Used when `connectionString` is absent. Neither set, or the variable unset or empty, is a configuration error at `setup()`. |
| `system` | `{ username, password }`: the **names** of two environment variables. Their values replace the credentials in the connection string. Both must be set. The config carries references, never secrets. |
| `settleTimeoutMs` | How long `settle()` may take to read its fence marker back. Default 5000. Keep `convergenceTimeout` at or above it. |
| `nodeMajor` | An integer that overrides the Node major the TLS host rule uses, so a scenario can put the adapter "on Node 24 or 26" without a second Node. Default: the running Node's major. |
| `proxy` | A Toxiproxy in front of KurrentDB for `Connection` faults. `api` and `upstream` are required. See below. |

The adapter does not reject unknown keys under `options`; a misspelled option is
ignored. `connectionString` and `connectionStringEnv` may both appear; the
literal wins.

The adapter's own client (capture, fence, read, seed, reset) connects to the
node **directly** and never through the proxy.

## A minimal spec

```
feat 1.0

spec SPEC-ORD-010 "PlaceOrder appends to the order stream"
context Orders
aggregate Order
type command
status agreed

construct:
  handler at features/place-order/handler.ts
  touches features/place-order/**

enforce:
  append OrderPlaced to the stream orders-<orderId>
  rejects CONCURRENCY_CONFLICT when the store reports a wrong expected version

contract:
  input PlaceOrderInput
  response OrderAccepted
  event OrderPlacedEvent
  event OrderSeededEvent
  error Refusal

scenario "a first order is appended":
  given:
    A customer has an earlier order in another stream.
    seed orderStore [ OrderSeeded with OrderSeededEvent { stream: "orders-o-0", orderId: "o-0" } ]
  when: PlaceOrder { orderId: "o-1" }
  predict success:
    response 202 OrderAccepted { orderId: @when.orderId }
    orderStore has [ OrderPlaced with OrderPlacedEvent { orderId: @when.orderId } ]

scenario "a competing writer created the stream first":
  given:
    fault orderStore AppendToStream WRONG_EXPECTED_VERSION { stream: "orders-o-2" } until reset
  when: PlaceOrder { orderId: "o-2" }
  predict rejection CONCURRENCY_CONFLICT:
    response 409 Refusal { code: "CONCURRENCY_CONFLICT" }
    orderStore has []
```

The seed record's event type is `OrderSeeded`. It goes to the stream named in
`values.stream` (`orders-o-0`), or to a stream named after the record type when
`values` has no string `stream`. The whole of `values`, `stream` included, is
the event data. Seeds are written before the window opens, so they are never in
a capture. The fault line must say `until reset`: a count of `once` or
`times <n>` is refused (see the fault table).

## Namespaces

The runner derives a namespace per spec file, exactly `^s[0-9a-f]{12}$`
(SPEC-RT-006), and hands it to the adapter as the config's top-level
`namespace`. It is never an option. Because the form is fixed-length with no
dot, no namespace is a prefix of another.

- A stream is stored as `<ns>.<stream>`. The spec writes `orders-o-1`; the
  adapter reports `orders-o-1`. The system under test must write to the prefixed
  names. Seeds, fault details and read hints take the relative name and the
  adapter adds the prefix.
- Capture, read and reset are all scoped to the prefix. A write outside every
  namespace is nobody's effect.
- The fence stream is `feat-fence.<ns>`, outside the user prefix.
- `reset()` soft-deletes the namespace's streams. It does not tombstone them: a
  tombstoned stream name is dead forever.

## Seed, read and reset

- **`seed(records)`** appends each record to `<ns>.<stream>` with stream state
  `ANY`, before the window.
- **`read(query)`** reads the namespace's streams forwards and returns the
  events as records (`metadata: { revision }`). With hints, `contains`
  assertions that carry a `key.stream` literal name the streams to read; the
  adapter reads those and may return no others. Without hints it finds every
  stream the namespace has ever held by an `$all` prefix scan. A soft-deleted or
  never-written stream reads as empty, so state is not resurrected from `$all`.
  Instrument events, `$`-typed events and non-JSON events are skipped.
- **`reset()`** disarms every transport fault and restores a paused or stopped
  container, clears and soft-deletes every stream of the namespace (clearing
  stream metadata first, which removes an `ACCESS_DENIED` ACL), and closes the
  window.

## Faults

All logical faults are armed `until reset`: the product keeps no record of a
refusal it issued. `firedFaults` is not implemented, so evidence is
`unobserved`. A fault line with any other count is refused with
`FAULT_UNSUPPORTED` before it has an effect.

| Fault | Operation | Counts | Detail | What the system sees |
| --- | --- | --- | --- | --- |
| `WRONG_EXPECTED_VERSION` | `AppendToStream` | `until reset` | `{ stream }` (required) | The adapter appends an instrument event to the stream, so a stream the system expects **not** to exist now exists, and the server refuses the append with `WRONG_EXPECTED_VERSION`. It fires only for appends that expect `NoStream`; an append with `ANY` succeeds. |
| `ACCESS_DENIED` | `AppendToStream` | `until reset` | `{ stream }` (required) | The adapter sets the stream's `$acl` write role to one nobody holds, so the server refuses a non-admin writer's append with `ACCESS_DENIED`. `$admins` bypass ACLs, so the **system must connect as a non-admin** user. |
| `Timeout` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy stalls the stream and never delivers; the system's call runs into its own deadline. Armed downstream (the library default; the adapter passes no direction), so on an established connection the node may apply a request whose answer the system never hears. |
| `ConnectionReset` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy resets the connection (default direction upstream, on the request path). |
| `Partition` | `Connection` | `until reset` | none | Needs `options.proxy`. The proxy is disabled: the system's connections fail. |
| `BrokerLoss` | `Connection` | `until reset` | none | Needs `options.proxy.container`. The container is paused with the runtime's CLI. Exclusive and serial. |

Under a transport fault the system's gRPC client reports `UNAVAILABLE`,
`DEADLINE_EXCEEDED` or `CANCELLED`.

Not offered: `STREAM_DELETED` (a tombstone is irreversible and would poison the
namespace), `NOT_LEADER` (no native way to produce it), timeouts on the product
itself (those are `Connection.Timeout`), and `once` or `times` counts for every
fault. A race between the system's read and write cannot be produced without
sitting in the call path.

### Transport faults and broker loss

Set `options.proxy` and the catalog gains `Connection.Timeout`,
`Connection.ConnectionReset` and `Connection.Partition`. Adding
`options.proxy.container` adds `Connection.BrokerLoss`. The mechanism is
[`@mmmnt/feat-fault-proxy`](https://github.com/mmmnt/feature/blob/main/adapters/fault-proxy/README.md) (SPEC-FPX-001): one
Toxiproxy proxy per namespace and product, named `feat-<ns>-<name>`.

- A transport fault is on the **system's path only**. The adapter observes on
  its own direct connection, so under a fault the capture, the fence and the
  state read still work, and an absence under a fault is still provable.
- Point the system's client at the proxy's listen address (`proxyListen()` on
  the adapter). KurrentDB's gRPC over HTTP/2 passes through Toxiproxy's TCP
  proxy unchanged.
- Give the system a **single-node connection string** (no gossip discovery,
  which would hand the client the node's advertised address and bypass the
  proxy), and either a certificate that names the proxy host or
  `tlsVerifyCert=false` on a dev node.
- Whether a fault was consumed is unobserved: the proxy reports bytes, not
  activations.
- `BrokerLoss` pauses the node's container, which every namespace and every spec
  file shares. It is an exclusive fault: the harness runs it only in the serial
  pass with one worker and `FEAT_SERIAL=1`, and refuses it elsewhere with
  `FAULT_REQUIRES_SERIAL`. Keep it in a spec file of its own. While the node is
  paused `settle()` answers `false`, not `true`; `reset()` unpauses it.
- A `Connection` fault without `options.proxy`, or `BrokerLoss` without
  `options.proxy.container`, is not in the catalog and is refused with
  `FAULT_UNSUPPORTED`.

## The TLS host rule (SPEC-ADPKUR-004)

Node 26 refuses an IP address as the TLS server name
(`ERR_INVALID_ARG_VALUE`). `@grpc/grpc-js` 1.14.7 sets the server name to the
remote host unconditionally, and `@kurrent/kurrentdb-client` 1.3.2 has no
channel option to stop it, so a `kurrentdb://` string with `tls=true` (the
default when `tls` is absent) and an IP host cannot connect on Node 26.
`tlsVerifyCert=false` does not help, because the name is still set. The
upstream issue is
[grpc/grpc-node#3131](https://github.com/grpc/grpc-node/issues/3131); the rule
can go when grpc-js stops sending an IP as the server name.

The rule applies to the adapter's own connection (the system's client is the
system's concern), host by host, in order:

| Connection string | What the adapter does |
| --- | --- |
| Host exactly `127.0.0.1` or `::1`, `tls=true` | Connects as `localhost`. Only the host changes: credentials, port, path and every parameter are as written. This applies on **every** Node major, so one path serves the whole CI matrix. `[0:0:0:0:0:0:0:1]` is the same host as `::1`. |
| Any other IP literal, `tls=true`, Node 26 or later (or `options.nodeMajor` 26 or later) | `setup()` throws `TLS_HOST_UNSUPPORTED` before connecting. The detail names the host and says to use a hostname the certificate names, or `tls=false`. It carries no credential. |
| A hostname, `kurrentdb+discover://`, `tls=false`, or a non-loopback IP on Node below 26 | Left exactly as written. |

A string with several hosts is judged host by host; the first refused host is
the one the detail names. The loopback test is exact, not `127.0.0.0/8`:
`localhost` never resolves to `127.0.0.2`, so that address is refused on Node 26.
`[::ffff:127.0.0.1]` is an IPv4-mapped IPv6 literal: an IP host, not a loopback
host, so it is refused on Node 26.

Consequences:

- If you verify the certificate and relied on an IP SAN for `127.0.0.1`, the
  certificate must now name `localhost`.
- `@kurrent/kurrentdb-client` 1.3.2 cannot parse a **bracketed IPv6** host. Only
  `::1`, which the rule rewrites to `localhost`, can reach a node over IPv6.
- `0.0.0.0` reaches a local node on Linux and macOS but is judged by the rule
  like any non-loopback IP, so on Node 26 it is refused.

Two methods let a host check the rule without a network: `connectionRefusal()`
returns the code `setup()` would refuse with (or `undefined`), and
`connectionTarget()` returns the string the client is created from. Neither
connects, and neither throws for a refusal.

## Errors and refusals

Adapter errors are `KurrentAdapterError`, with a `code` and a `detail`.

| Code | Raised by | When |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The namespace does not match `^s[0-9a-f]{12}$`. Defensive: the runner never passes another. |
| `ALL_READ_DENIED` | `setup()` | The instrument credentials cannot read `$all`. |
| `TLS_HOST_UNSUPPORTED` | `setup()` | An IP host other than `127.0.0.1` and `::1`, with `tls=true`, on Node 26 or later. |
| `FAULT_UNSUPPORTED` | `fault()` | The fault is not in the catalog (including `Connection` without `options.proxy` and `BrokerLoss` without `container`), or the count is not `until reset`, or an `AppendToStream` fault has no `detail.stream`. The detail lists the catalog. |

Plain `Error`s (no code) report a missing connection string
(`connectionString`, or `connectionStringEnv` naming a set variable) and
`options.system` naming variables that are not both set. Errors from the
Toxiproxy layer keep the codes of `@mmmnt/feat-fault-proxy`
(`PROXY_UNREACHABLE`, `PROXY_NOT_OPEN`, `FAULT_UNSUPPORTED`,
`CONTAINER_NOT_FOUND`, `CONTAINER_RUNTIME_UNAVAILABLE`).

## Limitations

- `settle()` does not prove writes the system starts after its handler returned
  (the ADR-0021 boundary), and a cluster is not verified (see Install).
- `read()` without a hint and `reset()` find the namespace's streams by scanning
  `$all` from the start, so their cost grows with the log. `reset()` leaves the
  fence stream `feat-fence.<ns>` in place; it holds only instrument markers.
- Non-JSON events are not captured or read.
- `WRONG_EXPECTED_VERSION` fires only for appends that expect `NoStream`.
  `ACCESS_DENIED` needs a non-admin system identity. Neither can be armed
  `once`.
- The `options.proxy` block needs a Toxiproxy server you run; the adapter does
  not start one. `Timeout` can leave a write applied on an established
  connection (see the fault table).
- Options are not validated: unknown keys are ignored, and `nodeMajor` is not
  range-checked.

## Specs and design

- [`observe.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kurrent/observe.feat): SPEC-ADPKUR-001, namespaced capture, state,
  settle, reset and faults.
- [`transport.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kurrent/transport.feat): SPEC-ADPKUR-002, transport faults on the
  system's path (integration tier).
- [`broker-loss.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kurrent/broker-loss.feat): SPEC-ADPKUR-003, broker loss
  (integration tier, serial).
- [`node26-tls-host.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kurrent/node26-tls-host.feat): SPEC-ADPKUR-004, the TLS
  host rule (spec tier).
- [`DESIGN.md`](https://github.com/mmmnt/feature/blob/main/adapters/kurrent/DESIGN.md): the client choice, the settle proof, the
  namespace, the faults and the TLS host rule, with sources.

The generated suites run under `feat run` against throwaway containers
(`kurrentplatform/kurrentdb:26.2.3`, `ghcr.io/shopify/toxiproxy:2.12.0`) that
the fixture starts and removes on exit. They are not part of the package's
`test` script.

## License

MIT. Docs: https://github.com/mmmnt/feature/wiki
