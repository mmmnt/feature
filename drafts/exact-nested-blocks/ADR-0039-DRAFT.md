# ADR-0039: a nested value block is exact

- **Status:** Proposed. Draft for the founder; nothing here is agreed. Founder ruling
  e9b228ec-4f2b-5414-a11a-ae44f9946ef3 (2026-11-24, "Feature spec + fix (Recommended)"): payload predictions must
  match exactly, so an unpredicted key fails the scenario; `partial` blocks keep their declared looseness (ADR-0038).
- **Amends:** ADR-0002 (value blocks are partial: now the top-level block only); grammar reference §5.4 (the
  `{ ... }` row of the matcher table); SPEC-RT-015 (its "Unchanged: `nested` stays partial" line). ADR-0034 and
  ADR-0038 are unchanged.
- **Spec:** SPEC-RT-017 (draft, `drafts/exact-nested-blocks/packages/feat-runtime/match-nested.feat`).

## Context

A value block asserts the fields it lists (ADR-0002, §5.4). That holds for a record's or a response's top-level
block and, because the runtime evaluates `{ … }` in a field position through the same `applyValueBlock`, for every
nested block too. ADR-0038 closed the top-level block: the schema refuses an undeclared key, and the lint error
`OPTIONAL_UNSTATED` names every optional property the block leaves out. Nothing closes a nested block: the lint
reads only the top-level block's schema, and a nested schema is often open (`{ "type": "object" }`).

A consumer found it: two policies predicted an event `{ entryType, payload: { … }, timestamp, … }` with a key left
out of the `payload` block, and the suite stayed green (160 of 160) while the event carried the key. Only a closed
contract schema for the payload caught it. Objects inside a list are already exact (ADR-0034, ruling 7ca2385c);
a nested block outside a list was not, so the same object was exact in a list and loose beside it.

## Decision

1. A nested value block (`{ … }` in a field position, IR `{ "matcher": "nested", "fields" }`) is exact: after each
   declared field is matched, each key of the value that the block does not declare is one violation,
   `<anchor>: UNPREDICTED field '<key>' = <value as JSON, cut to 80 characters with …>`, in the value's key order,
   with the same words and cut as an object inside a list (ADR-0034 §5).
2. It holds at every depth and wherever a nested block is evaluated: a record in `has` (ordered or unordered), a
   record in `contains`, and a response body.
3. **The top-level block is unchanged** (Q1): it checks its listed fields, and ADR-0038 closes it with the schema
   and `OPTIONAL_UNSTATED`. Exact top-level blocks were rejected in ADR-0038.
4. **`partial` covers its own block only** (Q2): `<Schema> partial { … }` still leaves the top level unchecked beyond
   its listed fields, and its nested blocks are exact. A sub-object a spec means to leave unchecked is written
   `field: any`, which already exists and says so.
5. `absent` stays allowed in a nested block (Q3): it is redundant there now, but refusing it would break existing
   specs for no gain in what they assert.
6. No grammar, IR, schema or adapter change; the language stays `feat 1.0`. A record that fails still reports
   "captured X does not match predicted Y"; a response reports the field's anchor.

## Rejected alternatives

- **Exact top-level blocks too:** reverses ADR-0002 and the alternative ADR-0038 rejected, and every spec that
  lists a few fields of a large record goes red; ADR-0038 already closes the top level. (Open as Q1 with its
  measured cost.)
- **`partial` loosens nested blocks too:** a `partial` block would hide a nested key the same way the finding did,
  and the keyword cannot be written on a nested block (ADR-0038 L4), so the looseness would be invisible where it
  applies. (Open as Q2.)
- **Extend `OPTIONAL_UNSTATED` into nested blocks instead:** catches only keys a closed nested schema declares as
  optional; an open nested schema, the case found, still passes.
- **Exact only for a field named `payload`:** a rule keyed on a field name the language does not reserve; the same
  hole stays under every other name.

## Consequences

- Every nested block in every consumer's spec now states every key of its object, or the field is written `any`.
  The measured cost is in `drafts/exact-nested-blocks/README.md` (Feature's own specs and one consumer's).
- `packages/feat-runtime/src/matcher.ts` (`applyMatcher`, case `nested`) is the only code change; `@mmmnt/feat-runtime`
  takes a minor version and every consumer re-pins.
- The grammar reference §5.4 row `{ ... }` reads "Nested value block — exact: an undeclared key is a violation"
  and the paragraph "Value blocks are partial" says "A top-level value block is partial".
