# ADR-0040: the parser refuses what it silently drops, replaces or rewrites

Status: Accepted (the owner's rulings 2026-11-25, recorded in flmnt, workspace feature; each the recommended
option): decision 1 "MISSING_MINIMUM"; decision 2a "JSON escapes + \uXXXX"; decision 2b "Same JSON rule,
decoded"; decision 3 "Refuse all of them"; decision 4 "Refuse on keyword lines"; decision 5 "Header only";
decision 6 "Stay feat 1.0", with one ADR-0040. Built in SPEC-CORE-001 (amended).
Inputs: the owner's ruling "Parser wins" (commits 1d0a075 and 5e5136c, 2026-11-25), which made
`docs/grammar-reference.md` describe what the parser does today, including five behaviours the reference
now has to state as defects. This ADR proposes the rules that let the reference state stricter ones.
Governs: SPEC-CORE-001 (`packages/feat-core/parse.feat`, amended), `docs/grammar-reference.md`,
the corpus (exemplar #22, `corpus/strict-lines/`), the parse fixtures.

## Context

§1.3 of the reference says of the compiler zone: "Malformation is a parse error, never a silent failure."
SPEC-CORE-001 says of the agent zones: "parse errors inside construct:/enforce: freeform text are impossible."
The parser breaks both. Each item below was run on main (72f71de) with
`node packages/feature/bin/run.js parse <fixture> --config packages/feat-core/fixtures/parse.config.json`;
the fixtures are in `packages/feat-core/fixtures/bad/`. The draft's README (`drafts/parser-strict-lines/README.md`,
commit 55373d5) has the commands and outputs.

| | Input | What the parser does today | Where |
| --- | --- | --- | --- |
| a | a scenario with a `when:` and no `predict` | throws `TypeError: Cannot read properties of undefined (reading 'services')`, uncaught: no code, no line | `packages/feat-core/src/parse.ts:1046` reads `prediction.services` of an undefined `prediction`; the trigger check (line 1029) has no prediction twin |
| b | `"a\qb"`, `"caf\u00e9"` in a payload or value block | throws `SyntaxError: Bad escaped character in JSON` / `Bad Unicode escape in JSON`, uncaught | `parse.ts:197`: `JSON.parse(\`"\\${c.peek()}"\`)` hands JSON one character after the backslash, so `\u` never sees its four digits |
| b′ | `scenario "a \q b":`, `spec X "say \"hi\""` | accepted and recorded **raw**: the IR name keeps the backslashes, and `\q` is not refused | the line-level regexes (`parse.ts:743`, `:788`, `:821`, `:828`, `:897`, `:919`, `:953`; `:676` for a `variables:` template) match `(?:[^"\\]|\\.)*` and keep the capture as written |
| c | a second `when:`, `predict`, `response`, `has` or `contains` for one service, `clock at`, `random seed`, header key | the later line replaces the earlier one, silently. A second `predict` drops a whole `predict rejection` block | `parse.ts:862` (`scenario.when = when`), `:885` (prediction), `:958` (response), `:966`-`:967` (`has`, `contains`), `:898` (clock), `:904` (random), `:744`-`:759` (header) |
| d | `execute X { } # c`, `seed s [ … ] # c`, `clock at "…" # c` in `given:` | each becomes a freeform `given.context` line: the step never runs | `parse.ts:905`, `:919`, `:922` anchor on `\}$`, `\]$`, `"$`; the fall-through at `:930` makes it context |
| d | `touches lib/** # c`, `handler at x.ts # c` | a `custom` construct directive: the change boundary or the handler is gone from the IR | `parse.ts:796`-`:804` anchor on `(\S+)$` |
| d | `response OK R { ok: true } # c` | the comment is dropped without a word | `parse.ts:955`: `parseValueBlock` stops at the block's `}` and the tail is never checked |
| d | `eventStore has [] # c`, `when: X { } # c` | `MALFORMED_SYNTAX` "Unrecognized prediction line" / "scenario line", hint none | `:972`, `:997` |
| e | `status agreed` in `construct:`, `context X` in `enforce:`, `aggregate Y` in `given:` | sets the header field, overwriting the header; a `draft` spec reads as `agreed`. `type safety` in `construct:` is `MALFORMED_SYNTAX` ("Unknown spec type") | `parse.ts:743`-`:760`: the header regexes run before the section dispatch, for every line of the file |

