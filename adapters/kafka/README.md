# @mmmnt/feat-adapter-kafka

Service adapter for Feat that turns **namespaced Kafka topics into a capture
window read at the last stable offset**: every record the system produces to a
namespaced topic during a scenario becomes a captured record, and records of
aborted transactions never appear. An unpredicted record fails the suite by
prediction inversion. The adapter is built on Confluent's
`@confluentinc/kafka-javascript`.

```jsonc
// feat.config.json
"services": {
  "orderBus": {
    "adapter": "@mmmnt/feat-adapter-kafka",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "bootstrapServersEnv": "FEAT_KAFKA_BOOTSTRAP"   // or "bootstrapServers": "localhost:9092"
    }
  }
}
```

```
predict success:
  response 202 OrderAccepted { orderId: @when.orderId }
  orderBus has [ orders with OrderMessage { orderId: @when.orderId } ]
```

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## What it observes, and how

The adapter declares `observes = { diff: "native", state: true }`.

- **Diff (native).** The log is the change feed. At `startCapture()` the
  cursor of every namespaced partition is its `READ_COMMITTED` end offset (the
  last stable offset). A topic created later starts at its low offset.
  `peekCapture()` and `stopCapture()` consume from the cursors to the current
  `READ_COMMITTED` ends with a consumer that is **assigned by hand**: no group
  join, no commit (`enable.auto.commit=false`), so no consumer group is left
  behind. Because it reads at `read_committed`, the records of an aborted
  transaction and the transaction markers are never delivered.
- **State.** `read()` consumes the namespaced topics from the low offset to the
  `READ_COMMITTED` end, so `contains` assertions see what is stored.
- **Settle.** After the system's produces returned, `settle()` takes the end
  offsets of every partition of every namespaced topic at `READ_COMMITTED` (the
  last stable offset) and at `READ_UNCOMMITTED` (the high watermark). **An open
  transaction holds the first below the second.** While any partition's two
  offsets differ, `settle()` waits and retries; if that outlives
  `settleTimeoutMs` it answers `false`, because an open transaction is an effect
  that is not yet decided. Otherwise it consumes to the last stable offset and
  answers `true`. An empty window settles `true`, which is how an absence is
  proven. It answers `false` with no window open, or when the brokers do not
  answer in time. It writes nothing to the product.
- **No `deliver()`.**

Declare the service `eventual`: `settle()` ends the convergence wait on proof,
and `convergenceTimeout` is the ceiling when it cannot vouch.

### The captured record

```
{ type: <topic, without the namespace prefix>, key: <record key as UTF-8, "" when none>,
  payload: <the JSON value>, timestamp: <record timestamp>,
  metadata: { partition, offset, headers } }
```

- A JSON object value is the payload. A JSON value that is not an object is
  `{ value: <it> }`; a value that is not JSON is `{ value: "<text>" }`; a null
  value is `{}`.
- `headers` is a `{ name: string }` map.
- **Order is per partition only.** Records come back by topic name, then by
  partition id, then by offset. Kafka orders a partition and nothing else, so the
  adapter's order across partitions or topics is a convention, not time. Use
  `has unordered [ ... ]` for predictions that span partitions.
- Topics outside the namespace are nobody's effect.

## Install

```sh
npm install --save-dev @mmmnt/feature @mmmnt/feat-adapter-kafka
```

- Node 20 or later (`engines.node` is `>=20`). The adapter is ESM.
- No peer dependencies. `@confluentinc/kafka-javascript` (pinned at 1.11.0,
  librdkafka 2.16.0) and `@mmmnt/feat-fault-proxy` are regular dependencies.
- The supported product is Apache Kafka. The adapter's tests run against a
  two-broker KRaft cluster of `apache/kafka:3.9.0`, with
  `ghcr.io/shopify/toxiproxy:2.12.0` in front of it. Managed Kafka works
  through `bootstrapServers` plus SASL `auth`.

### The native dependency

`@confluentinc/kafka-javascript` is a **native addon** (librdkafka). It
installs a prebuilt binary chosen by Node ABI, platform, libc and architecture
(`node-pre-gyp install --fallback-to-build`), and builds from source when no
prebuilt binary matches. The prebuilt set at 1.11.0 covers Node 18 to 24 on
Linux (x64 and arm64, glibc and musl), macOS arm64 (Intel on a best-effort
basis) and Windows x64. On any other Node major the install falls back to a
source build, which needs a C++ toolchain, Python and `node-gyp`.

- **After you change the Node major**, the installed binary no longer matches
  the ABI and loading it fails. Reinstall the dependency (delete `node_modules`
  and install again) or rebuild it for the new Node:
  `npm rebuild @confluentinc/kafka-javascript`
  (`pnpm rebuild @confluentinc/kafka-javascript` under pnpm). Do this on every
  machine and in every CI image whose Node major differs from the one that ran
  the install.
