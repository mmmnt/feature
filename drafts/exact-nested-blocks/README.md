# Exact nested value blocks (draft, needs the founder's rulings)

Founder ruling e9b228ec (2026-11-24, "Feature spec + fix (Recommended)"): payload predictions must match exactly, so
an unpredicted key fails the scenario. This follows prediction inversion and ADR-0034's exact objects. `partial`
blocks keep their declared looseness (ADR-0038). This directory holds the draft. No matcher code is changed until
the founder rules on the questions below.

| File | What it is |
| --- | --- |
| `packages/feat-runtime/match-nested.feat` + `.contract.json` | SPEC-RT-017, status draft, 18 scenarios |
| `ADR-0039-DRAFT.md` | the decision record, Proposed |
| `grammar-reference.change.md` | the §5.4 text it changes |
| `../../packages/feat-runtime/fixtures/matcher/probe.mjs` | test-only: `MatchValue` gains a diff form (an input with `predicted` runs the record diff, one with `expect` runs the response diff) so record and response scenarios can be driven; every existing input behaves as before |

## Where the looseness lives

Both levels are partial in `packages/feat-runtime/src/matcher.ts`, and both by an agreed rule, so this is a gap in the
rules rather than a bug against one:

- **The top-level block** of a record or response (`recordMatches`, `diffResponse` → `applyValueBlock`) checks only
  the fields it lists. ADR-0002 and grammar §5.4 say so. ADR-0038 (agreed 580f3d10) kept this and closed it from
  outside: the schema refuses an undeclared key, and `OPTIONAL_UNSTATED` names every optional property left out.
  ADR-0038 explicitly rejected exact top-level blocks.
- **A nested block** (`{ … }` in a field position, `applyMatcher` case `nested` → `applyValueBlock`) also checks only
  its listed fields. SPEC-RT-015 says "Unchanged: `nested` (a value block outside a list stays partial)". Nothing
  closes it. `lintOptionalFields` (packages/feat-analyze) reads only the top-level block's schema, and a nested
  schema is often open.

The finding is the second case: in `log has [ projections.rebuilt with RebuiltEvent { …, payload: { replayed, parity,
at }, … } ]` the `payload` block left out `workspace`. Confirmed red-first: SPEC-RT-017 runs 10 of 18 red against
the current matcher (every scenario that asserts an undeclared nested key), and 18 of 18 green against a patched one.

## Domain delta