A sweep of every tracked `.feat` file (275 on main) with the scratch scripts described in the draft's README found
none that uses a trailing comment, a string escape outside JSON's single-character set, a header line after
the header, a second `when:` or a second `has` for a service, or a `construct:` or `given:` line that begins
with a keyword and does not parse. The only tracked spec whose IR the decisions below change is
SPEC-RT-014: its name `"Matcher: the f32 digest f32 <dims> sha256 \"<hex>\""` is recorded today with the
backslashes, and under decision 2b it is recorded with the quotes.

## Decision

1. **A scenario without a prediction is `MISSING_MINIMUM`.** The message names the scenario, the line is the
   scenario's opener, and the hint names the three forms. It is checked with the trigger, before anything
   reads the prediction. No new code: §1.2 already lists the prediction under the minimum, and the code is
   the one the language uses for the no-escape-hatch minimums.
2. **Strings are JSON strings, everywhere.**
   a. The escapes are JSON's: `\"` `\\` `\/` `\b` `\f` `\n` `\r` `\t` and `\uXXXX` (exactly four hex digits;
      a surrogate pair is two escapes and decodes to one code point, as JSON). Any other escape, and a `\u`
      without four hex digits, is `MALFORMED_SYNTAX` naming the escape, hint
      `Valid escapes: \" \\ \/ \b \f \n \r \t \uXXXX.`, with no line, as every other refusal inside a value is.
   b. The same rule holds for every quoted string on a line: the spec name, a scenario name, `clock at`,
      `seed … from`, `equals fixture`, `stream`, `contract … from`. The IR records the decoded string; an
      invalid escape there is `MALFORMED_SYNTAX` with the line.
3. **One of each per scope.** A second `when:` in a scenario, a second `predict` block, a second `response`
   line in a prediction, a second `has` or a second `contains` for one service in a prediction, a second
   `clock at` or `random seed` in a given, and a second `spec`, `context`, `aggregate`, `type` or `status`
   line in the header are `MALFORMED_SYNTAX` at the second line, the message naming the first one's line.
   (`observes` is already refused twice, ADR-0033; `DUPLICATE_SCENARIO_NAME` stays the code for scenarios.)
   Lines that are lists by design stay repeatable: `execute`, `seed`, `fault`, `deliver`, `touches`, `needs`,
   the contract entries.
4. **Comments are whole-line, and a trailing one is refused where the parser reads the line.** A `#` outside
   a string with a space or tab before it is a trailing comment. On a compiler-zone line (header, contract,
   variables, a scenario opener, `when:`, `deliver`, `predict`, `response`, `has`, `contains`, an examples
   row, a given `execute`, `seed`, `clock at`, `random seed` or `fault` line) and on a `construct:` line that
   is a typed directive once the comment is removed (`handler at`, `imports … from`, `register … in`,
   `emit to`, `touches`, `needs`), it is `MALFORMED_SYNTAX` with the line, hint
   `Comments are whole-line: move '# …' to a line of its own.` Freeform text keeps it as text: an agent-zone
   directive (`see ticket #12`) and a given context line. A `#` with no space before it is part of its
   token (`src/#gen/**`), and a `#` inside a string is data (`"#1"`).
5. **Header directives are read in the header only.** The header is the lines after the pragma and before
   the first section opener. After it, a header-shaped line is whatever its zone makes it: a directive in
   `construct:` and `enforce:` (recorded verbatim, never a parse error, as SPEC-CORE-001 already promises),
   a context line in `given:`, and elsewhere an unrecognized line (`MALFORMED_SYNTAX`). A header field
   missing from the header is then `MISSING_MINIMUM`, as a missing one is today.
