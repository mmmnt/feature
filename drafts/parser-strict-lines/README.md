# Parser bugs (a)–(e): the stricter line rules (DRAFT)

Status: draft, awaiting the owner. Nothing here is built, and no agreed spec is changed: the amended
SPEC-CORE-001 beside this file is a copy at `status draft`.

| File | Layer |
| --- | --- |
| `ADR-0040-DRAFT.md` | the design decision (a language change needs an ADR) |
| `grammar-reference.change.md` | layer 1, the reference text, before and after |
| `corpus/strict-lines/` | layer 2, exemplar #22 (`.feat`, `.ir.json`, contract, config; the three validate against `schemas/`) |
| `packages/feat-core/parse.feat` | SPEC-CORE-001 amended (`status draft`): construct text, four enforce lines, eleven scenarios |
| `packages/feat-core/fixtures/bad/*.feat` | twenty refusal fixtures, SPEC-BAD-144 to -163 |
| `packages/feat-core/fixtures/ok/header-shaped-lines.*` | one ok fixture, SPEC-OK-203, with its IR |
| `parser.change.md` | layer 3, what changes in `parse.ts`, for the implementer after the flip; layer 4, the re-validation |

The IR files were made by running today's parser on a copy with the changed lines replaced by placeholders,
then putting the lines back by hand (`context matters` as a custom construct directive; the scenario name
decoded). They show what the parser must produce after the change; today's parser refuses or misreads both
`.feat` files.

## Reproduction (run on main 72f71de, Node 24.19.0)

Every fixture in `fixtures/bad/` through today's CLI:

```sh
for f in drafts/parser-strict-lines/packages/feat-core/fixtures/bad/*.feat; do
  node packages/feature/bin/run.js parse "$f" --config packages/feat-core/fixtures/parse.config.json; echo "exit=$?"
done
```

| Fixture | Today | After (proposed) |
| --- | --- | --- |
| `missing-predict` | exit 1, `TypeError: Cannot read properties of undefined (reading 'services')` | `MISSING_MINIMUM`, line 21 |
| `string-escape-invalid` (`"a\qb"`) | exit 1, `SyntaxError: Bad escaped character in JSON at position 2` | `MALFORMED_SYNTAX`, `Invalid escape '\q'` |
| `string-escape-unicode-short` (`"caf\u00e"`) | exit 1, `SyntaxError: Bad Unicode escape in JSON at position 3` | `MALFORMED_SYNTAX`, `Invalid escape '\u'` |
| `string-escape-scenario-name` (`scenario "does the \q thing":`) | exit 0, name recorded as `does the \q thing` | `MALFORMED_SYNTAX`, line 21 |
| `duplicate-when` | exit 0, `when.payload` is `{ value: 2 }`: the first `when:` is gone | `MALFORMED_SYNTAX`, line 23 |
| `duplicate-has` | exit 0, `eventStore.records` is `[]`: the predicted record is gone | `MALFORMED_SYNTAX`, line 26 |
| `duplicate-contains`, `duplicate-response`, `duplicate-clock`, `duplicate-random-seed` | exit 0, the last one wins | `MALFORMED_SYNTAX` at the second |
| `duplicate-predict` | exit 0, `prediction.type` is `success`: the `predict rejection NOT_ALLOWED` block is gone | `MALFORMED_SYNTAX`, line 27 |
| `duplicate-header-status` (`status draft`, then `status agreed`) | exit 0, status `agreed` | `MALFORMED_SYNTAX`, line 8 |
| `comment-trailing-execute`, `-seed`, `-clock` | exit 0, the line is `given.context` (`"execute DoThing { value: 0 }   # warm up"`): the step never runs | `MALFORMED_SYNTAX` at the line |
| `comment-trailing-touches` | exit 0, `{ kind: "custom", text: "touches lib/**   # and lib" }` | `MALFORMED_SYNTAX`, line 12 |
| `comment-trailing-handler` | exit 0, `{ kind: "custom", text: "handler at src/do-thing.ts   # the handler" }`: no handler in the IR | `MALFORMED_SYNTAX`, line 10 |
| `comment-trailing-response` | exit 0, the comment is dropped | `MALFORMED_SYNTAX`, line 24 |
| `comment-trailing-has`, `comment-trailing-when` | exit 1, `MALFORMED_SYNTAX` "Unrecognized … line", no hint | `MALFORMED_SYNTAX`, with the comment hint |