- **pnpm 10** does not run a dependency's install script unless the workspace
  approves it. Add the package to `onlyBuiltDependencies` in
  `pnpm-workspace.yaml` (or run `pnpm approve-builds`):

  ```yaml
  onlyBuiltDependencies:
    - "@confluentinc/kafka-javascript"
  ```

The package ships `dist/` only. Its `fixtures/` helpers are internal.

## Configuration

A complete service entry. `bootstrapServers` or `bootstrapServersEnv` is
required; every other option is optional.

```jsonc
"services": {
  "orderBus": {
    "adapter": "@mmmnt/feat-adapter-kafka",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "bootstrapServersEnv": "FEAT_KAFKA_BOOTSTRAP",     // name of the variable holding host:port[,host:port...]
      // "bootstrapServers": "localhost:9092",           // or a literal; wins over bootstrapServersEnv
      "auth": {                                          // SASL; env-var NAMES, never values
        "mechanism": "scram-sha-512",                    // "plain" | "scram-sha-256" | "scram-sha-512"
        "username": "FEAT_KAFKA_USER",
        "password": "FEAT_KAFKA_PASSWORD",
        "ssl": true                                      // TLS to the brokers; default true
      },
      "settleTimeoutMs": 5000,                           // default 5000
      "proxy": {                                         // transport faults on the system's path
        "api": "http://127.0.0.1:8474",                  // Toxiproxy API
        "upstream": "127.0.0.1:19092",                   // host:port of the broker's proxied listener, as Toxiproxy reaches it
        "name": "kafka",                                 // product label of the proxy name feat-<ns>-<name>; default "kafka"
        "container": "kafka-1",                          // the broker's container; without it BrokerLoss is not offered
        "metrics": "http://127.0.0.1:8474/metrics",      // Toxiproxy /metrics URL
        "runtime": "docker"                              // container runtime CLI; default "docker"
      }
    }
  }
}
```

| Option | Meaning |
| --- | --- |
| `bootstrapServers` | A comma-separated `host:port` list (librdkafka `bootstrap.servers`). |
| `bootstrapServersEnv` | The name of an environment variable holding the list. Used when `bootstrapServers` is absent. Neither set, or the variable unset or empty, is a configuration error. |
| `auth` | SASL credentials as the **names** of two environment variables, both of which must be set. `mechanism` is `plain`, `scram-sha-256` or `scram-sha-512`. `ssl` defaults to `true` (`sasl_ssl`); `false` selects `sasl_plaintext`. Without `auth` the adapter connects without SASL and without TLS. |
| `settleTimeoutMs` | How long `settle()` may wait for open transactions to close and for the window to be consumed. Default 5000. Keep `convergenceTimeout` at or above it. |
| `proxy` | A Toxiproxy in front of the broker for `Connection` faults. `api` and `upstream` are required. See below. |

The adapter does not reject unknown keys under `options`; a misspelled option is
ignored. The adapter's own clients (admin, consumer, producer for seeds and
faults) connect to the brokers **directly** and never through the proxy.

## A minimal spec

```
feat 1.0

spec SPEC-ORD-020 "PlaceOrder publishes to the orders topic"
context Orders
aggregate Order
type command
status agreed

construct:
  handler at features/place-order/handler.ts
  touches features/place-order/**

enforce:
  produce an order message to the orders topic
  rejects AUDIT_TOO_LARGE when the broker refuses the audit record as too large

contract:
  input PlaceOrderInput
  response OrderAccepted
  event OrderMessage
  error Refusal

scenario "an order is published, the seed is not":
  given:
    An earlier order is already on the topic.
    seed orderBus [ orders with OrderMessage { key: "o-0", orderId: "o-0" } ]
  when: PlaceOrder { orderId: "o-1" }
  predict success:
    response 202 OrderAccepted { orderId: @when.orderId }
    orderBus has [ orders with OrderMessage { orderId: @when.orderId } ]

scenario "the broker refuses an oversized audit record":
  given:
    fault orderBus Produce MESSAGE_TOO_LARGE { topic: "audit" } until reset
  when: PlaceOrder { orderId: "o-2" }
  predict rejection AUDIT_TOO_LARGE:
    response 502 Refusal { code: "AUDIT_TOO_LARGE" }
    orderBus has []
```

A seed record's `type` is the topic (`orders`, stored as `<ns>.orders`). If
`values` has a string `key`, it becomes the record key and is removed from the
value; the rest of `values` is the JSON value. Seeds are produced with
`acks=all` and idempotence on, before the window opens, so they are never in a
capture. The fault line must say `until reset` (see the fault table).

