# Seed variables: the SPEC-GEN-001 amendment (draft)

Status: draft, awaiting the founder (flip `status draft` to `agreed` in the amended copy; it replaces `packages/feature/generate-seed-fixtures.feat`, `agreed` today, with its contract).
Ruling 2026-11-10: "Resolve, then validate (Recommended)".
Files (the tree mirrors the repo root):
- `packages/feature/generate-seed-fixtures.amended.feat` + `.amended.contract.json` (full copy, WHAT CHANGED header, as `drafts/gen-001-outline-seeds` did)
- `packages/feature/fixtures/seed/var-*/` (twelve fixture workspaces)
- `build-sketch.patch`: the scratch patch that made the scenarios green, for the builder to read, not to apply as is.

## The rule

The seed check substitutes the spec's declared variables into seed values before validating, wherever a variable's value is static at generate time. A variable with no static value is skipped for that field.
The substitution is the runtime's own (`substituteVariables`), run on a copy that is validated; the record is inlined as written and the harness substitutes it again at run time.

## The fault (proved before any scenario was written)

`checkSeeds` hands the record's values to the schema adapter as written. Repro (`feat generate`, unmodified main): `variables: when_at: string = "2030-01-01T00:00:00Z"`, `seed ... { validUntil: "${when_at}" }` against a `format: "date-time"` field is `SEED_VALUES_INVALID ... /validUntil must match format "date-time"`, and the run never sees it, because the same string would have been substituted to a valid instant.

## Evidence

