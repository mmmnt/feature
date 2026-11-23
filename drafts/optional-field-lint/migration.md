# ADR-0038 hand migration plan (DRAFT, for review; nothing applied)

Founder rulings 7d3026eb-73ec-5a92-b3fe-e2fcb7b42a31, 55fb39c4-d774-5f92-a62b-4bce3f352f28 (L3: by hand, every block a deliberate choice) and d2cd2f0d-8284-5d0c-a310-ad6741b0747e (MG1–MG6: SPEC-CORE-001 refusal outlines gain line/hint columns; load-config-extends states its merged fields; harness-faults RunResult and SPEC-PRR-001 bodies partial; corpus `message: any string`; every `absent` re-checked on CI Linux before applying).

Each row is one value block the lint flags. *Proposed* is the choice; *Statement* is what the block gains (`partial` goes after the schema name). The proposal comes from what the spec run actually returned for each omitted field (an instrumented run of the full spec chain, 970 tests, 2026-11-23): never returned → `absent`; always the same short value → that value; minted, row-dependent, sometimes-present or long → `partial`. Corpus exemplars are not executed, so their 15 rows were decided by reading the exemplar.

| Choice | Blocks |
|---|---|
| absent | 225 |
| value | 66 |
| value (columns) | 4 |
| absent + value | 43 |
| partial | 45 |
| **total** | **383** |

flmnt's three blocks (FLMNT-SPEC-PRJ-007 Erase, two REMOVE `NodeRecord`s; FLMNT-SPEC-PRJ-004 Rebuild, one INSERT `NodeRecord`) are `partial` by ruling L5 and are not repeated below.

## SPEC-PRR-001 — `actions/pr-report/report.feat` (25)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a green build with an unbroken chain posts a new report comment and a passing check | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 2 | a second run updates the same comment instead of adding one | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 3 | a failing scenario shows its violation and fails the check | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 4 | an attestation whose signature fails verification breaks the chain | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 5 | a provenance source commit other than the built commit breaks the chain | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 6 | a signer that is not this repository's workflow breaks the chain | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 7 | an attestation signed by another key breaks the chain | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 8 | a built commit whose parents are not the PR's base and head breaks the chain | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 9 | a bundle with no run is incomplete, not passing | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 10 | main's build attested for another commit breaks the chain at main's provenance | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 11 | a pull request run whose attestations are gone is refused and nothing is signed | response: ReportError | detail | value | `detail: "run 44153523061 has no attested artifacts"` | always returned with this value here; stating it makes the prediction whole |
| 12 | a push to a branch other than main is refused and nothing is posted | response: ReportError | detail | value | `detail: "this run is neither a pull request nor a push to main"` | always returned with this value here; stating it makes the prediction whole |
| 13 | no uploaded evidence is refused and nothing is posted | response: ReportError | detail | value | `detail: "no feat evidence bundle was uploaded"` | always returned with this value here; stating it makes the prediction whole |
| 14 | a read-only token is refused before anything is posted | response: ReportError | detail | value | `detail: "the token cannot write pull request comments or check runs"` | always returned with this value here; stating it makes the prediction whole |
| 15 | main's evidence that cannot be stored in GHCR is refused and nothing is signed | response: ReportError | detail | value | `detail: "evidence bundles could not be stored: push refused"` | always returned with this value here; stating it makes the prediction whole |
| 16 | a merge ref whose first parent is not on the base branch breaks the chain | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 17 | a statement for another main commit is refused and nothing is signed | response: ReportError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 18 | a statement whose digest differs from the one main's check recorded is refused and nothing is signed | response: ReportError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 19 | a fork run whose branch has moved past its head commit matches no pull request and nothing is posted | response: ReportError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 20 | the follow-up refuses a run a person started from this repository, which reports itself | response: ReportError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 21 | a force push, whose before is not an ancestor of the main commit, is refused and nothing is stored, signed or posted | response: ReportError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 22 | a merge pushed as a force push is refused like any other | response: ReportError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 23 | a direct commit whose build attested another commit breaks the chain at main's provenance and writes no statement | response: ProbeResult | body | partial | `partial` | body is long diagnostic text — the scenario's claim is the listed fields |
| 24 | a direct commit whose evidence cannot be stored in GHCR is refused and nothing is written or posted | response: ReportError | detail | value | `detail: "evidence bundles could not be stored: push refused"` | always returned with this value here; stating it makes the prediction whole |
| 25 | a push whose commits cannot all be listed is refused and nothing is stored, signed or posted | response: ReportError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |

