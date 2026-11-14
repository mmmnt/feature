# ADR-0027 — the negation matcher `not <matcher>`

Status: Accepted (founder ruling 9959cfbc, 2026-11-13: "Add `not` to Feature (Recommended)"). Built in
SPEC-CORE-001 (amended) and SPEC-RT-011 (new).

## Context

A value block can say what a field is (a literal, `@when.<path>`, `@deliver.<path>`,
`@<service>[i].<path>`, `any [type]`, `matching "<regex>"`, a nested block) or that it is `absent`. It
cannot say what a field is not. A consumer's Cycle executor redoes a Cycle under a new id: the redo's
`NodeChanged` must carry a `cycleId` that differs from the first attempt's. Neither id can be written as a
literal (both are minted), `any string` pins nothing, and `@log[0].data.cycleId` asserts the opposite of the
claim. The same gap shows for a status that must not be a given value and for a string that must not
match a pattern.

## Decision

1. A matcher may be written `not <matcher>`. `not M` passes when the field is **present** and `M` fails on
   its value. An absent field fails `not M` whatever `M` is: a negation states something about a value, so
   a missing value satisfies none.
2. The operand is one of: a literal, `@when.<path>`, `@deliver[i].<path>`, `@<service>[i].<path>`,
   `any <type>` (`uuid`, `timestamp`, `string`, `number`, `boolean`), `matching "<regex>"`, or an outline
   placeholder (`<name>`, or `matching <name>`), which derive substitutes per row as it does elsewhere.
3. The parser refuses, as `MALFORMED_SYNTAX` with a hint naming the spelling to use:
   - `not not M`: a double negation is `M`; write `M`.
   - `not absent`: it would mean "present", which is `any`; write `any`. One spelling per meaning.
   - `not any` (no type): `any` passes on every present value, so `not any` can never pass; write `absent`.
   - `not { … }`: the negation of a partial block is ambiguous (which field differs?); negate the field
     inside the block instead, `{ field: not <matcher> }`.
   - `not` with no operand.
   The IR schema refuses the same operands, so a hand-written IR cannot carry them either.
4. A reference operand that cannot resolve is a **violation**, never a pass, exactly as a plain reference
   is (ADR-0021): an `@<service>[i]` whose service captured nothing or whose index is out of range, and a
   path absent on the referent (`@when`, `@deliver` or the captured record). Without this rule, a negated
   reference would pass precisely when the thing it points at failed to happen.
5. The IR is `{ "matcher": "not", "operand": <matcher> }`. A capture reference inside `not` joins the
   closed service space (`UNKNOWN_SERVICE_KEY`), as one outside it does.
6. A violation names the negated matcher as written and, for a reference, the value it resolved to:
   `expected not @log[0].cycleId (= "c-1"), got "c-1"`; `expected a value that is not "Failed", field is
   absent`; `not @log[3].cycleId: @log[3].cycleId is out of range — log captured 1 record(s)`.
7. `not` is reserved in the value position of a value block only. The language version stays `feat 1.0`:
   the change is additive, every existing spec parses to the same IR, and the adapter interface and the Feat
   Host Protocol are unchanged.

## Consequences

- `schemas/builtspec.schema.json` gains the `not` matcher; `@mmmnt/feat-types` gains it in `Matcher`;
  the parser (feat-core), derive (outline placeholders inside `not`) and the runtime's `applyMatcher`
  implement it; the TextMate grammar scopes `not` as a matcher word.
- A suite generated before this change never contains a `not` matcher, so nothing regenerates for it.
- The corpus gains exemplar #17, `corpus/not-matcher/`.
