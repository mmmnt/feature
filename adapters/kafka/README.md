# @mmmnt/feat-adapter-kafka

The Kafka service adapter for Feature. It turns the runner's namespaced Kafka topics into a capture window read at the last stable offset: every record the system produces to a namespaced topic during a scenario becomes a captured record, records of aborted transactions never appear, and an unpredicted record fails the case by prediction inversion. It also reads topics for `contains`, seeds records, proves settlement from transaction state, and injects produce and transport faults. It is built on Confluent's `@confluentinc/kafka-javascript` (librdkafka).

## Installation

Requires Node.js 22 or newer and an Apache Kafka cluster (managed Kafka works through `bootstrapServers` plus SASL `auth`).

```bash
npm install -D @mmmnt/feat-adapter-kafka
```

`@confluentinc/kafka-javascript` (pinned at 1.11.0) and `@mmmnt/feat-fault-proxy` are regular dependencies.

### The native dependency

`@confluentinc/kafka-javascript` is a native addon. Its install picks a prebuilt binary by Node ABI, platform, libc and architecture, and builds from source when none matches (which needs a C++ toolchain, Python and `node-gyp`).

- After changing the Node major, rebuild it: `npm rebuild @confluentinc/kafka-javascript` (or `pnpm rebuild ...`), on every machine and CI image.
- pnpm 10 runs a dependency's install script only when approved. Add it to `onlyBuiltDependencies` in `pnpm-workspace.yaml` (or run `pnpm approve-builds`):

  ```yaml
  onlyBuiltDependencies:
    - "@confluentinc/kafka-javascript"
  ```