## SPEC-ADPDDB-001 — `adapters/dynamodb/query-mode.feat` (20)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | the adapter declares which diff it serves | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | with no stream the adapter declares snapshot | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | native capture reports insert, modify and remove in stream order without the namespace prefix, seeds excluded | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | two namespaces never see each other's items | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | an item whose key carries no namespace prefix is nobody's effect | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | a peek reports the window's records and consumes nothing | response: ObserveResult | readVia | absent | `readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | a peek with no window open is empty | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | with the fence on, settle vouches once the stream has caught up, and the sentinel is not a record | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | with the fence off, native settle declines, so the harness keeps its ceiling | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 10 | settle declines when no window is open | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | snapshot capture reports insert, modify and remove by key | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 12 | snapshot diff cannot see an item written and deleted inside the window | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | snapshot settle vouches because a consistent read sees every acknowledged write | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 14 | a read given a full key uses GetItem | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | a read given a partition key uses Query | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 16 | a read given no key scans the namespace only and hides the instrument's rows | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 17 | reset deletes the namespace's items and leaves the other namespace alone | response: ObserveResult | last, peekEqualsStop, readVia | absent + value | `last: absent, peekEqualsStop: absent, readVia: "Scan"` | every omitted field is either never returned or always the same value here |
| 18 | a conditional put on a key that already exists is refused when CONDITIONAL_CHECK_FAILED is armed | response: ObserveResult | last, peekEqualsStop, readVia | absent + value | `last: absent, peekEqualsStop: absent, readVia: "Scan"` | every omitted field is either never returned or always the same value here |
| 19 | reset disarms the fault, so the same conditional put then succeeds | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 20 | DynamoDB reports no request it refused, so firedFaults is not offered | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPDDB-003 — `adapters/dynamodb/seed-transform.feat` (2)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a transformed seed is state: the window that follows reports nothing | response: SeedTransformResult | readItems, readVia | absent | `readItems: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | without seedTransform no host is asked and a plain seed is put as before | response: SeedTransformResult | readItems | value | `readItems: "[{\"PK\":\"o1\",\"SK\":\"1\",\"v\":\"x\"}]"` | always returned with this value here; stating it makes the prediction whole |

## SPEC-FPX-001 — `adapters/fault-proxy/fault-proxy.feat` (5)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | each namespace gets its own proxy with its own address | response: ProbeResult | upstreamSaw | value | `upstreamSaw: 0` | always returned with this value here; stating it makes the prediction whole |
| 2 | opening the same namespace again returns the same proxy | response: ProbeResult | upstreamSaw | value | `upstreamSaw: 0` | always returned with this value here; stating it makes the prediction whole |
| 3 | faults stack until disarm and are listed | response: ProbeResult | upstreamSaw | value | `upstreamSaw: 0` | always returned with this value here; stating it makes the prediction whole |
| 4 | broker loss pauses the container and disarm restores it | response: ProbeResult | upstreamSaw | value | `upstreamSaw: 0` | always returned with this value here; stating it makes the prediction whole |
| 5 | broker loss in stop mode stops the container and disarm starts it again | response: ProbeResult | upstreamSaw | value | `upstreamSaw: 0` | always returned with this value here; stating it makes the prediction whole |

## SPEC-ADPFS-002 — `adapters/fs/archive.feat` (17)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | an archive written in the window is reported with its members in archive order | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | an empty .jsonl member is no lines | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastTypes: "FILE_WRITTEN"` | every omitted field is either never returned or always the same value here |
| 3 | a member name longer than 100 bytes is read whole, from a GNU long-name entry, a pax header or a ustar prefix | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastTypes: "FILE_WRITTEN"` | every omitted field is either never returned or always the same value here |
| 4 | a glob reaches into subdirectories when it says so | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | a written file that matches no archive glob is reported as before, with no members | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | without the archives option an archive is a file like any other | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastTypes: "FILE_WRITTEN"` | every omitted field is either never returned or always the same value here |
| 7 | a deleted archive is reported deleted, with no members | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | an archive that existed before the window and did not change is not reported | response: ObserveResult | lastPayloads, lastTypes, peekEqualsStop | absent | `lastPayloads: absent, lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | a peek reports the members and the stop reports the same | response: ObserveResult | lastTypes | value | `lastTypes: "FILE_WRITTEN"` | always returned with this value here; stating it makes the prediction whole |
| 10 | an archive that cannot be read in full is captured as ARCHIVE_UNREADABLE, never skipped | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | an empty file matching a glob is an unreadable archive, not an archive with no members | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 12 | reset with clearOnReset empties the scope and keeps the scope directory | response: ObserveResult | lastPayloads, lastTypes, peekEqualsStop | absent | `lastPayloads: absent, lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | reset with clearOnReset keeps the names the adapter never descends into | response: ObserveResult | lastPayloads, lastTypes, peekEqualsStop | absent | `lastPayloads: absent, lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 14 | reset without clearOnReset writes nothing to the tree | response: ObserveResult | lastPayloads, lastTypes, peekEqualsStop | absent | `lastPayloads: absent, lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | reset with clearOnReset and no scope directory leaves it absent | response: ObserveResult | lastPayloads, lastTypes, peekEqualsStop | absent | `lastPayloads: absent, lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 16 | what reset removes is never a record of the next window | response: ObserveResult | lastPayloads, lastTypes, peekEqualsStop | absent | `lastPayloads: absent, lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 17 | a root scope is not refused when clearOnReset is off | response: ObserveResult | lastPayloads, lastTypes, peekEqualsStop | absent | `lastPayloads: absent, lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPFS-001 — `adapters/fs/observe.feat` (6)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a file that existed before the window and did not change is not reported | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `lastTypes: absent, peekEqualsStop: true` | every omitted field is either never returned or always the same value here |
| 2 | a peek after stop finds the window closed | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a stop with no window open reports nothing, not every file in scope | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | settle declines inside a window with a write in it | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastTypes: "FILE_WRITTEN"` | every omitted field is either never returned or always the same value here |
| 5 | settle declines inside an empty window, so an absence is never proven by a fence | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | settle declines outside a window | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPKFK-001 — `adapters/kafka/observe.feat` (20)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | with the right SASL credentials the instrument connects and captures | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | records produced in the window are captured in offset order, seeds are not | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | two namespaces never see each other's records | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a topic outside every namespace is nobody's effect | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | across partitions only each partition's order is reported | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | records of an aborted transaction are not captured, committed ones are | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | a peek with no window open is empty | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | settle vouches once the system's records are consumable | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | settle vouches on an empty window, which is how an absence is proven | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 10 | settle declines when no window is open | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | settle declines while a transaction is open, because that effect is not yet decided | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 12 | settle declines when it cannot consume to the fence in time | response: ObserveResult | last, peekEqualsStop | absent + value | `peekEqualsStop: absent, last: "orders/Placed"` | every omitted field is either never returned or always the same value here |
| 13 | read reports the namespace's committed records and no other namespace's | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 14 | read with a topic hint returns that topic and may return no other | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | reset empties the namespace and leaves the other one alone | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 16 | a window left open by the previous case is closed by reset | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 17 | a record bigger than the topic allows is refused when MESSAGE_TOO_LARGE is armed | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 18 | a produce that needs more in-sync replicas than exist is refused when NOT_ENOUGH_REPLICAS is armed | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 19 | reset removes the topic the fault created, so the same produce then succeeds | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 20 | the broker reports no produce it refused, so firedFaults is not offered | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPKMS-001 — `adapters/kms/observe.feat` (22)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | the adapter declares snapshot diff and state | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a window reports keys created and changed, seeds excluded | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | rotation and tags are changes of state | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | deleting a key's only alias changes its identity, so it reads as one removal and one insertion | response: ObserveResult | last, peekEqualsStop, readVia | absent + value | `peekEqualsStop: absent, readVia: absent, last: "INSERT:22d0db89-7584-411e-a36c-782807ee5391,REMOVE:three"` | every omitted field is either never returned or always the same value here |
| 5 | a key scheduled for deletion is a change, not a removal | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | two namespaces never see each other's keys | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | a key with no namespace tag and no namespaced alias is nobody's effect | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | a cryptographic use of a key leaves nothing for a snapshot to see | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | a peek reports the window's records and consumes nothing | response: ObserveResult | readVia | absent | `readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 10 | a peek with no window open is empty | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | settle vouches for the emulator, whose reads follow its writes | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 12 | settle vouches on an empty window, which is how an absence is proven | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | settle declines when the endpoint is not a declared emulator, because KMS is eventually consistent | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 14 | settle declines when no window is open | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | a read given an alias describes that key | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 16 | a read given no hint lists the namespace and no other | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 17 | reset takes the namespace's keys out of the namespace and leaves the other one alone | response: ObserveResult | last, peekEqualsStop, readVia | absent + value | `last: absent, peekEqualsStop: absent, readVia: "ListKeys"` | every omitted field is either never returned or always the same value here |
| 18 | a use of a disabled key is refused when DISABLED is armed | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 19 | a use of a key pending deletion is refused when PENDING_DELETION is armed | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 20 | a use through a missing alias is refused when ALIAS_NOT_FOUND is armed | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 21 | reset leaves no fault behind, so a fresh key under the same alias is usable | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 22 | KMS reports no request it refused, so firedFaults is not offered | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPKUR-005 — `adapters/kurrent/credential-files.feat` (2)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a tlsCAFile parameter in a connection string from a file is passed to the client as written | response: ObserveResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | the refusal is known without a connection, so connectionRefusal reports it | response: ObserveResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPKUR-004 — `adapters/kurrent/node26-tls-host.feat` (4)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | the rewrite changes the host and nothing else | response: ObserveResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | an IP host is left as written where the name is allowed, so no refusal and no rewrite | response: ObserveResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | the TLS host rule judges an IP host by the Node major, so below Node 26 nothing is refused | response: ObserveResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | tls absent is tls on, so a loopback host is still rewritten | response: ObserveResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPKUR-001 — `adapters/kurrent/observe.feat` (32)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | writes made in the window are captured in commit order, seeds are not | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{},{},{}]` | every omitted field is either never returned or always the same value here |
| 2 | the order is the log's even across streams | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{},{},{},{}]` | every omitted field is either never returned or always the same value here |
| 3 | two namespaces never see each other's records | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{},{}]` | every omitted field is either never returned or always the same value here |
| 4 | a write outside every namespace is nobody's effect | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | rewriting a stream that held events before a reset captures only the system's write, not the server's $tb record | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{}]` | every omitted field is either never returned or always the same value here |
| 6 | a soft delete by the system is reported as stream.deleted naming the stream, and its $metadata record is not captured | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | a stream name with separators is named whole in stream.deleted | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | a soft delete of a stream that has other metadata is still a stream.deleted | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | a metadata write that is not a delete is still captured as $metadata | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 10 | a delete then a rewrite in one window is a stream.deleted then the write, and the server's $tb record is still dropped | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{"streamId":"orders"},{}]` | every omitted field is either never returned or always the same value here |
| 11 | a peek reports the stream.deleted and the stop reports the same | response: ObserveResult | lastPayloads | value | `lastPayloads: [{"streamId":"orders"}]` | always returned with this value here; stating it makes the prediction whole |
| 12 | a hard delete by the system is reported as stream.deleted with hard true | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | a soft delete then a hard delete of one stream are two stream.deleted records, soft then hard | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 14 | a tombstoned stream reads as empty and reset passes over it | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | a soft delete in another namespace is not this namespace's stream.deleted | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{"streamId":"orders"}]` | every omitted field is either never returned or always the same value here |
| 16 | a peek reports the window's records and consumes nothing | response: ObserveResult | lastPayloads | value | `lastPayloads: [{}]` | always returned with this value here; stating it makes the prediction whole |
| 17 | a peek sees records written between peeks exactly once | response: ObserveResult | lastPayloads | value | `lastPayloads: [{},{}]` | always returned with this value here; stating it makes the prediction whole |
| 18 | a peek with no window open is empty | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 19 | settle vouches once the system's writes are readable, and the fence is not a record | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{}]` | every omitted field is either never returned or always the same value here |
| 20 | settle vouches on an empty window, which is how an absence is proven | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 21 | settle declines when no window is open | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 22 | settle declines when the marker cannot be read back in time, and says so by being false | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, last: "orders/Placed", lastPayloads: [{}]` | every omitted field is either never returned or always the same value here |
| 23 | read reports the namespace's streams and not the instrument's markers | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 24 | read with a stream hint returns that stream and may return no other | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 25 | reset clears the namespace and leaves the other one alone | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 26 | a window left open by the previous case is closed by reset | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 27 | an append that expects a new stream is refused when WRONG_EXPECTED_VERSION is armed | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 28 | the fault's placeholder is not a record of the system | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 29 | a write to a stream whose ACL denies writers is refused when ACCESS_DENIED is armed | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 30 | reset disarms the fault, so the same write then succeeds | response: ObserveResult | lastPayloads, peekEqualsStop | absent + value | `peekEqualsStop: absent, lastPayloads: [{}]` | every omitted field is either never returned or always the same value here |
| 31 | the product reports no refusal it issued, so firedFaults is not offered | response: ObserveResult | last, lastPayloads, peekEqualsStop | absent | `last: absent, lastPayloads: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 32 | an event whose JSON data is null is captured with a null payload, as stored | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPKUR-006 — `adapters/kurrent/seed-transform.feat` (2)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a transformed seed is state: the window that follows reports nothing | response: SeedTransformResult | readPayloads | absent | `readPayloads: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | without seedTransform no host is asked and a plain seed is appended as before | response: SeedTransformResult | readPayloads | value | `readPayloads: "[{\"stream\":\"orders\"}]"` | always returned with this value here; stating it makes the prediction whole |

## SPEC-ADPMEM-001 — `adapters/memory/observe.feat` (8)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a peek before any effect is empty | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `lastTypes: absent, peekEqualsStop: true` | every omitted field is either never returned or always the same value here |
| 2 | the delivered stimulus is not in a peek, only what the consumer published | response: ObserveResult | peekEqualsStop | absent | `peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | seeded records are not in a peek | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `lastTypes: absent, peekEqualsStop: true` | every omitted field is either never returned or always the same value here |
| 4 | a peek after stop finds the window closed | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | reset closes the window | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | settle vouches once the consumer's publishes are in the log | response: ObserveResult | lastTypes, peekEqualsStop | value | `lastTypes: "Pong", peekEqualsStop: true` | always returned with this value here; stating it makes the prediction whole |
| 7 | settle declines when no window is open | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | settle vouches on an empty window, which is how an absence is proven | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPMODEL-001 — `adapters/model/observe.feat` (11)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | every ask type of the consumer's port is captured | response: ObserveResult | lastPayload | partial | `partial` | lastPayload differs per row — the scenario's claim is the listed fields |
| 2 | a seeded answer is a line the system reads, and is never in the window | response: ObserveResult | lastPayload, lastTypes | absent | `lastPayload: absent, lastTypes: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | an ask written before the window opened is not in it | response: ObserveResult | lastPayload | partial | `partial` | lastPayload is long diagnostic text — the scenario's claim is the listed fields |
| 4 | a line still being written is not a record until its line ending lands | response: ObserveResult | lastPayload | partial | `partial` | lastPayload is long diagnostic text — the scenario's claim is the listed fields |
| 5 | a peek consumes nothing | response: ObserveResult | lastPayload | partial | `partial` | lastPayload is long diagnostic text — the scenario's claim is the listed fields |
| 6 | with no window open, peek and stop return nothing | response: ObserveResult | lastPayload, lastTypes | absent | `lastPayload: absent, lastTypes: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | settle vouches with a window open, which is how an absence is proven | response: ObserveResult | lastPayload, lastTypes | absent | `lastPayload: absent, lastTypes: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | settle declines when no window is open | response: ObserveResult | lastPayload, lastTypes | absent | `lastPayload: absent, lastTypes: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | reset empties the record file and closes the window | response: ObserveResult | lastPayload, lastTypes | absent | `lastPayload: absent, lastTypes: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 10 | setup creates the record file under the namespace's name and teardown removes it | response: ObserveResult | lastPayload, lastTypes | absent | `lastPayload: absent, lastTypes: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | a relative dir is read from the project root | response: ObserveResult | lastPayload | partial | `partial` | lastPayload is long diagnostic text — the scenario's claim is the listed fields |

