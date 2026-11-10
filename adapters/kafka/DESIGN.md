# Kafka adapter — design

Specs: `observe.feat` (SPEC-ADPKFK-001, 25 scenarios), `transport.feat` (SPEC-ADPKFK-002, 6),
`broker-loss.feat` (SPEC-ADPKFK-003, 3). Package: `@mmmnt/feat-adapter-kafka`, leaf, `createAdapter(config)`.
Founder rulings: 58a4ac88 (agreed), c7af7871 (fault counts, client, BrokerLoss serial), and 2026-11-09 Kafka two-broker B
("B: two-broker test cluster").

## Client: `@confluentinc/kafka-javascript` 1.11.0
| Candidate | Finding (npm / published types) | Verdict |
| --- | --- | --- |
| `@confluentinc/kafka-javascript` 1.11.0 | published 2026-10-07; librdkafka 2.16.0; engines node >=18; prebuilt binaries linux x64/arm64 (glibc+musl), macOS arm64, Node 18-24; supported by Confluent. Promisified KafkaJS-compatible API (`Admin.fetchTopicOffsets(topic,{isolationLevel})`, `deleteTopicRecords`, `createTopics` with `configEntries`) and the rdkafka API (`KafkaConsumer.assign`, `isolation.level`, `Producer.initTransactions`). | **use** |
| `kafkajs` 2.2.4 | last registry change 2023-02-27; `fetchTopicOffsets(topic)` has no isolation level, so the last stable offset is unreachable and an open transaction cannot be detected | no |
| `@platformatic/kafka` 2.15.0 | active, but engines node >=22.22 / >=24.6 against Feature's >=20 | no |

Trade-off accepted: a native addon. pnpm 10 does not run a dependency's install script unless the workspace approves
it, so `pnpm-workspace.yaml` lists the client in `onlyBuiltDependencies`.

## Modes
- **diff = native.** The log is the feed. Per namespaced partition the cursor is the READ_COMMITTED end offset at
  `startCapture`; a topic created later starts at its low offset. A consumer with manual `assign` (no group join, no
  commit, so no group left behind) and `isolation.level=read_committed` reads to the current READ_COMMITTED ends; the
  consumer's position moving past the end is "done", because markers and aborted records are never delivered.
  Order: **per partition only**; partitions in id order, topics in name order.
- **state = true.** `read` = the namespaced topics from the low offset to the READ_COMMITTED end.
- `deliver()` is not offered.

## settle: what it proves
After the system's produces returned, take the end offsets of every partition of every namespaced topic with
READ_COMMITTED (last stable offset) and READ_UNCOMMITTED (high watermark). **An open transaction holds the first below
the second**, so while any partition's two differ settle waits, then declines; otherwise it consumes to the last stable
offset and vouches. Nothing is written to the product. It does not prove produces the system starts after its handler
returned, nor acks=0 / unflushed producer buffers (the system's contract).

## Namespace
From the runner (SPEC-RT-006) as the config's `namespace`; there is no option. Topics are `<ns>.<topic>`. `reset`
truncates (`deleteTopicRecords` to the high watermark) rather than deleting topics the system created, so topic
configuration survives; topics a fault created are deleted, waiting until they are gone.

## Faults (all `until reset`; the broker keeps no record of a produce it refused)
- `Produce.MESSAGE_TOO_LARGE {topic}`: the adapter creates the topic with `max.message.bytes=1024`.
- `Produce.NOT_ENOUGH_REPLICAS {topic}`: the adapter creates the topic with replication factor 2 and
  `min.insync.replicas=2`. The topic answers NOT_ENOUGH_REPLICAS to an `acks=all` producer **while fewer than two
  replicas are in sync**. A single-node broker never does (creating a topic with `min.insync.replicas` above its
  replication factor is accepted and `acks=all` still succeeds), which is why the test cluster has two brokers: the
  fixture arms the fault by stopping the second broker and waits until the ISR holds one. The adapter does not stop
  brokers; against a cluster of your own, take a broker down (or lag it) after the fault topic exists.
- Both require the topic NOT to exist (`FAULT_TARGET_EXISTS`). Not offered: TOPIC_AUTHORIZATION_FAILED (needs an
  authorizer the default image lacks), NOT_LEADER (no native way).
- Transport: `Connection.*` via SPEC-FPX-001 (`options.proxy`). A Kafka client follows the addresses in broker
  metadata, not the bootstrap address, so for the proxy to carry the system's traffic the broker must advertise the
  proxy's address on the listener the system uses.

## The test cluster (`fixtures/cluster.mjs`)
- Toxiproxy (`ghcr.io/shopify/toxiproxy:2.12.0`) owns a network namespace; both brokers (`apache/kafka:3.9.0`) and the
  system's peer (`node:22.12.0-slim`) run with `--network=container:<toxiproxy>`.
- Broker 1 is broker + controller (the only quorum voter, so stopping broker 2 never costs the quorum). Listeners:
  INTERNAL (inter-broker), CONTROLLER, DIRECT (advertised at the published host port: the instrument and the
  observe-mode system), PROXY (advertised at a fixed Toxiproxy listen port: the transport-mode system). Pausing broker 1
  is the loss of the broker (SPEC-ADPKFK-003).
- Broker 2 is broker-only, with the INTERNAL listener only, and exists to be the second replica of the NOT_ENOUGH_REPLICAS
  topic. It is started the first time that fault is armed and stopped otherwise, so no other topic is placed on a broker
  the instrument has no listener on. A stop is a controlled shutdown: the controller drops it from the ISR at once.
  `replica.lag.time.max.ms` and `broker.session.timeout.ms` are lowered anyway.
- The system's producer runs in the observe spec on the host (direct listener) and in the transport and broker-loss
  specs as a peer container in the Toxiproxy namespace, with the linux build of the pinned client staged in
  `.feature/kafka-peer` (gitignored).
- Each spec file's process starts its own containers and removes them on exit, so BrokerLoss never reaches another file.

## Endpoints
Local: the cluster above. Managed Kafka: `bootstrapServers` (or `bootstrapServersEnv`) plus SASL `auth` (env-var names).
