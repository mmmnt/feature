# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Feature** — the `.feat` execution specification language and toolchain (github.com/mmmnt/feature).
A `.feat` file instructs an AI agent how to build a feature and predicts every observable effect;
it compiles deterministically to complete test suites with zero human-authored test code
(prediction inversion: unpredicted = failure).

**This project is built spec-driven on itself.** No issue tracker decomposition:

- Scope is tracked in a local working ledger (untracked, maintained alongside each change).
- **`.feat` specs are the unit of work.** The agent builds only `status agreed` specs, only within
  their `touches` globs. Ambiguity = halt and ask — never guess, never annotate the file.
- Design changes require an ADR (see the decision-record index referenced from FEATURES.md), and a
  language change is incomplete until all four layers close in the same change: grammar reference
  updated, corpus exemplar added, parser/IR implemented, full corpus re-validated.

## The language (source of truth in-repo)

- `docs/grammar-reference.md` — the `.feat` v1 reference. When code and reference disagree, fix
  the spec first (spec is source of truth).
- `corpus/` — exemplars, each `.feat` + `.contract.json` + expected-IR `.ir.json` + `feat.config.json`.
  The corpus is the parser's ground truth; it grows with every language change, forever.
- `schemas/` — `builtspec.schema.json` (the language-neutral IR contract — TS types mirror it),
  `contract.schema.json`, `feat.config.schema.json`. Validate: `pnpm corpus:validate`.

## Toolchain

- pnpm + Turborepo, TypeScript strict, Vitest. Node version per `.tool-versions`.
- Packages: `@mmmnt/feature` (CLI, owns the `feat` bin) + `@mmmnt/feat-*` (types, core, runtime,
  derive, emit-ts, runner, adapters). Dependency law: `types ← runtime ← {core, generated tests}`;
  derive/emit are pure; adapters are leaves exporting `createAdapter(config)`.
- `pnpm build` / `pnpm test` / `pnpm typecheck` via turbo. The CI chain is
  `feat verify && feat run` (generated suites execute from the project root; package-level vitest
  covers non-generated tests only).
- Secrets in `.env.local` (gitignored); never commit `.env.*` files.
