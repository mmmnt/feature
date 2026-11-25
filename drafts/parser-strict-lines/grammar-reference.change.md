# DRAFT: grammar-reference change for ADR-0040 (the parser's stricter line rules)

Layer 1 of 4. Apply to `docs/grammar-reference.md` only after the owner flips the amended
`packages/feat-core/parse.feat` beside this file to `agreed`. Title becomes "Grammar Reference v1.4" and the
header line "ADR-0001…0040". The language version stays `feat 1.0` (ADR-0040 decision 6). Every "Before" is
the text on main at 72f71de; every "After" assumes the recommended option of each decision (README.md lists
the alternatives and what changes here under each).

## 1. §1.2 Lexical rules: the Comments bullet

Before:

> - **Comments**: whole-line only. A line whose first non-blank character is `#` is skipped, outside a
>   multi-line `{ … }` / `[ … ]` value (inside one it is part of the value, and a parse error). A `#`
>   after content on the same line is not a comment:
>   - on a compiler-zone line (a `when:` or `predict` line, a `has` line, a `contract:` entry, a header
>     directive, a `scenario` opener) it is `MALFORMED_SYNTAX`, and on the pragma line `MISSING_PRAGMA`;
>   - in an agent zone it is part of the line's text: `mint an invite  # note` is captured verbatim, and a
>     `touches` or `handler at` line that carries one is no longer recognized and becomes a freeform
>     directive;
>   - on a `given:` line it turns an `execute`, `seed` or `clock at` line into freeform context;
>   - after a `response` line's closing `}` it is dropped without an error.
>
>   Write comments on their own line.

After:

> - **Comments**: whole-line only (ADR-0040). A line whose first non-blank character is `#` is skipped,
>   outside a multi-line `{ … }` / `[ … ]` value (inside one it is part of the value, and a parse error).
>   A **trailing comment** is a `#` outside a string with a space or tab before it. It is
>   `MALFORMED_SYNTAX` (hint: "Comments are whole-line: move '# …' to a line of its own.") on every line
>   the parser reads by its keywords:
>   - every compiler-zone line: a header directive, a `contract:` entry, a `variables:` definition, a
>     `scenario` opener, `given:` lines that begin `execute`, `seed`, `clock at`, `random seed` or
>     `fault`, `when:`, `deliver`, `predict`, `response` (after its block too), `has`, `contains`, an
>     examples row; on the pragma line it is `MISSING_PRAGMA`, as before;
>   - a `construct:` line that is a typed directive once the comment is removed (`handler at`,
>     `imports … from`, `register … in`, `emit to`, `touches`, `needs`), so a change boundary or a
>     handler is never turned into a freeform directive.
>
>   Freeform text keeps a `#` as text: `mint an invite, see ticket #12` in an agent zone and a `given:`
>   context line are captured verbatim. A `#` with no space before it is part of its token
>   (`touches src/#gen/**`), and a `#` inside a string is data (`{ title: "#1" }`).

## 2. §1.2 Lexical rules: the Minimum bullet, last sentence

Before:

> Every scenario also needs a trigger (`when:` or
>   `deliver`; without one it is `MALFORMED_SYNTAX`, "has no trigger") and a prediction: a scenario
>   without a `predict` is not a valid spec, though `MISSING_MINIMUM` does not cover it and the parser
>   reports it with no error code today.

After:

> Every scenario also needs a trigger (`when:` or
>   `deliver`; without one it is `MALFORMED_SYNTAX`, "has no trigger") and a prediction: a scenario
>   without a `predict` is `MISSING_MINIMUM` at the scenario's opener, naming the scenario (ADR-0040).

## 3. §1.2 Lexical rules: the Strings bullet

Before:

> - **Strings**: a string in a payload, seed record or value block is `"…"`. A backslash escapes the next character, and the valid escapes are
>   JSON's single-character ones: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`. Any other escape, including
>   `\uXXXX`, is refused with a raw `SyntaxError` from the parser rather than a coded parse error.

After:

> - **Strings** (ADR-0040): every quoted string is a JSON string: in a payload, a seed record and a value
>   block, and on a line (the spec name, a scenario name, `clock at`, `seed … from`, `equals fixture`,
>   `stream`, `contract … from`, a `variables:` template). The escapes are JSON's: `\"`, `\\`, `\/`, `\b`,
>   `\f`, `\n`, `\r`, `\t` and `\uXXXX` (exactly four hexadecimal digits; a surrogate pair is two escapes and
>   one character). The IR records the decoded string: `scenario "say \"hi\""` is named `say "hi"`. Any
>   other escape, and a `\u` without four hex digits, is `MALFORMED_SYNTAX` naming it (hint: "Valid escapes:
>   \" \\ \/ \b \f \n \r \t \uXXXX."); inside a value it carries no line, as every refusal inside a value.