## SPEC-ADPNEO-001 — `adapters/neo4j/observe.feat` (18)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | the adapter declares snapshot diff and state | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a window reports nodes and relationships created, changed and removed, seeds excluded | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | two namespaces never see each other's graph | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a node with no namespace label is nobody's effect | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | snapshot diff cannot see a node created and removed inside the window | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | a peek reports the window's records and consumes nothing | response: ObserveResult | readVia | absent | `readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | a peek with no window open is empty | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | settle vouches on a direct connection once no other transaction runs | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | settle vouches on an empty window, which is how an absence is proven | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 10 | settle declines when no window is open | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | settle declines while the system's transaction is open and vouches after it commits | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 12 | settle declines on a routing connection, where another member may serve the read | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | a read given a label and key matches that node | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 14 | a read given no hint reports the namespace only and not the fault placeholder | response: ObserveResult | last, peekEqualsStop | absent | `last: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | reset deletes the namespace's graph and leaves the other one alone | response: ObserveResult | last, peekEqualsStop, readVia | absent + value | `last: absent, peekEqualsStop: absent, readVia: "NamespaceScan"` | every omitted field is either never returned or always the same value here |
| 16 | a node that repeats a unique property is refused when UNIQUE_CONSTRAINT_VIOLATION is armed | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 17 | reset drops the constraint and the placeholder, so the same create then succeeds | response: ObserveResult | peekEqualsStop, readVia | absent | `peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 18 | the server reports no write it refused, so firedFaults is not offered | response: ObserveResult | last, peekEqualsStop, readVia | absent | `last: absent, peekEqualsStop: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPNEO-004 — `adapters/neo4j/relationship-seeds.feat` (7)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a seeded relationship is state: the window that follows reports nothing | response: SeedsResult | last, readKeys, readVia | absent | `last: absent, readKeys: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a read reports a seeded relationship as the diff names it | response: SeedsResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a fork: two relationships of the same type into one node | response: SeedsResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a cycle: two nodes that point at each other | response: SeedsResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | a relationship's own properties are seeded with it | response: SeedsResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | the same relationship seeded twice is two relationships, reported with a count | response: SeedsResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | one seed call writes its nodes before its relationships, wherever the relationship stands | response: SeedsResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPNEO-005 — `adapters/neo4j/seed-transform.feat` (8)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a node seed's value is written as the host transformed it | response: SeedTransformResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a transformed seed is state: the window that follows reports nothing | response: SeedTransformResult | last, readValues, readVia | absent | `last: absent, readValues: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a relationship seed's own property is transformed too | response: SeedTransformResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | one seed call is transformed in one request, asked twice, and written in order | response: SeedTransformResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | a host that answers late is awaited before the seed is written | response: SeedTransformResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | without seedTransform no host is asked and a plain seed is written as before | response: SeedTransformResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | after a refused seed call the namespace holds nothing of it | response: SeedTransformResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | a plain seed whose value is an empty list is written and read back as an empty list | response: SeedTransformResult | last | absent | `last: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-ADPRDS-001 — `adapters/redis/observe.feat` (18)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | the adapter declares snapshot diff and state | response: ObserveResult | last, payloads, peekEqualsStop, read, readPayloads, readVia | absent | `last: absent, payloads: absent, peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a window reports keys added, changed and removed, seeds excluded | response: ObserveResult | peekEqualsStop, read, readPayloads, readVia | absent | `peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | every kind the adapter reads is reported in its canonical order | response: ObserveResult | peekEqualsStop, read, readPayloads, readVia | absent | `peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | two namespaces never see each other's keys | response: ObserveResult | payloads, peekEqualsStop, read, readPayloads, readVia | partial | `partial` | payloads is long diagnostic text — the scenario's claim is the listed fields |
| 5 | a key with no namespace prefix is nobody's effect | response: ObserveResult | last, payloads, peekEqualsStop, read, readPayloads, readVia | absent + value | `last: absent, peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent, payloads: "[]"` | every omitted field is either never returned or always the same value here |
| 6 | snapshot diff cannot see a key created and removed inside the window | response: ObserveResult | last, payloads, peekEqualsStop, read, readPayloads, readVia | absent + value | `last: absent, peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent, payloads: "[]"` | every omitted field is either never returned or always the same value here |
| 7 | a peek reports the window's records and consumes nothing | response: ObserveResult | payloads, read, readPayloads, readVia | absent + value | `read: absent, readPayloads: absent, readVia: absent, payloads: "[{\"key\":\"k1\",\"kind\":\"string\",\"value\":\"v\"}]"` | every omitted field is either never returned or always the same value here |
| 8 | settle vouches with a window open and declines with none | response: ObserveResult | payloads, peekEqualsStop, read, readPayloads, readVia | absent + value | `peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent, payloads: "[{\"key\":\"k1\",\"kind\":\"string\",\"value\":\"v\"}]"` | every omitted field is either never returned or always the same value here |
| 9 | a read with a key hint looks the key up; without one it scans the namespace | response: ObserveResult | last, payloads, peekEqualsStop, readPayloads | partial | `partial` | readPayloads is long diagnostic text — the scenario's claim is the listed fields |
| 10 | a read's records carry their key in the payload | response: ObserveResult | last, payloads, peekEqualsStop, readVia | absent + value | `last: absent, payloads: absent, peekEqualsStop: absent, readVia: "KeyedLookup"` | every omitted field is either never returned or always the same value here |
| 11 | a keyed read names how it found the key | response: ObserveResult | last, payloads, peekEqualsStop, readPayloads | absent + value | `last: absent, payloads: absent, peekEqualsStop: absent, readPayloads: "[{\"key\":\"k3\",\"kind\":\"list\",\"value\":[\"i0\"]}]"` | every omitted field is either never returned or always the same value here |
| 12 | reset removes every key of the namespace and nothing else | response: ObserveResult | last, payloads, peekEqualsStop, read, readPayloads, readVia | absent | `last: absent, payloads: absent, peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | a password read from a file connects the instrument, and the system's writes are observed | response: ObserveResult | payloads, peekEqualsStop, read, readPayloads, readVia | absent + value | `peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent, payloads: "[{\"key\":\"k1\",\"kind\":\"string\",\"value\":\"v\"}]"` | every omitted field is either never returned or always the same value here |
| 14 | one trailing line ending is removed, so a secret written by echo or an editor still connects | response: ObserveResult | last, payloads, peekEqualsStop, read, readPayloads, readVia | absent | `last: absent, payloads: absent, peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | nothing but the line ending is trimmed, so a password with a space in it is kept | response: ObserveResult | payloads, peekEqualsStop, read, readPayloads, readVia | absent + value | `peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent, payloads: "[{\"key\":\"k1\",\"kind\":\"string\",\"value\":\"v\"}]"` | every omitted field is either never returned or always the same value here |
| 16 | a relative path is read from the run's working directory | response: ObserveResult | last, payloads, peekEqualsStop, read, readPayloads, readVia | absent | `last: absent, payloads: absent, peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 17 | a URL read from a file connects, with its line ending removed | response: ObserveResult | last, payloads, peekEqualsStop, read, readPayloads, readVia | absent | `last: absent, payloads: absent, peekEqualsStop: absent, read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 18 | a TLS server is verified against the CA read from tlsCAFile, and the instrument reads through it | response: ObserveResult | last, payloads, peekEqualsStop, readPayloads | absent + value | `last: absent, payloads: absent, peekEqualsStop: absent, readPayloads: "[]"` | every omitted field is either never returned or always the same value here |

