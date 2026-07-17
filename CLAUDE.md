# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**Feature** — the `.feat` execution specification language and toolchain (github.com/mmmnt/feature).
Positioning: *the quality spine of AI-native delivery* — (A) AI-collaborative spec authoring with
memory, (B) guaranteed delivery of the spec in its original format. A `.feat` file instructs an AI
agent how to build a feature and predicts every observable effect; it compiles deterministically to
complete test suites with zero human-authored test code (prediction inversion: unpredicted = failure).

**This project is built spec-driven on itself (dogfood).** No Jira, no epics/stories/tasks:

- **`FEATURES.md`** (repo root) is the source of truth for scope — every row status-tracked; update
  it **in the same commit** as the work that moves a row. Nothing gets built without a row.
- **`.feat` specs are the unit of work.** The agent builds only `status agreed` specs, only within
  their `touches` globs. Ambiguity = halt and ask — never guess, never annotate the file.
- **flmnt** (workspace `d52ee565-8e27-4fec-adb6-9247a7f067a6`) holds all decisions/causality.
  Record decisions, mistakes, and plans as you work; supersede rather than silently reverse.
- **ADRs live in Confluence** (FEAT space → "Architecture Decision Records", page 28573697) — never
  in the repo. Grammar/design changes need an ADR + flmnt record + corpus exemplar.

## The language (source of truth in-repo)

- `docs/grammar-reference.md` — the `.feat` v1.1 reference. When code and reference disagree, fix
  the spec first (spec is source of truth).
- `corpus/` — 8 exemplars, each `.feat` + `.contract.json` + expected-IR `.ir.json` + `feat.config.json`.
  The corpus is the parser's ground truth; it grows with every language change, forever.
- `schemas/` — `builtspec.schema.json` (the language-neutral IR contract — TS types derive from it),
  `contract.schema.json`, `feat.config.schema.json`. Validate: `pnpm corpus:validate`.

## Build state & bootstrap protocol

Milestones M0/M0.5 (language definition) are complete. M1–M4: **agent-as-compiler bootstrap** —
read the spec's construct/enforce as build instructions, hand-derive tests from predictions by
mechanically applying the derivation rules (red), implement (green). At M4 `feat generate` runs
against Feature's own specs and the diff against hand-derived tests is the product's proof.

## Toolchain

- pnpm 10.33.0 + Turborepo, TypeScript strict, Vitest. Node 24 (`.tool-versions`).
- Packages: `@mmmnt/feature` (CLI, owns the `feat` bin) + `@mmmnt/feat-*` (types, core, runtime,
  derive, emit-ts, runner, adapters). Dependency law: `types ← runtime ← {core, generated tests}`;
  derive/emit are pure; adapters are leaves exporting `createAdapter(config)` (no oclif hooks).
- `pnpm build` / `pnpm test` / `pnpm typecheck` via turbo. **Do not push** — commits stay local
  unless the user says otherwise.
- Secrets in `.env.local` (gitignored), loaded via `@dotenvx/dotenvx`; never commit `.env.*`.

## MCP servers (`.mcp.json`)

- **atlassian** — Jira/Confluence at `https://coada.atlassian.net` (FEAT space = docs + ADRs).
- **flmnt** — project memory at `https://mcp.production.flmnt.ai/mcp`. If workspaces look wrong or
  return `forbidden`, the MCP OAuth identity differs from the CLI's (`flmnt workspace list` to
  compare; re-auth via `/mcp` as mike@flmnt.ai).