And (e). `fixtures/ok/header-shaped-lines.feat` (header `status draft`; `status agreed` and `type safety`
in `construct:`, `context matters` in `enforce:`, `aggregate Other` in `given:`) is refused today: exit 1,
`MALFORMED_SYNTAX` at line 18, "Unknown spec type 'safety'". A scratch spec without the `type safety` line
(header `context Bad`, `aggregate Thing`, `status draft`; `status agreed` in `construct:`, `context
Elsewhere` in `enforce:`, `aggregate Other` in `given:`) parsed with exit 0 and the identity
`{ context: "Elsewhere", aggregate: "Other", status: "agreed" }`, and none of the three lines appeared in
construct, enforce or given. A draft spec read as agreed is a spec the build gate would build.

Sweep of the repository (two throwaway scripts over `git ls-files '*.feat'`, 275 files on main): no tracked
spec has a trailing `#` comment, a non-JSON escape, a header line after the header, a second `when:`, a
second `has` for a service, or a `construct:`/`given:` line beginning with a keyword that does not parse. One
tracked spec has an escape on a line: SPEC-RT-014's name, `"… sha256 \"<hex>\""`, recorded today with the
backslashes.

## Decisions for the owner

Each with the recommendation first. "Option" text is phrased to be put to the owner as is.

1. **(a) A scenario with no `predict`.**
   - **A. `MISSING_MINIMUM` at the scenario's opener (Recommended).** No new code; §1.2 already counts the
     prediction in the minimum.
   - B. `MALFORMED_SYNTAX` "has no prediction", mirroring "has no trigger".
   - C. A new code, `MISSING_PREDICTION` (a ParseError schema and feat-types change).
2. **(b) String escapes in values.**
   - **A. Support `\uXXXX` and refuse every other non-JSON escape as `MALFORMED_SYNTAX` (Recommended).**
     A payload is a JSON literal position and a contract fixture is JSON.
   - B. Refuse `\uXXXX` too, as `MALFORMED_SYNTAX`.
3. **(b′) Strings on a line (spec name, scenario name, `clock at`, fixture paths, `stream`).**
   - **A. The same JSON rule; the IR records the decoded string (Recommended).** SPEC-RT-014's recorded name
     changes from `\"<hex>\"` to `"<hex>"` and its suite is regenerated in the same change.
   - B. Keep them raw, and only refuse a non-JSON escape there.
   - C. Leave them as they are (raw and unrefused) and fix values only.
4. **(c) Duplicates.**
   - **A. `MALFORMED_SYNTAX` at the second line, naming the first, for `when:`, `has` and the siblings found
     by the sweep: `predict`, `response`, `contains`, `clock at`, `random seed`, each header key
     (Recommended).**
   - B. Only `when:` and `has`, as reported.
   - C. A new code, `DUPLICATE_LINE`.
5. **(d) Trailing `#` comments.**
   - **A. Refuse: `MALFORMED_SYNTAX` on every line the parser reads by keyword, and on a `construct:` line that
     is typed once the comment is removed; freeform text keeps its `#` (Recommended).** Nothing is silently
     shortened, and the sweep finds no tracked spec it breaks.
   - B. Strip: a `#` after a space or tab, outside a string, starts a comment on every line. `see ticket #12`
     in `enforce:` would be recorded as `see ticket`.
6. **(e) Header lines after the header.**
   - **A. Read the header directives in the header only; after it the line belongs to its zone, a directive
     or a context line (Recommended).** Agrees with SPEC-CORE-001 ("parse errors inside construct:/enforce:
     freeform text are impossible"); a field written only in a zone is `MISSING_MINIMUM`.
   - B. Refuse a header-shaped line after the header as `MALFORMED_SYNTAX`.
7. **Language version.**
   - **A. Stay `feat 1.0`, announced as a fix (Recommended).** Precedent: ADR-0023 reserved `fault` in
     `feat 1.0`; the sweep finds no tracked spec that stops parsing.
   - B. `feat 2.0`, since ADR-0005 reserves narrowing for a major.
8. **ADR.** A language change, so yes: ADR-0040 as drafted, or one ADR per decision if the owner wants to
   accept them separately.
