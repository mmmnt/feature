# Storability amendments from the real-store audit (founder ruling 99212372, 2026-11-21)

These are amendments to three agreed specs. Each keeps its status as agreed and cites 99212372. The audit wrote every value
class straight to the real stores (Neo4j 2026.01.4-community, KurrentDB 26.2.3 and DynamoDB local) with no adapter in between.
The amended suites passed on those stores before these drafts were written.

| Draft | Amends | Ruling |
|---|---|---|
| `adapters/neo4j/seed-transform.feat` | SPEC-ADPNEO-005 | S1: null stays refused, with the correct reason. Neo4j drops a property set to null rather than storing it, so a seed states a field absent by leaving it out. A new scenario pins that reason. |
| `adapters/kurrent/seed-transform.feat` | SPEC-ADPKUR-006 | S2 "Allow any JSON": a seed's values may be any JSON value. Only an object can name `values.stream`. A non-object goes to the stream named by its type. A transform that turns an object naming a stream into a non-object moves the record's stream, so it is refused as a changed identity. |
| `adapters/dynamodb/seed-transform.feat` | SPEC-ADPDDB-003 | S3: each key attribute must have the type the table's key schema declares (read by DescribeTable at setup): S needs a non-empty string, N a finite number, and a B key can't be stated in JSON. A mismatch is SEED_VALUE_UNSTORABLE, naming the attribute and the type the table expects. |

`run.patch` is the code the drafts need to run: the three adapters' seed checks, plus new `seedraw` cases in the Kurrent and
DynamoDB probes. It touches only paths inside each spec's `touches`. It is not applied on this branch.

## Real-store results (spec tier, drafts in place and run.patch applied)

| Spec | Cases |
|---|---|
| SPEC-ADPNEO-005 | 27 of 27 |
| SPEC-ADPKUR-006 | 22 of 22 (19 before, plus three non-object rows) |
| SPEC-ADPDDB-003 | 24 of 24 (22 before, plus the key-type scenario and the `sknum` row) |

The first Kurrent run failed twice. A scalar answer from the transform was appended rather than refused, because the
shared transform (`adapters/stdio-jsonrpc/src/seed-transform.ts`) checks identity only when the answer is an object. The Kurrent
adapter now compares the stream itself for every answer (in `run.patch`). After that, both cases pass.

## Open questions

1. How does a non-object seed name its stream? Recommended: the stream named by its type, which is SPEC-ADPKUR-001's
   existing fallback. It needs no new field, and the drafts are written this way. The alternatives are a record-level
   `stream` beside `values`, which changes the cross-adapter SeedRecord type in feat-types, or an option giving a default
   stream, which is a second place a stream can come from.
2. Where does the identity check for a non-object answer belong? Recommended: move it into the shared transform in
   stdio-jsonrpc, so every adapter checks identity for any answer. That changes Neo4j's and DynamoDB's `scalar` rows from
   SEED_VALUE_UNSTORABLE to SEED_TRANSFORM_FAILED, which is a SPEC-RPC-001/ADPNEO-005 amendment. The alternative is the
   Kurrent-only check in `run.patch`, which stays inside SPEC-ADPKUR-006's touches.
3. Should Kurrent's read report null event data as null? Today `read()` reports null event data as `{}`
   (`adapters/kurrent/src/index.ts`, `payload: event.data ?? {}`), so a null seed would read back as `{}`. The drafts leave
   null out of the non-object rows for that reason. Recommended: report null as null, which amends SPEC-ADPKUR-001's read
   and capture and adds a null row here. The alternative is to keep `{}` and state in SPEC-ADPKUR-006 that a null seed
   reads back as `{}`.
4. Is the N-key path proven? Not yet: only the S-key path is. The probe's ephemeral table always declares S keys, so
   "a finite number for an N key" is never exercised. Recommended: add an ephemeral option for the key attribute types
   (SPEC-ADPDDB-001's ephemeral options), and a row seeding a number on an N key, plus a string on an N key that is
   refused. The alternative is to leave the N path to code review.
