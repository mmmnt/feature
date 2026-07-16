# The `.feat` Language — Grammar Reference v1.1

> Language version: `feat 1.0` · Status: M0.5 draft, pre-implementation
> Decisions: Confluence FEAT → Architecture Decision Records (ADR-0001…0007);
> causal history in flmnt workspace `d52ee565-…::domain`.
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

construct:                      ← agent zone (required, ≥1 directive + ≥1 touches)
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

- **Indentation-sensitive**: block membership by indentation (Python/YAML style). A section ends
  when indentation returns to the parent level. Spaces only; a tab in leading whitespace is a
  parse error.
- **Comments**: `#` to end of line, allowed anywhere.
- **No escape hatches**: every file must have at minimum the header, one construct directive,
  one enforce directive, one contract reference, and one scenario with a prediction.

### 1.3 The two zones (DP-5, non-negotiable)

| Zone | Sections | Parser behavior |
| --- | --- | --- |
| **Agent** | `construct:`, `enforce:` | Freeform natural language. Keyword-matching lines produce typed IR nodes; every other line is captured verbatim as an opaque directive. A parse error here is impossible. |
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
| `status` | `status agreed` | Lifecycle (ADR-0008): `draft` → `agreed` → `built` → `verified`. The agent refuses to build a spec that is not `agreed`; the agent may *propose* the draft→agreed flip, the human can revert; tooling flips `built`/`verified`. |

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
| `touches <glob>` | `touches features/create-flow/**` — **change boundary** (ADR-0008): the build may create/modify ONLY paths matching a `touches` glob; the `handler at` path must fall inside one. Repeatable. **Always required**, even in drafts — the build-time mirror of prediction inversion. |
| `needs <SPEC-ID>` | `needs SPEC-USR-001` — **cross-spec dependency** (ADR-0012): explicit build-order DAG; `feat audit` detects cycles; the agent builds in topological order. Repeatable. |

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
| `rejects` | `rejects UNIQUE_NAME when a flow with this name exists for the tenant` | Justifies a business-rule rejection. `<ID>` is typed (KEYWORD position, validated two-way against scenario rejection IDs); the reason is FREEFORM. |

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
`given › execute[i]`, `given › seed[i]`), so failures map to exact spec coordinates. The parser
additionally stamps optional `loc` (line/column) on IR nodes for editor jump-to-line.

### 5.1 `given:` — the hybrid zone

Three line kinds, freely mixed:

| Kind | Form | Semantics |
| --- | --- | --- |
| Freeform | any unmatched line | Human/agent context; opaque |
| `execute` | `execute [(as <actor>)] <Command> { <json> }` | Runs the command through the **response adapter** before the capture window opens (INV-9) |
| `seed` (ADR-0003) | `seed <service> [ <records> ]` or `seed <service> from "<path.json>"` | Injects state directly through the service adapter's `seed()`; fixture form for bulk state |
| `clock at` (ADR-0012) | `clock at "2026-07-16T00:00:00Z"` | Freezes scenario time. v1: honored by the **handler adapter only** (it injects the clock); remote protocols need their own test-time hooks. |

Seed records take **full literal values only** — no matchers, no `@when` (seeds are writes, and
`given` precedes `when`). Optional `with <Schema>` validates seed data at generate time.
Fixture JSON is data, not glue code — DP-3 stands; imperative seed scripts are forbidden.

### 5.2 The trigger — `when:` or `deliver` (ADR-0011)

The spec `type` declares its trigger discipline (parse error on mismatch):

| Spec types | Trigger | Form |
| --- | --- | --- |
| `command`, `query` | `when:` | `when [(as <actor>)]: <Command> { <json> }` — exactly one; command ∈ `response.commands`; actor ∈ `response.actors` or reserved `anonymous`, omitted = `actors.default` (ADR-0012) |
| `projection`, `policy`, `saga` | `deliver` | `deliver <EventType> { <json> }` `to <service>` — one or more, in order; saga sequences chain multiple lines |

Delivered stimuli are **excluded from capture** — they are the input, not the output — so
`eventStore has []` on a projection asserts "the projection emitted nothing new."
Deliver-triggered scenarios have **no `response` surface**, and `predict rejection` is invalid
for them (lint ERROR; `success`/`error` only).

### 5.3 `predict` — the measurement contract

Three types, fixed grammar:

| Form | Assertion behavior |
| --- | --- |
| `predict success:` | Positive response + expected effects per service |
| `predict rejection <ID>:` | Error response + **zero effects across ALL configured services** |
| `predict error <CODE>:` | Error response + zero or compensating effects |

Prediction lines:

