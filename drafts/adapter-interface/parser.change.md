# DRAFT — parser edit points for `fault` (Layer 3 of 4)

Nothing here is applied. Each point names the file and the line it hangs from in the v0.1.47 tree.

1. `packages/feat-core/src/parse.ts`, scenario `given` phase (~line 636, the `if/else if` chain
   that already holds `clock at`, `execute`, `seed`). Insert **before** the final `else` that
   pushes freeform context:

   ```ts
   } else if (/^fault(?:[ \t]|$)/.test(t)) {
     // ADR-0023: `fault` is reserved at the start of a given line. Anything that starts with it
     // and does not match the form is MALFORMED_SYNTAX, never freeform context (today it is
     // silently freeform: the exemplar's fault lines parse as context and exit 0).
     const faults = (given.faults as unknown[] | undefined) ?? [];
     faults.push(parseFaultLine(t, s.line));
     given.faults = faults;
   }
   ```

   `parseFaultLine(t, line)`: strip a trailing consumption clause with
   `/[ \t]+(once|times[ \t]+([1-9][0-9]*)|until[ \t]+reset)$/` (none = `times: 1`; `once` = 1;
   `times n` = n; `until reset` = `"reset"`), then match the head with
   `/^fault[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+([A-Z][A-Za-z0-9]*)[ \t]+([A-Z][A-Za-z0-9]*|[A-Z][A-Z0-9_]*)(?:[ \t]+(\{[\s\S]*\}))?$/`
   and read the optional `{…}` with the existing `parseInlinePayload` (the same object reader the
   `execute` and `when:` payloads use; it already rejects matchers outside value blocks).
   Emit `{ service, operation, fault, detail?, times }` with `times` always present. Failures:
   `MALFORMED_SYNTAX` with the hint
   `Form: fault <service> <Operation> <Fault> [{ json }] [once | times <n> | until reset]`.

2. Same file, the closed-space block (~line 757, where `serviceRefs` collects prediction, seed
   and deliver targets): add
   `for (const f of (given?.faults as Record<string, unknown>[] | undefined) ?? []) serviceRefs.push(f.service as string);`
   so a fault on an unconfigured service is `UNKNOWN_SERVICE_KEY` listing the configured ones.
   `INCOMPLETE_PREDICTION`, `QUERY_SIDE_EFFECT` and the trigger checks are untouched. A `fault`
   in a `type query` spec is allowed (a query can meet a faulted read).

3. `packages/feat-types/src/index.ts`: `Fault` and `Given.faults` (schemas.change.md).
4. `schemas/builtspec.schema.json`: the `fault` definition (schemas.change.md).
5. `packages/feat-derive/src/index.ts`, `substituteGiven` (~line 158): copy `faults`, running
   `substituteValue` over each `detail` so outline placeholders and `${vars}` work:
   `if (given.faults) out.faults = given.faults.map((f) => f.detail === undefined ? f : { ...f, detail: substituteValue(f.detail, row) as Record<string, unknown> });`
6. `packages/feat-runtime/src/harness.ts`: `HarnessCase.given.faults`; preflight, arming and the
   consumption check (DESIGN.md §d). `feat-emit-ts` needs no change (cases are JSON).
7. Highlighters: `packages/feat-grammar/feat.tmLanguage.json` line 121 (and its two copies,
   `editor/feat.tmLanguage.json`, `editors/vscode/syntaxes/feat.tmLanguage.json`): add `fault` to
   the keyword alternation `(… |clock at|execute)` and `once|times|until reset` after it.
8. `packages/feat-analyze`: lint info when a fault's `<service>` has `consistency: eventual` and
   the scenario predicts `records []` without an `absenceTimeout` is out of scope; none required.
9. `corpus/README.md`: row 13 for the exemplar; `corpus/given-fault/` from
   `drafts/adapter-interface/corpus/given-fault/` (`feat.config.json` inherits nothing; its
   service is the memory adapter at `strong`, the spec tier).
10. Re-validate: `pnpm corpus:validate`, the `feat-core` corpus tests (INV-1 determinism over the
    whole corpus, parse-source parity), and `feat parse` of every existing `.feat` in the repo —
    a repo-wide grep of every `.feat` (corpus, packages, adapters, drafts) finds no line that
    starts with `fault` other than this draft's exemplar, so reserving the prefix breaks nothing here.
