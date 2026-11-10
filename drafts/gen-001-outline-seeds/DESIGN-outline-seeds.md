# Outline seeds: SPEC-DRV-001 (new, draft) and the SPEC-GEN-001 amendment (draft)

Status: draft, awaiting the founder (flip `status draft` to `agreed` in both files; the GEN-001 copy replaces `packages/feature/generate-seed-fixtures.feat`, which is `agreed` today).
Ruling 2026-11-10: "New spec + GEN-001 (Recommended)"; open choices accepted "Whole-value only, Fixture seeds literal"; "Keep code, add row anchor" was NOT accepted, so an outline-row violation has a new code.
Files (this tree mirrors the repo root; on agreement they move there):
- `packages/feat-derive/derive-seeds.feat` + `.contract.json` (SPEC-DRV-001), `packages/feat-derive/fixtures/probe.mjs`, `packages/feat-derive/fixtures/seed-outline/{values,fixture,missing,plain}/`
- `packages/feature/generate-seed-fixtures.amended.feat` + `.amended.contract.json` (full copy with a WHAT CHANGED header, as `drafts/adapter-interface` did), `packages/feature/fixtures/seed/outline-*/`

## The fault (proved 2026-11-10, before any scenario was written)

1. `derive()` substitutes a row into `when`, `delivers`, `given.executes`, `given.faults` and the predictions. For seeds `substituteGiven` does `out.seeds = given.seeds`: the same array, `{ $placeholder }` objects intact, in every row.
2. The harness seeds `adapter.seed(seed.records)` verbatim. A scratch two-row outline run through the real `feat generate` and `vitest` against the memory adapter (its `seed()` logged) seeded `{"itemId":{"$placeholder":"id"},"name":"Item-<n>","qty":{"$placeholder":"q"}}` in BOTH rows. Seed placeholders never worked at run time, not only at validation.
3. `checkSeeds` validates a shared array once (`done` map), so a typed field holding `<placeholder>` is refused on row 1 even when every row's value is valid.
4. Sift: C2-18 (`stream: <enablement>`, `customerWorkspace: <ws>`, `enabledRef: { stream: <enablement> }`, nested in `data`) and C3-56 (`candidates: [ { type: <kind> } ]`) are whole-value placeholders at depth, which is what SPEC-DRV-001 substitutes; no in-string placeholder is involved.

## Part 1: SPEC-DRV-001 "Derive substitutes each outline row into its own seeds"

Home and number by precedent: specs sit beside the package they describe (`packages/feat-core/parse.feat` SPEC-CORE-001, `packages/feat-runtime/*.feat` SPEC-RT-*, `packages/feature/generate-seed-fixtures.feat` SPEC-GEN-001), the id is `SPEC-<AREA>-<nnn>`, and no `SPEC-DRV` or `SPEC-DER` exists anywhere, so `packages/feat-derive/derive-seeds.feat`, SPEC-DRV-001. (feat-derive has no `.feat` and none of its tests are spec-generated today.)

Rule: an outline row's values are substituted into every inline seed record's `values`, exactly as into a `given.executes` payload (`substituteValue`), at any depth in objects and arrays; each row gets its own seeds array, records and values; service, type and schemaName copy unchanged.

Edge-case decisions:
- Whole value only: `<id>` takes the row's cell as written, whatever its kind (string, number, boolean, null, object, array). `"Item-<n>"` stays literal, as in every other field today (accepted choice).
- Fixture seed (`seed x from "<path>"`): never substituted, path included; carried into each row as written (accepted choice).
- Missing column: derive throws `Outline row is missing a value for placeholder '<name>'`. There is NO error code to reuse: all three throw sites in derive are plain `Error`s, and `prepareAll` lets them propagate uncoded (generate crashes with the message). The spec keeps that message and mechanism for seeds. The probe labels it `DERIVE_THREW`, which is the probe's wrapper, not a derive code. Open choice 1.
- Non-outline scenario: seeds are the parsed seeds, untouched, a `<x>` left as the parser made it. This matters: substituting with the empty row `{}` would make derive throw for a non-outline seed that holds a `<x>`, which does not happen today. Build must gate on the scenario being an outline (`rawRow !== null`).

Observability: derive is pure and has no existing probe. Minimal addition named: `DeriveSeeds { spec, config }` in `packages/feat-derive/fixtures/probe.mjs` (about 20 lines, in the draft tree), a new command in `feat.config.json`, answering `{ cases: [{ name, seeds }], seedsShared }`. The suite is the repo's usual generated test; `packages/feat-derive/package.json` needs `devDependencies: "@mmmnt/feat-runtime": "workspace:^"` (feat-core has the same) for the generated test's import to resolve.

