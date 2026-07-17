# Architecture

## The pipeline

```
.feat + .contract.json + feat.config.json
   │
   ├─ parse   (@mmmnt/feat-core)      text → BuiltSpec IR; four closed-space validations
   ├─ derive  (@mmmnt/feat-derive)    IR + config → TestTopology; outline expansion,
   │                                  ordering resolution, query implicit-zero
   ├─ emit    (@mmmnt/feat-emit-ts)   topology + resolved schemas/goldens/seeds →
   │                                  complete Vitest file (deterministic, self-contained)
   ├─ verify  (CLI)                   regenerate + byte-compare committed files
   └─ run     (@mmmnt/feat-runner)    vitest subprocess; adapters do the capturing
```

Schema resolution happens **upfront in the CLI** — derive and emit are pure functions
(no I/O, no clock, no randomness), which is what makes the determinism invariants testable.

## Packages

| Package | Role | Depends on |
| --- | --- | --- |
| `@mmmnt/feat-types` | Shared contracts — types only, zero runtime code. Mirrors the JSON Schemas in `schemas/`. | nothing |
| `@mmmnt/feat-core` | Parser: statement scanner (bracket-balanced logical lines), matcher grammar, IR builder, validations. | types, runtime |
| `@mmmnt/feat-derive` | Pure IR→topology transform. | types |
| `@mmmnt/feat-emit-ts` | Pure topology→Vitest-file emitter; owns no runtime code. | types, derive |
| `@mmmnt/feat-runtime` | What generated tests import: config loading, adapter loading, the capture harness, the prediction matcher. | types |
| `@mmmnt/feat-runner` | Thin vitest subprocess orchestrator. | types |
| `@mmmnt/feature` | The `feat` CLI — orchestrates, delegates. | all of the above |
| `@mmmnt/feat-adapter-*` | Adapters: `handler` (direct invocation), `http`, `fs` (filesystem capture). | types |

Dependency law: `types ← runtime ← { core, generated tests }`; adapters are leaves.

## Adapters

Three kinds, one contract: an adapter is a plain package (or local file) exporting
`createAdapter(config)`.

- **Response adapters** invoke the system under test (routes come from `response.commands`;
  actors supply auth material) and capture `{ status, body }`.
- **Service adapters** capture observable effects during the window
  (`setup / reset / startCapture / stopCapture / read / seed?`).
- **Schema adapters** resolve schema references at compile time only — generated tests carry
  their schemas inlined.

Resolution is anchored at the **project root** (where the config lives), so generated tests are
location-independent: run them from anywhere.

## The capture window

Per test: reset (fresh namespaces) → preconditions execute/seed (**before** the window — their
effects are never captured) → window opens → stimulus (`when:` invocation or `deliver` events,
which are excluded from capture as input) → one shared wait covering the scenario's
eventual-consistency services → capture sweep → prediction diff. Adapter instances are
**per test file**, so cross-file parallelism is safe by construction.

## Determinism invariants

| | Invariant | Enforced by |
| --- | --- | --- |
| INV-1 | Same spec + config → identical IR | property test over the whole corpus |
| INV-2 | Same IR + config → identical topology | derive is pure |
| INV-3 | Same topology + schemas → byte-identical file | no timestamps; inputs hash in the header; `feat verify` |
| INV-6/7 | Prediction completeness; closed service keys | parse-time errors |

## The corpus as executable contract

`corpus/` holds nine exemplars spanning every language capability — commands, CRUD, seeds,
ordering overrides, error predictions, a projection, a query, an outline/actors/clock exemplar,
and a true multi-deliver saga. Each pairs with its expected IR. The parser's own spec asserts,
via golden fixtures, that every exemplar parses to its IR exactly — so the corpus is
simultaneously documentation, test data, and the language's conformance suite. Any future parser
(including an LSP-oriented grammar) must round-trip the same corpus to the same fixtures.