## Namespaces

The runner derives a namespace per spec file, exactly `^s[0-9a-f]{12}$`
(SPEC-RT-006), and hands it to the adapter as the config's top-level
`namespace`. It is never an option.

- A topic is stored as `<ns>.<topic>`. The spec writes `orders`; the adapter
  reports `orders`. The system under test must produce to the prefixed names.
  Seeds, fault details and read hints take the relative name.
- Capture, read and reset are scoped to the prefix.
- `reset()` **truncates** instead of deleting the topics the system created:
  `deleteTopicRecords` up to the high watermark on every namespaced partition, so
  the topics and their configuration survive. Topics a fault created are the
  exception; `reset()` deletes them and waits until they are gone.

## Seed, read and reset

- **`seed(records)`** produces each record to `<ns>.<type>` as above.
- **`read(query)`** consumes from the low offset to the `READ_COMMITTED` end of
  the namespaced topics. With hints, `contains` assertions name the topics (the
  record type): the adapter reads those that exist and may return no others.
  Without hints it reads every namespaced topic.
- **`reset()`** disarms transport faults and restores a paused or stopped
  container, deletes the topics a fault created, truncates the rest and closes
  the window.

## Faults

Logical faults are made by **creating the topic the fault names**, with one
partition. Each needs `detail.topic`, and the topic must **not** exist yet:
the fault creates it, and a topic the system already wrote to is refused with
`FAULT_TARGET_EXISTS`. All faults are armed `until reset`. The broker keeps no
record of a produce it refused, so `firedFaults` is not implemented and evidence
is `unobserved`.

| Fault | Operation | Counts | Detail | What the system sees |
| --- | --- | --- | --- | --- |
| `MESSAGE_TOO_LARGE` | `Produce` | `until reset` | `{ topic }` (required) | The topic is created with `max.message.bytes=1024`. A produce of a larger record is refused with `MESSAGE_TOO_LARGE`. |
| `NOT_ENOUGH_REPLICAS` | `Produce` | `until reset` | `{ topic }` (required) | The topic is created with replication factor 2 and `min.insync.replicas=2`. An `acks=all` producer gets `NOT_ENOUGH_REPLICAS` **while fewer than two replicas are in sync**. |
| `Timeout` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy stalls the stream and never delivers; the system's call runs into its own deadline. Armed downstream (the library default; the adapter passes no direction), so an established connection can have a request applied whose answer the system never hears. |
| `ConnectionReset` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy resets the connection (default direction upstream, on the request path). |
| `Partition` | `Connection` | `until reset` | none | Needs `options.proxy`. The proxy is disabled: the system's connections fail. |
| `BrokerLoss` | `Connection` | `until reset` | none | Needs `options.proxy.container`. The broker's container is paused with the runtime's CLI. Exclusive and serial. |

`NOT_ENOUGH_REPLICAS` needs a **cluster with at least two brokers**, and the
fault only starts to bite when fewer than two replicas are in sync. A single-node
broker never answers it, and cannot place replication factor 2 at all: the
broker refuses the topic creation, and the adapter throws a plain `Error` that
carries the broker's reason. The adapter does not stop brokers. Against a
cluster of your own, take a broker down (or lag it) **after** the fault topic
exists and wait until the in-sync set holds one.

Not offered: `TOPIC_AUTHORIZATION_FAILED` (it needs an authorizer the default
image lacks), `NOT_LEADER` (no native way to produce it), and `once` or
`times` counts for every fault.

### Transport faults and broker loss

