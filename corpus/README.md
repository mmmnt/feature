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
| 8 | `suspend-user/` | SPEC-USR-002 | ADR-0012 set: `when (as <actor>)` + `anonymous` rejection, `clock at` freeze, scenario outline + examples table, `needs` cross-spec dependency, config actors registry |

Validation (until `feat parse` exists in M2):

```
pnpm dlx ajv-cli@5 validate --spec=draft7 -s schemas/builtspec.schema.json -d "corpus/*/*.ir.json"
pnpm dlx ajv-cli@5 validate --spec=draft7 -s schemas/contract.schema.json -d "corpus/*/*.contract.json"
```
