# SPEC-CORE-001 amendment (DRAFT): the `partial` keyword (ADR-0038)

Status: draft. Founder rulings 7d3026eb-73ec-5a92-b3fe-e2fcb7b42a31 and 55fb39c4-d774-5f92-a62b-4bce3f352f28 (L1, L4).

## Grammar (docs/grammar-reference.md §5.4)

```
record      := DOTTED-IDENT:type "with" IDENT:schemaName [ "partial" valueBlock | "equals" "fixture" STRING | valueBlock ]
response    := "response" STATUS IDENT:schemaName [ "partial" valueBlock | "equals" "fixture" STRING | valueBlock ]
```

`partial` is reserved inside compiler-zone blocks (with `any`, `matching`, `absent`, `not`, `f32`, `sha256`, `ordered`,
`unordered`).

## Construct / enforce

- construct: a predicted record or response whose head carries `partial` records `"partial": true` beside its
  `valueBlock`; one without it records no `partial` key, so every existing exemplar's IR is unchanged.
- enforce, each refused `MALFORMED_SYNTAX` with a hint naming where `partial` goes:
  `partial` in a payload or a seed (data); as a field's value or a list item; beside `equals fixture`, before or after;
  with no value block after it.

## Scenarios (drafted in packages/feat-core/parse.feat; ran green with the prototype, 105 of 105)

1. "a record and a response block marked partial record partial: true, and an unmarked block records nothing new" —
   `fixtures/ok/partial-blocks.feat` → `partial-blocks.ir.json` (SPEC-OK-202).
2. Outline "refuses 'partial' anywhere but a predicted record's or response's head, naming where it goes", 8 rows:
   SPEC-BAD-136 payload, -137 seed, -138 list item, -139 field value, -140 record golden, -141 response golden,
   -142 after a golden, -143 no block.

## Lint hand tests (packages/feat-analyze/lint.test.ts; ran green, 8 of 8 with the two existing)

1. A response block leaving out an optional property is an error naming scenario, schema and property.
2. A record block leaving one out names the service and record type.
3. A block that states the property (absent or otherwise) passes.
4. A block marked `partial` passes.
5. A property required through an `allOf` part reached by a local `$ref` is not optional.
6. A schema with no optional property, and a golden, never fail.
