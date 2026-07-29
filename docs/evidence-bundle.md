# The evidence bundle (`feat-evidence/2`)

`feat report --evidence <path>` writes a self-contained, digest-anchored record
of a project's spec state and verification results at a point in time:

- **spec inventory** — every discovered spec with its id, lifecycle status, and
  content digest (plus the committed generated file's digest when present);
- **verify** — whether the committed generated tests byte-match the specs
  (`feat verify` semantics, evaluated at production time);
- **run** — the most recent `feat run` result (test/failure/error counts and a
  digest of the JUnit artifact), when one exists;
- **producer** — the exact `@mmmnt` toolchain versions in effect;
- **project** — the language version and a digest of `feat.config.json`.

The schema is `schemas/evidence.schema.json` (also shipped inside the
`@mmmnt/feature` package for programmatic consumers).

## What it is for

A bundle answers, reproducibly and after the fact: *what specs existed, did the
committed tests match them, and did they pass — under which toolchain?* Emit
one per CI run and archive it as a build artifact and you have a longitudinal
record of delivery conformance with no additional infrastructure.

When the config declares a top-level `environment` (ADR-0016), the bundle's
`project.environment` carries it — the environment is a property of the config
the run *actually used* (per-environment config files are the intended
pattern), so a bundle can never claim an environment the adapters weren't
pointed at. Absent from the config, absent from the bundle.

Producing bundles is free, local, and requires no account — like every
capability in the toolchain. The `signature` field is null when produced
locally; attestation (signing on ingestion, and the ledger of bundles over
time) is account-side functionality.

## Producing

```sh
feat run                             # optional — populates the run block
feat report --evidence evidence.json
```

Production never fails the build by itself: a project whose specs don't parse
still gets an honest bundle (the inventory records `parse_error`; `verify`
reports `fail`). Gate on `feat verify && feat run` as usual — the bundle is a
record, not a gate.

## Environment & output location (supersedes the static ADR-0016 field)

The bundle's `project.environment` resolves: `config.environment` (explicit
override) → `FEAT_ENVIRONMENT` → `ENVIRONMENT` — none is an immediate
failure. `feat report --evidence` writes to
`.feature/evidence/<environment>/<commit-sha>[-dirty].json` (the SHA is the
bundle's identity; a dirty tree can never masquerade as a clean commit).
The `local` environment records no evidence (skip with notice; `--force`
for debugging) — compliance windows begin above local. `--out` overrides
the path.

## Per-case resolved variables (ADR-0017)

When a spec declares `variables:`, the harness records each case's resolved
values to `.feature/run/<config>-variables.jsonl` (cleared per run) and the
bundle carries them as `variables` keyed by case anchor — the byte-locked
spec text keeps its ${expressions}; the bundle replays the substitution.

## Per-scenario runs (`feat-evidence/2`, ADR-0020)

`/2` is a strict superset of `/1`: every `/1` field is unchanged, and when a
run artifact exists the bundle additionally carries `runs` — one entry per
scenario with its spec id, pass/fail status, duration, and the parsed
prediction-violation rows (`{path, expected, got}` at spec coordinates). This
is the exact envelope the dashboard's violation view renders (its demand
contract: feature-dashboard `SPEC-FD-037`): what was predicted, what was
captured, and where they diverged — provenance-grade, not prose.

Stage 1 (this contract) derives `runs` from the JUnit artifact; the parse is
lenient — an unparseable failure still records the failed scenario, never
drops it. Stage 2 moves production to a structured run sidecar written by the
harness itself (the ADR-0017 sidecar pattern), replacing text parsing with
recorded fact; the bundle shape does not change.

Consumers accepting `/1` accept `/2` by ignoring `runs`; the dashboard ledger
accepts both contracts.

## The spec's face (`feat-evidence/2` additive)

Each `specs[]` entry carries, beyond its digests and status, the identity the
spec declares — `name`, `context`, `aggregate`, `type`, the construct's
`handler` path — and `excerpt`: zone-tagged source lines (`header` · `agent` ·
`compiler` · `blank`) up to the second scenario, capped at 60. The excerpt is
deterministic — same source, same excerpt — so the dashboard's spec-detail
view renders the contract's face without a second fetch or a second truth.
Unparseable specs carry none of these; the honest inventory row stands alone.

## The spec's IR facets (`feat-evidence/2` additive)

Parseable entries also carry the raw material of a *semantic diff between two
stored versions* — the comparison `feat diff` makes against a git ref, made
possible against a ledger where the versions live in the workspace chain, not
in anyone's working tree:

- `scenarios` — one `{ name, digest }` per scenario, the digest taken over the
  scenario's IR with source locations excluded. Two versions differ
  semantically iff a name appears, disappears, or changes digest; a comment
  added above a scenario changes nothing.
- `interface` — the contract surface as sorted lines, `<kind> <SchemaName>`
  (or `stream <pattern>`), exactly the shape `feat diff` compares.

A consumer holding two envelopes for the same spec can state the delta —
scenarios added/removed/changed, contract lines added/removed, status
transitions — without ever parsing `.feat` source.
