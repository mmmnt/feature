# ADR-0038 (DRAFT): an omitted optional property is named, unless the block says it is partial

- **Status:** Draft. Founder ruling 7d3026eb-73ec-5a92-b3fe-e2fcb7b42a31 ("Fix specs + Feature lint (Recommended)"),
  2026-11-22, chose the lint; the syntax, the level and the migration below are this draft's recommendations, open
  for ruling.
- **Amends:** ADR-0002 (value blocks are partial) — semantics unchanged; ADR-0007 (lint rules) — one rule added;
  SPEC-CORE-001 — one token added to the value-block grammar.

## Context

A value block is partial (ADR-0002, grammar reference §5.4): it asserts the fields it lists, and shape completeness is
the schema's job. The schema rejects a key it does not declare, but an **optional** property the schema declares can
appear, unpredicted, and nothing reports it. Prediction inversion says anything unpredicted is a violation; for
optional properties, today, it is not.

Found in flmnt: FLMNT-SPEC-MEM-019's "an empty one has no last write" stayed green with a handler that added
`lastWriteAt`, because the block never named it. An object inside a list is already exact (ADR-0034, cc58ae94); a
top-level or nested block is not.

## Decision

1. **The rule (feat lint, warn):** for every predicted response and record value block, each optional property of the
   block's resolved schema (properties minus required, following `allOf` and local `$ref`s in the adapter's bundled
   schema) that the block does not list is named:
   `warn: scenario "<name>" › <service> <type>: <Schema> leaves out optional 'a', 'b' — state each (absent, any, or a
   value), or mark the block partial with '...'`.
2. **The marker:** a block ending in `...` asserts its listed fields and says, in the spec, that the rest is unchecked
   on purpose: `graph has [ REMOVE with NodeRecord { id: "e1", streamId: "ws::domain", ... } ]`. IR:
   `"partial": true` on the record or response prediction. The runtime's comparison is unchanged (still partial); the
   marker only silences the lint.
3. **Refused as `MALFORMED_SYNTAX`:** `...` anywhere but last in a block; `...` in an object inside a list (lists are
   exact, ADR-0034); `...` in a `when:`/`execute`/`deliver` payload or a seed (they are data, not predictions); `...`
   in a block with `equals fixture` (a golden is whole).
4. **Level: warning in this release.** Measured against the drafts' prototype (`run.patch`): Feature's 48 package
   specs carry 367 flagged blocks (mostly adapter probe results that are partial on purpose: `last`, `peekEqualsStop`,
   `readVia`, `detail`), the corpus 15, flmnt 3 after its sweep (20 before). An error now would fail every Feature
   gate. Promote to an error by a later ruling, once Feature's own specs carry `...` or the fields.
5. **Migration:** a codemod (`feat fmt --mark-partial`, draft) appends `...` to every flagged block, so a corpus
   starts silent and each `...` is a visible, reviewable claim that the rest is unchecked. Reviewers remove a marker by
   stating the fields.

## Rejected alternatives

- **Exact top-level blocks** (report every unpredicted field, as lists do): the strongest inversion, but it reverses
  ADR-0002 and breaks every spec that lists a few fields of a large record — 367 blocks in Feature alone.
- **A `partial` keyword** (`NodeRecord partial { … }`): reads well, but it sits between the schema name and the block,
  where `equals fixture` already sits, and adds a reserved word; `...` reads as "and the rest" where the rest would be.
- **Error from day one:** fails Feature's own gate and every consumer's until migrated.
- **Spec-only fixes, no lint:** the gap returns in the next spec written.

## Consequences

- A spec's partial blocks become explicit; an unmarked block is a claim that every optional field is stated.
- The lint needs each spec's contract registry (the schema adapter), so `feat lint` loads contracts as `generate` does.
- Lint rules are hand-tested today (`packages/feat-analyze/lint.test.ts`, ADR-0007); this rule is too, plus the
  parser's `...` scenarios in SPEC-CORE-001.
