# CLI Reference

All commands take `--config <path>` (default `feat.config.json`). Exit codes are uniform:
**`0`** success · **`1`** validation failure · **`2`** configuration error.

---

## feat parse `<file>`

Parse and validate one spec. Prints the intermediate representation (JSON) on success; on
failure, a coded error with location and a hint:

```
ERROR [UNKNOWN_SERVICE_KEY] specs/create-flow.feat
  Service 'cache' is not configured.
  Hint: Configured services: eventStore, projectionStore, eventBroker
```

Twelve error codes cover the pragma (`MISSING_PRAGMA`, `UNSUPPORTED_VERSION`), grammar
(`MALFORMED_SYNTAX`), the four closed spaces (`UNKNOWN_SERVICE_KEY`, `UNKNOWN_COMMAND`,
`UNDECLARED_SCHEMA`, `UNKNOWN_ACTOR`), and structure (`DUPLICATE_SCENARIO_NAME`,
`TRIGGER_MISMATCH`, `QUERY_SIDE_EFFECT`, `INCOMPLETE_PREDICTION`, `MISSING_MINIMUM`).

## feat generate

Compile every spec (`specs.dir` + pattern from config; `fixtures/` directories are excluded by
convention) into its test file, written next to the spec per `specs.outputPattern`. Generated
files are complete and self-contained: resolved schemas, golden fixtures, and seed fixtures are
inlined; the only runtime import is the Feature runtime. The header carries the source reference,
language and emitter versions, and a hash of the inputs — no timestamps.

## feat verify

The CI integrity gate. Regenerates in memory and **byte-compares** against the committed files:

```
ERROR [VERIFY_FAILED] Committed tests do not match current specs:
  packages/feat-core/parse.test.ts (differs)
  Run "feat generate" and commit the updated files.
```

## feat run `[--spec <ID>]`

Execute the generated suites through a vitest subprocess. Adapters load by dynamic import from
the config (`createAdapter` contract); each test file gets its own adapter instances; capture
windows respect per-service consistency. Writes JUnit XML when `report.format` includes
`"junit"`.

## feat report `[--junit]`

Summarize the last run from the JUnit output — per-suite pass/fail counts, exit 1 if anything
failed. `--junit` prints the XML path for CI import.

## feat audit

The buildability gate, per spec:

- **B1** — a `handler at` exists for code-producing types.
- **B2** — two-way traceability: every predicted rejection ID has a `rejects` directive and vice
  versa (outline-expanded IDs included).
- **B3** — `touches` change boundaries declared.
- Warnings: missing paired contract, missing generated test, `draft` status.

## feat lint

Language-quality warnings: schemas declared but never referenced by a scenario (`input` is exempt
— it is the when-payload's contract by definition), duplicate declarations, lifecycle surfacing.

## feat fmt `[--check]`

Conservative, content-preserving canonicalization: trailing whitespace, blank-line collapse,
final newline; reports tabs-in-indentation (a parse error) rather than rewriting them. `--check`
exits 1 if anything would change.

## feat watch

Regenerates on any `.feat` or `.contract.json` change under the specs directory.

## feat diff `<file> [--ref <git-ref>]`

Spec-level change summary against a git ref (default `HEAD`) — added/removed/changed scenarios,
status transitions, and contract interface changes. Built for PR review: the reviewer reads what
the *contract* changed, not a wall of generated-test diff.
