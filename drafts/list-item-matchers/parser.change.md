# SPEC-CORE-001 amendment (ADR-0034) — draft

Applies to `packages/feat-core/parse.feat`. Status stays `agreed` only once the founder agrees this draft; until
then nothing under `packages/` changes.

## Header comment (appended after the ADR-0033 amendment)

```
# AMENDMENT (ADR-0034, matchers inside a list; founder ruling cc58ae94, 2026-11-20, "Matchers in list items
# (Recommended)"). In a value block's matcher position, a list's items, and the fields of an object inside it,
# are read in matcher position. A list with no matcher at any depth is recorded as today, { matcher: "literal",
# value }, so every existing exemplar's IR is unchanged. A list that holds one is { matcher: "list", items }; inside
# it an object that holds one is { matcher: "object", fields } and any matcher-free subtree is a literal; the
# runtime evaluates them (SPEC-RT-015). One new exemplar, corpus/list-matcher (#21), and six refusal fixtures.
# Every other scenario is unchanged.
```

## Construct (appended after the `observes` paragraph)

```
  In a value block's matcher position, `[` opens a list whose items are read in matcher position, and inside it
  `{ ... }` is an object whose fields are read in matcher position, at any depth (ADR-0034). An item or field is a
  literal, an object, a list, a reference (`@when`, `@deliver`, `@given`, `@<service>[i]`), `any [type]`,
  `matching ...`, `not <matcher>` or `f32 ...`; an outline placeholder in it is literal data, as in a literal.
  A list holding no matcher at any depth is recorded as { matcher: "literal", value } exactly as before. Otherwise
  it is { matcher: "list", items }, each matcher-free item or field recorded as { matcher: "literal", value }, each
  object that holds a matcher as { matcher: "object", fields } with fields in written order, and each list that
  holds one as { matcher: "list", items }. `absent` as a list item, `absent` as a field of an object inside a list,
  and `not` over a list that holds a matcher are MALFORMED_SYNTAX, each with a hint giving the spelling to use;
  `not` over a list of literals stays a literal operand. A capture reference inside a list joins the closed service
  space and, when the spec declares observes, the observed space, as one outside it does. A `{ ... }` outside any
  list keeps its value-block meaning, { matcher: "nested", fields }.
```

## enforce (one line amended)

`rejects MALFORMED_SYNTAX when a compiler-zone block violates the grammar, …, an f32 digest of any other shape
(ADR-0030), and a list item or list-object field that is absent, or a negated list that holds a matcher (ADR-0034)`

## New scenarios

```
scenario "parses the list-matcher exemplar (list-matcher, ADR-0034)":
  when: Parse { spec: "corpus/list-matcher/list-matcher.feat", config: "corpus/list-matcher/feat.config.json" }
  predict success:
    response OK BuiltSpec equals fixture "../../corpus/list-matcher/list-matcher.ir.json"
    filesystem has []

scenario outline "refuses a list item or list field it does not take, naming the spelling to use":
  when: Parse { spec: <spec>, config: "packages/feat-core/fixtures/parse.config.json" }
  predict rejection MALFORMED_SYNTAX:
    response ERR ParseError { code: "MALFORMED_SYNTAX", message: matching <message>, hint: matching <hint> }
    filesystem has []
  examples:
    | spec                                                       | message                                       | hint                                  |
    | "packages/feat-core/fixtures/bad/list-absent-item.feat"    | "^'absent' is not a list item"                | "^Write a shorter list"               |
    | "packages/feat-core/fixtures/bad/list-absent-field.feat"   | "^'absent' is refused inside a list"          | "^Leave the field out"                |
    | "packages/feat-core/fixtures/bad/not-list.feat"            | "^'not \\[ … \\]' is refused"                 | "^Negate a field inside an item"      |
```

Messages, exactly:

- `'absent' is not a list item: an item is a value.` — hint `Write a shorter list: a list predicts every item it holds.`
- `'absent' is refused inside a list: an object there is exact, so a field it does not name is already absent.` —
  hint `Leave the field out.` (subject to open question Q1)
- `'not [ … ]' is refused: the negation of a list that holds a matcher does not say which item differs.` — hint
  `Negate a field inside an item instead: '[ { field: not <matcher> } ]'.`

Rows added to the code outline ("refuses …, naming the code"):

```
    | "packages/feat-core/fixtures/bad/list-absent-item.feat"             | "MALFORMED_SYNTAX"        |
    | "packages/feat-core/fixtures/bad/list-absent-field.feat"            | "MALFORMED_SYNTAX"        |
    | "packages/feat-core/fixtures/bad/not-list.feat"                     | "MALFORMED_SYNTAX"        |
    | "packages/feat-core/fixtures/bad/list-unterminated.feat"            | "MALFORMED_SYNTAX"        |
    | "packages/feat-core/fixtures/bad/list-unknown-capture-service.feat" | "UNKNOWN_SERVICE_KEY"     |
```

and to the observes outline (config `packages/feat-core/fixtures/parse-observes.config.json`):

```
    | "packages/feat-core/fixtures/bad/list-unobserved-service.feat"      | "UNOBSERVED_SERVICE"      |
```

## Unchanged-IR guard

Every existing corpus exemplar's `.ir.json` must parse byte-identical after the change (the exemplar scenarios
already assert it). `corpus/list-matcher` shows a literal list (`tags`, response `members`) and a literal list
with a placeholder (`tags: [<tag>]`) recorded as `literal` beside the `list` ones.

## Implementation notes (for the build, not normative)

- `parseMatcher`: on `[`, parse items with a list-aware matcher reader (objects in it read as closed `object`
  candidates), then collapse: a subtree with no matcher becomes a literal (the same value `parseLiteralValue`
  would have produced, `$placeholder` included).
- `collectCaptureServices`: descend into `list.items` and `object.fields`.
- Schema (`schemas/builtspec.schema.json`): add `list` { items: Matcher[] } and `object` { fields: { [k]: Matcher } };
  refuse `absent` in `items` and in `object.fields`; extend the `not` operand refusal set with `list` and `object`.
