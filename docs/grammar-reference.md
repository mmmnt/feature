# The `.feat` Language — Grammar Reference v1.3

> Language version: `feat 1.0`
> Design decisions are recorded as ADRs (ADR-0001…0039; 0022 onward are in docs/adr/) in the project decision log.
> The `corpus/` directory holds canonical exemplars paired with expected-IR fixtures —
> when this document and the corpus disagree, that is a bug in one of them; fix the spec first.

A `.feat` file is an **execution specification**: it instructs an AI agent how to build a feature
(agent zone), predicts every observable effect the feature will produce (compiler zone), and
compiles to a complete test suite with zero human-authored test code.

---

## 1. File structure

```
feat 1.0                        ← version pragma (required, first non-comment line)

spec <ID> "<name>"              ← header (required)
context <Name>
aggregate <Name>
type <spec-type>
status <lifecycle>              ← draft | agreed | built | verified (ADR-0008)
observes <service>, ...         ← optional (ADR-0033): the services this spec observes; absent = all configured

construct:                      ← agent zone (required, ≥1 directive; `feat audit` requires ≥1 touches)
  ...

enforce:                        ← agent zone (required, ≥1 directive)
  ...

contract:                       ← compiler zone (required, ≥1 reference)
  ...

scenario "<name>":              ← compiler zone (required, ≥1 scenario)
  given: ...                    ← optional
  when: ...                     ← required
  predict <type>:               ← required
    ...
```

### 1.1 Version pragma (ADR-0005)

`feat <major>.<minor>` — first non-comment, non-blank line of every file. Names the **language
grammar version**. Missing pragma → parse error. Unsupported version → "this toolchain supports
feat 1.x". Minor versions are strictly additive; majors may break.

### 1.2 Lexical rules

- **Directive- and keyword-driven, not indentation-sensitive**: the parser does not read
  indentation. A section opener (`construct:`, `enforce:`, `contract:`, `variables:`,
  `scenario "…":`) starts a section that runs to the next opener, and inside a scenario `given:`,
  `when:` / `deliver`, `predict …:` and `examples:` decide what the following lines are. The indentation
  in this reference is conventional: it is how specs are written, but a spec
  with none parses to the same IR. A line whose `{` or `[` is not closed continues on the next lines
  until it is. Spaces only: a tab in leading whitespace is a parse error (`MALFORMED_SYNTAX`).
- **Comments**: whole-line only. A line whose first non-blank character is `#` is skipped, outside a
  multi-line `{ … }` / `[ … ]` value (inside one it is part of the value, and a parse error). A `#`
  after content on the same line is not a comment:
  - on a compiler-zone line (a `when:` or `predict` line, a `has` line, a `contract:` entry, a header
    directive, a `scenario` opener) it is `MALFORMED_SYNTAX`, and on the pragma line `MISSING_PRAGMA`;
  - in an agent zone it is part of the line's text: `mint an invite  # note` is captured verbatim, and a
    `touches` or `handler at` line that carries one is no longer recognized and becomes a freeform
    directive;
  - on a `given:` line it turns an `execute`, `seed` or `clock at` line into freeform context;
  - after a `response` line's closing `}` it is dropped without an error.

  Write comments on their own line.
- **Rejection ids** (ADR-0022): the `<ID>` of `rejects <ID> when …` and `predict rejection <ID>:`
  is one token, either **UPPER_SNAKE** (`[A-Z0-9_]+`, e.g. `UNIQUE_NAME`) or **UpperCamel**
  (`[A-Z][A-Za-z0-9]*`, e.g. `NotOperator`). The two forms are both valid and may be mixed in one
  spec. An id is kept verbatim and compared **case-sensitively and exactly**: `NotOperator` and
  `NOT_OPERATOR` are two different ids. Anything else in the id position of a `predict rejection`
  line (`notOperator`, `Not_Operator`, `not-operator`) is a `MALFORMED_SYNTAX` parse error whose
  hint names both valid forms. A `rejects` line whose id is not valid is, as before, an opaque
  enforce-zone constraint; the two-way lint (B2) then reports the predicted id with no `rejects`.
- **Minimum**: the parser refuses a file as `MISSING_MINIMUM` unless it has a complete header
  (`spec`, `context`, `aggregate`, `type`, `status`), at least one construct directive, one enforce
  directive, one contract entry and one scenario. Every scenario also needs a trigger (`when:` or
  `deliver`; without one it is `MALFORMED_SYNTAX`, "has no trigger") and a prediction: a scenario
  without a `predict` is not a valid spec, though `MISSING_MINIMUM` does not cover it and the parser
  reports it with no error code today.
- **Strings**: a string in a payload, seed record or value block is `"…"`. A backslash escapes the next character, and the valid escapes are
  JSON's single-character ones: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`. Any other escape, including
  `\uXXXX`, is refused with a raw `SyntaxError` from the parser rather than a coded parse error.

### 1.3 The two zones (DP-5, non-negotiable)

| Zone | Sections | Parser behavior |
| --- | --- | --- |
| **Agent** | `construct:`, `enforce:` | Freeform natural language. Keyword-matching lines produce typed IR nodes; every other line is captured verbatim as an opaque directive. Header directives are still read here, as on any line of the file: a line of exactly the form `spec <ID> "<name>"`, `context <Name>`, `aggregate <Name>`, `type <type>` or `status <status>` (one token after the keyword) sets that header field, overwriting the header's value (`context Other` replaces the header context), and an unknown `type` or `status` (`status shipped`) is `MALFORMED_SYNTAX`. A line that merely starts with the word (`context matters here`) stays a directive. Section openers (`construct:`, `enforce:`, `contract:`, `variables:`, `scenario "…":`) end the zone. |
| **Compiler** | `contract:`, `scenario`, `predict` | Strict typed grammar. Malformation is a parse error, never a silent failure. |