1. IR. `parseVariableDefinition` (feat-core parse.ts) produces `{ kind: "call", fn: "now"|"iso"|"unique", offsetMs? }`, `{ kind: "number", value }`, `{ kind: "template", parts: (string | { ref })[] }`; a variable is `{ name, type: "string"|"number", definition }`. `offsetMs` only for now/iso (unique with an offset is a parse error). The IR carries them to every derived case as `case.variables` (derive index.ts: `testCase.variables = spec.variables`) and the clock as `case.given.clock`. NOTE: `feat-types` `VariableDefinition` still says `fn: "now" | "unique"` with no `iso` and no `offsetMs`; the runtime's `CaseVariable` is the accurate type. The build uses `CaseVariable` (a cast, as the sketch does) or fixes the type.
2. Static or not: see the table. The runtime's `resolveVariables(vars, frozenClock)` is the oracle: `unique` is random plus the wall clock; now/iso are `Date.parse(clock) + offsetMs` when `given.clock` is set, `Date.now() + offsetMs` otherwise; a number is its literal; a template joins its parts' resolved values. `resolveVariables` is exported by feat-runtime, which feature already depends on, so the check calls it on the static subset and never reimplements it.
3. Substitution today (read, then proved by a scratch run that logged the memory adapter's `seed()` through real `feat generate` and `feat run`): `substituteVariables` is applied to the WHOLE case once per case (given including seeds, when, predictions). A regex replaces each `${name}` inside any string with `String(value)`: whole-string and embedded alike (`"item-${n}"` seeded `"item-7"`), always a string (`qty: "${n}"` seeded `"7"`, a string, so an integer field is refused at the check and would be wrong at run time too), at any depth in objects and arrays (`tags: ["a-${n}", "${token}"]`, `nested: { x: "${until}" }` all substituted), numbers and booleans in the record untouched, keys never substituted. The grammar allows `${}` only inside string literals (a bare `k: ${n}` is `MALFORMED_SYNTAX`). Fixture records are inlined at generate time and then substituted at run time like inline ones (the scratch run seeded `"at":"${until}"` as `2030-01-01T00:00:00Z`). The runtime is consistent, so there is no larger defect and this amendment goes ahead.
4. Non-static variable: the narrowest skip that is buildable is the one string leaf. After substituting the static variables, any string leaf that still holds a `${nonstatic}` is a skipped field (its JSON pointer is recorded); the adapter is called on the substituted copy and every error whose text starts with `<pointer> ` or `<pointer>/` is dropped (feat-schema-json formats errors as `<instancePath> <message>`, one per ajv error, allErrors on). Every other field, `required` included, is checked as usual. Reported in the new `skipped` array of the success report, one anchor per skipped field (`scenario "<n>" given › seed[i] record j [› row[n]] › <pointer>`, fixtures `<path> record j › <pointer>`), `[]` when none. A string with both a static and a non-static reference is skipped as a whole (it cannot be known). A refusal does not carry `skipped` (an error is the answer).
5. Outline order: row first, variables second. derive substitutes the row into the seeds at generate time (`substituteSeeds`), then the harness substitutes variables at run time on the derived case. Proved: an outline row cell `"${good}"` substituted by derive into `validUntil: <when>`, then seeded as the variable's value (scratch run: row 1 seeded `2030-01-01T00:00:00Z`; a placeholder inside a string stays literal and the variable inside the same string still substitutes: `"<n>-${n}"` seeded `"<n>-7"`). The check reads the derived row case, so it sees the row-substituted values and applies variables on top: the same order.
6. Unknown `${name}`: in an inline seed, a scenario, a row cell: parse refuses it, `UNKNOWN_VARIABLE` listing the declared names, before the check runs (this holds with zero declarations too). The runtime itself leaves an undeclared name as written (`name in resolved ? ... : whole`); a fixture file is the only place one can arrive (the parser never reads fixtures), and the scratch run seeded `"miss":"${nope}"` literally. The draft matches: left as written, validated as written, so a date-time field holding `${nope}` in a fixture is `SEED_FIXTURE_VALUES_INVALID`. A scenario in a spec with no variables is not substituted at run time at all, the same literal result.

## Static at generate time, by source kind

| Source | Static? | Value the check uses |
|---|---|---|
| number literal (`n: number = 7`) | yes | the number, rendered as text (`"7"`) |
| string template (`"2030-${m}"`) | iff every referenced variable is static | the joined text |
| `now()` / `now(ms)` with `clock at` in the scenario | yes | `Date.parse(clock) + ms`, epoch millis, rendered as text |
| `iso()` / `iso(ms)` with `clock at` | yes | `new Date(Date.parse(clock) + ms).toISOString()` (milliseconds always present, `...00.000Z`) |
| `now()` / `iso()` (with or without offset), no `clock at` | no | skipped for that field |
| `unique()` | never | skipped for that field |

The scenario clock is per scenario, so every row of an outline shares it. A variable is judged per case, a spec may have static and non-static variables side by side.

## Scenarios (twelve, appended; the twenty existing are unchanged)

static literal valid; static literal invalid (SEED_VALUES_INVALID, anchored); embedded valid; embedded invalid; number variable is a string (integer field refused); `iso(ms)` under `clock at` valid; `now()` under `clock at` refused as an epoch string; non-static fields skipped and reported; a skipped field does not hide a sibling's violation; outline row plus variable (row 2 refused, row 1 passes); fixture record substituted; undeclared name in a fixture validated as written.

## Mechanics proved in a scratch copy (then reverted; `git status` clean outside `drafts/`)

- Against unmodified source, with the amended spec and contract: 20 existing scenarios pass except the five success scenarios (they miss `skipped`, a field the amended contract requires); of the twelve new ones, seven are red (the five that expect success, the sibling case and the outline) and five pass trivially, because their literal `${...}` string fails the same field too: static-bad, embedded-bad, number-typed, clock-bad, fixture-undeclared. These five prove the refusal code and anchor stay right under the build, not the substitution.
- With `build-sketch.patch` (seed-fixtures.ts and pipeline.ts only): 32/32 green through `feat generate` and `feat run --spec SPEC-GEN-001`.
- Response literals match field by field, so the existing scenarios, which do not name `skipped`, are unaffected by the extra field once built.

## Open choices

1. `skipped` in the report (drafted: always present, an array of anchors) against reporting skips only in the `feat generate` output, or not at all. `generate` prints nothing about seeds today, so the report is the only channel; the amended contract makes `skipped` required, so five existing success scenarios are red until the build lands (drop `skipped` from `required` to keep them green meanwhile).
2. Fixture records are in scope (drafted: the runtime substitutes them, so the check must). Alternative: inline records only, leaving fixtures literal.
3. Skip granularity: the one string leaf (drafted). A schema error raised at an ancestor on behalf of the skipped leaf (a `oneOf`/`anyOf` at the parent pointer) is NOT dropped; the build may widen the skip to the record if that proves noisy, which the founder's "that field" rule does not say.
4. A partially static string (static and non-static refs in one string) is skipped whole (drafted); the alternative, checking the static parts, needs a schema-aware partial validation that does not exist.
5. Error-path matching uses the adapter's message prefix (`<pointer> `). That works with feat-schema-json today; another schema adapter with a different message form would need a structured path, which is a change to `FeatSchemaAdapter.validate` (not drafted).
6. The static test needs `case.variables` and `case.given.clock`, both present in the topology today; the `feat-types` `VariableDefinition` omits `iso` and `offsetMs` (see evidence 1) and should be corrected in the build.
