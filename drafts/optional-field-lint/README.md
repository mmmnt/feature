# Optional-field lint (DRAFT)

Founder rulings 7d3026eb-73ec-5a92-b3fe-e2fcb7b42a31 ("Fix specs + Feature lint (Recommended)") and
55fb39c4-d774-5f92-a62b-4bce3f352f28 (L1 `partial` keyword, L2 error now, L3 migrate by hand, L4 refusal sites, L5
flmnt's three blocks partial).

- `ADR-0038-DRAFT.md` — the decision, the keyword, the error, the refusals, the order of landing, rejected alternatives.
- `parse.change.md` — the SPEC-CORE-001 amendment (the `partial` keyword) with its scenarios, and the lint's hand tests.
- `run.patch` — the prototype, not applied on this branch: the parser's `partial` keyword and its refusals
  (`packages/feat-core/src/parse.ts`), `partial` on the IR (`schemas/builtspec.schema.json`, `feat-types`), the
  `OPTIONAL_UNSTATED` lint error (`feat-analyze`), `feat lint` loading each spec's contract and exiting 1 on it, the
  SPEC-CORE-001 scenarios and fixtures (SPEC-OK-202, SPEC-BAD-136 to -143), and six lint hand tests.
- `migration.md` — the hand migration plan (L3): every flagged Feature block, grouped by spec, with a proposed choice
  and a one-line reason. Not applied.

## Results with `run.patch` applied (2026-11-23)

- SPEC-CORE-001 (`packages/feat-core/parse.test.ts`): 105 of 105, the nine new cases included. Bugs put back, one per
  run: the record's `partial` not recorded (1 red), the seed refusal removed (1 red).
- Lint hand tests (`packages/feat-analyze/lint.test.ts`): 8 of 8. Bugs put back, one per run: `partial` ignored (1
  red), `allOf` not followed (1 red, after strengthening a test that first stayed green), warning level (1 red).
- The full Feature spec chain (`feat run`, root config): 970 of 970. `feat lint` at error level exits 1 on Feature
  itself until the migration lands (383 blocks), as ADR-0038 §5 orders.

## Counts the prototype reports

| Corpus | Flagged blocks |
|---|---|
| Feature package, adapter and action specs (root config) | 368 (367 plus one of the new SPEC-CORE-001 scenarios) |
| Feature `corpus/` exemplars | 15 |
| flmnt at origin/main after #312 | 3 (ruled `partial`, L5) |