### 1.4 Token classes (ADR-0007 — normative)

Consumers are not expected to study this language before using it; every example and table in
this reference marks what is grammar and what is prose, and editor highlighting (M6) realizes
the same distinction in files. Four token classes:

| Class | Meaning | In this document |
| --- | --- | --- |
| **KEYWORD** | Reserved word with fixed grammar (`predict`, `has`, `any`, `matching`, `seed`) | **bold** in prose; first column of grammar tables |
| **IDENT** | User-defined name validated against a **stated closed space** (service keys → `feat.config.json`; schema names → the `contract:` block; spec types → the fixed list) | *italic*, with its validating space named |
| **LITERAL** | JSON literal position (strings, numbers, booleans, null, inline payloads) | plain monospace |
| **FREEFORM** | Opaque natural language (agent zones; `given:` context lines) | zones explicitly labeled FREEFORM |

Rule of thumb: **inside compiler-zone blocks, every bare word is a KEYWORD or a validated
IDENT — nothing is prose.** `flowId: any uuid` is three tokens: IDENT (field), KEYWORD (`any`),
KEYWORD-qualifier (`uuid`); `flowId: any zebra` is a parse error, not a comment.

---

## 2. Header

| Keyword | Form | Notes |
| --- | --- | --- |
| `spec` | `spec SPEC-AUT-001 "CreateFlow Command Handler"` | ID + display name |
| `context` | `context Automation` | Bounded context |
| `aggregate` | `aggregate Flow` | Aggregate / entity |
| `type` | `type command` | One of: `command`, `query`, `policy`, `projection`, `saga`, `infrastructure`, `integration`, `scaffold` |
| `status` | `status agreed` | Lifecycle (ADR-0008): `draft` → `agreed` → `built` → `verified`. The agent refuses to build a spec that is not `agreed`; the agent may *propose* the draft→agreed flip, the human can revert. Nothing in the toolchain writes a status: `built` and `verified` are set by hand, by convention. |
| `observes` | `observes log, cache` | Optional, at most once (ADR-0033). The services this spec observes, each a key of the config's `services` (closed space: an unknown key is `UNKNOWN_SERVICE_KEY`). Absent = every configured service, as before. A key written twice, a bare `observes`, an empty item or a second line is `MALFORMED_SYNTAX`. Recorded in the IR as top-level `observes`, in written order. |

---

## 3. Agent zone

### 3.1 `construct:` — structural instructions

Recognized line keywords (produce typed IR nodes):

| Keyword | Example |
| --- | --- |
| `handler at <path>` | `handler at features/create-flow/handler.ts` |
| `imports <X> from <path>` | `imports FlowAggregate from core/domain/flow-aggregate` |
| `register <kind> <name> in <path>` | `register mutation createFlow in resolvers/mutations.ts` |
| `emit to <stream-pattern>` | `emit to automation-flow-{flowId}` |
| `touches <glob>` | `touches features/create-flow/**` — **change boundary** (ADR-0008): the build may create/modify ONLY paths matching a `touches` glob; the `handler at` path must fall inside one. Repeatable. The parser does not require it; `feat audit` does (B3: an error on any spec without one, drafts included) — the build-time mirror of prediction inversion. |
| `needs <SPEC-ID>` | `needs SPEC-USR-001` — **cross-spec dependency** (ADR-0012): explicit build-order DAG; the agent builds in topological order (no tool checks the graph for cycles). Repeatable. |

Any other line is a **freeform directive**, captured verbatim:

```
construct:
  handler at features/create-flow/handler.ts
  Lambda cannot write directly to Kurrent.
  Redis cache has TTL of 60 min, minimum.
```

### 3.2 `enforce:` — behavioral instructions

Freeform, with **one structured keyword** (ADR-0008):

| Keyword | Form | Purpose |
| --- | --- | --- |
| `rejects` | `rejects UNIQUE_NAME when a flow with this name exists for the tenant` · `rejects NotOperator when the caller is not an operator` | Justifies a business-rule rejection. `<ID>` is typed (KEYWORD position; UPPER_SNAKE or UpperCamel, §1.2; validated two-way, case-sensitively, against scenario rejection IDs); the reason is FREEFORM. |

**Two-way lint**: every `predict rejection <ID>` must have a matching `rejects <ID>` line, and
every `rejects <ID>` must be predicted by at least one scenario. Predictions and build
instructions corroborate mechanically. (`predict error <CODE>` is exempt — system failures,
not business rules.)

Conventional shapes (`validate input against X`, `on success emit Y`) are recognized for IR
categorization but carry no compiler semantics; all other lines are constraints, captured verbatim.

---

## 4. `contract:` — the spec's declared interface (ADR-0007)

**Closed reference space — type safety in the spec.** Every schema name referenced anywhere in
this file's scenarios (response schemas, `with` on predicted records, `with` on seeds, and schema
names inside referenced fixtures) MUST be declared here. An undeclared name is a parse-time error
listing the declared names — exactly like unknown service keys (INV-7). A declared-but-unused
schema is a `feat lint` warning.

Micro-grammar: `KEYWORD IDENT:schemaName [ "from" STRING:path ]` — `from` is **optional**:
absent means the name resolves in the paired `.contract.json` registry; present names an external
file the registry `$ref`s.

| Keyword | Form | Purpose |
| --- | --- | --- |
| `input` | `input CreateFlowInput` | Input schema |
| `response` | `response FlowCreatedResponse` | Response body shape |
| `event` | `event FlowCreatedEvent from "core/contracts/events"` | Emitted event schema |
| `record` | `record UserRow` | Service-record shape that is not an event (DB rows, seeded shapes) |
| `error` | `error RFC7807 from "contracts/adrs/error-format"` | Error format |
| `stream` | `stream "automation-flow-{flowId}"` | Stream name pattern |

