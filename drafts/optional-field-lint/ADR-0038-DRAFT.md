# ADR-0038 (DRAFT): an omitted optional property is an error, unless the block says `partial`

- **Status:** Draft. Founder rulings 7d3026eb-73ec-5a92-b3fe-e2fcb7b42a31 (2026-11-22, "Fix specs + Feature lint
  (Recommended)") and 55fb39c4-d774-5f92-a62b-4bce3f352f28 (2026-11-23, L1–L5).
- **Amends:** ADR-0002 (value blocks are partial: semantics unchanged); ADR-0007 (lint rules: one rule added, at error
  level); SPEC-CORE-001 (one keyword in the record and response heads).

## Context

A value block is partial (ADR-0002, grammar reference §5.4): it asserts the fields it lists, and shape completeness is
the schema's job. The schema rejects a key it does not declare, but an **optional** property it declares can appear,
unpredicted, and nothing reports it. Prediction inversion says anything unpredicted is a violation; for optional
properties it was not. Found in flmnt: FLMNT-SPEC-MEM-019's "an empty one has no last write" stayed green with a
handler that added `lastWriteAt`. An object inside a list is already exact (ADR-0034, cc58ae94).

## Decision

1. **The rule — `feat lint`, error `OPTIONAL_UNSTATED` (L2, "Error now"):** for every predicted response and record
   value block, each optional property of the block's resolved schema (its properties minus its required ones,
   following `allOf` and the local `$ref`s of the schema adapter's bundle) that the block does not list is an error:
   `error [OPTIONAL_UNSTATED]: scenario "<name>" › <service> <type>: <Schema> leaves out optional 'a', 'b' — state each
   (absent, any, or a value), or mark the block '<Schema> partial { … }' (ADR-0038)`. `feat lint` exits 1.
2. **The marker (L1, "`partial` keyword"):** the keyword `partial` sits where `equals fixture` sits, between the
   schema name and the block — `graph has [ REMOVE with NodeRecord partial { id: "e1", streamId: "ws::domain" } ]`,
   `response 200 Probe partial { ok: true }`. It records `"partial": true` on the record or response prediction in the
   IR (`schemas/builtspec.schema.json`). The runtime's comparison is unchanged; the keyword says, in the spec, that
   the rest is unchecked on purpose, and the lint then names nothing for that block.
3. **Refused as `MALFORMED_SYNTAX` (L4):**
   - in data: a `when:`/`execute`/`deliver` payload or a seed record (`'partial' is refused in data` /
     `'partial' is refused on a seed`);
   - inside a value: a field's value or a list item (`'partial' is refused inside a value`; an object in a list is
     exact, ADR-0034);
   - beside `equals fixture`, before or after it (`'partial' is refused beside 'equals fixture'`: a golden is whole);
   - with no value block after it (`'partial' must be followed by a value block`).
   `partial` joins the reserved words of compiler-zone blocks; agent zones stay freeform.
4. **Migration by hand (L3, "Migrate by hand"):** no codemod. Every flagged block in Feature (packages, adapters,
   actions and corpus) gets a deliberate choice — `partial`, `absent`, or the value — recorded in
   `drafts/optional-field-lint/migration.md` for review before it is applied. flmnt's three blocks (FLMNT-SPEC-PRJ-007
   Erase's two REMOVE records and FLMNT-SPEC-PRJ-004 Rebuild's INSERT record) are marked `partial` (L5).
5. **Order of landing:** the grammar and the IR first, then the migration, then the lint at error level, in one
   release, so Feature's own gate is never red on its own rule.

## Rejected alternatives

- **A trailing `...` in the block** (the draft's first recommendation): rejected by L1; the keyword reads beside the
  schema it qualifies, where `equals fixture` already reads.
- **Warning first, error later:** rejected by L2.
- **A codemod that marks every flagged block partial:** rejected by L3 — it would silence the rule without a decision
  per block, which is the gap the rule closes.
- **Exact top-level blocks** (report every unpredicted field, as lists do): reverses ADR-0002 and breaks every spec
  that lists a few fields of a large record.
- **Spec-only fixes, no lint:** the gap returns in the next spec written.

## Consequences

- An unmarked block is a claim that every optional field it can carry is stated; `partial` is a visible exception.
- `feat lint` loads each spec's contract through the schema adapter, as `generate` does.
- Lint rules stay hand-tested (`packages/feat-analyze/lint.test.ts`, ADR-0007); the keyword and its refusals are
  SPEC-CORE-001 scenarios with one new exemplar (`fixtures/ok/partial-blocks`) and eight refusal fixtures
  (SPEC-BAD-136 to -143).