## Part 2: SPEC-GEN-001 amendment

Changes to the `enforce:` block:
- `rejects SEED_VALUES_INVALID when ... in a scenario that is not an outline` (was: any inline seed).
- `rejects SEED_ROW_VALUES_INVALID when ... in an outline row, after the row's values are substituted` (new).
- `validate each outline row's own substituted seeds, never one shared array, and check a fixture seed once` (new). The `done` sharing of `checkSeeds` goes.

Decisions:
- New code: **SEED_ROW_VALUES_INVALID**. It sits in the SEED_* family beside SEED_VALUES_INVALID (same failure, schema values, in a narrower context), says "row" where the anchor says `row[n]`, and cannot be mistaken for the fixture codes. Candidates rejected: SEED_OUTLINE_VALUES_INVALID (longer, "outline" is the scenario form, the row is what failed), SEED_ROW_INVALID (loses "values"). The founder confirms it at the flip.
- Anchor: `scenario "<name>" given › seed[i] record j › row[n]`, n 1-based as derive names rows (`row[1]` first). The detail line is `SEED_ROW_VALUES_INVALID: <anchor>: values fail schema '<S>': <errors>`.
- Counting: each bad record in each row is one violation. A placeholder-free inline seed in an outline is checked in every row, so one bad record in a 2-row outline is 2 violations (scenario "without a placeholder").
- First-violation code and order: spec, then scenario, then row, then seed, then record (row-major: the cases are already in that order). The code is the first violation's code; count and detail cover all of them. A spec with an outline row violation first and a plain violation later is refused as SEED_ROW_VALUES_INVALID, count 2, both lines in the detail (scenario "reported together").
- Fixture seed in an outline: checked, counted and inlined once per scenario (all its problems, found once, keep their fixture codes and anchors; they have no row, because they are not row-specific). Build note: derive carries the same seed object into each row, and `checkSeeds` caches per fixture seed object, including when it is refused, so a bad fixture is not re-reported per row. A path written as a placeholder is looked up as written: `SEED_FIXTURE_NOT_FOUND`, detail names `<path>`.
- Report counts: `records` counts inline records in every row (2 rows x 1 record = 2), a fixture's records once; `fixtures` counts a fixture once.
- Non-outline seeds keep `SEED_VALUES_INVALID` and their anchor; the twelve existing scenarios are unchanged and pass.
- Contract: `SeedFixtureError.code` enum gains the code.

Edge cases, by value kind (scenarios "every bad row..." and the valid-row ones): string value that satisfies the schema passes; number where the schema wants a string, and an object where it wants a string, each fail, one violation each; a value that makes the record valid raises nothing in that row regardless of the others.

## Scenario mechanics, proved in a scratch copy (not committed)

All draft files were copied into the worktree with a scratch config, `feat generate` + `vitest` ran, then everything was reverted (`git status` clean outside `drafts/`).
- Against unmodified source: SPEC-DRV-001 passes only the "not an outline" scenario (4 red: derive returns `{ $placeholder }` objects and `seedsShared: true`; the missing-column case returns OK); the amendment's twelve existing scenarios pass, the three fixture-once scenarios pass (today's code already checks a fixture once), and five outline scenarios are red (SEED_VALUES_INVALID, count 1, no row).
- With a temporary patch (derive's `substituteGiven` substituting `r.values` per row for outlines only; `checkSeeds` without `done`, a row suffix and code from the case name `... › row[n]`, a per-fixture-seed cache): 4/4 DRV and 20/20 amendment scenarios green. Response literals compare by deep equality, so each scenario asserts the whole `cases` array.
- Build risk: row detection in `checkSeeds` is by the case name suffix ` › row[n]` (as the existing scenario-name stripping is). A plain scenario literally named `x › row[1]` would be read as a row. Cleaner: `TestCase` carries `row?: number`; that is an IR-visible field, so it is left to the build to choose.

## Open choices for the founder
1. Missing placeholder column has no code today (uncoded Error). Keep as is (drafted), or give derive a real code (for example OUTLINE_PLACEHOLDER_MISSING) and have `prepareAll` collect it instead of crashing; that is a separate, larger change.
2. The code name SEED_ROW_VALUES_INVALID.
3. Placeholder-free outline seeds count per row (drafted); the alternative is to check them once with the old code.
4. Row detection mechanism for the build (case-name suffix, or a `row` field on `TestCase`).
