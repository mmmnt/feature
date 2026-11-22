# Storability amendments from the real-store audit (founder rulings 99212372 and 57cc575c, 2026-11-21)

These are amendments to agreed specs. Each keeps its status as agreed and cites its rulings. The audit wrote every value class
straight to the real stores (Neo4j 2026.01.4-community, KurrentDB 26.2.3 and DynamoDB local) with no adapter in between. Every
suite these drafts affect passed on the real stores before the drafts were written.

| Draft | Amends | Rulings |
|---|---|---|
| `adapters/neo4j/seed-transform.feat` | SPEC-ADPNEO-005 | S1: null stays refused, for the reason the server gives: it drops a property set to null, so a seed leaves the field out to state it absent. A scenario pins that reason. T2: identity is compared for every answer, whatever its values are. |
| `adapters/stdio-jsonrpc/transport.feat` | SPEC-RPC-001 | T2: the shared transform compares each answered record's identity for every answer. A non-map answer carries no key, so it is SEED_TRANSFORM_FAILED. |
| `adapters/kurrent/seed-transform.feat` | SPEC-ADPKUR-006 | S2 "Allow any JSON": values may be any JSON value. T1: a non-object seed, or an object without `stream`, goes to the stream named by its type. An object naming a stream that a transform turns into a non-object is refused as a changed identity. T3: a null row reads back as `[null]`. |
| `adapters/kurrent/observe.feat`, `observe.contract.json` | SPEC-ADPKUR-001 | T3: capture and read report an event's JSON data as stored, null included; it used to be reported as `{}`. This adds a `writenull` probe step and a capture scenario. `lastPayloads` items may be any JSON. |
| `adapters/dynamodb/seed-transform.feat` | SPEC-ADPDDB-003 | S3: each key attribute has the type the table's key schema declares (read by DescribeTable at setup); a mismatch is SEED_VALUE_UNSTORABLE, naming the attribute and the type the table expects. T2: the `scalar` row becomes SEED_TRANSFORM_FAILED. T4: the N-key path is proven on an ephemeral table whose sort key is N. |
| `adapters/dynamodb/query-mode.feat` | SPEC-ADPDDB-001 | T4: `options.ephemeral` gains `partitionKeyType` and `sortKeyType` ("S" or "N", default "S"). |
| `docs/adr/ADR-0035-seed-transform.md` | ADR-0035 | T2, stated in decision 5. |

`run.patch` is the code the drafts need to run. It covers:
- the shared identity check (stdio-jsonrpc);
- the Neo4j null reason;
- Kurrent any-JSON seeds and null payloads;
- the DynamoDB key-type check and ephemeral key types (with the README);
- the probe steps `writenull`, `seedraw` (new cases) and `setupeph`.

Every changed path is inside its spec's `touches`. The patch is not applied on this branch, and the real spec paths are
unchanged.

## Real-store results (drafts in place, run.patch applied, regenerated suites)

Spec chain (`feat run -c feat.config.json`): 46 files, 948 tests, all passed. The affected suites:

| Spec | Suite | Cases |
|---|---|---|
| SPEC-ADPNEO-005 | adapters/neo4j/seed-transform | 27 of 27 |
| SPEC-RPC-001 | adapters/stdio-jsonrpc/transport | 55 of 55 |
| shared host registry (uses the shared transform) | adapters/stdio-jsonrpc/host-sharing | 24 of 24 |
| SPEC-ADPRDS-002 (shares the transform) | adapters/redis/seed-transform | 26 of 26 |
| SPEC-ADPKUR-001 | adapters/kurrent/observe | 42 of 42 |
| SPEC-ADPKUR-006 | adapters/kurrent/seed-transform | 23 of 23 |
| Kurrent credential files, Node 26 TLS host (capture code changed) | credential-files, node26-tls-host | 15 of 15, 22 of 22 |
| SPEC-ADPDDB-001 | adapters/dynamodb/query-mode | 29 of 29 |
| SPEC-ADPDDB-003 | adapters/dynamodb/seed-transform | 26 of 26 |

Integration config (`feat run -c feat.integration.config.json`): 7 files, 45 tests, all passed. That includes Kurrent
transport (7), Kurrent broker-loss (4) and DynamoDB transport (8).

Every literal is the value the real adapter produced:
- Kurrent traces follow SPEC-ADPKUR-001's `read:<ns>:<stream>=<n>` and `last: <stream>/<Type>`.
- DynamoDB keys are `PK`/`SK`, a keyless read is `Scan`, and `readItems` lists attributes in name order.
- Neo4j details name `Order:o1 › v`.
- Numbers come back as the store returns them (`1`, not `1.0`).

## Left open

Nothing the rulings asked for. One note: `partitionKeyType: "N"` is accepted, but a namespaced adapter refuses it at setup,
because the namespace prefixes the partition key, as SPEC-ADPDDB-001 already says. So the N path is proven on the sort key.
An N partition key works only without a namespace, which no probe scenario runs.