6. **The language stays `feat 1.0`.** These rules narrow what parses, which ADR-0005 reserves for a major.
   The precedent is ADR-0023, which reserved `fault` in `given:` within `feat 1.0` ("reserved inside given:
   in feat 1.0"), and the sweep above finds no tracked spec that stops parsing. The change is announced as a
   fix: every refused input was a silent misreading, so a spec it breaks was not doing what it said.

## Consequences

- `packages/feat-core/src/parse.ts`: the scanner and the line dispatch change as in `parser.change.md`.
  No IR field is added or removed; `schemas/builtspec.schema.json`, `@mmmnt/feat-types`, `feat-derive` and
  the runtime do not change. The ParseError code set does not change.
- `docs/grammar-reference.md` §1.2, §1.3, §2, §5 (the example), §5.2 and §5.3 change as in
  `grammar-reference.change.md`; the reference becomes v1.4.
- The corpus gains exemplar #22, `corpus/strict-lines/`; SPEC-CORE-001 gains one exemplar scenario, one ok
  fixture (SPEC-OK-203, `header-shaped-lines`) and twenty refusal fixtures (SPEC-BAD-144 to -163).
- Decision 2b changes SPEC-RT-014's recorded name; its generated suite is regenerated in the same change
  (`feat generate`, then `feat verify`). Nothing else regenerates.
- The TextMate grammars should follow decision 4 (scope `#` as a comment only at the start of a line) and
  decision 2 (escapes inside strings). That is SPEC-GRM-001's (`packages/feat-grammar/grammar.feat`), not this ADR's.
- The LSP and any embedder of `parseSource` stop seeing raw `TypeError` and `SyntaxError` throws from
  ordinary input: every refusal is a `{ status: "ERR", body: { code, message, line?, hint? } }`.

## Amendment (2026-11-26): the two remaining overwrites

The owner's ruling, 2026-11-26: "fix them", treated as decision 3 ("Refuse all of them"). Building decision 3 left
two silent overwrites:

- a second `given:` in a scenario merged into the first, so two blocks read as one;
- a service's `ordered`/`unordered` is one IR field (`prediction.services.<key>.ordering`) that both its `has`
  and its `contains` line could write, and the later one replaced the earlier. Only the `has` diff reads it, so a
  `contains unordered` after `has ordered` silently changed how the captured records are compared.

Both are now `MALFORMED_SYNTAX` at the second line, the message naming the first: a second `given:`, and the second
of a service's `has` and `contains` lines to write an ordering. An ordering written on one line only is unchanged
(also on a `contains` line, as before). No IR field changes; SPEC-CORE-001 gains three refusal fixtures (SPEC-BAD-164
to -166), and no tracked spec writes either form.

## Rejected alternatives

- **Strip trailing comments everywhere** (the other option for decision 4). It is the shell and YAML habit
  and turns every case in the table into a pass. It also changes freeform text: `see ticket #12` in
  `enforce:` would be recorded as `see ticket`, an instruction to the agent silently shortened. Stripping
  only on compiler lines makes the rule depend on the zone, the inconsistency this ADR removes.
- **Header lines refused after the header** (the other option for decision 5). Loud for a misplaced
  `status agreed`, but it makes `context matters` in `construct:` a parse error, which SPEC-CORE-001 rules
  out for freeform text. Decision 5 is loud anyway when it matters: a header field that is only in a zone is
  missing from the header, and that is `MISSING_MINIMUM`.
- **A new code per family** (`MISSING_PREDICTION`, `DUPLICATE_LINE`, `INVALID_ESCAPE`,
  `TRAILING_COMMENT`). Each is a malformation of one line or a missing minimum; the codes the language has
  already say so, and a new code is a schema and types change for every consumer.
- **Refuse `\uXXXX`** (the other option for decision 2a). Simpler, but a payload is a JSON literal
  position (§1.4) and a contract fixture is JSON: a control character or a lone code unit could be written in
  one and not the other.
- **Keep line-level strings raw** (the other option for decision 2b). It keeps SPEC-RT-014's name as it is,
  and keeps two string rules in one language.
