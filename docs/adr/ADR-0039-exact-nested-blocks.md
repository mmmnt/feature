# ADR-0039: a nested value block is exact

- **Status:** Accepted. The founder ruled in e9b228ec-4f2b-5414-a11a-ae44f9946ef3 (2026-11-24, "Feature spec + fix
  (Recommended)"): payload predictions must match exactly, so an unpredicted key fails the scenario. The founder's
  rulings 02af6938-de96-52b6-a8d8-d6a6944670d0 (2026-11-24, on workshop 749e4a70) settle the details:
  1. "Nested blocks only (Recommended)"
  2. "Nested stays exact (Recommended)"
  3. "Keep allowing it (Recommended)"
  4. "feat-runtime 0.10.0 (Recommended)"
  5. "Breaking, with a lint" (not the recommendation)
  6. "Fix as part of the build" (not the recommendation)
  7. "Keep the current wording (Recommended)"
- **Amends:**
  - ADR-0002: value blocks are partial; that now holds for the top-level block only.
  - Grammar reference §5.4: the paragraph on partial blocks and the `{ ... }` row.
  - SPEC-RT-015: its "Unchanged: `nested` stays partial" line.
  - ADR-0007: one lint rule is added, at warning level.
- **Leaves alone:** ADR-0034 and ADR-0038.
- **Specs:** SPEC-RT-017 (the matcher) and SPEC-ANL-001 (the migration lint).

## Context

A value block asserts the fields it lists (ADR-0002, §5.4). That holds for a record's or a response's top-level block.
Because the runtime evaluates `{ … }` in a field position through the same `applyValueBlock`, it held for every nested
block too.

ADR-0038 closed the top-level block. The schema refuses an undeclared key, and the lint error `OPTIONAL_UNSTATED` names
every optional property the block leaves out. Nothing closed a nested block: the lint reads only the top-level block's
schema, and a nested schema is often open (`{ "type": "object" }`).

A consumer found the gap. Two policies predicted an event `{ entryType, payload: { … }, timestamp, … }` with a key left
out of the `payload` block. The suite stayed green (160 of 160) while the event carried the key, and only a closed
contract schema for the payload caught it. Objects inside a list were already exact (ADR-0034, ruling 7ca2385c). A
nested block outside a list was not, so the same object was exact inside a list and loose beside it.

## Decision

1. **Exact nested blocks.** A nested value block (`{ … }` in a field position, IR `{ "matcher": "nested", "fields" }`)
   is exact. After each declared field is matched, each key of the value that the block does not declare is one
   violation: `<anchor>: UNPREDICTED field '<key>' = <value as JSON, cut to 80 characters with …>`. Violations come in
   the value's key order, with the same words and cut as an object inside a list (ADR-0034 §5).
2. **Everywhere a nested block is evaluated.** This holds at every depth, for a record in `has` (ordered or unordered),
   for a record in `contains`, and for a response body.
3. **The top-level block is unchanged** (ruling 1). It checks its listed fields, and ADR-0038 closes it with the schema
   and `OPTIONAL_UNSTATED`.
4. **`partial` covers its own block only** (ruling 2). `<Schema> partial { … }` still leaves the top level unchecked
   beyond its listed fields, but its nested blocks are exact. A sub-object a spec means to leave unchecked is written
   `field: any`.
5. **`absent` stays allowed in a nested block** (ruling 3), and is parsed and evaluated as before.
6. **The words are unchanged** (ruling 7). A record that fails still reports "captured X does not match predicted Y";
   a response reports the field's anchor.
7. **The migration lint `NESTED_SCHEMA_OPEN`** (ruling 5) is a `feat lint` warning, never a config switch.
   - **What it flags:** every nested block of a predicted response, `has` record or `contains` record, `partial` or
     not, whose schema lets its object carry undeclared keys. That is any schema that does not say
     `additionalProperties: false` or `unevaluatedProperties: false`, whether directly, through a local ref, through
     an allOf part, or in every anyOf/oneOf branch. A property no schema describes is open too.
   - **The message:** `warn [NESTED_SCHEMA_OPEN]: scenario "<name>" › <response | <service> <type>> › <path>:
     <Schema> leaves '<path>' open, so from feat-runtime 0.10.0 a key the block does not state fails the scenario
     (ADR-0039) — close it (additionalProperties: false), or check the block states every key`.
   - **Why a warning:** an error would fail every consumer's lint gate on contracts that are theirs to close. The
     runtime already fails the scenario that matters. `feat lint` still exits 1 only on errors.
8. **No language change.** There is no grammar, IR, schema or adapter change; the language stays `feat 1.0`.
9. **Breaking.** A spec that under-predicts a nested object goes red with no change of its own. The release is
   `@mmmnt/feat-runtime` 0.10.0, `@mmmnt/feat-analyze` 0.3.0 for the lint, and `@mmmnt/feature` 0.16.0 on both new
   ranges, tagged v0.1.84 (ruling 4). Feature's own scenarios that relied on the partial matcher are amended in the same
   change (ruling 6).

## Rejected alternatives

- **Exact top-level blocks too:** reverses ADR-0002 and an alternative ADR-0038 already rejected. Measured at the spec
  tier, 472 of one consumer's 729 scenarios would go red, and 113 of Feature's. Ruling 1.
- **`partial` loosens the nested blocks inside it:** a `partial` block would hide a nested key the way the finding did.
  The keyword cannot be written on a nested block (ADR-0038 L4), so the looseness would be invisible where it applies.
  Ruling 2.
- **Refusing `absent` inside a nested block**, as ruling 7ca2385c does inside a list: it would break parsing in at
  least 20 of one consumer's predictions for no gain in what they assert. Ruling 3.
- **A 0.9.1 patch:** it would reach every `^0.9.0` range silently. Ruling 4.
- **No migration lint:** ruled against in ruling 5.
- **A report-only runtime switch:** a config flag that changes domain behaviour.
- **The lint at error level:** breaks consumers' lint gates on contracts that are theirs to close.
- **Extending `OPTIONAL_UNSTATED` into nested blocks instead of exact matching:** catches only keys a closed nested
  schema declares as optional. An open nested schema, the case found, would still pass.
- **Exactness only for a field named `payload`:** a rule keyed on a field name the language does not reserve.

## Consequences

- Every nested block in every consumer's spec now states every key of its object, or the field is written `any`.
- The code changes are confined to two places:
  - `packages/feat-runtime/src/matcher.ts`: `applyMatcher`, case `nested`.
  - `packages/feat-analyze/src/index.ts`: `lintNestedOpen`, which `feat lint` runs.
- At the spec tier one consumer has one red scenario. Feature amends its own 22, in SPEC-RPC-002, SPEC-RT-004 and
  SPEC-RT-001.
