# ADR note — seed fixture validation (SPEC-GEN-001)

Recommendation: no new ADR. This is enforcement of ADR-0007 and completion of ADR-0003.

- ADR-0007 (FEATURES.md 1b "Closed schema reference space") already says every schema name used in
  scenarios, "incl. fixture schemaNames", must be declared in `contract:`. The parser enforces it for
  inline seeds (UNDECLARED_SCHEMA, packages/feat-core/src/parse.ts ~781-785) but cannot see inside a fixture,
  because the IR carries only the path. The generate step is the first place the records exist.
- ADR-0003 defines the fixture form and the record shape ({type, schemaName?, values}); grammar-reference
  line 211 already promises "`with <Schema>` validates seed data at generate time". Nothing implements that
  promise for either form.
- The mechanism is the configured schema adapter's existing `validate()` (FeatSchemaAdapter, feat-types),
  which no code calls today. No new config key, no new grammar, no IR change, no language-version change.
  New refusal codes are tool output, not grammar.

Two things that DO want a ruling (not an ADR), recorded as open questions in the report:
1. Whether inline `with <Schema>` values are also validated at generate time (same defect, promised by the
   grammar reference; changes behaviour of existing inline seeds, so excluded from SPEC-GEN-001 as drafted).
2. Whether a fixture record without `schemaName` stays legal (shape-checked only), as the SeedRecord type allows.

If the founder prefers a paper trail for the refusal codes, a one-paragraph amendment to ADR-0003 (not a new
ADR) naming the five SEED_FIXTURE_* codes and the 0-based record index is enough. Rejected alternative:
validating in the parser. It would make `feat parse` do file I/O and the parser would no longer be a pure
text-to-IR function (SPEC-CORE-001, INV-1).

Layer closure per CLAUDE.md for a language-visible change: the grammar reference needs one sentence (fixture
records are checked at generate time; codes listed) beside line 207-212; corpus exemplar #14 (staged in
drafts/seed-fixture-validation/corpus/seed-fixture/) is the new exemplar; parser and IR do not change.
Number note: #13 is claimed by drafts/uppercamel-rejection-id; renumber on promotion if that order flips.