## SPEC-ADPRDS-002 — `adapters/redis/seed-transform.feat` (5)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a seed value is written as the host transformed it | response: SeedTransformResult | read, readVia | partial | `partial` | read differs per row — the scenario's claim is the listed fields |
| 2 | one seed call is transformed in one request, asked twice | response: SeedTransformResult | readPayloads | partial | `partial` | readPayloads is long diagnostic text — the scenario's claim is the listed fields |
| 3 | a transformed seed is state: the window that follows reports nothing | response: SeedTransformResult | read, readPayloads, readVia | absent | `read: absent, readPayloads: absent, readVia: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | without seedTransform no host is asked and a plain seed is written as before | response: SeedTransformResult | readPayloads | value | `readPayloads: "[{\"key\":\"k1\",\"kind\":\"string\",\"value\":\"v0\"}]"` | always returned with this value here; stating it makes the prediction whole |
| 5 | after a refused seed call the namespace holds nothing of it | response: SeedTransformResult | readPayloads | value | `readPayloads: "[]"` | always returned with this value here; stating it makes the prediction whole |

## SPEC-RPC-002 — `adapters/stdio-jsonrpc/host-sharing.feat` (23)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | one host serves the response role and every service role of a spec file | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 2 | the first role to set up spawns the host, whichever role it is | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 3 | the host stays up until the last role tears down | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 4 | a file whose roles all tore down and set up again gets a fresh host | response: RunFilesResult | distinctHosts | value | `distinctHosts: 2` | always returned with this value here; stating it makes the prediction whole |
| 5 | each role opens only its own service and no setup closes another role's | response: RunFilesResult | distinctHosts | value | `distinctHosts: 2` | always returned with this value here; stating it makes the prediction whole |
| 6 | a host crash fails every role of that file and no other file | response: RunFilesResult | distinctHosts | value | `distinctHosts: 2` | always returned with this value here; stating it makes the prediction whole |
| 7 | a role configured with another host command than its file's host is refused | response: SharingError | casesRun, detail, rpcCode | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 8 | settle vouches only after every task the scenario spawned has finished | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 9 | settle answers false when a spawned task did not finish cleanly | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 10 | settle answers false when the host cannot vouch, so the harness keeps the ceiling | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 11 | peekCapture is non-destructive: repeated peeks and the stop all see the same records | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 12 | every role of a file sets up with the same namespace and the host reports it in its environment | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 13 | two files get two namespaces and each host sees only its own | response: RunFilesResult | distinctHosts | value | `distinctHosts: 2` | always returned with this value here; stating it makes the prediction whole |
| 14 | a host that echoes another namespace stops the file before any case runs | response: SharingError | rpcCode | absent | `rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | a host that answers another protocol version stops the file before any case runs | response: SharingError | rpcCode | absent | `rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 16 | a host that gives no protocol version fails the setup exchange as a protocol violation | response: SharingError | rpcCode | absent | `rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 17 | a host that gives no echo fails the setup exchange as a protocol violation | response: SharingError | rpcCode | absent | `rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 18 | a role that sets up under another namespace is refused by the host | response: SharingError | casesRun, detail | value | `casesRun: 0, detail: "namespace s3b04e21257fd is not this host's s0599e33863c1"` | always returned with this value here; stating it makes the prediction whole |
| 19 | the scenario clock reaches the host through setClock on every role, response first, in every case | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 20 | a case without a clock sends null so the previous case's freeze does not leak | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 21 | a clock without a zone designator is refused INVALID_CLOCK before any host call | response: SharingError | casesRun, detail, rpcCode | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 22 | a case's random seed reaches the host through setSeed on the response role, and null unseeds it | response: RunFilesResult | distinctHosts | value | `distinctHosts: 1` | always returned with this value here; stating it makes the prediction whole |
| 23 | a seed that is not a whole number is refused INVALID_SEED before any host call | response: SharingError | casesRun, detail, rpcCode | absent + value | `rpcCode: absent, casesRun: 1, detail: "'-1' is not a whole number from 0 to 9007199254740991"` | every omitted field is either never returned or always the same value here |

## SPEC-RPC-001 — `adapters/stdio-jsonrpc/transport.feat` (32)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a setup answer without the namespace echo violates the closed schema | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a setup answer without the protocol version violates the closed schema | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a setup answer whose namespace is not s plus twelve hex characters violates the closed schema | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a setup without a namespace never reaches a host | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | a setup without a protocol version never reaches a host | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | a setup naming another protocol version never reaches a host | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | a setup whose namespace is not s plus twelve hex characters never reaches a host | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | a setup whose namespace has the wrong length never reaches a host | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | a fault with both a count and until reset never reaches a host | response: ExchangeError | detail, message, rpcCode | absent + value | `message: absent, rpcCode: absent, detail: "request/params must NOT be valid"` | every omitted field is either never returned or always the same value here |
| 10 | a setClock with a clock lacking a zone designator never reaches a host | response: ExchangeError | detail, message, rpcCode | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 11 | a reset that still carries a clock never reaches a host | response: ExchangeError | detail, message, rpcCode | absent + value | `message: absent, rpcCode: absent, detail: "request/params must NOT have additional properties 'clock'"` | every omitted field is either never returned or always the same value here |
| 12 | a settle with a stray parameter never reaches a host | response: ExchangeError | detail, message, rpcCode | absent + value | `message: absent, rpcCode: absent, detail: "request/params must NOT have additional properties 'wait'"` | every omitted field is either never returned or always the same value here |
| 13 | a fault without a kind never reaches a host | response: ExchangeError | detail, message, rpcCode | absent + value | `message: absent, rpcCode: absent, detail: "request/params must have required property 'kind' 'kind'"` | every omitted field is either never returned or always the same value here |
| 14 | a method outside the protocol never reaches a host | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 15 | a host that cannot be started is named | response: ExchangeError | detail, message, rpcCode | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 16 | a host that exits before answering is named | response: ExchangeError | detail, message, rpcCode | absent + value | `message: absent, rpcCode: absent, detail: "the host exited before it answered"` | every omitted field is either never returned or always the same value here |
| 17 | a silent host times out and is killed | response: ExchangeError | detail, message, rpcCode | absent + value | `message: absent, rpcCode: absent, detail: "no answer within 300 ms"` | every omitted field is either never returned or always the same value here |
| 18 | a line that is not JSON is a protocol violation | response: ExchangeError | detail, message, rpcCode | absent + value | `message: absent, rpcCode: absent, detail: "the host's line is not JSON: this is not json"` | every omitted field is either never returned or always the same value here |
| 19 | an answer carrying another id is a protocol violation | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 20 | an invoke answer without a status violates the closed schema | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 21 | a captured record with a stray key violates the closed schema | response: ExchangeError | message, rpcCode | absent | `message: absent, rpcCode: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 22 | a settle answer that is a bare boolean violates the closed schema | response: ExchangeError | detail, message, rpcCode | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 23 | an answer that carries both result and error is a protocol violation | response: ExchangeError | detail, message, rpcCode | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 24 | a host that serves no response-role delivery answers an error, relayed as HOST_ERROR | response: ExchangeError | detail | value | `detail: "Method not found: deliver to response"` | always returned with this value here; stating it makes the prediction whole |
| 25 | a JSON-RPC error from the host is relayed verbatim | response: ExchangeError | detail | value | `detail: "boom"` | always returned with this value here; stating it makes the prediction whole |
| 26 | a parse-error answer with a null id is relayed as the host error of the one outstanding request | response: ExchangeError | detail, message | value | `detail: "Parse error", message: "Parse error"` | always returned with this value here; stating it makes the prediction whole |
| 27 | a null id with any other code is a protocol violation | response: ExchangeError | detail, message, rpcCode | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 28 | a mapped arm reaches the host as kind operation.fault with its count | response: ArmResult | hostSawDetail | absent | `hostSawDetail: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 29 | once is a count of one | response: ArmResult | hostSawDetail | absent | `hostSawDetail: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 30 | an until-reset arm reaches the host as untilReset | response: ArmResult | hostSawDetail | absent | `hostSawDetail: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 31 | a fault the catalog declares only until reset arms until reset | response: ArmResult | hostSawDetail | absent | `hostSawDetail: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 32 | a host that serves no seed transform answers method not found | response: ExchangeError | detail, message | value | `detail: "Method not found: transformSeed", message: "Method not found: transformSeed"` | always returned with this value here; stating it makes the prediction whole |