Roles are declared only when used (a spec that emits nothing declares no `event`); the minimum
remains ≥1 contract entry. References resolve **at compile time** through the configured schema
adapter, against the spec's paired `.contract.json` (same basename). `.contract.json` is a schema
registry:

```json
{
  "$schema": "https://feat.dev/schemas/contract.json",
  "specId": "SPEC-AUT-001",
  "schemas": {
    "FlowCreatedEvent": { "type": "object", "required": ["flowId"], "properties": { } },
    "RFC7807": { "$ref": "../../contracts/adrs/error-format.json" }
  }
}
```

`.feat` owns behavior; `.contract.json` owns shapes. Resolved schemas are **inlined** into
generated test files (ADR-0001) — nothing resolves at run time.

---

## 5. Scenarios

```
scenario "rejects duplicate flow name":
  given:
    A flow already exists for this tenant.                          # freeform context
    seed projectionStore [ TenantRecord with TenantSchema { id: "tenant-1", plan: "pro" } ]
    execute CreateFlow { name: "Welcome", tenantId: "tenant-1" }
  when: CreateFlow { name: "Welcome", tenantId: "tenant-1" }
  predict rejection UNIQUE_NAME:
    response 409 RFC7807
    eventStore has []
    projectionStore has []
```

**Anchors (ADR-0010):** scenario names are unique within a spec (lint ERROR) and serve as
failure anchors — every ValidationReport assertion result carries
`<specId> › "<scenario name>" › <surface>` (`response`, `<service>[index]`,
`given › execute[i]`, `given › seed[i]`), so failures map to exact spec coordinates. The IR carries no
`loc` (line/column); a parse error carries its line.

### 5.1 `given:` — the hybrid zone

Six line kinds, freely mixed. The `seed` and `execute` lines run in the order they are written
(ADR-0025), so a given states history in sequence: `execute EnableX { … }` then `seed s [ XDisabled … ]`
leaves the seeded event as the latest. A given with both kinds records their written order in the IR as
`given.order`, an array of `"seed"` and `"execute"` (the n-th of a kind names `seeds[n]` or
`executes[n]`); a given with one kind has no `order`. Faults are armed after every seed and execute.