## 4. §1.2 Lexical rules: a new bullet after Strings

> - **One of each per scope** (ADR-0040). These lines are written once in their scope, and a second one is
>   `MALFORMED_SYNTAX` at the second, its message naming the first one's line: each header directive
>   (`spec`, `context`, `aggregate`, `type`, `status`, and `observes`, ADR-0033); in a scenario, `when:`
>   and `predict`; in a prediction, `response`, and `has` and `contains` for each service; in a given,
>   `clock at` and `random seed`. The repeatable lines stay repeatable: `execute`, `seed`, `fault`,
>   `deliver`, `touches`, `needs`, `imports`, `register`, `emit to`, the contract entries and the
>   variables.

## 5. §1.3 The two zones: the Agent row

Before (the Parser behavior cell):

> Freeform natural language. Keyword-matching lines produce typed IR nodes; every other line is captured verbatim as an opaque directive. Header directives are still read here, as on any line of the file: a line of exactly the form `spec <ID> "<name>"`, `context <Name>`, `aggregate <Name>`, `type <type>` or `status <status>` (one token after the keyword) sets that header field, overwriting the header's value (`context Other` replaces the header context), and an unknown `type` or `status` (`status shipped`) is `MALFORMED_SYNTAX`. A line that merely starts with the word (`context matters here`) stays a directive. Section openers (`construct:`, `enforce:`, `contract:`, `variables:`, `scenario "…":`) end the zone.

After:

> Freeform natural language. Keyword-matching lines produce typed IR nodes; every other line is captured verbatim as an opaque directive, and freeform text is never a parse error. Header directives are read in the header only (§2): here `status agreed`, `context matters` or `type safety` is a directive like any other and never changes the header. Section openers (`construct:`, `enforce:`, `contract:`, `variables:`, `scenario "…":`) end the zone.

## 6. §2 Header: a sentence under the table

> The header is the lines between the pragma and the first section opener, and the header directives are
> read there only (ADR-0040). Each is written once (§1.2, "One of each per scope"); their order is free.
> After the header a header-shaped line belongs to its zone: a directive in `construct:` and `enforce:`, a
> context line in `given:`, an unrecognized line elsewhere. A header field that is missing from the header
> is `MISSING_MINIMUM` wherever else it is written.

## 7. §5 Scenarios: the example

Before:

> ```
>   given:
>     A flow already exists for this tenant.                          # freeform context
> ```

After (the trailing `# freeform context` would be recorded as part of the context text):

> ```
>   given:
>     # a freeform context line
>     A flow already exists for this tenant.
> ```

## 8. §5.1 `given:`: one sentence after the `fault` paragraph

> The same holds for the other given keywords (ADR-0040): a line that begins `execute`, `seed`,
> `clock at` or `random seed` and carries a trailing comment is `MALFORMED_SYNTAX`, never context, so a
> step is never skipped because of a comment.

## 9. §5.2 The trigger: the `command`, `query` row

Before: "— one per scenario; a second `when:` replaces the first (the last one wins);"

After: "— one per scenario; a second `when:` is `MALFORMED_SYNTAX` (§1.2, ADR-0040);"

## 10. §5.3 `predict`: the `has` row

Before: "Exactly these records **captured** (writes during the window). One per service: a second `has` for
the same service replaces the earlier one (the last one wins)."

After: "Exactly these records **captured** (writes during the window). One per service: a second `has` for
the same service is `MALFORMED_SYNTAX`; put every record in one list (ADR-0040)."

And the `contains` row gains: "One per service, as `has`."

And under the table of three types: "One `predict` per scenario; a second is `MALFORMED_SYNTAX`."

## 11. §9 Reserved keyword summary: no change.

## 12. Corpus README (layer 2): add a row

> | 22 | `strict-lines/` | SPEC-NTE-001 | The stricter line rules (ADR-0040): whole-line comments between given, when and predict lines; `é` and `\"` decoded in a payload, a value block and a scenario name; a `#` kept as text in an enforce constraint and a given context line and as data in a string; `context matters` in `construct:` recorded as a directive with the header unchanged |