## SPEC-ADPSTR-001 — `adapters/stripe/observe.feat` (6)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | events from before the window are not in a peek | response: ObserveResult | lastTypes, peekEqualsStop | absent + value | `lastTypes: absent, peekEqualsStop: true` | every omitted field is either never returned or always the same value here |
| 2 | the types filter applies to a peek | response: ObserveResult | peekEqualsStop | value | `peekEqualsStop: true` | always returned with this value here; stating it makes the prediction whole |
| 3 | a peek after stop finds the window closed | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a peek with no window open is empty even though the feed is not | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | settle declines after the event it could have waited for has arrived | response: ObserveResult | lastTypes, peekEqualsStop | value | `lastTypes: "charge.succeeded", peekEqualsStop: true` | always returned with this value here; stating it makes the prediction whole |
| 6 | settle declines outside a window | response: ObserveResult | lastTypes, peekEqualsStop | absent | `lastTypes: absent, peekEqualsStop: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-CORE-001 — `packages/feat-core/parse.feat` (9)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | refuses an observes declaration that is not well formed or names an unconfigured service | response: ParseError | line | value (columns) | `add a line column to the outline: each row's exact value, absent where the row has none` | MG1 (d2cd2f0d): the values are deterministic per fixture, so each row states its own |
| 2 | a delivery to a target that is neither response nor a configured service is refused | response: ParseError | line | absent | `line: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | refuses a service the spec uses but does not observe, naming it and the observed ones | response: ParseError | line | absent | `line: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a prediction that omits an observed service is incomplete | response: ParseError | hint, line | value (columns) | `add a hint column and a line column to the outline: each row's exact value, absent where the row has none` | MG1 (d2cd2f0d): the values are deterministic per fixture, so each row states its own |
| 5 | rejects invalid specs with the precise code | response: ParseError | hint, line | value (columns) | `add a hint column and a line column to the outline: each row's exact value, absent where the row has none` | MG1 (d2cd2f0d): the values are deterministic per fixture, so each row states its own |
| 6 | refuses a negation of a matcher it does not take, naming the spelling to use | response: ParseError | line | absent | `line: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | refuses an f32 digest of any other shape, giving the form | response: ParseError | line | absent | `line: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | refuses a list item or a list object's field it does not take, naming the spelling to use | response: ParseError | line | absent | `line: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | refuses 'partial' anywhere but a predicted record's or response's head, naming where it goes | response: ParseError | line | value (columns) | `add a line column to the outline: each row's exact value, absent where the row has none` | MG1 (d2cd2f0d): the values are deterministic per fixture, so each row states its own |

## SPEC-RT-005 — `packages/feat-runner/serial-faults.feat` (7)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | specs with no exclusive fault all run in the parallel pass | response: PlanResult | exit, reported | absent | `exit: absent, reported: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a spec that arms BrokerLoss moves to the serial pass and the rest do not | response: PlanResult | exit, reported | absent | `exit: absent, reported: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | one scenario among many is enough to move its whole file | response: PlanResult | exit, reported | absent | `exit: absent, reported: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | the file's name decides nothing | response: PlanResult | exit, reported | absent | `exit: absent, reported: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | a fault a probe arms in its when input is swept like a given one | response: PlanResult | exit, reported | absent | `exit: absent, reported: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | the same fault in the serial worker is armed | response: PlanResult | exit, parallel, reported, serial, serialWorkers | absent | `exit: absent, parallel: absent, reported: absent, serial: absent, serialWorkers: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | a fault that is not exclusive is armed in any worker | response: PlanResult | exit, parallel, reported, serial, serialWorkers | absent | `exit: absent, parallel: absent, reported: absent, serial: absent, serialWorkers: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-RT-016 — `packages/feat-runtime/harness-deliver.feat` (5)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | an event delivered to a service reaches that service's deliver() inside the capture window | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | an event delivered to response reaches the response adapter, and no service is handed it | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a sequence that delivers to a service and to response goes out in the order it is listed | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a response delivery reaches a response adapter even when no service can take a delivery | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | a refused delivery stops the sequence: no later delivery is made | response: HarnessError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |

