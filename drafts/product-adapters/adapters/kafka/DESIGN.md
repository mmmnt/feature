# Kafka adapter — design (DRAFT)

Specs: `observe.feat` (SPEC-ADPKFK-001, 25 scenarios), `transport.feat` (SPEC-ADPKFK-002, 7).
Package: `@mmmnt/feat-adapter-kafka` (new).

## Client: recommendation `@confluentinc/kafka-javascript` 1.11.0
| Candidate | Finding (npm / published types) | Verdict |
| --- | --- | --- |
| `@confluentinc/kafka-javascript` 1.11.0 | published 2026-10-07; librdkafka 2.16.0; engines node >=18; prebuilt binaries linux x64/arm64 (glibc+musl), macOS arm64 (Intel best-effort), Node 18-24; commercial support offered by Confluent (GitHub README). Types: promisified KafkaJS-compatible API (`KafkaJS.Admin.fetchTopicOffsets(topic,{isolationLevel})`, `deleteTopicRecords`, `createTopics` with `configEntries`, `readUncommitted`) and the rdkafka API (`KafkaConsumer.assign`, `isolation.level`, `queryWatermarkOffsets`, `Producer.initTransactions/beginTransaction`). | **use** |
| `kafkajs` 2.2.4 | last registry change 2023-02-27 (a 2.3.0-beta.3 exists, never released); `fetchTopicOffsets(topic)` has no isolation level, so the last stable offset is unreachable and an open transaction cannot be detected | no |
| `@platformatic/kafka` 2.15.0 | active, but engines node >=22.22 / >=24.6 against Feature's >=20 | no |
Trade-off accepted: a native addon (prebuilt binaries; a source build needs a toolchain).

## Modes
- **diff = native.** The log is the feed. Per namespaced partition the cursor is the READ_COMMITTED end
  offset at `startCapture`; a topic created later starts at its low offset. A consumer with manual
  `assign` (no group join, no commits, so no group left behind) and `isolation.level=read_committed`
  reads to the current READ_COMMITTED ends. Aborted-transaction records and markers never appear.
  Order: **per partition only**; partitions in id order, topics in name order. Kafka orders nothing
  else, so specs about multi-partition topics use `unordered` across partitions.
- **state = true.** `read` = the namespaced topics from the low offset to the READ_COMMITTED end; a state
  of a log is its records.
- `deliver()` not offered.

## settle: what it proves
The interface drafter's assumption **holds, and is better than a sentinel**: after the system's produces
returned, take the end offsets of every partition of every namespaced topic with READ_COMMITTED (last
stable offset, LSO) and READ_UNCOMMITTED (high watermark, HW), and consume to the LSO. Nothing is
written to the product. The refinement: **an open transaction holds LSO below HW**, so while any
partition's two differ the adapter cannot see an effect that may still commit, and settle waits, then
declines. Needs a client that exposes the isolation level on offsets (the Confluent admin does).
Does NOT prove: produces the system starts after its handler returned; acks=0 / unflushed producer
buffers (the system's contract); topics created after the listing (the adapter re-lists inside settle).

## Namespace
Namespace now comes from the runner (SPEC-RT-006) as config `namespace`; there is no option. Topics are `<ns>.<topic>`; the spec writes `orders`, the adapter reports `orders`. The system's host
configures the same prefix. Reset truncates (`deleteTopicRecords` to HW) rather than deleting topics the
system created, so topic configuration survives; topics a fault created are deleted (waiting until gone).

## Faults (all `until reset`; the broker keeps no record of a produce it refused)
- `Produce.MESSAGE_TOO_LARGE {topic}`: the adapter creates the topic with a small `max.message.bytes`.
- `Produce.NOT_ENOUGH_REPLICAS {topic}`: the topic is created with `min.insync.replicas` above what a
  single node can satisfy; fires for `acks=all` producers. **Unverified:** that a single-node broker
  accepts the creation and answers NotEnoughReplicas; the test container must confirm, otherwise drop it.
- Both require the topic NOT to exist (`FAULT_TARGET_EXISTS`): config cannot be changed after the
  fact by the client's promisified admin. Not offered: TOPIC_AUTHORIZATION_FAILED (needs an
  authorizer the default image lacks), NOT_LEADER (no native way).
- Transport: `Connection.*` via SPEC-FPX-001. **Advertised listeners:** a Kafka client follows the
  addresses in broker metadata, not the bootstrap address, so for the proxy to carry the system's
  traffic the broker must advertise the proxy's address on the listener the system uses. The test fixture
  gives the broker two listeners (instrument direct, system via proxy).

## Endpoints
Local: a single-node KRaft container the test starts (the machine already has Sift's, not to be used),
auto topic creation on. Cloud/managed Kafka: same options plus SASL `auth`; nothing here needs AWS.

## What a test needs
A Kafka container (`apache/kafka`, two listeners), a Toxiproxy container for -002, `fixtures/probe.mjs`.