- Query `MatchValue` (probe) / the harness's record and response diff: no new command, event or refusal.
- A changed outcome: a nested block whose object holds an undeclared key is a violation
  `<anchor>: UNPREDICTED field '<key>' = <value cut to 80>` (a response names it; a record reports "captured X does
  not match predicted Y", as today).
- Stories where the system says no: an extra key one level down (`payload.warehouse`), two levels down
  (`payload.check.checkedBy`), in an unordered `has`, in `contains`, in a response body, and inside a `partial`
  record.
- Stories where it still says yes: the top-level block leaves out a field (record and response), a `partial` record
  leaves out top-level fields, and a field written `any` leaves a sub-object unchecked.

## Pipeline (the draft copied into `packages/feat-runtime/`, then removed)

| Step | Result |
| --- | --- |
| `feat lint` | 49 specs, 0 errors, 0 warnings (the draft gets the info line "status draft") |
| `feat generate` | 49 test files; only `match-nested.test.ts` is new (no other inputs hash moved) |
| `feat audit` | 49 specs, 0 with errors, 1 warning (the draft's status) |
| `feat verify` | 49 generated files match their specs |
| `feat run --spec SPEC-RT-017`, current matcher | 10 failed, 8 passed (18) |
| `feat run --spec SPEC-RT-017`, patched matcher | 18 passed (18) |
| `feat run --spec SPEC-RT-017`, patched, `partial` loosening nested blocks | 17 passed, 1 failed ("a partial record's nested block is exact") |

## Blast radius

The matcher was measured with an instrumented build of `matcher.ts`. The patch was applied after commit 90e78a6,
and the file was restored with `git show HEAD:<path>`. It ran three variants:

- **nested:** the draft.
- **nested-not-in-partial:** Q2's alternative, where `partial` also loosens its nested blocks.
- **all:** Q1's alternative, where the top-level block is exact too unless it is `partial`.

**flmnt, spec tier, every crate (in the gate image, Linux x86_64).** The run used a throwaway clone in a scratch
directory. Its pinned `@mmmnt/feat-runtime` 0.9.0 had `dist/matcher.js` replaced (unlinked, then copied). After the
run the clone and its docker volumes were deleted. Nothing in the flmnt repository was changed.

| flmnt revision | baseline | nested | nested-not-in-partial | all |
| --- | --- | --- | --- | --- |
| main 900e326 | 729 / 729 green | **1 red** | 1 red | **472 red** (of 729) |
| PR #334 head bf79f3d | n/a | **1 red** (of 774) | n/a | n/a |

- **nested:** the one red scenario is FLMNT-SPEC-MEM-012 "a type is matched exactly: another casing is refused".
  Its refusal response predicts `details: { type: "Plan" }`, but the body also carries `details.allowed`, the
  list of allowed types, which a sibling scenario does state.
- **all:** the most common shapes are:
  - a refusal response that states `code` (often with `status` and `context`) and leaves out `sentence` and `remedy`
    (about 297 scenarios);
  - an event record that leaves out `correlationId` (94), `timestamp` (58), `entryType` (57), `actor` (38),
    `causationId` (32) or `tokenSize` (31);
  - a response that leaves out `error` (54) or `detail` (16).
- **The finding, reproduced:** at the PR #334 head, `workspace` was taken out of LCY-014's and LCY-019's
  `projections.rebuilt` predictions. The current matcher kept them green (160 of 160). The patched matcher turned
  exactly the PR's three scenarios red (LCY-019's rebuild, and LCY-014's single-workspace and two-workspace
  imports).
- **Not measured:** the integration tier (`feat.integration.json` against real stores). The pin PR's CI runs it.

**Feature itself (macOS, `feat run`, all 48 specs plus the draft).**

| Variant | Newly red scenarios (vs baseline) | Where |
| --- | --- | --- |
| nested | 22 | SPEC-RPC-002 host-sharing 16, SPEC-RT-004 load-config-extends 5, SPEC-RT-001 load-config 1 |
| all | 113 | the above, plus SPEC-CORE-001 parse (refusals' `message`), SPEC-GEN-001, SPEC-ADPFS-002, SPEC-RPC-001 and more |

- **SPEC-RPC-002:** its nested per-file result blocks `a: { … }` / `b: { … }` state a few of about fifteen keys
  (`setups`, `clocks`, `peeks`, `stopped`, `settled`, …).
- **SPEC-RT-004 and SPEC-RT-001:** their nested config blocks (`specs`, `services`, `commands`, `report`,
  `response`) state a subset of the merged config.
- **Caveat:** six SPEC-RPC-002 timeout scenarios already fail on macOS at baseline, so whether they hit is unmeasured.
  A Linux re-check belongs to the migration (as MG6 did for ADR-0038).
- **`partial`:** no hit, in either repository, sat inside a `partial` block, so Q2 costs nothing either way.
- **`absent`:** at least 20 uses of `absent` sit inside nested blocks of flmnt's predictions, in 17 files (a
  line-based count). Feature has none outside its fixtures.

## Rulings workshop (recorded as flmnt exploration 749e4a70-5f69-526d-bad0-1992223441be)

### (a) Already promised

- **e9b228ec:** payload predictions match exactly. An unpredicted key fails the scenario. `partial` blocks keep their
  declared looseness. The order is a Feature workshop and spec amendment, then a release, then a flmnt pin PR that
  fixes every spec the stricter matching turns red.
- **Prediction inversion:** what is unpredicted is a violation.

### (b) Already answered (cited, not asked again)

- **The top-level block stays partial**, closed by the schema and `OPTIONAL_UNSTATED`. Exact top-level blocks were
  rejected: ADR-0038, agreed 580f3d10 (rulings 7d3026eb, 55fb39c4). The draft therefore reads e9b228ec as the
  nested block.
- **An object inside a list is exact**: an extra key is `UNPREDICTED field`, and `absent` there is refused: cc58ae94,
  7ca2385c, agreed 37a158c3. The draft reuses those words and that cut.
- **`partial` is written only on a record or response head.** It is refused inside a value, in a list item, in data
  and beside a golden: 55fb39c4 L1 and L4. No nested marker exists and the draft adds none.
- **Migration is by hand**, each block's choice is recorded, and fixes land before the rule so Feature's own gate is
  never red on it: 55fb39c4 L3, d2cd2f0d, ADR-0038 §4 and §5.
- **Surfacing a field violation in a record mismatch is a separate change**: ADR-0034 Consequences.

### (c) Open questions

1. **Scope. Confirm that e9b228ec means nested blocks only, with the top level as 580f3d10 left it.**
   - *Nested only:* flmnt has 1 red scenario, Feature 22.
   - *Top level too:* flmnt has 472 of 729 red, Feature 113. It also reverses ADR-0038's rejected
     alternative.
   - *Recommended:* nested only.
2. **Does `partial` loosen the nested blocks inside it?**
   - *Exact (recommended):* the keyword covers its own block's top level only, and a sub-object left unchecked on
     purpose is written `any`.
   - *Loosened:* hides a nested key the way the finding did, where no keyword can be seen.
   - *Cost:* 0 scenarios either way.
3. **`absent` inside a nested block.**
   - *Keep it allowed (recommended):* it is redundant now, but harmless.
   - *Refuse it as MALFORMED_SYNTAX,* as 7ca2385c did for list objects: one spelling per meaning, but at least 20
     flmnt uses break at parse time.
4. **The release version.**
   - *Recommended:* `@mmmnt/feat-runtime` 0.10.0, with `@mmmnt/feature` 0.16.0 taking the new range so a consumer
     resolves one runtime, tagged v0.1.84.
   - *Alternative:* a 0.9.1 patch. It would reach every `^0.9.0` range silently, which is wrong for a change that
     turns specs red.
5. **Is the change breaking for consumers?**
   - *Recommended:* yes. Say so in the release notes, because a spec that under-predicts a nested object goes red with
     no change of its own. In 0.x that is the minor bump of Q4, and consumers re-pin deliberately (flmnt pins exact
     versions).
6. **A migration lint.**
   - *None (recommended):* the runtime's list is exact and small (flmnt 1, Feature 22).
   - *A static `feat lint` rule* for nested blocks whose resolved sub-schema declares properties the block leaves out:
     partial coverage, and blind to open schemas, which is the case found.
   - *A report-only runtime switch:* rejected as an ungoverned config flag that changes domain behaviour.
7. **Feature's own 22 scenarios.** SPEC-RPC-002, SPEC-RT-004 and SPEC-RT-001 are agreed specs.
   - *Recommended:* amend them by hand from a migration table the founder ratifies (state each key, or write
     `any`), Linux-checked, and landed before the matcher in the same release.
8. **Record diagnostics.**
   - *Keep (recommended), for scope:* a red record keeps saying "captured X does not match predicted Y", as
     ADR-0034 left it.
   - *Name the first nested violation:* changes the words existing scenarios assert.