## SPEC-RT-003 — `packages/feat-runtime/harness-faults.feat` (13)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | faults are armed after the seeds and the given executes and before the capture window | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | once is the next call only | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | times n is the next n calls | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | until reset is every call of the case | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | several faults are armed in written order and the detail reaches the adapter | response: RunResult | readHint, violationCodes, violations | absent | `readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | reset disarms, so a fault never leaks into the next case | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 7 | an armed fault the system never consumed fails the case | response: RunResult | armedDetail, readHint, violations | partial | `partial` | violations is long diagnostic text — the scenario's claim is the listed fields |
| 8 | times n consumed fewer than n times fails the case | response: RunResult | armedDetail, readHint, violations | partial | `partial` | violations is long diagnostic text — the scenario's claim is the listed fields |
| 9 | until reset never consumed fails the case | response: RunResult | armedDetail, readHint, violations | partial | `partial` | violations is long diagnostic text — the scenario's claim is the listed fields |
| 10 | an adapter that cannot see consumption is exempt | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | a fault that declares only until reset is armed when the case writes until reset | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 12 | a catalog in the earlier array shape declares every count | response: RunResult | armedDetail, readHint, violationCodes, violations | absent | `armedDetail: absent, readHint: absent, violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | a transport fault until reset is armed and checked like any other | response: RunResult | armedDetail, readHint, violations | partial | `partial` | violations is long diagnostic text — the scenario's claim is the listed fields |

## SPEC-RT-009 — `packages/feat-runtime/harness-given-order.feat` (3)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | an execute written before a seed runs before it | response: RunResult | violationCodes, violations | absent | `violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | seeds and executes interleave in the written order | response: RunResult | violationCodes, violations | absent | `violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a given with no written order runs its seeds, then its executes, as before | response: RunResult | violationCodes, violations | absent | `violationCodes: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-RT-006 — `packages/feat-runtime/harness-namespace.feat` (7)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | the namespace matches the protocol's pattern and is derived from the spec path | response: RunResult | trace | partial | `partial` | trace is long diagnostic text — the scenario's claim is the listed fields |
| 2 | equivalent spellings of one path give one namespace | response: RunResult | trace | partial | `partial` | trace is long diagnostic text — the scenario's claim is the listed fields |
| 3 | every adapter of a file and every case of it see the same namespace | response: RunResult | valid | value | `valid: true` | always returned with this value here; stating it makes the prediction whole |
| 4 | two files in parallel each get their own namespace | response: RunResult | valid | value | `valid: true` | always returned with this value here; stating it makes the prediction whole |
| 5 | the namespace is in the environment while the file runs and restored after | response: RunResult | valid | value | `valid: true` | always returned with this value here; stating it makes the prediction whole |
| 6 | a host that echoes the delivered namespace is accepted | response: RunResult | trace, valid | partial | `partial` | trace is long diagnostic text — the scenario's claim is the listed fields |
| 7 | the response check comes before the predictions: a refused namespace is reported, not the violation behind it | response: NamespaceError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |

