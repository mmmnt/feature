# SPEC-CORE-001 amendment (DRAFT): the partial marker `...` (ADR-0038)

Status: draft. Founder ruling 7d3026eb-73ec-5a92-b3fe-e2fcb7b42a31; syntax per ADR-0038-DRAFT decision 2.

## Grammar (docs/grammar-reference.md §5.4)

```
valueBlock  := "{" { IDENT:field ":" matcher } [ "..." ] "}"   # ADR-0038: trailing "..." marks the block partial on purpose
```

`...` is a token only inside a compiler-zone value block; agent zones stay freeform.

## Construct / enforce lines

- construct: a predicted response or record whose value block ends in `...` carries `"partial": true` in the IR; a
  block without it carries no `partial` key (existing IR unchanged).
- enforce: `...` that is not the block's last part, inside an object in a list, in a `when:`/`execute`/`deliver`
  payload or a seed, or beside `equals fixture` is refused `MALFORMED_SYNTAX`, naming the position.

## Scenarios (to add to packages/feat-core/parse.feat)

1. A response block ending in `...` parses with `partial: true` and its listed fields.
2. A record in a `has` list ending in `...` parses with `partial: true`.
3. A block with no `...` parses exactly as before (no `partial` key) — every existing corpus IR unchanged.
4. `...` before the last field is refused `MALFORMED_SYNTAX` (hint: "`...` closes a block").
5. `...` inside an object in a list matcher is refused (hint: "an object in a list is exact, ADR-0034").
6. `...` in a `when:` payload is refused (hint: "a payload is data").
7. `...` in a seed record is refused.
8. `...` beside `equals fixture` is refused.

## Lint (packages/feat-analyze, ADR-0007 discipline, hand-tested in lint.test.ts)

1. A response block omitting an optional property warns, naming scenario, schema and properties.
2. A record block omitting one warns, naming service and record type.
3. A block stating the property (`absent`, `any`, a value) does not warn.
4. A block marked `...` does not warn.
5. A property required through an `allOf` part reached by a local `$ref` is not treated as optional.
6. A schema with no optional property never warns.
