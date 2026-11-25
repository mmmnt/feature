# @mmmnt/feat-adapter-kurrent

The KurrentDB service adapter for Feature. It turns the `$all` log into a capture window: every event the system appends to a namespaced stream during a scenario becomes a captured record, in log order, and an unpredicted append fails the case by prediction inversion. It also reads streams for `contains`, seeds events, proves settlement with a fence marker, and injects append and transport faults. It is built on `@kurrent/kurrentdb-client`.

## Installation

Requires Node.js 22 or newer and a KurrentDB node (Kurrent Cloud works through `connectionString`).

```bash
npm install -D @mmmnt/feat-adapter-kurrent
```

`@kurrent/kurrentdb-client` (pinned at 1.3.2), `@mmmnt/feat-fault-proxy` and `@mmmnt/feat-adapter-stdio-jsonrpc` (seed transforms) are regular dependencies. The adapter's specs run against `kurrentplatform/kurrentdb:26.2.3` as a single secure dev node with projections off; projections are not needed (streams are found by an `$all` prefix scan). A cluster is not verified: `settle()` is a proof only when the append and the read go to the same node.

The instrument identity must be able to read `$all` (an admin identity); any other is refused at `setup()` with `ALL_READ_DENIED`.

## Usage

```jsonc
// feat.config.json, under "services"
"orderStore": {
  "adapter": "@mmmnt/feat-adapter-kurrent",
  "consistency": "eventual",
  "convergenceTimeout": 5000,
  "options": {
    "connectionStringEnv": "FEAT_KURRENT_URL",
    "system": { "username": "FEAT_KURRENT_USER", "password": "FEAT_KURRENT_PASSWORD" }
  }
}
```

```feat
scenario "a first order is appended":
  given:
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

Declare the service `eventual`: `settle()` ends the convergence wait on proof and `convergenceTimeout` is the ceiling. Eventual services compare unordered by default; write `has ordered [ ... ]` when log order is part of the prediction.

## Options

| Option | Meaning |
| --- | --- |
| `connectionString` | A literal `kurrentdb://` or `kurrentdb+discover://` string. Wins over `connectionStringEnv`. |
| `connectionStringEnv` | Name of an environment variable holding the string. |
| `connectionStringFile` | Path of a file holding the whole string. Exclusive with the other two (`OPTIONS_INVALID`). |
| `system` | The instrument's credentials, replacing those in the string: `{ username, password }` (names of environment variables, both set) or `{ user, passwordFile }` (a literal login and a password file). Never mixed (`OPTIONS_INVALID`). |
| `settleTimeoutMs` | How long `settle()` may take to read its marker back. Default 5000. Keep `convergenceTimeout` at or above it. |
| `nodeMajor` | Integer, 1 or more, overriding the Node major the TLS host rule judges by (otherwise `OPTIONS_INVALID`). Default: the running Node's. |
| `proxy` | Toxiproxy in front of the node for `Connection` faults: `api` and `upstream` required; `name` (default `"kurrent"`), `container` (adds `BrokerLoss`), `metrics`, `runtime` optional. |
| `seedTransform` | `{ host: { command, cwd?, env? } }`: a spec host that transforms seeds before they are appended. |

No connection string from any source is an error at `setup()`. Unknown option keys are ignored. The adapter's own client connects to the node directly, never through the proxy.

**Files.** A relative path is resolved against the run's working directory. Exactly one trailing `\n` or `\r\n` is removed and nothing else. A file that is missing, a directory, unreadable or empty is `CREDENTIAL_FILE_UNREADABLE` before any connection; the detail names the option, path and cause, never the content. For a CA, put the client's `tlsCAFile=<path>` in the connection string. Reads pass the decoded credentials on every call, so a password with a character the string must percent-encode works on reads as well as appends.

## Observation

The adapter declares `observes = { diff: "native", state: true }`.