## SPEC-RT-002 — `packages/feat-runtime/harness-observation.feat` (9)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | clock at reaches every adapter after the resets and before anything is invoked | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | a case without clock at hands the clock back, so one case's freeze never leaks into the next | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a service adapter that cannot take a clock is simply not called with one | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | a case without clock at needs no clock hook | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 5 | clock at against a response adapter that cannot honour it is refused before any effect | response: HarnessError | mode, service | absent | `mode: absent, service: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 6 | contains against a service that cannot report state is refused before any effect | response: HarnessError | detail | partial | `partial` | detail is long diagnostic text — the scenario's claim is the listed fields |
| 7 | a snapshot diff serves has, and a state-less adapter is fine without contains | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 8 | an adapter that declares nothing keeps both modes | response: RunResult | readHint, violations | absent + value | `violations: absent, readHint: ""` | every omitted field is either never returned or always the same value here |
| 9 | a contains assertion hands its predicted records to read as the query hint | response: RunResult | calls, violations | absent + value | `violations: absent, calls: "reset:store start:store invoke:Ping stop:store read:store"` | every omitted field is either never returned or always the same value here |

## SPEC-RT-013 — `packages/feat-runtime/harness-seed.feat` (4)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | random seed reaches the response adapter after the clock and before anything is invoked | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 2 | the case after a seeded one is unseeded with null, and a later unseeded case sends nothing | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | a case without random seed needs no seed hook | response: RunResult | readHint, violations | absent | `readHint: absent, violations: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | random seed against a response adapter that cannot honour it is refused before any effect | response: HarnessError | mode, service | absent | `mode: absent, service: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-RT-004 — `packages/feat-runtime/load-config-extends.feat` (14)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | an overlay replaces a service whole and keeps nothing of the base's options | response: FeatConfigResult | featVersion, report, response | value | `see Appendix A1` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 2 | a service the overlay does not mention is the base's | response: FeatConfigResult | environment, extends, featVersion, report, response | value | `see Appendix A2` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 3 | featVersion and schemas are inherited | response: FeatConfigResult | environment, extends, report, response | value | `see Appendix A3` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 4 | the response block is replaced whole | response: FeatConfigResult | environment, extends, featVersion, report | value | `see Appendix A4` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 5 | specs and report are replaced whole | response: FeatConfigResult | environment, extends, featVersion, response | value | `see Appendix A5` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 6 | an overlay without an environment has none, not the base's | response: FeatConfigResult | featVersion, report, response | value | `see Appendix A6` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 7 | an overlay file alone need not carry schemas, services or specs | response: FeatConfigResult | extends, featVersion, report, response | value | `see Appendix A7` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 8 | a missing base is named | response: ConfigError | change, path, space | absent | `change: absent, path: absent, space: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 9 | a chain is named and refused | response: ConfigError | change, path, space | absent | `change: absent, path: absent, space: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 10 | a file that extends itself is a chain | response: ConfigError | change, path, space | absent | `change: absent, path: absent, space: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 11 | a base that is itself invalid is named | response: ConfigError | change, path, space | absent | `change: absent, path: absent, space: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 12 | an overlay may not redeclare what it inherits | response: ConfigError | change, path, space | absent | `change: absent, path: absent, space: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 13 | a merged service that is eventual without a timeout is refused | response: ConfigError | change, path, space | absent | `change: absent, path: absent, space: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 14 | an overlay may not add a service or add or remove a command or an actor | response: ConfigError | path | absent | `path: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-RT-001 — `packages/feat-runtime/load-config.feat` (4)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | loads a valid config | response: FeatConfigResult | extends, report, response | absent + value | `see Appendix A8` | MG2 (d2cd2f0d): the merged fields are what these scenarios exist to check; a stray inherited key is the defect class |
| 2 | missing file | response: ConfigError | detail | absent | `detail: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 3 | eventual service without convergence timeout | response: ConfigError | path | absent | `path: absent` | never returned in this scenario; stating it absent makes the prediction whole |
| 4 | schema-invalid configs are rejected | response: ConfigError | path | absent | `path: absent` | never returned in this scenario; stating it absent makes the prediction whole |

## SPEC-PAY-001 — `corpus/capture-charge/capture-charge.feat` (4)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | successful charge capture | database INSERT: ReceiptRow | id | value | `id: any string` | exemplar not executed; the row id is minted by the store |
| 2 | rejects a non-positive amount | response: ErrorResponse | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |
| 3 | the receipt records the charge id the instrument assigned | payments charge.succeeded: Charge | livemode | value | `livemode: false` | exemplar not executed; the capture runs in test mode |
| 4 | the receipt records the charge id the instrument assigned | database INSERT: ReceiptRow | id | value | `id: any string` | exemplar not executed; the row id is minted by the store |

## SPEC-EMB-001 — `corpus/f32-digest/f32-digest.feat` (1)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | an entry with no text gets no vector | graph INSERT: NodeRecord | meta | absent | `meta: absent` | exemplar not executed; an entry with no text gets no vector anywhere, so no meta.embedding |

## SPEC-ORD-003 — `corpus/given-fault/given-fault.feat` (2)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a concurrent writer wins the append | response: Refusal | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |
| 2 | access denied holds for the whole case | response: Refusal | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |

## SPEC-WSP-001 — `corpus/given-order/given-order.feat` (1)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a workspace enabled and then disabled is refused | response: Refusal | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |

## SPEC-INV-001 — `corpus/given-ref/given-ref.feat` (3)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a second invite draws a different code | log InviteCreated: InviteEvent | codeHash | value | `codeHash: any string` | exemplar not executed; the id/hash is minted, and the exemplar asserts the other field |
| 2 | a seeded invite draws a known code | response: InviteReceipt | inviteId | value | `inviteId: any string` | exemplar not executed; the id/hash is minted, and the exemplar asserts the other field |
| 3 | a seeded invite draws a known code | log InviteCreated: InviteEvent | inviteId | value | `inviteId: any string` | exemplar not executed; the id/hash is minted, and the exemplar asserts the other field |

## SPEC-REJ-001 — `corpus/rejection-camelcase/rejection-camelcase.feat` (3)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | a non-operator is refused | response: Refusal | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |
| 2 | a question that already holds an answer is refused | response: Refusal | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |
| 3 | an unknown question is refused with an UPPER_SNAKE id | response: Refusal | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |

## SPEC-WL-001 — `corpus/waitlist-variables/waitlist-variables.feat` (1)

| # | Scenario | Block | Omitted | Proposed | Statement | Reason |
|---|---|---|---|---|---|---|
| 1 | an implausible email is rejected | response: ErrorResponse | message | value | `message: any string` | exemplar not executed; a refusal always carries a human message, and its wording is not the exemplar's point |


## Appendix: MG2 — the merged values SPEC-RT-004 / SPEC-RT-001 blocks state (observed in the run)

### A1. SPEC-RT-004 — an overlay replaces a service whole and keeps nothing of the base's options

```
featVersion: "1.0"
report: {"format":["console","junit"],"junitOutput":".feature/reports/integration-junit.xml"}
response: {"adapter":"@mmmnt/feat-adapter-http","invoke":{"baseUrl":"https://orders.integration.example"},"commands":{"Ping":{"method":"GET","path":"/ping"},"Pong":{"method":"GET","path":"/pong"}},"actors":{"default":"operator","operator":{"headers":{"authorization":"Bearer o"}},"auditor":{"headers":{"authorization":"Bearer a"}}}}
```

### A2. SPEC-RT-004 — a service the overlay does not mention is the base's

```
environment: "integration"
extends: "base.config.json"
featVersion: "1.0"
report: {"format":["console","junit"],"junitOutput":".feature/reports/integration-junit.xml"}
response: {"adapter":"@mmmnt/feat-adapter-http","invoke":{"baseUrl":"https://orders.integration.example"},"commands":{"Ping":{"method":"GET","path":"/ping"},"Pong":{"method":"GET","path":"/pong"}},"actors":{"default":"operator","operator":{"headers":{"authorization":"Bearer o"}},"auditor":{"headers":{"authorization":"Bearer a"}}}}
```

### A3. SPEC-RT-004 — featVersion and schemas are inherited

```
environment: "integration"
extends: "base.config.json"
report: {"format":["console","junit"],"junitOutput":".feature/reports/integration-junit.xml"}
response: {"adapter":"@mmmnt/feat-adapter-http","invoke":{"baseUrl":"https://orders.integration.example"},"commands":{"Ping":{"method":"GET","path":"/ping"},"Pong":{"method":"GET","path":"/pong"}},"actors":{"default":"operator","operator":{"headers":{"authorization":"Bearer o"}},"auditor":{"headers":{"authorization":"Bearer a"}}}}
```

### A4. SPEC-RT-004 — the response block is replaced whole

```
environment: "integration"
extends: "base.config.json"
featVersion: "1.0"
report: {"format":["console","junit"],"junitOutput":".feature/reports/integration-junit.xml"}
```

### A5. SPEC-RT-004 — specs and report are replaced whole

```
environment: "integration"
extends: "base.config.json"
featVersion: "1.0"
response: {"adapter":"@mmmnt/feat-adapter-http","invoke":{"baseUrl":"https://orders.integration.example"},"commands":{"Ping":{"method":"GET","path":"/ping"},"Pong":{"method":"GET","path":"/pong"}},"actors":{"default":"operator","operator":{"headers":{"authorization":"Bearer o"}},"auditor":{"headers":{"authorization":"Bearer a"}}}}
```

### A6. SPEC-RT-004 — an overlay without an environment has none, not the base's

```
featVersion: "1.0"
report: {"format":["console"]}
response: {"adapter":"@mmmnt/feat-adapter-handler","commands":{"Ping":{"module":"src/ping.ts","export":"ping"},"Pong":{"module":"src/pong.ts","export":"pong"}},"actors":{"default":"operator","operator":{"context":{"role":"operator"}},"auditor":{"context":{"role":"auditor"}}}}
```

### A7. SPEC-RT-004 — an overlay file alone need not carry schemas, services or specs

```
extends: "base.config.json"
featVersion: "1.0"
report: {"format":["console"]}
response: {"adapter":"@mmmnt/feat-adapter-handler","commands":{"Ping":{"module":"src/ping.ts","export":"ping"},"Pong":{"module":"src/pong.ts","export":"pong"}},"actors":{"default":"operator","operator":{"context":{"role":"operator"}},"auditor":{"context":{"role":"auditor"}}}}
```

### A8. SPEC-RT-001 — loads a valid config

```
extends: absent
report: {"format":["console"]}
response: {"adapter":"@mmmnt/feat-adapter-handler","commands":{"Ping":{"module":"src/ping.ts","export":"ping"}}}
```


## MG6 — re-check every `absent` on CI's Linux runners (plan, founder ruling d2cd2f0d)

1. A throwaway Feature branch, `scratch/adr-0038-mg6-observed-fields`, from origin/main: the matcher logs each compared
   block's actual value when `FEAT_OPTSWEEP_LOG` names a file, and CI's spec-chain job (Node 22, 24, 26, ubuntu-latest)
   sets it and uploads `optsweep-node<n>` as an artifact. A draft PR, marked do-not-merge, triggers it; it is closed
   and the branch deleted once the artifacts are downloaded.
2. The artifacts are joined with this table's blocks, recomputed against the same main commit. A field proposed
   `absent` that Linux returned in any row is corrected (to its value if constant and short, else `partial`); a
   proposed value that differs on Linux is corrected the same way; blocks new since this table was written are added.
3. The corrections are listed here before the founder is asked to agree the set.
