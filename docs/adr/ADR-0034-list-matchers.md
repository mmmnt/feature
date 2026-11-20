# ADR-0034 — matchers inside a list

Status: Accepted (founder ruling cc58ae94, 2026-11-20, "Matchers in list items (Recommended)": "Feature allows a
matcher to sit inside a list item … every field still declared, list comparison stays exact"; Q1 ruled 7ca2385c,
"Refuse it (Recommended)"; the draft set agreed 2026-11-20, "Agree (Recommended)"). Built in
SPEC-CORE-001 (amended) and SPEC-RT-015 (new; it touches derive's substitution, as SPEC-RT-011 did for `not`).

## Context

In a value block a field's matcher may be a literal, a reference, `any [type]`, `matching "<regex>"`, `not <m>`,
`f32 …`, `absent`, a placeholder, or a nested block. A list is only ever a literal: the parser reads `[` with the
literal reader, so `[ { name: "a", text: any string } ]` is MALFORMED_SYNTAX ("Malformed value near 'any string'").

A consumer (flmnt FLMNT-SPEC-LCY-004, Export) predicts the members of an archive it writes as a list. Every member
is a literal except one: `manifest.sha256` holds the digest of `manifest.json`'s bytes, whose layout the spec
deliberately does not fix. Written without its `text`, the member can never match, because a literal list is
compared exactly; written with its literal digest, the spec pins a byte layout the format ADR leaves open.

## Decision

1. In a value block's matcher position, `[` opens a list whose items are read in matcher position. An item is a
   literal, an object `{ … }`, a list `[ … ]`, a reference (`@when`, `@deliver`, `@given`, `@<service>[i]`),
   `any [type]`, `matching …`, `not <m>` or `f32 …`. An object's fields, inside a list, are read the same way, at
   any depth.
2. **Literal lists are unchanged.** A list whose items hold no matcher at any depth is recorded exactly as today,
   `{ "matcher": "literal", "value": [ … ] }`, outline placeholders included (they are literal data, as now). Every
   existing spec parses to the same IR; nothing regenerates.
3. Otherwise the list is `{ "matcher": "list", "items": [ <matcher> … ] }`. Inside it, an item or field whose
   subtree holds no matcher is `{ "matcher": "literal", "value": … }`; an object that holds one is
   `{ "matcher": "object", "fields": { <key>: <matcher> } }`; a list that holds one is again `list`.
4. **Exact, as a literal list is.** A `list` passes when the value is an array of exactly as many items, and each
   item, in order, passes its matcher. An `object` passes when the value is an object (not an array, not null)
   whose keys are exactly the declared keys and each field passes its matcher. A field present in the value and
   not declared is a violation. A matcher changes only what its own field accepts; every other part of the list
   keeps literal semantics. (A `{ … }` outside any list keeps its value-block meaning, `nested`, unchanged.)
5. Violations are reported at the item and field: `<anchor>[1] › text: expected any string, got 42`,
   `<anchor>[1]: UNPREDICTED field 'size' = 120`. A value that is not a list, and a list of the wrong length, is
   one violation for the list and no item is checked (the items would be compared out of place):
   `expected a list of 5 item(s), got 4`. Within a list of the right length every item's violations are reported.
6. The parser refuses, as MALFORMED_SYNTAX with a hint:
   - `absent` as a list item: an item is a value; write a shorter list.
   - `absent` as a field of an object inside a list: an undeclared field must already be absent; leave it out
     (one spelling per meaning, as ADR-0027 refuses `not absent`; ruling 7ca2385c).
   - `not [ … ]` over a list that holds a matcher: which item differs is unsaid; negate a field inside it
     (`[ { id: not @when.id } ]`). `not` over a literal list stays a literal operand, as today.
   - an unterminated list or object (existing message).
   The IR schema refuses the same shapes.
7. A capture reference inside a list joins the closed service space (UNKNOWN_SERVICE_KEY) and, when the spec
   declares `observes`, the observed space (UNOBSERVED_SERVICE), exactly as one outside a list.
8. derive substitutes an outline placeholder inside a `list` or `object` (in a literal item, a `matching <name>`,
   or `not <name>`) as it does elsewhere.
9. No new reserved word; the language stays `feat 1.0`. The adapter interface and the Feat Host Protocol are
   unchanged.

## Rejected alternatives

- **Predict the literal digest** (the consumer's side): pins a byte layout the consumer's format ADR does not fix;
  any serializer change breaks the spec for no behaviour change.
- **Partial list items** (match only the named fields of an item): an unpredicted field inside any listed item would
  pass silently, which breaks prediction inversion. Rejected by the founder in cc58ae94.
- **Value-block (partial) semantics for objects inside a list**: the same hole by another route; objects inside a
  list are exact today and stay exact.
- **An unordered or `contains`-style list match**: the ruling keeps list comparison exact; order is part of the
  value (flmnt's archive members are in path order by contract).
- **A per-item adapter option to drop the field** (e.g. fs reports no `text` for `*.sha256`): moves the prediction
  into adapter configuration and hides an effect from the spec.

## Consequences

- `schemas/builtspec.schema.json` gains the `list` and `object` matchers, and its `literal` value admits arrays and
  objects: the parser has always recorded a list or object literal that way, and no corpus exemplar carried one until
  `list-matcher`, whose list items are object literals; `@mmmnt/feat-types` gains them in
  `Matcher`; feat-core parses them; feat-runtime's `applyMatcher` evaluates them; feat-derive recurses into them.
- The parser's capture-service walk (`collectCaptureServices`) descends into lists and objects.
- The record diff (`has`, `contains`) is unchanged: a record that fails still reports "captured X does not match
  predicted Y"; the item and field anchors show in a response diff and in the MatchValue probe. (Surfacing the
  first field violation in a record mismatch is a separate change; not part of this ruling.)
- The TextMate grammars need no new word; check that matcher words inside `[ … ]` are scoped as outside.
- The corpus gains exemplar #21, `corpus/list-matcher/`.
