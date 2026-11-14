# Language Corpus

The first `.feat` files ever written. Each exemplar defines part of the language by example and
pairs with an expected-BuiltSpec-IR fixture (`.ir.json`, validating against
`schemas/builtspec.schema.json`) — together they are the ground truth `@mmmnt/feat-core`'s parser
is tested against. The corpus grows with every language change, forever.

| # | Exemplar | Spec | Exercises |
| --- | --- | --- | --- |
| 1 | `create-flow/` | SPEC-AUT-001 | Founding example (PRD §1): full dual-zone shape, all construct keywords, freeform directives, `execute` precondition, success + rejection, matchers (`@when`, `any uuid`, `any timestamp`), eventual services |
| 2 | `create-user/` | SPEC-USR-001 | CRUD-only, single acid service, `absent` matcher, literal matchers, value block on error response |
| 3 | `tenant-at-limit/` | SPEC-AUT-002 | Seed mechanism (ADR-0003): inline record seed + JSON fixture bulk seed |
| 4 | `publish-order/` | SPEC-ORD-001 | Ordering semantics (ADR-0004): multi-record predictions, `ordered`/`unordered` overrides, `predict error <CODE>` (retyped saga→command per ADR-0011 trigger discipline — caught by the parser; a true multi-deliver saga exemplar is owed at M5) |
| 5 | `emit-test-file/` | SPEC-FEAT-001 | Compiler-shaped dogfood pattern: handler response adapter, filesystem service, `matching` regex, nested value blocks, string statuses (`OK`/`ERR`), infrastructure type |
| 6 | `flow-view/` | SPEC-AUT-003 | Projection (ADR-0011): `deliver` trigger, `contains` state assertions, `@deliver` refs, stimulus excluded from capture, no response surface, deliver-only config (no `response` block); record-position golden fixture (ADR-0013) |
| 7 | `get-flow/` | SPEC-AUT-004 | Query (ADR-0011): the query guarantee — no service predictions writable, response-only success + NOT_FOUND rejection, seed-backed read; response-position golden fixture (ADR-0013) |
| 8 | `suspend-user/` | SPEC-USR-002 | ADR-0012 set: `when (as <actor>)` + `anonymous` rejection, `clock at` freeze, scenario outline + examples table (incl. placeholder rejection-ID and matching-argument positions), `needs` cross-spec dependency, config actors registry |
| 9 | `ship-order/` | SPEC-ORD-002 | True saga (owed from the publish-order retype): ordered multi-deliver sequence, `@deliver[i]` indexed references, no response surface, deliver-only + mixed acid/eventual services |
| 10 | `capture-charge/` | SPEC-PAY-001 | Dotted record types (ADR-0015): `charge.succeeded with Charge` in a `has` prediction, plain-IDENT types alongside, seed + mixed eventual/acid services, `unordered` override on an event-feed service. ALSO the cross-surface capture reference (ADR-0021): `@payments[0].id` in both a response value block and a record value block — the instrument assigns the id, the local receipt must record THAT id, and neither a literal nor `any` can state it |

Validation (until `feat parse` exists in M2):

```
pnpm dlx ajv-cli@5 validate --spec=draft7 -s schemas/builtspec.schema.json -d "corpus/*/*.ir.json"
pnpm dlx ajv-cli@5 validate --spec=draft7 -s schemas/contract.schema.json -d "corpus/*/*.contract.json"
```
| 11 | `waitlist-variables/` | SPEC-WL-001 | Spec variables (ADR-0017): `variables:` block, source calls (`now()`), definition-side template composition, `${ref}` interpolation in when-payloads and predictions, idempotent-repeat via shared per-case resolution |
| 12 | `userinfo-profile/` | SPEC-IDP-001 | Quoted payload keys (ADR-0019): colon-namespaced IdP claims in payloads and shapes |
| 13 | `rejection-camelcase/` | SPEC-REJ-001 | UpperCamel rejection ids (ADR-0022): `rejects NotOperator`, `rejects AlreadyAnswered`, `predict rejection NotOperator:` beside an UPPER_SNAKE id (`UNKNOWN_QUESTION`) in one spec; actors (`as operator` / `as reader`); ids kept verbatim in the IR |
| 14 | `seed-fixture/` | SPEC-SHF-001 | The seed fixture form, checked (ADR-0003 + ADR-0007, SPEC-GEN-001): `seed <service> from "<path>"` resolved against the spec directory; fixture records are `{type, schemaName?, values}`, each schemaName declared in `contract:` and its values valid against it at generate time; a record with no schemaName is shape-checked only; inlined in file order so the generated suite is self-contained; query spec |
| 15 | `given-fault/` | SPEC-ORD-003 | Logical faults as preconditions (ADR-0023): `fault <service> <Operation> <Fault>` in `given:`, the three consumption forms (default once, `times n` with a detail object, `until reset`), recorded in `given.faults` with `times` always present; a fault line is reserved, never freeform |
| 16 | `given-order/` | SPEC-WSP-001 | Given steps in written order (ADR-0025): `execute` then `seed`, and `seed`, `execute`, `seed`, recorded as `given.order` beside `given.executes` and `given.seeds`; a given of one kind carries no order |
| 17 | `not-matcher/` | SPEC-CYC-001 | The negation matcher (ADR-0027): `not` over a literal, `@when`, `@log[0]` (a capture reference inside `not`, beside a plain one), `any <type>` and `matching "<regex>"` in response and record value blocks, and over a placeholder and a `matching` placeholder in an outline; recorded as `{ matcher: "not", operand }` |