Set `options.proxy` and the catalog gains `Connection.Timeout`,
`Connection.ConnectionReset` and `Connection.Partition`. Adding
`options.proxy.container` adds `Connection.BrokerLoss`. The mechanism is
[`@mmmnt/feat-fault-proxy`](https://github.com/mmmnt/feature/blob/main/adapters/fault-proxy/README.md) (SPEC-FPX-001): one
Toxiproxy proxy per namespace and product, named `feat-<ns>-<name>`.

- A transport fault is on the **system's path only**. The adapter observes on its
  own direct connections, so under a fault the capture, the settle and the state
  read still work, and an absence under a fault is still provable.
- A Kafka client follows the addresses in broker **metadata**, not the
  bootstrap address. For the proxy to carry the system's traffic, the broker must
  advertise the proxy's listen address on the listener the system uses (the
  adapter's `proxyListen()` reports it). Without that, the client connects around
  the proxy and the fault never touches it.
- Whether a fault was consumed is unobserved: the proxy reports bytes, not
  activations.
- `BrokerLoss` pauses the broker's container, which every namespace and every
  spec file shares. It is an exclusive fault: the harness runs it only in the
  serial pass with one worker and `FEAT_SERIAL=1`, and refuses it elsewhere with
  `FAULT_REQUIRES_SERIAL`. Keep it in a spec file of its own. While the broker is
  paused, `settle()` answers `false`; `reset()` unpauses it.
- A `Connection` fault without `options.proxy`, or `BrokerLoss` without
  `options.proxy.container`, is not in the catalog and is refused with
  `FAULT_UNSUPPORTED`.

### The two-broker test cluster

The adapter's own suites run on a cluster the fixture builds
(`fixtures/cluster.mjs`; founder ruling 2026-11-09, "B: two-broker test
cluster"), because a single node never answers `NOT_ENOUGH_REPLICAS`.

- Toxiproxy owns a network namespace; both brokers (`apache/kafka:3.9.0`) and the
  system's peer container run inside it.
- Broker 1 is broker and controller, and the only quorum voter, so stopping
  broker 2 never costs the quorum. It has `INTERNAL`, `CONTROLLER`, `DIRECT`
  (advertised at the published host port, for the instrument and the
  observe-mode system) and `PROXY` (advertised at a Toxiproxy listen port, for the
  transport-mode system) listeners. Pausing broker 1 is the loss of the broker.
- Broker 2 is broker-only, has the `INTERNAL` listener only, and exists to be the
  second replica of the `NOT_ENOUGH_REPLICAS` topic. The fixture starts it when
  that fault is armed and stops it otherwise, so no other topic is placed on a
  broker the instrument has no listener on.
- Each spec file's process starts and removes its own containers, so `BrokerLoss`
  never reaches another file.

## Errors and refusals

Adapter errors are `KafkaAdapterError`, with a `code` and a `detail`.

| Code | Raised by | When |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The namespace does not match `^s[0-9a-f]{12}$`. Defensive: the runner never passes another. |
| `BROKER_UNREACHABLE` | `setup()` | No bootstrap server answered within 5000 ms. The detail names the bootstrap list and the client's message. A wrong SASL password surfaces here too. |
| `FAULT_TARGET_EXISTS` | `fault()` | A `Produce` fault names a topic that already exists. |
| `FAULT_UNSUPPORTED` | `fault()` | The fault is not in the catalog (including `Connection` without `options.proxy` and `BrokerLoss` without `container`), or the count is not `until reset`, or a `Produce` fault has no `detail.topic`. The detail lists the catalog. |

Plain `Error`s (no code) report a missing `bootstrapServers`, `options.auth`
naming variables that are not both set, and a broker's refusal to create a
fault topic. Errors from the Toxiproxy layer keep the codes of
`@mmmnt/feat-fault-proxy` (`PROXY_UNREACHABLE`, `PROXY_NOT_OPEN`,
`FAULT_UNSUPPORTED`, `CONTAINER_NOT_FOUND`, `CONTAINER_RUNTIME_UNAVAILABLE`).

## Limitations

- `settle()` does not prove produces the system starts after its handler
  returned (the ADR-0021 boundary), nor `acks=0` produces or unflushed producer
  buffers, which are the system's contract.
- Order is per partition only. A record in an open transaction is invisible
  until it commits; `settle()` declines while one is open.
- Faults need a topic that does not exist yet, so a fault cannot be armed on a
  topic that holds the system's data. A topic a fault created is deleted at
  reset; the system's other topics are truncated, so offsets keep counting.
- `NOT_ENOUGH_REPLICAS` needs two brokers and a broker taken out of the
  in-sync set by you.
- Seeds are JSON only. Records that are not JSON are captured as
  `{ value: "<text>" }`.
- The adapter needs the permissions to list topics, read offsets, consume,
  produce (seeds), create and delete topics (faults) and delete records
  (reset). It does not stop brokers.
- The `options.proxy` block needs a Toxiproxy server you run; the adapter does
  not start one.
- Options are not validated: unknown keys are ignored.

## Specs and design

- [`observe.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kafka/observe.feat): SPEC-ADPKFK-001, namespaced capture,
  transactions, settle, reset and faults.
- [`transport.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kafka/transport.feat): SPEC-ADPKFK-002, transport faults on the
  system's path (integration tier).
- [`broker-loss.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kafka/broker-loss.feat): SPEC-ADPKFK-003, broker loss
  (integration tier, serial).
- [`DESIGN.md`](https://github.com/mmmnt/feature/blob/main/adapters/kafka/DESIGN.md): the client choice, the settle proof, the
  namespace, the faults and the test cluster, with sources.

The generated suites run under `feat run` against throwaway containers that the
fixture starts and removes on exit. They are not part of the package's `test`
script.

## License

MIT. Docs: https://github.com/mmmnt/feature/wiki
