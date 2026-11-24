# docs/grammar-reference.md — the change SPEC-RT-017 brings (draft; applied only once agreed)

§5.4, the paragraph after "A record is `<Type> with <Schema>` plus an optional value block":

> Three assertion layers: type match → schema validation → value-block matchers. ~~Value blocks are **partial**:
> they assert listed fields only; shape completeness is the schema's job.~~ A record's or response's **top-level**
> value block is **partial**: it asserts its listed fields only; shape completeness is the schema's job, and
> `OPTIONAL_UNSTATED` (ADR-0038) names every optional property it leaves out. A **nested** block (`{ … }` in a
> field position) is **exact**: a key of its object that it does not declare is a violation, at any depth, in
> `has`, `contains` and responses alike, and inside a `partial` block too (ADR-0039). To leave a sub-object
> unchecked, write the field `any`.

§5.4, matcher table, the `{ ... }` row:

| Matcher | Meaning |
| --- | --- |
| `{ ... }` | Nested value block — **exact** (ADR-0039): each declared field passes its matcher and every other key of the object is a violation (`a › payload: UNPREDICTED field 'workspace' = "6f96…"`); write the field `any` to leave a sub-object unchecked |

No other section changes: no reserved word, no IR shape, no grammar production.