- **Diff.** `startCapture()` appends a marker to the fence stream `feat-fence.<ns>` and keeps its position as an exclusive cursor. `peekCapture()` and `stopCapture()` read `$all` forwards from it with a server-side prefix filter (`<ns>.` and `$$<ns>.`), in commit-position order, which is total across streams.
- **State.** `read()` reads the namespace's streams forwards. Records whose literal `key.stream` hints name streams read only those; otherwise every stream the namespace has held is found by an `$all` prefix scan. A deleted or never-written stream reads as empty.
- **Settle** appends a fence marker after the system's writes returned and reads `$all` until it is seen: every earlier write is then visible, and an empty window proves an absence. It answers `false` with no window, past `settleTimeoutMs`, or when the node does not answer.

A captured record:

```
{ type: <event type>, key: <stream without the namespace prefix>,
  payload: <the event's JSON data>, timestamp: <created, ms>, metadata: { revision, commitPosition } }
```

- Streams outside the namespace, and the adapter's own events (metadata `{ "feat": "instrument" }`), are never captured.
- `$`-typed system events are dropped except `$metadata` (captured with key `$$<stream>`) and deletions.
- A soft delete is `stream.deleted` with `payload: { streamId }`; a hard delete (tombstone) is `stream.deleted` with `payload: { streamId, hard: true }`.
- The `$$<stream>/$metadata` record the server writes on the first append after a soft delete (a body of exactly `{ "$tb": n }`, `n` below the Int64 maximum) is the server's and is dropped.
- Non-JSON events are dropped.

## Namespace, seeds and reset

The adapter requires the runner's namespace (`^s[0-9a-f]{12}$`; otherwise `NAMESPACE_INVALID`). A stream is stored as `<ns>.<stream>`; specs, seeds, fault details and read hints use the relative name, and the system under test writes to the prefixed one.

- **`seed`** appends each record (event type = record type, data = the whole of `values`) to `values.stream` when given, else to a stream named after the type, with stream state `ANY`, before the window. Every record is checked first: `values.stream`, when present, must be a non-empty string (`SEED_VALUE_UNSTORABLE`). With `seedTransform`, the adapter joins the spec file's shared stdio host, asks `transformSeed` twice per call and writes the first answer only when both agree and keep count, order, type and stream (ADR-0035).
- **`reset()`** disarms transport faults (restoring a paused container), clears stream metadata (removing an `ACCESS_DENIED` ACL) and soft-deletes every namespace stream. A stream the system tombstoned stays dead; use a fresh name per hard-delete scenario. The fence stream is left in place.

## Faults

Every fault is `until reset`; any other count is `FAULT_UNSUPPORTED`. No refusal is recorded, so evidence is `unobserved`.

| Fault | Detail | Effect |
| --- | --- | --- |
| `AppendToStream WRONG_EXPECTED_VERSION` | `{ stream }` | Appends an instrument event, so an append that expects `NoStream` is refused. An `ANY` append succeeds. |
| `AppendToStream ACCESS_DENIED` | `{ stream }` | Sets the stream's write role to one nobody holds. `$admins` bypass ACLs, so the system must connect as a non-admin. |
| `Connection Timeout` | none | With `proxy`. The stream stalls (downstream: the node may apply a request whose answer is never heard). |
| `Connection ConnectionReset` | none | With `proxy`. The connection is reset (upstream). |
| `Connection Partition` | none | With `proxy`. The proxy is disabled. |
| `Connection BrokerLoss` | none | With `proxy.container`. The node's container is paused. Shared fate: the harness runs it only in the serial pass and refuses it elsewhere with `FAULT_REQUIRES_SERIAL`. |

Point the system's client at `proxyListen()`, with a single-node connection string (gossip discovery would bypass the proxy) and a certificate naming the proxy host or `tlsVerifyCert=false` on a dev node. Not offered: `STREAM_DELETED` (a tombstone is irreversible) and `NOT_LEADER`.

## The TLS host rule

Node 26 refuses an IP address as the TLS server name, and the client's gRPC layer always sets it ([grpc/grpc-node#3131](https://github.com/grpc/grpc-node/issues/3131)). For the adapter's own connection, with `tls` on (the default):

