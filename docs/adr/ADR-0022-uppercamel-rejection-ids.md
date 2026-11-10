# ADR-0022 — UpperCamel rejection ids beside UPPER_SNAKE

Status: Accepted (founder, 2026-11-09: "agreed"; "put the ADRs in the repo"). Built in e53230a (SPEC-CORE-001).

Decided under Sift workspace 19878957 (1), the decision to accept UpperCamel rejection ids, and
ruling 0026e0ea ("flip the specs"; build order: SPEC-CORE-001 first).

## Context

Before this ADR the id of `rejects <ID> when ...` and `predict rejection <ID>:` had to match
`[A-Z0-9_]+`. Products whose error vocabulary is UpperCamel (`NotOperator`, `AlreadyAnswered`)
had to rename their errors in the spec, so the spec and the product's own names diverged.

## Decision

1. A rejection id is one token, either UPPER_SNAKE (`[A-Z0-9_]+`, e.g. `UNIQUE_NAME`) or
   UpperCamel (`[A-Z][A-Za-z0-9]*`, e.g. `NotOperator`). Both forms are valid and may be mixed in
   one spec. This applies to the `rejects` enforce line, to `predict rejection <ID>:`, and to a
   rejection-id placeholder value in a scenario outline.
2. An id is kept verbatim in the IR and compared exactly and case-sensitively. `NotOperator` and
   `NOT_OPERATOR` are two different ids; the two-way lint (B2) is a set comparison on exact strings.
3. Anything else in the id position of a `predict rejection` line (`notOperator`, `Not_Operator`,
   `not-operator`) is a `MALFORMED_SYNTAX` parse error whose hint names both valid forms. A
   `rejects` line whose id is not valid remains an opaque enforce-zone constraint, and B2 then
   reports the predicted id with no `rejects`.
4. `predict error <CODE>:` stays UPPER_SNAKE only.
5. The language version stays `feat 1.0`. The change only widens what is accepted, so every v1.0
   file still parses (additive minor rule, ADR-0005). The grammar reference is v1.2, section 1.2.

Build order (ruling 0026e0ea): the SPEC-CORE-001 amendment was flipped first; the parser, the
TextMate grammar (`editor/feat.tmLanguage.json`), the corpus exemplar `corpus/rejection-camelcase/`
and the tests followed in e53230a.

## Consequences

- Additive: no existing spec changes meaning. A spec that used two ids differing only in case would
  now have two distinct ids; none existed, because only UPPER_SNAKE was accepted.
- A product's UpperCamel error names appear in specs unchanged.
- The id grammar has two forms, so a typo that lands in neither form (`notOperator`) is a parse
  error rather than a silent mismatch. A typo that lands in the other valid form (`NotOperator` vs
  `NOT_OPERATOR`) is a B2 lint failure.
- `predict error <CODE>` and `rejects` ids can now differ in form within one spec; this is
  intended.
- No change was needed to `schemas/builtspec.schema.json` (`rejectionId` is an unconstrained
  string), `feat-derive` or `feat-analyze`.

## Rejected alternatives

- **Lower-camel ids (`notOperator`).** Indistinguishable at a glance from identifiers and
  placeholders, and no product error vocabulary asked for it. Widening to it would also loosen the
  rule that an id is a constant.
- **One form only (UpperCamel replacing UPPER_SNAKE).** Breaks every existing v1.0 spec, which forces
  a major version for a convenience.
- **Case-insensitive comparison.** `NotOperator` and `NOT_OPERATOR` would silently be one id, and
  a lint match could pass for a name the product does not return. Exact comparison keeps the spec
  checkable against the product's own spelling.