**Node 26 on Linux.** 1.11.0 has no prebuilt binary for Node 26, and the source build fails on Linux whenever the install path contains `@` (librdkafka's `ar -M` script cuts paths at `node_modules/@confluentinc/…`); macOS is not affected. Build the client in a path with no `@` and copy the binary into place:

```sh
npm install --ignore-scripts                     # pnpm: pnpm install --ignore-scripts
work=$(mktemp -d /tmp/ckjs.XXXXXX)               # a path with no '@'
(cd "$work" && npm pack @confluentinc/kafka-javascript@1.11.0 \
  && mkdir src && tar -xzf confluentinc-kafka-javascript-1.11.0.tgz -C src --strip-components=1 \
  && cd src && npm install --ignore-scripts && ./node_modules/.bin/node-pre-gyp rebuild)
adapter=$(dirname "$(node -p 'require.resolve("@mmmnt/feat-adapter-kafka/package.json")')")
dir=$(dirname "$(node -p "require.resolve('@confluentinc/kafka-javascript/package.json', { paths: ['$adapter'] })")")
mkdir -p "$dir/build" && cp -R "$work/src/build/Release" "$dir/build/"
npm rebuild                                      # pnpm: pnpm rebuild
```

Run it from the project root. Feature's own CI does the same (`scripts/node26-kafka-native.sh`).

## Usage

```jsonc
// feat.config.json, under "services"
"orderBus": {
  "adapter": "@mmmnt/feat-adapter-kafka",
  "consistency": "eventual",
  "convergenceTimeout": 5000,
  "options": { "bootstrapServersEnv": "FEAT_KAFKA_BOOTSTRAP" }
}
```

```feat
scenario "an order is published, the seed is not":
  given:
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

Declare the service `eventual`: `settle()` ends the convergence wait on proof, and `convergenceTimeout` is the ceiling when it cannot vouch.

## Options

| Option | Meaning |
| --- | --- |
| `bootstrapServers` | Comma-separated `host:port` list. Wins over `bootstrapServersEnv`. |
| `bootstrapServersEnv` | Name of an environment variable holding the list. Neither set, or the variable unset or empty, is an error. |
| `auth` | `{ mechanism, username, password, ssl? }`. `mechanism` is `plain`, `scram-sha-256` or `scram-sha-512`; `username` and `password` are the **names** of environment variables, both of which must be set; `ssl` defaults to `true` (`sasl_ssl`), `false` is `sasl_plaintext`. Without `auth`: no SASL, no TLS. |
| `settleTimeoutMs` | How long `settle()` may wait. Default 5000. Keep `convergenceTimeout` at or above it. |
| `proxy` | Toxiproxy in front of the broker for `Connection` faults: `api` and `upstream` (the broker's proxied listener as Toxiproxy reaches it) required; `name` (default `"kafka"`), `container` (adds `BrokerLoss`), `metrics`, `runtime` optional. |

Unknown option keys are ignored, not refused. The adapter's own admin, consumer and producer clients connect to the brokers directly, never through the proxy.

## Observation

The adapter declares `observes = { diff: "native", state: true }`.

- **Diff.** At `startCapture()` each namespaced partition's cursor is its `READ_COMMITTED` end (the last stable offset); a topic created later starts at its low offset. `peekCapture()` and `stopCapture()` consume from the cursors to the current ends with a hand-assigned consumer (no group join, no commit) at `read_committed`, so aborted transactions and markers are never delivered.
- **State.** `read()` consumes namespaced topics from the low offset to the `READ_COMMITTED` end. With hints, only the hinted topics (record types) that exist are read.
- **Settle.** `settle()` compares each partition's `READ_COMMITTED` and `READ_UNCOMMITTED` ends; an open transaction holds the first below the second. While any differ it retries until `settleTimeoutMs` and then answers `false`. Otherwise it consumes to the last stable offset and answers `true` (an empty window settles `true`, which proves an absence). It answers `false` with no window open or when the brokers do not answer. It writes nothing.

A captured record:

```
{ type: <topic without the namespace prefix>, key: <record key as UTF-8, "" when none>,
  payload: <the JSON value>, timestamp, metadata: { partition, offset, headers } }
```

A JSON object value is the payload; any other JSON value is `{ value }`, non-JSON text is `{ value: "<text>" }`, a null value is `{}`. Records come back by topic, then partition, then offset: Kafka orders a partition and nothing else, so use `has unordered [ ... ]` across partitions.

## Namespace, seeds and reset

The adapter requires the runner's namespace (`^s[0-9a-f]{12}$`; anything else, including none, is `NAMESPACE_INVALID`). A topic is stored as `<ns>.<topic>`; specs, seeds, fault details and read hints use the relative name, and the system under test must produce to the prefixed name.

- **`seed`** produces each record to `<ns>.<type>` with `acks=all` and idempotence on, before the window opens. A string `values.key` becomes the record key and is removed from the JSON value.
- **`reset()`** disarms transport faults (restoring a paused or stopped container), deletes the topics faults created, and truncates every other namespaced partition to its high watermark, so topics and their configuration survive.

## Faults

Every fault is `until reset`; `once` and `times` are `FAULT_UNSUPPORTED`. No refusal is recorded, so evidence is `unobserved`.

| Fault | Detail | Effect |
| --- | --- | --- |
| `Produce MESSAGE_TOO_LARGE` | `{ topic }` | Creates the topic with `max.message.bytes=1024`. |
| `Produce NOT_ENOUGH_REPLICAS` | `{ topic }` | Creates the topic with replication factor 2 and `min.insync.replicas=2`; an `acks=all` producer is refused while fewer than two replicas are in sync. Needs a cluster of two or more brokers; taking a replica out of sync is up to you. |
| `Connection Timeout` | none | With `proxy`. Toxiproxy stalls the stream (downstream: a request may be applied whose answer is never heard). |
| `Connection ConnectionReset` | none | With `proxy`. The connection is reset (upstream). |
| `Connection Partition` | none | With `proxy`. The proxy is disabled. |
| `Connection BrokerLoss` | none | With `proxy.container`. The broker's container is paused. Shared fate: the harness runs it only in the serial pass and refuses it elsewhere with `FAULT_REQUIRES_SERIAL`; keep it in a spec file of its own. |

A `Produce` fault's topic must not exist yet (`FAULT_TARGET_EXISTS`). A Kafka client follows the addresses in broker metadata, so for the proxy to carry the system's traffic the broker must advertise the proxy's listen address on the system's listener; `proxyListen()` reports it.

## Errors

`KafkaAdapterError`s carry `code` and `detail`.

| Code | Raised by | When |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The namespace is missing or off the pattern. |
| `BROKER_UNREACHABLE` | `setup()` | No bootstrap server answered within 5000 ms (a wrong SASL password surfaces here too). |
| `FAULT_TARGET_EXISTS` | `fault()` | A `Produce` fault names a topic that already exists. |
| `FAULT_UNSUPPORTED` | `fault()` | Not in the catalog, not `until reset`, or a `Produce` fault without `detail.topic`. |

Plain `Error`s report a missing bootstrap list, `auth` variables not both set, and a broker's refusal to create a fault topic. Toxiproxy errors keep the `@mmmnt/feat-fault-proxy` codes.

## Limitations

- `settle()` cannot prove produces the system starts after its handler returned, `acks=0` produces, or unflushed producer buffers.
- Faults need a topic that does not exist yet. Other topics are truncated at reset, so offsets keep counting.
- Seeds are JSON only.
- Needs permissions to list topics, read offsets, consume, produce, create and delete topics, and delete records.
- Toxiproxy is yours to run; the adapter does not start one.

The generated suites run against a two-broker `apache/kafka:3.9.0` KRaft cluster behind Toxiproxy that `fixtures/cluster.mjs` builds and removes, under `feat run`, not the package's `test` script.

## See also

- Specs: [observe.feat](observe.feat) (SPEC-ADPKFK-001), [transport.feat](transport.feat) (SPEC-ADPKFK-002), [broker-loss.feat](broker-loss.feat) (SPEC-ADPKFK-003)
- [DESIGN.md](DESIGN.md): the client choice, the settle proof, the namespace, the faults and the test cluster
- [`@mmmnt/feat-fault-proxy`](../fault-proxy/README.md)

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