| Host | What the adapter does |
| --- | --- |
| Exactly `127.0.0.1` or `::1` | Connects as `localhost`, changing only the host, on every Node major. |
| Any other IP literal, Node 26 or later (or `nodeMajor` 26+) | `setup()` throws `TLS_HOST_UNSUPPORTED` before connecting. |
| A hostname, `kurrentdb+discover://`, `tls=false`, or Node below 26 | Left as written. |

Several hosts are judged one by one. A certificate that relied on an IP SAN for `127.0.0.1` must now name `localhost`. `connectionRefusal()` and `connectionTarget()` report the outcome without connecting.

## Errors

`KurrentAdapterError`s carry `code` and `detail`.

| Code | Raised by | When |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The namespace is missing or off the pattern. |
| `OPTIONS_INVALID` | `setup()` | More than one connection source with `connectionStringFile`, a `system` that mixes the two forms or gives only one of `user` and `passwordFile`, a bad `nodeMajor`, or a malformed `seedTransform`. |
| `CREDENTIAL_FILE_UNREADABLE` | `setup()` | A named file is missing, a directory, unreadable or empty. |
| `TLS_HOST_UNSUPPORTED` | `setup()` | See the TLS host rule. |
| `ALL_READ_DENIED` | `setup()` | The instrument credentials cannot read `$all`. |
| `SEED_TRANSFORM_UNAVAILABLE` | `setup()` | The transform host cannot be started. |
| `SEED_TRANSFORM_FAILED`, `SEED_TRANSFORM_NONDETERMINISTIC` | `seed()` | The host failed or changed the records, or its two answers differ. |
| `SEED_VALUE_UNSTORABLE` | `seed()` | `values.stream` is present and not a non-empty string. |
| `FAULT_UNSUPPORTED` | `fault()` | Not in the catalog, not `until reset`, or an `AppendToStream` fault without `detail.stream`. |

Plain `Error`s report no connection string and `system` variables that do not both give a value. Toxiproxy errors keep the `@mmmnt/feat-fault-proxy` codes.

## Limitations

- `settle()` cannot prove writes the system starts after its handler returned.
- An unhinted `read()` and `reset()` scan `$all` from the start, so their cost grows with the log.
- `@kurrent/kurrentdb-client` 1.3.2 cannot parse a bracketed IPv6 host; only `::1` (rewritten to `localhost`) reaches a node over IPv6.
- Toxiproxy is yours to run.

The generated suites start throwaway KurrentDB and Toxiproxy containers, so they run under `feat run`, not the package's `test` script.

## See also

- Specs: [observe.feat](observe.feat) (SPEC-ADPKUR-001), [transport.feat](transport.feat) (SPEC-ADPKUR-002), [broker-loss.feat](broker-loss.feat) (SPEC-ADPKUR-003), [node26-tls-host.feat](node26-tls-host.feat) (SPEC-ADPKUR-004), [credential-files.feat](credential-files.feat) (SPEC-ADPKUR-005), [seed-transform.feat](seed-transform.feat) (SPEC-ADPKUR-006)
- [DESIGN.md](DESIGN.md): the client choice, the settle proof, the namespace, the faults and the TLS host rule
- [ADR-0035](../../docs/adr/ADR-0035-seed-transform.md): seed transform; [`@mmmnt/feat-fault-proxy`](../fault-proxy/README.md)

## Changelog

Per-release changes are in [CHANGELOG.md](CHANGELOG.md). Every `@mmmnt` package is released at the same version.

## Contributing

This package is part of the [Feature monorepo](https://github.com/mmmnt/feature). See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the development setup, the spec-driven rules and the
local gate.

```bash
git clone https://github.com/mmmnt/feature.git
cd feature
pnpm install
pnpm build --filter=@mmmnt/feat-adapter-kurrent
pnpm --filter @mmmnt/feat-adapter-kurrent test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
