# Optional-field lint (DRAFT)

Founder ruling 7d3026eb-73ec-5a92-b3fe-e2fcb7b42a31 ("Fix specs + Feature lint (Recommended)").

- `ADR-0038-DRAFT.md` — the decision, level, migration, rejected alternatives.
- `parse.change.md` — the SPEC-CORE-001 grammar amendment (`...`) with its scenarios, and the lint's hand tests.
- `run.patch` — the prototype the counts below came from (feat-analyze `lintOptionalFields`, `feat lint` loading each
  spec's contract registry). Not applied on this branch; no `...` parsing in it yet (it counts unmarked blocks).

## Measured with the prototype (2026-11-22)

| Corpus | Specs | Flagged blocks |
|---|---|---|
| Feature package and adapter specs (`feat.config.json` at the root) | 48 | 367 |
| Feature `corpus/` exemplars | 7 of them flagged | 15 |
| flmnt, at origin/main 3b5f0b7 | 55 | 20 |
| flmnt, after its sweep (fix/optional-field-sweep) | 55 | 3 |

Most Feature hits are adapter probe results that are partial on purpose (`last`, `peekEqualsStop`, `readVia`,
`lastTypes`, `detail`, `distinctHosts`); they would take `...`.
