# The TextMate grammar has fallen behind the language (DRAFT)

Status: draft, awaiting the owner. Nothing is built.

| File | |
| --- | --- |
| `packages/feat-grammar/grammar.feat` | SPEC-GRM-001, new, `status draft` |
| `packages/feat-grammar/grammar.contract.json` | its contract (validates against `schemas/contract.schema.json`) |

## Which spec owns it

None. `packages/feat-grammar` has tests (`tokenize.test.ts`, `copies.test.ts`, `language.test.ts`) and no spec;
the ADRs that touched it (0022, 0027, 0030, 0033, 0034) each named a grammar change in their consequences and
the change rode along with the parser's spec. The draft is a new spec for the package. It is not a language
change, so it needs no ADR.

## Root cause

`packages/feat-grammar/feat.tmLanguage.json` (main 72f71de):

- `repository.sections` (`^(construct|enforce|contract|given)\s*:` and `^\s+(handler at|touches|imports|input|response|record|event|error|rejects|clock at|execute|fault)\b`):
  no `variables`, `needs`, `register`, `emit to`, `stream`, `seed`, `random seed`, `from`, `in`; the opener only at
  column 0, so an indented `given:` (every corpus given) is unscoped; the directives only when indented.
- `repository.prediction` record rule `\b([A-Z][A-Za-z0-9_]*)\s+(with)\s+…`: an uppercase first letter, no dot.
- `repository.matchers` `\b(any)\s+(uuid|timestamp|string|number|boolean)\b`: `any` only with a type.
- `repository.trigger` `^\s+(when)\s*:\s*([A-Z]…)`: `when` only directly before the colon, so not
  `when (as admin):`.
- `repository.placeholders` `\{\$[A-Za-z_][A-Za-z0-9_]*\}`: matches `{$x}`; the language's reference is `${x}`
  (`packages/feat-core/src/parse.ts:658`, `VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g`), and it is written only in
  strings, which `repository.strings` (`"[^"]*"`) scopes whole.
- `repository.strings` `"[^"]*"`: no escapes, so `"a\"b"` ends at the escaped quote.
- `repository.trigger` deliver rule scopes the word after `to` as `variable.other.service.feat`, `response`
  included (ADR-0036: `response` is never a service).
- `repository.comment` `#.*$`: any `#` outside a string starts a comment, so a trailing comment is coloured as one
  while the parser refuses it or reads it as text (grammar reference §1.2; `drafts/parser-strict-lines`).

## Reproduction

A scratch script loads the package's grammar with its own devDependencies (vscode-textmate 9.2,
vscode-oniguruma 2.0), tokenizes each line alone, and prints the scopes (without `source.feat`) of the token
holding the given text:

| Line | At | Scopes today |
| --- | --- | --- |
| `variables:` | `variables` | none |
| `  random seed 42` | `random`, `seed` | none |
| `    seed eventStore [ X with S { a: 1 } ]` | `seed` | none |
| `    seed eventStore from "fixtures/x.json"` | `seed`, `from` | none |
| `  needs SPEC-USR-001` | `needs` | none |
| `  register mutation createFlow in resolvers/mutations.ts` | `register` | none |
| `  emit to automation-flow-{flowId}` | `emit to` | none |
| `  stream "automation-flow-*"` | `stream` | none |
| `  imports FlowAggregate from core/domain/flow` | `from` | none |
| `    fault store Append Timeout once` / `times 3` / `until reset` | `once`, `times`, `until reset` | none |
| `    eventStore has [ stripe.charge with Charge { a: 1 } ]` | `stripe.charge` | none |
| `    eventStore has [ userCreated with User { a: 1 } ]` | `userCreated` | none |
| `    eventStore has [ UserCreated with User { a: 1 } ]` (control) | `UserCreated` | `entity.name.type.record.feat` |
| `    response OK R { id: any }` | `any` | none |
| `    response OK R { id: any uuid }` (control) | `any` | `support.function.matcher.feat` |
| `  when (as admin): DoThing { a: 1 }` | `when`, `DoThing` | none |
| `  when: DoThing { a: 1 }` (control) | `when` | `keyword.control.trigger.feat` |
| `  when: DoThing { name: "${who}" }` | `${who}` | `string.quoted.double.feat` only |
| `  when: DoThing { name: {$who} }` | `{$who}` | `variable.parameter.placeholder.feat` (the wrong form) |
| `  when: DoThing { name: "a\"b" }` | `b"` | none (the string ended at `\"`) |
| `  given:` | `given` | none |
| `touches src/**` | `touches` | none |
| `  deliver OrderShipped { id: 1 } to response` | `response` | `variable.other.service.feat` |
| `    response OK R { title: "x" }   # note` | `# note` | `comment.line.number-sign.feat` |

Corpus sweep (scratch script): over every corpus exemplar, the lines whose first word is a keyword listed in
the reference's §9, leaving out a keyword used as a value-block field name (`status: "active"`): 623 lines, 48
whose keyword token has only `source.feat`. One is prose (`ship-order.feat:20`, an enforce line beginning
"when"), so 47: `given` 24, `seed` 9, `when` 7 (`when (as …):` in `rejection-camelcase` and `suspend-user`),
`emit` 2, `register` 1, `stream` 1, `random` 1, `needs` 1, `variables` 1. The spec's `SweepCorpus` replaces the
first-word heuristic with feat-core's own section rules, so prose lines are not counted.

## Decisions for the owner

1. **Own the grammar with a spec.**
   - **A. SPEC-GRM-001 as drafted: one scenario per form, prose controls, and a corpus sweep keyed to §9 of the
     reference, so a keyword added to the language without a grammar change fails the build (Recommended).**
   - B. Fix the grammar under `tokenize.test.ts` alone, without a spec (how it has been maintained).
2. **Trailing `#`.** The draft scopes a comment only at the start of a line, matching ADR-0040 decision 4A
   (refuse trailing comments). If the owner takes 4B (strip them), the last prose row flips: a trailing
   `# the answer` is a comment, and the grammar keeps `#.*$` outside strings.
3. **Scope names.** The draft reuses the grammar's names and adds three: `keyword.other.fault-count.feat`,
   `constant.character.escape.feat` and `keyword.other.response.feat` (for `to response`). Themes colour them
   by their prefix. The owner may prefer other names; the scenarios name them.
4. **The two copies.** `editor/feat.tmLanguage.json` and `editors/vscode/syntaxes/feat.tmLanguage.json` stay
   byte-identical copies (`copies.test.ts`); the spec touches both so the sync is in scope.
