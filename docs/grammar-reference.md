# The `.feat` Language — Grammar Reference v1.0

> Language version: `feat 1.0` · Status: M0 draft, pre-implementation
> Decisions: Confluence FEAT → Architecture Decision Records (ADR-0001…0006);
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

construct:                      ← agent zone (required, ≥1 directive)
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

---

## 2. Header

| Keyword | Form | Notes |
| --- | --- | --- |
| `spec` | `spec SPEC-AUT-001 "CreateFlow Command Handler"` | ID + display name |
| `context` | `context Automation` | Bounded context |
| `aggregate` | `aggregate Flow` | Aggregate / entity |
| `type` | `type command` | One of: `command`, `query`, `policy`, `projection`, `saga`, `infrastructure`, `integration`, `scaffold` |

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

Any other line is a **freeform directive**, captured verbatim:

```
construct:
  handler at features/create-flow/handler.ts
  Lambda cannot write directly to Kurrent.
  Redis cache has TTL of 60 min, minimum.
```

### 3.2 `enforce:` — behavioral instructions

Entirely freeform. Conventional shapes (`validate input against X`, `on success emit Y`) are
recognized for IR categorization but carry no compiler semantics; unrecognized lines are
constraints, captured verbatim.

---

## 4. `contract:` — schema references

| Keyword | Form | Purpose |
| --- | --- | --- |
| `input` | `input CreateFlowInput from "core/contracts/commands"` | Input schema |
| `event` | `event FlowCreatedEvent from "core/contracts/events"` | Event schema |
| `error` | `error RFC7807 from "contracts/adrs/error-format"` | Error format |
| `stream` | `stream "automation-flow-{flowId}"` | Stream name pattern |

References resolve **at compile time** through the configured schema adapter, against the
spec's paired `.contract.json` (same basename). `.contract.json` is a schema registry:

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

### 5.1 `given:` — the hybrid zone

Three line kinds, freely mixed:

| Kind | Form | Semantics |
| --- | --- | --- |
| Freeform | any unmatched line | Human/agent context; opaque |
| `execute` | `execute <Command> { <json> }` | Runs the command through the **response adapter** before the capture window opens (INV-9) |
| `seed` (ADR-0003) | `seed <service> [ <records> ]` or `seed <service> from "<path.json>"` | Injects state directly through the service adapter's `seed()`; fixture form for bulk state |

Seed records take **full literal values only** — no matchers, no `@when` (seeds are writes, and
`given` precedes `when`). Optional `with <Schema>` validates seed data at generate time.
Fixture JSON is data, not glue code — DP-3 stands; imperative seed scripts are forbidden.

### 5.2 `when:` — the invocation under test

`when: <Command> { <json> }` — exactly one per scenario. Payload is inline JSON.

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
| `<service> has [ <record>, ... ]` | Exactly these records captured on that service |
| `<service> has []` | Zero records captured (explicit absence assertion) |
| `<service> has ordered [...]` / `has unordered [...]` | Ordering override (ADR-0004) |

**Completeness (INV-6)**: every configured service must appear in every prediction — `has []`
is the explicit "nothing happens here". Omission is a validation error.
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

**Matcher vocabulary:**

| Matcher | Meaning |
| --- | --- |
| `"str"`, `42`, `true`, `null` | Strict equality |
| `@when.<path>` | Equals the value sent in the `when:` payload |
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

---

## 6. Configuration (`feat.config.json`)

```json
{
  "featVersion": "1.0",
  "schemas":  { "adapter": "@mmmnt/feat-schema-json" },
  "response": { "adapter": "@mmmnt/feat-adapter-handler",
                "invoke": { "entrypoint": "src/index.ts", "method": "handle" } },
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

## 8. Reserved keyword summary

**Block openers:** `spec` `context` `aggregate` `type` `construct:` `enforce:` `contract:`
`scenario` `given:` `when:` `predict`
**Contract:** `input` `event` `error` `stream` `from`
**Construct:** `handler at` `imports … from` `register … in` `emit to`
**Given:** `execute` `seed` `from` `with`
**Predict:** `success` `rejection` `error` `response` `has` `ordered` `unordered` `with`
**Value blocks:** `any` (`uuid` `timestamp` `string` `number` `boolean`) `matching` `absent`
`@when.<path>`
**Pragma:** `feat <major>.<minor>`

---

## 9. Minimal complete example

```
feat 1.0

spec SPEC-USR-001 "CreateUser"
context Users
aggregate User
type command

construct:
  handler at handlers/create-user.ts
  Uses Prisma ORM for database access.

enforce:
  validate input against CreateUserInput
  check email uniqueness before insert

contract:
  input CreateUserInput from "schemas/user-input"
  error ErrorResponse from "schemas/error"

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
