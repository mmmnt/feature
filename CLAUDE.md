# CLAUDE.md

Feature: the `.feat` execution specification language and toolchain (see README.md).

## flmnt

flmnt is the memory of record for this repo: decisions, rulings, history and runbooks live there,
not here.

- This repo records into the flmnt workspace `feature` (`d52ee565-8e27-4fec-adb6-9247a7f067a6`) on
  the local server `http://localhost:8000/mcp`.
- `.flmnt.json` (CLI and hooks) and `.mcp.json` (the `flmnt` MCP entry) are tracked and must agree.
  Change them with `flmnt setup --server-url http://localhost:8000/mcp --project feature`; never
  hand-edit them, except the local-harness keys (`local_graphql_endpoint`, `volumes_path`,
  `compose_files`, `env_file`). Never edit `.claude/flmnt-hooks/*`.
- Pass `workspace: d52ee565-8e27-4fec-adb6-9247a7f067a6` on flmnt tool calls.
- Before reading code to answer why something is the way it is, or what was decided, query flmnt
  (`query_context`, `materialize_context`). Verify a recalled fact against current code before
  acting on it.
- Record a decision when it is made (`record_decision`, `record_operational_decision`). Quote the
  person's ruling verbatim.
- Diagnostics: `flmnt health`, `flmnt whoami`. A "not connected" MCP is often fixed by `/mcp`
  reconnect.

## Feature

- Build: `pnpm install`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm corpus:validate`.
  The spec chain: `node packages/feature/bin/run.js verify`, then `audit`, `lint`, `run`.
- `.feat` specs are the unit of work. Build only `status agreed` specs, and only within their
  `touches` globs.
- Ambiguity means halt and ask. Never guess, never annotate the spec to cover a guess.
- `docs/grammar-reference.md` is the source of truth for the language. When code and reference
  disagree, the code is wrong or the reference changes first, by decision.
- A language change is incomplete until all four layers close in the same change: the grammar
  reference, a corpus exemplar (`corpus/`), the parser and IR, and the full corpus re-validated.
- A design change needs an ADR in `docs/adr/` and an entry in `docs/adr/README.md`.
- Before any push run `scripts/ci-local.sh` (the full gate), then push. `.githooks/pre-push` only
  checks the pass record; it runs nothing. Enable it with `git config core.hooksPath .githooks`.
- Commit titles are conventional commits; they drive the release. Never push release tags by hand.
- Secrets live in `.env.local` (gitignored). Never commit `.env.*` files.
