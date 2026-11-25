# DRAFT: parser change for ADR-0040, for the implementer after the flip (layer 3 of 4)

`packages/feat-core/src/parse.ts`, line numbers at main 72f71de. No IR field, type or schema changes.

1. **Missing prediction (decision 1).** Record each scenario opener's line when the scenario is opened
   (`:788`; keep it off the IR, in a side map as `givenSteps` does). In the scenario loop beside the trigger
   check (`:1029`), before `:1046` reads `prediction.services`: no `prediction` →
   `new ParseFailure("MISSING_MINIMUM", "Scenario '<name>' has no prediction.", <opener line>, "Add 'predict success:', 'predict rejection <ID>:' or 'predict error <CODE>:' with its lines (grammar reference §1.2).")`.
   A scenario with neither trigger nor prediction keeps today's "has no trigger".
2. **Strings (decision 2).** One decoder for every quoted string: `parseString` (`:189`) and the captures of
   `:743`, `:788`, `:821`, `:828`, `:897`, `:919`, `:953` and the template at `:676` go through it. On `\`
   take exactly the JSON escapes; for `u` require `/^[0-9A-Fa-f]{4}/` after it and consume six characters;
   anything else is `MALFORMED_SYNTAX` "Invalid escape '\<c>' in a string." with the hint
   "Valid escapes: \" \\ \/ \b \f \n \r \t \uXXXX.", and `withLine` for the line-level captures. The
   scanner's `scanDepth` (`:94`) and the `(?:[^"\\]|\\.)*` regexes stay as they are: a `\u` escape is a
   backslash and a character to them, and the four digits are ordinary characters, so string ends are found
   as before. No change downstream (verified by reading): `packages/feat-derive/src/index.ts` builds anchors and
   test names from the IR's `scenario.name` (`:233`-`:235`) and `spec.identity.name` (`:265`), so it gets the
   decoded string as it is.
3. **One of each (decision 3).** Before each assignment that replaces (`:744`-`:759`, `:862`, `:885`,
   `:898`, `:904`, `:958`, `:966`-`:967`) check the slot and throw
   `MALFORMED_SYNTAX` "A second '<what>' in <scope>; the first is on line <n>.", hint
   "Write '<what>' once per <scope>." with the second line. Keep the first line of each slot in a side map.
   A second `predict` is detected at `:879`, not at the end of the scenario.
4. **Trailing comments (decision 4).** Add `trailingComment(t): number | -1`, the index of the first `#`
   outside a string with a space or tab before it (the same string walk as `scanDepth`). Call it on every
   statement the dispatch reads by keyword before matching, and on a `construct:` line after stripping
   (`t.slice(0, i).trimEnd()` matches one of the typed regexes at `:796`-`:803`). Do not call it on
   `enforce:` constraints, `construct:` custom directives or `given:` context. Throw
   `MALFORMED_SYNTAX` "A comment must be on its own line: '<t>'.", hint
   "Comments are whole-line: move '# …' to a line of its own.", with the line. The response tail (`:955`)
   then never sees a comment; check also that `parseValueBlock`'s cursor reached the end of `rest` (it does
   not today, which is how `} # c` was dropped), refusing other trailing content with "Unrecognized response
   tail".
5. **Header region (decision 5).** Guard the header regexes (`:743`-`:760`) with `section === "none"`, as
   `observes` already is (`:764`). After a section opener they fall through to the zone: construct custom,
   enforce constraint, given context, or the zone's "Unrecognized … line".

Sweep, never enumerate: every `scenario.X = …`, `given.X = …`, `prediction.X = …`, `identity.X = …` and
`entry.X = …` assignment in `parseFeat` is one of decision 3's slots or a list; list each in the PR.

## Re-validation (layer 4)

`pnpm corpus:validate`; the corpus-sweeping tests (`parse-source-parity`, `invariants`, which pick up
`corpus/strict-lines/` by directory); the SPEC-CORE-001 generated suite; `feat generate` and `feat verify`
for SPEC-RT-014, whose recorded name changes under decision 2b; then the chain
`feat lint → feat generate → feat audit → feat run`.