| Form | Meaning |
| --- | --- |
| `response <status> <Schema> [{ <value block> }]` | Response surface: status + body schema (+ optional value assertions) |
| `<service> has [ <record>, ... ]` | Exactly these records **captured** (writes during the window) |
| `<service> has []` | Zero records captured (explicit absence assertion) |
| `<service> has ordered [...]` / `has unordered [...]` | Ordering override (ADR-0004) |
| `<service> contains [ <record>, ... ]` | **Resulting state** via adapter `read()` (ADR-0011) — polled to convergence for eventual services; may appear alongside `has` for the same service |

**Completeness (INV-6)**: every configured service must appear in every prediction — `has []`
is the explicit "nothing happens here". Omission is a validation error.
**Query guarantee (ADR-0011)**: for `type query`, service predictions are implicitly `has []`
everywhere and writing any `has [X]` is a **parse error** — side-effect freedom is unviolable
by construction. Queries predict `response` (+ optional `contains`).
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

A record is `<Type> with <Schema>` plus an optional **value block**. Three assertion layers:
type match → schema validation → value-block matchers. Value blocks are **partial**: they
assert listed fields only; shape completeness is the schema's job.

Micro-grammar (every bare word below is KEYWORD or validated IDENT — never prose):

```
record      := IDENT:type "with" IDENT:schemaName [ valueBlock ]     # schemaName ∈ contract: block
valueBlock  := "{" { IDENT:field ":" matcher } "}"
matcher     := LITERAL | "@when." PATH | "any" [ "uuid"|"timestamp"|"string"|"number"|"boolean" ]
             | "matching" STRING | "absent" | valueBlock
```

**Matcher vocabulary:**

| Matcher | Meaning |
| --- | --- |
| `"str"`, `42`, `true`, `null` | Strict equality |
| `@when.<path>` | Equals the value sent in the `when:` payload |
| `@deliver.<path>` / `@deliver[i].<path>` | Equals the value in the delivered stimulus (index required for saga sequences) |
| `any` | Present, any value |
| `any uuid` · `any timestamp` · `any string` · `any number` · `any boolean` | Present + format/type check |
| `matching "<regex>"` | String matches pattern |
| `absent` | Field must not exist |
| `{ ... }` | Nested value block |

Reserved words (`any`, `matching`, `absent`, `ordered`, `unordered`) are reserved **inside
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

`<placeholder>` tokens are valid in `when:`/`execute` payloads and in value blocks; the
`examples:` pipe table supplies one row per derived test case (column headers = placeholder
names; cells are JSON literals). Anchors extend with `› row[i]`. Shared schemas across specs
need no outline-style syntax — the documented convention is a workspace `contracts/` directory
that per-spec `.contract.json` registries `$ref` into.

---

## 6. Configuration (`feat.config.json`)

```json
{
  "featVersion": "1.0",
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
- **Command routing (ADR-0009)**: `response.commands` maps every command name to an
  adapter-specific invocation shape (HTTP: `{method, path}`; handler: `{module, export}`).
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
excluded from user formatters (`specs.outputPattern` in `.prettierignore`; `feat audit` warns).
Generated tests import only `@mmmnt/feat-runtime` and run standalone under `npx vitest`.

---

## 8. The agent contract (ADR-0008)

- **Buildability** (ERROR-level lint): B1 `handler at` present for code-producing types;
  B2 two-way rejection traceability (`rejects` ↔ `predict rejection`); B3 `touches` present.
- **Lifecycle**: the agent builds only `status agreed` specs; it may propose draft→agreed
  (human can revert); `built`/`verified` are flipped by tooling, never by hand.
- **Ambiguity protocol**: on an ambiguous directive the agent halts that spec and asks —
  never guesses. The ambiguity is recorded to flmnt; the spec file is not annotated or demoted.
  Resolution is a spec edit after the human answers. Ambiguity count per spec is the standing
  language-quality metric.

## 9. Reserved keyword summary

**Block openers:** `spec` `context` `aggregate` `type` `status` `construct:` `enforce:` `contract:`
`scenario` `scenario outline` `given:` `when:` `predict` `examples:`
**Status values:** `draft` `agreed` `built` `verified`
**Trigger/actor:** `deliver … to` `as` `anonymous` · **Given:** `clock at`
**Contract:** `input` `response` `event` `record` `error` `stream` `from`
**Construct:** `handler at` `imports … from` `register … in` `emit to` `touches`
**Enforce:** `rejects … when`
**Given:** `execute` `seed` `from` `with`
**Trigger:** `when:` `deliver … to`
**Predict:** `success` `rejection` `error` `response` `has` `contains` `ordered` `unordered` `with`
**Value blocks:** `any` (`uuid` `timestamp` `string` `number` `boolean`) `matching` `absent`
`@when.<path>`
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
