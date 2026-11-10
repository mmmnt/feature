# Product adapters — draft specs (nothing applied)

Founder rulings 2026-11-09 (Sift workspace 79123645, 473acc1d): both query and diff, native product
clients, a namespace per host/spec file on every product, logical and transport faults. Target
interface: `../adapter-interface/DESIGN.md` (`observes`, `read({expect})`, `faults`/`fault`/
`firedFaults`, the `Connection` pseudo-operation). All specs are `status draft`; the parent owns
`FEATURES.md`, the founder flips draft to agreed.

## Matrix

| Product | Client (version) | diff | state | settle | Namespace | Logical faults (until reset only) | Transport |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Kurrent | `@kurrent/kurrentdb-client` 1.3.2 | native (`$all`, total commit order) | yes (streams) | **truthful**: fence marker's append position read back through `$all`; false if no window / not read in time; single node only proven | stream prefix `<ns>.` | AppendToStream: WRONG_EXPECTED_VERSION, ACCESS_DENIED (system must be non-admin) | Timeout, ConnectionReset, Partition; BrokerLoss (serial) |
| Kafka | `@confluentinc/kafka-javascript` 1.11.0 | native (offsets; order per partition only) | yes (topic records) | **truthful**: consume to the read_committed last stable offset; false while a transaction is open | topic prefix `<ns>.` | Produce: MESSAGE_TOO_LARGE, NOT_ENOUGH_REPLICAS (topic must not pre-exist; second unverified) | Timeout, ConnectionReset, Partition; BrokerLoss (serial; broker must advertise the proxy) |
| DynamoDB (amendment) | existing adapter, AWS SDK v3 | native (Streams) or **snapshot** (`stream:false`) | yes, query mode: GetItem / Query / Scan | native: truthful with `fence` and one shard, else false; snapshot: truthful (consistent reads) | partition-key prefix `<ns>#`, stripped on report | PutItem: CONDITIONAL_CHECK_FAILED | Timeout, ConnectionReset, Partition |
| Neo4j | `neo4j-driver` 6.3.0 (server compat unverified) | **snapshot** (CDC is Enterprise/Aura only) | yes (keyed MATCH or namespace scan) | truthful on direct bolt with no other transaction running; false on routing, no window, open transaction | node label `ns_<ns>` | Write: UNIQUE_CONSTRAINT_VIOLATION | Timeout, ConnectionReset, Partition |
| KMS | `@aws-sdk/client-kms` 3.1164.0 + local-kms | **snapshot** (key state only; cryptographic use invisible) | yes (DescribeKey / ListKeys) | truthful for the declared emulator; false otherwise (AWS KMS is eventually consistent) | tag `feat:namespace` or alias `alias/<ns>/` | UseKey: DISABLED, PENDING_DELETION, ALIAS_NOT_FOUND | Timeout, ConnectionReset, Partition |
| Fault-proxy library | `toxiproxy-node-client` 4.1.0 (new to this repo) | n/a | n/a | n/a | proxy `feat-<ns>-<product>` per namespace | n/a | the mechanism |

`firedFaults` is **not implemented by any binding** (evidence `unobserved`): none of the products report a
request they refused, and Toxiproxy reports bytes, not activations. Count forms (`once`, `times n`) are
refused (`FAULT_UNSUPPORTED`) because a standing condition cannot be consumed once.

## Files

| Spec | File | Scenarios |
| --- | --- | --- |
| SPEC-ADPKUR-001 / -002 / -003 | `adapters/kurrent/observe.feat`, `transport.feat`, `broker-loss.feat` (+ `.contract.json`, `DESIGN.md`) | 23 / 6 / 3 |
| SPEC-ADPKFK-001 / -002 / -003 | `adapters/kafka/...` | 25 / 6 / 3 |
| SPEC-ADPDDB-001 / -002 | `adapters/dynamodb/query-mode.feat`, `transport.feat` | 24 / 6 |
| SPEC-ADPNEO-001 / -002 | `adapters/neo4j/...` | 23 / 6 |
| SPEC-ADPKMS-001 / -002 | `adapters/kms/...` | 26 / 6 |
| SPEC-FPX-001 | `adapters/fault-proxy/fault-proxy.feat` | 21 |

Scenario counts are the parsed IR numbers (a scenario outline counts once, whatever its rows). Transport and broker-loss specs are integration-tier only
(`specs.exclude: **/transport.feat`, `**/broker-loss.feat` on the spec tier); broker-loss runs serially.

## Validate

From this directory; `feat.config.json` is a scratch config whose commands name probes that do not
exist yet (they are part of the builds):

    node ../../packages/feature/bin/run.js parse adapters/kurrent/observe.feat   # each file
    node ../../packages/feature/bin/run.js lint
    node ../../packages/feature/bin/run.js audit
    node ../../packages/feature/bin/run.js generate   # then delete the *.test.ts (not committed)

## Root config the builds will need (parent's edit)

`specs.dir` widened to cover `adapters`, the eleven probe commands in `feat.config.json` here, the
integration overlay (`feat.integration.config.json`) naming each product service with its adapter and
options, and `specs.exclude`.

## Rulings applied (Sift decision c7af7871, 2026-11-09)

1. Fault counts: every catalog entry declares the counts it accepts (`["reset"]` for every integration
   binding here); an undeclared count is `FAULT_UNSUPPORTED` before any effect; cross-tier scenarios write
   `until reset`; `unobserved` is accepted evidence. Amendment: `../adapter-interface/packages/feat-runtime/harness-faults.amended.feat`.
2. Namespace (SPEC-RT-006; composes with SPEC-RT-004 `extends`: injected in memory after loadConfig, never in a file, so no TIER_SPACE_MISMATCH; a file that writes one is NAMESPACE_CONFIGURED): derived per spec file by the runner and handed to adapters and the host; adapters have no
   `namespace` option. Spec: `../adapter-interface/packages/feat-runtime/harness-namespace.feat` (SPEC-RT-006);
   protocol list: `../stdio-jsonrpc-adapter/NAMESPACE-IMPACT.md`.
3. Kafka client: `@confluentinc/kafka-javascript` 1.11.0.
4. BrokerLoss runs serially: `BROKERLOSS-SERIAL.md`, SPEC-RT-005 (`../adapter-interface/packages/feat-runner/serial-faults.feat`);
   the scenarios moved to `adapters/{kurrent,kafka}/broker-loss.feat` (SPEC-ADPKUR-003, SPEC-ADPKFK-003).
5. `toxiproxy-node-client` is approved as a new dependency of the fault-proxy package.
Stand: Neo4j `options.keys` required; DynamoDB key-prefix only (table-per-namespace deferred).

## Still open and unverified (needs a running container)

Kurrent cluster behaviour; Neo4j `SHOW TRANSACTIONS` on Community and driver 6.3.0 on server 2026.01;
Kafka NOT_ENOUGH_REPLICAS on one node; Toxiproxy `timeout: 0` / `reset_peer` semantics; local-kms
CancelKeyDeletion; whether Sift's 11 KMS effects are all lifecycle (cryptographic use is invisible).
