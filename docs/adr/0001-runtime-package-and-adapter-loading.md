# ADR-0001: `@mmmnt/feat-runtime` and config-driven adapter loading

- **Status:** Accepted (2026-07-16, M0 session 1)
- **Resolves:** F1 (generated-test runtime has no owner), F2 (oclif hooks vs standalone tests)
- **Supersedes:** GAP-D06 resolution (oclif plugin registry), GAP-S08 resolution (hook payload
  contract), INV-10 (oclif formulation), GAP-S06 final matcher placement (emit-ts), GAP-S02
  resolution (core owns loadConfig — partial)
- **flmnt:** decision `3fc7cb8f`, supersessions `36ff0836`, `0ac3c64f`, `85c48444`, `e54c3c7d`

## Context

Generated tests must run standalone under `npx vitest` (GAP-D09, DP-6), but the converged model
gave them no runtime library: the PRD's generated-file example imported from the deleted
`@feat/engine`; the matcher lived in the codegen package; adapters registered through oclif hooks
that never fire outside the CLI process.

## Decision

1. **New package `@mmmnt/feat-runtime`** — everything a generated test imports at runtime:
   `loadConfig()` (Ajv-validated against `schemas/feat.config.schema.json`), `loadAdapters(config)`,
   lifecycle + capture orchestration (consistency-model timing), the precondition executor
   (INV-9), and `toMatchPrediction`. Dependencies: `@mmmnt/feat-types` + Ajv, nothing else.
2. **Adapter loading is config-driven dynamic import, everywhere.** The oclif hook registry is
   dropped entirely. Every adapter module (npm package or local file) exports
   `createAdapter(config)`; the runtime dynamic-imports the module specifier named in
   `feat.config.json` and instantiates. CLI and standalone tests share this one mechanism.
3. **INV-10 (restated):** a configured service key whose module fails to load or lacks
   `createAdapter` is a configuration error — CLI exit code 2, runtime throw before any test runs.
4. **`loadConfig` moves from core to runtime.** Core imports it for service-key validation
   (`core → runtime → types` stays a DAG); tests never load the Langium parser.
5. **Resolved schemas are inlined into generated test files** as constants. Schema adapters are
   compile-time only (extends GAP-S10); the matcher validates captured payloads against the
   inlined schemas via Ajv. Tests are self-contained with zero compile-time machinery at runtime.

## Consequences

- `@mmmnt/feat-emit-ts` owns no runtime code; it generates imports of `@mmmnt/feat-runtime`.
- Adapter packages are plain npm packages — no oclif plugin structure; simpler for community
  authors. `@mmmnt/feat-create-adapter` / `feat-adapter-kit` scaffolding requirements shrink.
- Final V1 dependency map: `types ← runtime ← { core, generated tests }`; `derive`/`emit-ts`
  pure compile-time; `@mmmnt/feature` orchestrates; `feat-runner` spawns; adapters are leaves.
- The F5 ordering design (M0 session 4) lands inside `toMatchPrediction` in runtime.