| Kind | Form | Semantics |
| --- | --- | --- |
| Freeform | any unmatched line | Human/agent context; opaque |
| `execute` | `execute [(as <actor>)] <Command> { <json> }` | Runs the command through the **response adapter** before the capture window opens (INV-9) |
| `seed` (ADR-0003) | `seed <service> [ <records> ]` or `seed <service> from "<path.json>"` | Injects state directly through the service adapter's `seed()`; fixture form for bulk state |
| `fault` (ADR-0023) | `fault <service> <Operation> <Fault> [{ <json> }] [once \| times <n> \| until reset]` | Declares a **logical fault** the product will return, as a precondition armed after the seeds and the `given` executes and before the capture window, in written order. Consumed by the system's next call of `<Operation>` on `<service>` (`once`, the default), the next `<n>` calls (`times <n>`, `n` ≥ 1), or every call until the case ends (`until reset`). `<service>` is a configured service key (INV-7). `<Operation>` is UpperCamel; `<Fault>` is UpperCamel or UPPER_SNAKE (§1.2); both are the **adapter's vocabulary**, not the language's. The optional `{ … }` is literal data for the adapter (no matchers, no `@when`). The IR is `given.faults[]` = `{ service, operation, fault, detail?, times }`, `times` always present (`1`, `n`, or `"reset"`). |
| `clock at` (ADR-0012, ADR-0023) | `clock at "2026-07-16T00:00:00Z"` | Freezes scenario time: an ISO-8601 instant **with a zone designator**. The harness delivers it on every case (a `null` when the case has no `clock at`), after the resets and before anything runs, to every adapter that offers the optional `setClock(clock)` hook. The **response adapter** must offer the hook, or a case that uses `clock at` is a configuration error (`CLOCK_UNSUPPORTED`) before any effect — never a silent pass. The handler and stdio-jsonrpc response adapters offer it; other remote protocols need their own test-time hooks. `now()`/`iso()` in `variables:` honour the clock regardless. |
| `random seed` (ADR-0029) | `random seed <n>` | Seeds the system's random source for the case: `<n>` is a whole number from 0 to 2^53 − 1, recorded as `given.random`; any other line that begins `random seed` is `MALFORMED_SYNTAX`. The harness delivers it after the clock to the **response adapter's** optional `setSeed(seed)`, and `setSeed(null)` on the first case after a seeded one, so a seed never reaches the next case; a case that neither seeds nor follows a seeded case sends nothing. A response adapter without the hook is a configuration error (`RANDOM_UNSUPPORTED`) before any effect. The stdio-jsonrpc response adapter offers it (the host protocol's `setSeed` request). What a seed means is the host's: the same seed yields the same draws in the same order within the case. Corpus exemplar: `corpus/given-ref/`. |

Seed records take **full literal values only** — no matchers, no `@when` (seeds are writes, and
`given` precedes `when`). Optional `with <Schema>` validates seed data at generate time.
Fixture JSON is data, not glue code — DP-3 stands; imperative seed scripts are forbidden.

**`fault` is reserved at the start of a `given` line.** A line that is exactly `fault`, or begins
`fault` followed by a space or tab, is a fault line: a well-formed one is recorded in
`given.faults`, any other is `MALFORMED_SYNTAX` (hint: the form above) — it is never freeform
context, so a mistyped precondition cannot silently become a comment. A word that merely begins
with those letters (`faults`, `faultline`) is not reserved. A fault on an unconfigured service is
`UNKNOWN_SERVICE_KEY`. A fault is a precondition, never an assertion: the scenario predicts what the
system does about it with the existing `predict` forms: a `predict rejection` (zero effects on every
service, so a half-write the product accepted before the fault fails as an unpredicted effect), a
`predict error`, or a `predict success` when a retry recovers. The harness (SPEC-RT-003, ADR-0023)
arms the faults after the seeds and the `given` executes and before the capture window, in written
order, and consumes them as the count says. A fault armed and **not consumed** (fewer firings than
the count) fails the case with `FAULT_NOT_CONSUMED`, unless the adapter cannot observe consumption.
An adapter declares a catalog of the faults it can produce and the counts each accepts (`once`,
`times`, `reset`; an array of fault names declares all three); a fault outside it, or armed with an
undeclared count, or against an adapter with no `fault()`, is `FAULT_UNSUPPORTED` before the case has
any effect. An adapter's own capture, `read()` and `seed()` are never faulted. A fault named in
`EXCLUSIVE_FAULTS` (`BrokerLoss`: it pauses a container every spec file shares) runs only in a
serial pass: `feat run` sweeps the IR for the files that arm one (a `given` fault, or an exclusive
`<Operation>.<Fault>` named in a string of a `when` input, as a probe's script does), runs them after the parallel pass
with one worker and `FEAT_SERIAL=1`, and the harness refuses one elsewhere (`FAULT_REQUIRES_SERIAL`).
At generate time (SPEC-GEN-001) every seed record is checked: a `seed ... from "<path>"` fixture is
resolved against the directory of the spec, must be a JSON array of `{ type, schemaName?, values }`
records, and each record's `schemaName` must be declared in `contract:` (ADR-0007) with `values` valid
against that schema; inline `with <Schema>` values get the same values check. A record without
`schemaName` is shape-checked only. Violations are generate errors (not parse errors), all reported
together with the fixture path (or `given › seed[i]`) and record index (0-based), under the codes
`SEED_FIXTURE_NOT_FOUND`, `SEED_FIXTURE_NOT_JSON`, `SEED_FIXTURE_NOT_RECORDS`,
`SEED_FIXTURE_SCHEMA_UNDECLARED`, `SEED_FIXTURE_VALUES_INVALID` and `SEED_VALUES_INVALID` (inline).
In a scenario outline each example row's whole-value `<placeholder>`s are substituted into that row's own
inline seed records (SPEC-DRV-001; `"Item-<n>"` inside a string stays literal, a fixture seed is never
substituted) and each row is checked on its own: a failing record is `SEED_ROW_VALUES_INVALID`, anchored
`given › seed[i] record j › row[n]` (n 1-based), in place of `SEED_VALUES_INVALID`; a fixture is checked once.

### 5.1b Spec variables — `variables:` (ADR-0017)

The **only expressions in the language**, confined to one block; scenario
literals get `${name}` interpolation and nothing else, so scenarios stay pure
data (DP-3).

```
variables:
  stamp: number = now()
  email: string = "test+${stamp}@example.com"
```

| Element | Rule |
|---|---|
| Entry | `NAME: TYPE = DEFINITION` — types: `string`, `number` |
| Definition | a **source call**, a number literal, or a string **template** interpolating declared variables (`${ref}`) |
| Sources | `now(): number` — epoch milliseconds **of the scenario clock** (honors `clock at`, ADR-0012); `iso(): string` — the same instant as an ISO-8601 string; `unique(): string` — collision-resistant token. `now` and `iso` accept an optional whole-millisecond offset — `iso(259200000)` is three days out, `iso(-3600000)` an hour ago — so a fixture can be **relative to the clock instead of an absolute date that silently expires**. `unique()` takes no offset. Sources are the sole nondeterminism entry. **The library grows by ADR only.** |
| Resolution | **once per case, at execution start** — every reference in that case's `given`/`when`/predictions shares the value; a different case resolves fresh (case independence) |
| Closed spaces | unknown function → parse error listing the reserved library; undeclared `${ref}` (definitions or scenarios) → `UNKNOWN_VARIABLE` listing declared; definition cycles → parse error; declared type must match the definition's produced type |
| Evidence | spec text (with expressions) stays byte-locked and hashed; matching is exact **post-resolution** |

Deliberately excluded: user-defined functions, `env()` in specs (environment
references are config's law — `tableEnv`/`endpointEnv`/`baseUrlEnv`),
cross-case shared variables, transform functions (composition is
definition-side interpolation). Corpus exemplar: `corpus/waitlist-variables/`.

`feat generate` substitutes the declared variables into every seed record's values (inline and fixture, SPEC-GEN-001)
before validating them, as the harness does at run time: `${name}` inside a string, whole or embedded, becomes the
variable's text (a number variable becomes its decimal string), at any depth; in an outline the row's values go in first.
Only a variable whose value is static at generate time is substituted: a number, a template of static variables,
`now()`/`iso()` under `clock at`. A string that still holds a reference to `unique()` or to an unfrozen `now()`/`iso()` is
skipped for that field alone, and the report lists it in `skipped`.

### 5.2 The trigger — `when:` or `deliver` (ADR-0011)

The spec `type` declares its trigger discipline (parse error on mismatch):

| Spec types | Trigger | Form |
| --- | --- | --- |
| `command`, `query` | `when:` | `when [(as <actor>)]: <Command> { <json> }` — one per scenario; a second `when:` replaces the first (the last one wins); command ∈ `response.commands`; actor ∈ `response.actors` or reserved `anonymous`, omitted = `actors.default` (ADR-0012) |
| `projection`, `policy`, `saga` | `deliver` | `deliver <EventType> { <json> }` `to <service>` or `to response` (ADR-0036: the response role's invoke host; `response` is reserved, never a service key) — one or more, in order; saga sequences chain multiple lines |

Delivered stimuli are **excluded from capture** — they are the input, not the output — so
`eventStore has []` on a projection asserts "the projection emitted nothing new."
A deliver-triggered scenario's `response` surface is the answer to its delivery `to response` (ADR-0036, ADR-0037):
when the response adapter's `deliver()` answers, the last delivery to `response` that answered is the case's captured
response, compared exactly as a `when:` answer. A `response` predicted when no delivery to `response` answered fails
(`response: no response captured`).

### 5.3 `predict` — the measurement contract

Three types, fixed grammar:

| Form | Assertion behavior |
| --- | --- |
| `predict success:` | Positive response + expected effects per service |
| `predict rejection <ID>:` | Error response + **zero effects across ALL configured services**, including the services the spec does not observe: derive asserts `has []` on each of them (ADR-0033). `<ID>` is UPPER_SNAKE or UpperCamel (§1.2). |
| `predict error <CODE>:` | Error response + zero or compensating effects |

Prediction lines:

| Form | Meaning |
| --- | --- |
| `response <status> <Schema> [{ <value block> }]` | Response surface: status + body schema (+ optional value assertions) |
| `<service> has [ <record>, ... ]` | Exactly these records **captured** (writes during the window). One per service: a second `has` for the same service replaces the earlier one (the last one wins). |
| `<service> has []` | Zero records captured (explicit absence assertion) |
| `<service> has ordered [...]` / `has unordered [...]` | Ordering override (ADR-0004) |
| `<service> contains [ <record>, ... ]` | **Resulting state** via adapter `read()` (ADR-0011) — polled to convergence for eventual services; may appear alongside `has` for the same service |

**Completeness (INV-6)**: every service the spec observes must appear in every prediction: every configured service
when the spec has no `observes` line, the declared ones when it has (ADR-0033). `has []` is the explicit "nothing
happens here". Omission is a validation error (`INCOMPLETE_PREDICTION`). A scenario that names a configured service
the spec does not observe (in a `has` or `contains`, a `seed`, a `deliver ... to`, a `fault`, or an `@<service>[i]`
reference) is `UNOBSERVED_SERVICE`.
**Query guarantee (ADR-0011)**: for `type query`, service predictions are implicitly `has []`
everywhere and writing any `has [X]` is a **parse error** — side-effect freedom is unviolable
by construction. This holds for every configured service, observed or not. Queries predict `response`
(+ optional `contains`, on an observed service).
**Observation modes (ADR-0023)**: `has` is the *diff* mode and `contains` the *state* mode. Diff is
not optional: INV-6 puts a `has` on every service of every prediction, so every adapter serves it,
natively or by comparing snapshots. State is the mode an adapter may lack. An adapter declares what
it serves (`observes: { diff: "native" | "snapshot", state }`; none declared means both); a `contains`
on a service whose adapter does not serve state is a configuration error (`MODE_UNSUPPORTED`) before
the case has any effect. For a `contains` the harness hands `read()` a hint
(`{ expect: [{ type, key? }] }`: each predicted record's type and its literal top-level fields) that
an adapter may use to narrow its read; it may answer more than asked, never less.

**Closed key space (INV-7)**: a service key not present in `feat.config.json` is a parse-time
error listing the configured keys.

### 5.4 Records and value blocks (ADR-0002)

```
eventStore has [ FlowCreated with FlowCreatedEvent {
  name: "Welcome"
  tenantId: @when.tenantId
  flowId: any uuid
  createdAt: any timestamp
  metadata: { source: "api", trace: matching "^tr-[0-9a-f]+$" }
  deletedAt: absent
} ]
```

Object-literal **keys** — in `when:`/`execute` payloads, seed records, and value blocks alike
— are a bare identifier (`[A-Za-z_$][A-Za-z0-9_$-]*`) **or a quoted string** (ADR-0019):
adapter and identity-provider vocabularies are colon-namespaced (`"cognito:username"`,
`"custom:displayName"`, OIDC claims), and the language honors its ecosystem's documented
forms. `corpus/userinfo-profile` is the exemplar.

A record is `<Type> with <Schema>` plus an optional **value block**. Three assertion layers:
type match → schema validation → value-block matchers. A record's or response's **top-level** value block is
**partial**: it asserts its listed fields only; shape completeness is the schema's job. A **nested** block (`{ … }` in a
field position) is **exact** (ADR-0039): a key of its object that it does not declare is a violation
(`a › payload: UNPREDICTED field 'workspace' = "6f96…"`), at any depth, in `has`, `contains` and responses alike, and
inside a `partial` block too. To leave a sub-object unchecked, write the field `any`. `feat lint` warns
`NESTED_SCHEMA_OPEN` on a nested block whose schema lets its object carry undeclared keys, since only the block then
states them.

**Every optional property is stated, or the block says `partial`** (ADR-0038). `feat lint` refuses, as the error
`OPTIONAL_UNSTATED`, a predicted record or response block that leaves out an optional property of its schema
(following `allOf` and local `$ref`s): state it — `absent`, `any …`, or its value — or mark the block partial on
purpose by writing `partial` where `equals fixture` would sit: `REMOVE with NodeRecord partial { id: "e1" }`,
`response 200 Probe partial { ok: true }`. The IR records `"partial": true`; the runtime's comparison is unchanged.
Refused as `MALFORMED_SYNTAX`: `partial` in a payload or a seed (data is written whole), as a field's value or a list
item (an object in a list is exact), beside `equals fixture` (a golden is whole), and with no value block after it.

The record **type** accepts dotted identifiers (ADR-0015): adapters own the type vocabulary
of what they capture, and event instruments name types with dots — `charge.succeeded with
Charge`, `checkout.session.completed with CheckoutSession`. Applies wherever a record head
appears (`has` / `contains` lists and `seed` records); the schema-name position stays a plain
IDENT validated against the `contract:` block.

Micro-grammar (every bare word below is KEYWORD or validated IDENT — never prose):

```
record      := DOTTED-IDENT:type "with" IDENT:schemaName [ [ "partial" ] valueBlock ]  # schemaName ∈ contract: block; ADR-0038
DOTTED-IDENT := IDENT { "." IDENT }                                  # ADR-0015: adapters own the type vocabulary
valueBlock  := "{" { IDENT:field ":" matcher } "}"
matcher     := LITERAL | "@when." PATH | "@deliver" [ "[" INT "]" ] "." PATH
             | "@given" [ "[" INT "]" ] ".response." PATH           # ADR-0028: the given's response
             | "@" IDENT:serviceKey [ "[" INT "]" ] "." PATH        # ADR-0021: cross-surface
             | "any" [ "uuid"|"timestamp"|"string"|"number"|"boolean" ]
             | "matching" STRING | "absent" | valueBlock
             | "not" operand                                         # ADR-0027: negation
             | "f32" INT "sha256" STRING                             # ADR-0030: f32 digest
             | list                                                  # ADR-0034: a list (literal or holding matchers)
list        := "[" { part } "]"                                       # ADR-0034
part        := list | "{" { IDENT:field ":" part } "}" | matcher     # an object in a list is exact; never "absent"
operand     := LITERAL | "@when." PATH | "@deliver" [ "[" INT "]" ] "." PATH
             | "@given" [ "[" INT "]" ] ".response." PATH
             | "@" IDENT:serviceKey [ "[" INT "]" ] "." PATH
             | "any" ( "uuid"|"timestamp"|"string"|"number"|"boolean" )
             | "matching" STRING | PLACEHOLDER | "matching" PLACEHOLDER
```

**Matcher vocabulary:**

| Matcher | Meaning |
| --- | --- |
| `"str"`, `42`, `true`, `null` | Strict equality |
| `@when.<path>` | Equals the value sent in the `when:` payload |
| `@given.response.<path>` / `@given[i].response.<path>` | **The given's response** (ADR-0028): a matcher in any value block of a prediction (`response`, records) and an operand of `not`, as well as an input-side reference in `execute`, `when:` and `deliver` payloads. `@given.response` reads the response body of the most recent preceding `execute`; `@given[i].response` the i-th `execute` of the `given`, 0-based, in written order (ADR-0025). So a scenario can name an id the system minted during setup (`inviteId: @given.response.inviteId`) or predict a fresh draw (`code: not @given.response.code`). A reference that cannot resolve (no `execute`, an index out of range, a path absent on that body) fails the case: a violation, never a pass; only the body is addressable, not the status. IR: `{ "matcher": "givenRef", "index"?: <int>, "path": "<path>" }`. Corpus exemplar: `corpus/given-ref/`. |
| `@deliver.<path>` / `@deliver[i].<path>` | Equals the value in the delivered stimulus (index required for saga sequences) |
| `@<service>[i].<path>` | **Cross-surface capture reference** (ADR-0021): equals a value captured on another surface in the same scenario. `<service>` is a configured service key (INV-7); `[i]` selects the i-th record captured on it in **capture order**, defaulting to `0`. Use it when a value travels between surfaces and no literal can name it — a system-minted id written to one surface and recorded on another. A reference that cannot resolve (unknown index, absent field) is a **violation**, never a silent pass. |
| `any` | Present, any value |
| `any uuid` · `any timestamp` · `any string` · `any number` · `any boolean` | Present + format/type check |
| `matching "<regex>"` | String matches pattern |
| `absent` | Field must not exist |
| `not <matcher>` | **Negation** (ADR-0027): the field is present and `<matcher>` fails on its value — `cycleId: not @log[0].data.cycleId` (a redo's id differs from the first attempt's), `status: not "Failed"`, `ref: not matching "^tmp-"`, `id: not any uuid`. An absent field fails `not M` whatever `M` is. The operand is a literal, an `@when` / `@deliver` / `@given` / `@<service>[i]` reference, `any <type>`, `matching "<regex>"`, or an outline placeholder. A reference operand that cannot resolve (a service that captured nothing, an index out of range, a path absent on the referent) is a **violation**, as a plain reference is. Refused as `MALFORMED_SYNTAX`: `not not M` (write `M`), `not absent` (write `any`), `not any` without a type (it can never pass; write `absent`), `not { … }` (negate a field inside the block instead) and a bare `not`. A violation names the negated matcher and, for a reference, the value it resolved to: `expected not @log[0].data.cycleId (= "c-1"), got "c-1"`. IR: `{ "matcher": "not", "operand": <matcher> }`. Corpus exemplar: `corpus/not-matcher/`. |
| `f32 <dims> sha256 "<hex>"` | **f32 digest** (ADR-0030): the field is an array of exactly `<dims>` numbers, each exactly an IEEE-754 single (`Math.fround(x) === x`), and the sha256 of the values written as consecutive 4-byte little-endian f32s is `<hex>` (64 lowercase hex) — `embedding: f32 384 sha256 "9c1e…"` predicts a pinned encoder's vector exactly in one line. Each check is a violation, the first failing one reported: absent; not an array of numbers; wrong length (`expected 384 f32 values, got 512`); a value that is not an f32 (`value [17] = 0.1 is not an f32 (the nearest f32 is 0.10000000149011612)`); a differing digest (both shown in full). A malformed IR is a violation, never a pass. Refused as `MALFORMED_SYNTAX` with the form as hint: a length that is not a positive integer, a digest that is not 64 lowercase hex, a missing part, and `not f32 …` (a negated digest pins nothing). No outline placeholders. IR: `{ "matcher": "f32Digest", "dims": <int>, "sha256": "<hex>" }`. Corpus exemplar: `corpus/f32-digest/`. |
| `equals fixture "<path>"` | **Golden fixture** (ADR-0013): deep structural equality against a JSON fixture (key-order insensitive, array-order sensitive). Also valid directly on `response` and on records (`<Type> with <Schema> equals fixture "<path>"`, incl. `contains`) — there it is mutually exclusive with a value block. Fixture resolves relative to the spec, inlines at compile time, and must validate against the position's schema (type-safe goldens). No escape clause — dynamic fields belong in value blocks. |
| `{ ... }` | **Nested value block — exact** (ADR-0039): each declared field passes its matcher and every other key of the object is a violation (`a › payload: UNPREDICTED field 'workspace' = "6f96…"`), inside a `partial` block too; `absent` is allowed in it; write the field `any` to leave a sub-object unchecked |
| `[ ... ]` holding a matcher | **List with matchers** (ADR-0034): a list's items, and the fields of an object inside it, may be matchers — `members: [ { name: "manifest.json", json: { formatVersion: 1 } }, { name: "manifest.sha256", text: any string } ]`. The list is exact: an array of the same length, each item passing its matcher in order; a wrong length or a value that is not a list is one violation (`expected a list of 2 item(s), got 3`) and no item is checked. An object inside the list is exact too: its keys are exactly the declared ones, an extra key is a violation (`a[1]: UNPREDICTED field 'size' = 120`); only a matcher's own field is loosened. Violations name the index and field (`members[1] › text: expected any string, got 42`). A list with no matcher in it is a literal, unchanged (placeholders in it stay literal data). Refused as `MALFORMED_SYNTAX`: `absent` as an item (write a shorter list), `absent` on a field of an object inside a list (leave the field out), and `not [ … ]` over a list that holds a matcher (negate a field inside an item). IR: `{ "matcher": "list", "items": [<matcher>] }`, an object holding a matcher `{ "matcher": "object", "fields": { … } }`, every matcher-free item or field a literal. Corpus exemplar: `corpus/list-matcher/`. |

Reserved words (`any`, `matching`, `absent`, `not`, `f32`, `sha256`, `ordered`, `unordered`, `partial`) are reserved **inside
compiler-zone blocks only** — agent zones remain fully freeform.

### 5.5 Ordering (ADR-0004)

Default by consistency model: `acid`/`strong` → **ordered**; `eventual` → **unordered**
(multiset). Override per prediction with `ordered`/`unordered` before the list.

### 5.6 Scenario outlines (ADR-0012)

```
scenario outline "unknown users are rejected":
  when (as admin): SuspendUser { email: <email> }
  predict rejection UNKNOWN_USER:
    response 404 ErrorResponse { code: <code> }
    database has []
  examples:
    | email                 | code           |
    | "missing@example.com" | "UNKNOWN_USER" |
```

`<placeholder>` tokens are valid in `when:`/`execute` payloads, in value blocks (as a field's whole
value, or as a whole element at any depth of a literal array or object: `roles: [<role>]`), and in the
**rejection-ID position** (`predict rejection <code>:` — every value the column supplies must be
a declared `rejects` ID; the two-way lint evaluates per expanded row; a row value is a rejection id in either form and is compared exactly). The `examples:` pipe table
supplies one row per derived test case (column headers = placeholder names; cells are JSON
literals). Anchors extend with `› row[i]`. Shared schemas across specs
need no outline-style syntax — the documented convention is a workspace `contracts/` directory
that per-spec `.contract.json` registries `$ref` into.

---

## 6. Configuration (`feat.config.json`)

```json
{
  "featVersion": "1.0",
  "environment": "staging",
  "schemas":  { "adapter": "@mmmnt/feat-schema-json" },
  "response": { "adapter": "@mmmnt/feat-adapter-handler",
                "commands": {
                  "CreateFlow": { "module": "features/create-flow/handler.ts", "export": "handle" }
                } },
  "services": {
    "eventStore": { "adapter": "@mmmnt/feat-adapter-kurrent",
                    "consistency": "eventual", "convergenceTimeout": 5000 }
  },
  "specs":    { "dir": "packages", "pattern": "**/*.feat",
                "contractPattern": "**/*.contract.json", "outputPattern": "{name}.test.ts" },
  "report":   { "format": ["console", "junit"], "junitOutput": "reports/feat-junit.xml" }
}
```

- Service keys defined here are the only valid prediction targets (INV-7).
- **Environment (ADR-0016)**: optional top-level `environment` names the environment this
  config verifies (`^[a-z][a-z0-9-]*$`). Per-environment config files are the intended
  pattern — adapters/baseUrls genuinely differ per environment, so the environment is a
  property of the config a run actually used, and `feat report --evidence` stamps it into
  the bundle. Deliberately **outside** the derivation-relevant slice: generated suites are
  environment-agnostic (committed once, run everywhere).
- **Tier overlay (ADR-0024)**: optional top-level `extends` names a base config (path relative to
  this file); one level only. The overlay replaces `environment`, `response`, `services.<key>`,
  `specs` and `report` **whole, key by key** (a replaced `services.eventStore` carries none of the
  base's options; a service the overlay does not mention is the base's); `featVersion` and
  `schemas` are inherited and may not be redeclared; `environment` is **not** inherited. The merged
  document is what is validated. The overlay may not add a service key, nor add or remove a command
  name or an actor name — `TIER_SPACE_MISMATCH`; a missing base is `EXTENDS_NOT_FOUND`, a base that
  itself extends is `EXTENDS_CHAIN`. The base is the spec tier (in-process, in-memory, `strong`); an
  overlay is the integration tier. Every command (`run`, `verify`, `audit`, `lint`, `fmt`, `report`,
  `generate`, `parse`) reads the merged config, so a drifting overlay is refused everywhere.
- **Namespace (SPEC-RT-006)**: the runner derives one namespace per spec file from the file's path
  alone — `"s"` + the first 12 hex characters of the SHA-256 of the path relative to the config
  directory (`/` separators, no leading `./`) — and hands it to every adapter
  (`createAdapter({ ...config, namespace })`), sets `FEAT_NAMESPACE` for the file and checks any
  adapter or spec host that reports one (`NAMESPACE_NOT_HONOURED`). Two files deriving one value stop
  the run (`NAMESPACE_COLLISION`); a `namespace` written in a config file's response config or a
  service's options is refused (`NAMESPACE_CONFIGURED`). Namespaces isolate data, not availability.
- **Selecting a tier**: `feat run --config <overlay>`; `feat run` hands the generated suites the
  active config as `FEAT_CONFIG`. `specs.exclude` (globs relative to `specs.dir`) removes spec files
  from a tier's run.
- **Generation is environment-agnostic**: a generated suite and its `Inputs-hash` depend only on
  the spec, its contract, `featVersion` and the three closed spaces (service keys, command names,
  actor names). Adapters, consistency, timeouts and options never enter the hash; the default
  `ordered`/`unordered` is resolved by the harness from the active config, and the per-test timeout
  envelope is computed by `feat run` from it (so a generated file run directly with `npx vitest`
  gets vitest's default timeout).
- **Command routing (ADR-0009)**: `response.commands` maps every command name to an
  adapter-specific invocation shape (HTTP: `{method, path}`; handler: `{module, export}`).
  A handler route may add `"namespace": true` (SPEC-ADPHND-002, founder ruling 2026-11-09, opt-in B)
  to declare that its handler reads `ctx.namespace`; only such a route is refused
  (`NAMESPACE_NOT_HONOURED`, after the invoke) when its handler never read it. A route without the
  marker is never checked.
- **Actors (ADR-0012)**: `response.actors` registers named actors with adapter-specific auth
  material (HTTP: headers/token; handler: context object); `default` names the implicit actor;
  `anonymous` is reserved and never declared.
- **The four closed reference spaces**: service keys (config `services`), schema names
  (`contract:`), command names (`response.commands`), actor names (`response.actors`).
  Unknown names in any of them are parse-time errors listing the valid names.
- `consistency`: `acid` (capture immediately) · `strong` (after replication) · `eventual`
  (after `convergenceTimeout`, polled).
- Adapter values are module specifiers — npm package or local path — whose module exports
  `createAdapter(config)` (ADR-0001 / INV-10). Loaded by dynamic import; no plugin registry.
- Validated against `schemas/feat.config.schema.json`; config loaded once per run (INV-8).

---

## 7. Generated output (ADR-0006)

Deterministic header, no timestamp:

```ts
// AUTO-GENERATED by feat emit — do not edit manually
// Source: create-flow.feat (SPEC-AUT-001)
// Language: feat 1.0 · Emitter: @mmmnt/feat-emit-ts@<version>
// Inputs-hash: sha256:<spec + resolved schemas + derivation-relevant config>
```

Same inputs → byte-identical file (INV-3); `feat verify` is a byte compare. Generated files are
excluded from user formatters (list `specs.outputPattern` in `.prettierignore`).
Generated tests import only `@mmmnt/feat-runtime` and run standalone under `npx vitest`.

---

## 8. The agent contract (ADR-0008)

- **Buildability** (ERROR-level lint): B1 `handler at` present for code-producing types;
  B2 two-way rejection traceability (`rejects` ↔ `predict rejection`); B3 `touches` present.
- **Lifecycle**: the agent builds only `status agreed` specs; it may propose draft→agreed
  (human can revert). Nothing in the toolchain writes a status: `built` and `verified` are set by
  hand, by convention.
- **Ambiguity protocol**: on an ambiguous directive the agent halts that spec and asks —
  never guesses. The ambiguity is recorded to flmnt; the spec file is not annotated or demoted.
  Resolution is a spec edit after the human answers. Ambiguity count per spec is the standing
  language-quality metric.

## 9. Reserved keyword summary

**Block openers:** `spec` `context` `aggregate` `type` `status` `construct:` `enforce:` `contract:`
`scenario` `scenario outline` `given:` `when:` `predict` `examples:`
**Status values:** `draft` `agreed` `built` `verified`
**Trigger/actor:** `when:` `deliver … to` (`to response`) `as` `anonymous`
**Contract:** `input` `response` `event` `record` `error` `stream` `from`
**Header:** `observes` · **Spec variables:** `variables:`
**Construct:** `handler at` `imports … from` `register … in` `emit to` `touches` `needs`
**Enforce:** `rejects … when`
**Given:** `execute` `seed` `from` `with` `fault` `clock at` `random seed`
**Predict:** `success` `rejection` `error` `response` `has` `contains` `ordered` `unordered` `with` `equals fixture`
**Value blocks:** `any` (`uuid` `timestamp` `string` `number` `boolean`) `matching` `absent` `not` `f32 … sha256` `partial`
`@when.<path>` `@given[i].response.<path>` `@deliver[i].<path>` `@<service>[i].<path>`
**Pragma:** `feat <major>.<minor>`

---

## 10. Minimal complete example

```
feat 1.0

spec SPEC-USR-001 "CreateUser"
context Users
aggregate User
type command
status agreed

construct:
  handler at handlers/create-user.ts
  touches handlers/**
  Uses Prisma ORM for database access.

enforce:
  validate input against CreateUserInput
  rejects DUPLICATE_EMAIL when a user with this email already exists

contract:
  input CreateUserInput
  response UserResponse
  record UserRow
  error ErrorResponse

scenario "successful user creation":
  when: CreateUser { email: "alice@example.com", name: "Alice" }
  predict success:
    response 201 UserResponse { id: any uuid, email: @when.email }
    database has [ INSERT with UserRow { email: "alice@example.com" } ]

scenario "rejects duplicate email":
  given:
    execute CreateUser { email: "alice@example.com", name: "Alice" }
  when: CreateUser { email: "alice@example.com", name: "Bob" }
  predict rejection DUPLICATE_EMAIL:
    response 409 ErrorResponse
    database has []
```
