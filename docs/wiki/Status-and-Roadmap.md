# Status and Roadmap

## Built and self-hosting (today)

- **The language, v1** — dual zones, four closed reference spaces, matchers (references, typed
  wildcards, regex, absence, nesting, golden fixtures), seeds, event triggers (`deliver`), state
  assertions (`contains`), the query guarantee, actors, clock freeze, scenario outlines,
  cross-spec dependencies, the agent contract (lifecycle, `touches`, `rejects` traceability).
- **The corpus** — nine exemplars with expected-IR goldens; the parser's conformance suite.
- **The toolchain** — parse / generate / verify / run / report / audit / lint / fmt / watch /
  diff; deterministic emission; JUnit output.
- **Adapters** — `handler` (direct invocation), `http`, `fs` (filesystem capture).
- **Editor** — TextMate grammar (`editor/feat.tmLanguage.json`).
- The repository itself runs on the chain it ships: `feat verify && feat run` (all suites
  generated from `.feat` specs).

## In front of us

- **Release engineering** — CI pipeline for the repository (verify + run + workspace tests as
  required checks), versioned releases, npm publishing.
- **Quality gates** — coverage thresholds, adapter compliance suite (`feat-adapter-kit`),
  config JSON Schema published at a stable URL.

## Deferred (designed, not yet built)

- **Runtime wiring for `contains` and `deliver`** — the grammar, IR, and derivation are complete;
  execution needs event-store service adapters that can deliver stimuli and serve reads.
- **External service adapters** — EventStoreDB, DynamoDB (+ Streams), Kafka, LocalStack, gRPC
  response adapter, TypeScript schema adapter.
- **LSP / editor depth** — a language server (diagnostics, completion for the closed spaces,
  go-to-definition for schema references); the corpus keeps any second grammar honest.
- **`feat import`** — bridges from other spec formats. Imports land as `status: draft` with a
  **gap report** ("what your spec fails to measure") and must clear the full quality gate before
  anything is built — on-ramps, never bypasses.
- **Agent authoring surface** — an MCP server exposing parse/lint/audit/gap analysis to AI
  assistants for collaborative spec authoring.
- **Adapter ecosystem kit** — `create-adapter` scaffolding + compliance test suite for
  third-party adapter authors.
- **External validation** — running Feature against a production event-sourced system.

## Design principles that won't move

1. The language is the product; runners and adapters are ecosystem.
2. Predict complete; reject everything else.
3. Zero glue code — if predictions can't express it, fix the language, never add an escape hatch.
4. Agent zone freeform, compiler zone strict.
5. Generated tests are committed, self-contained artifacts.
6. Deterministic everything: same inputs, same bytes.
7. A language change is incomplete until the reference, a corpus exemplar, the implementation,
   and full corpus validation land together.
