# @mmmnt/feat-grammar

**The TextMate grammar for `.feat`.** One JSON file, scope `source.feat`, behind
every place a spec is shown with colour: the VS Code extension, a website
rendered with Shiki, and any other tool that reads TextMate grammars.

The grammar highlights. It does not parse. A line can be coloured as a keyword
and still be a parse error. For validation use `feat parse`
([`@mmmnt/feature`](https://www.npmjs.com/package/@mmmnt/feature)) or
[`@mmmnt/feat-core`](https://www.npmjs.com/package/@mmmnt/feat-core).

## Where it sits

This package is the source of truth for `.feat` highlighting. The `feat-vscode`
extension ships a copy of the file, synced from here by
`editors/vscode/scripts-sync-grammar.mjs`. The grammar is tested by tokenizing a
real corpus exemplar and asserting scopes with `vscode-textmate`, the engine VS
Code itself uses.

## Install

```sh
npm install @mmmnt/feat-grammar
```

Requirements:

- Node 20 or later (`engines`).
- ESM only (`"type": "module"`).
- No dependencies. `vscode-textmate`, `vscode-oniguruma` and `vitest` are dev
  dependencies of the package's own test; you need them only if you tokenize
  yourself, as in [Tokenize without a highlighter](#tokenize-without-a-highlighter).

The package ships three files: `index.js`, `index.d.ts` and
`feat.tmLanguage.json`.

## What it exports

```ts
export declare const grammar: Record<string, unknown>;       // the raw TextMate grammar, scopeName "source.feat"
export declare const featLanguage: Record<string, unknown>;  // grammar plus { name: "feat", aliases: ["feat"] }
export default featLanguage;
```

`index.js` reads the JSON with `node:fs`, so it runs in Node. For a browser
bundle, import the JSON file directly. The package has no `exports` map, so
this path resolves:

```js
import grammarJson from "@mmmnt/feat-grammar/feat.tmLanguage.json" with { type: "json" };
```

## Websites (Shiki)

Pass the raw grammar to Shiki with an explicit `name`:

```js
import { createHighlighter } from "shiki";
import { grammar } from "@mmmnt/feat-grammar";

const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: [{ ...grammar, name: "feat" }],
});
const html = highlighter.codeToHtml(specText, { lang: "feat", theme: "github-dark" });
```

Do not pass the default export (`featLanguage`) to Shiki yet. It carries
`aliases: ["feat"]` next to `name: "feat"`, and Shiki 1.29, 3.2 and 4.6 all stop
with `ShikiError: Circular alias 'feat -> feat'` when it is registered. The
snippet above was run against all three. If you want the alias handling and the
default export, drop the alias yourself: `{ ...featLanguage, aliases: [] }`.

## Editors

- **VS Code, Windsurf, Cursor, Devin**: install the `feat-vscode` extension
  (publisher `mmmnt`). It bundles this grammar for the `.feat` extension, and
  also starts `feat watch --json` in any workspace that has a `feat.config.json`.
- **JetBrains IDEs**: Settings, Editor, TextMate Bundles, then add a directory
  containing `feat.tmLanguage.json`.
- **GitHub.com rendering**: needs a `github-linguist` submission, planned once
  the language has public usage.

## Tokenize without a highlighter

The engine VS Code uses is available from npm. This prints the most specific
scope of each token of a line:

```js
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Registry, parseRawGrammar } = require("vscode-textmate");
const { loadWASM, OnigScanner, OnigString } = require("vscode-oniguruma");

await loadWASM(readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer);
const registry = new Registry({
  onigLib: Promise.resolve({
    createOnigScanner: (patterns) => new OnigScanner(patterns),
    createOnigString: (s) => new OnigString(s),
  }),
  loadGrammar: async () =>
    parseRawGrammar(readFileSync(require.resolve("@mmmnt/feat-grammar/feat.tmLanguage.json"), "utf8"), "feat.tmLanguage.json"),
});
const grammar = await registry.loadGrammar("source.feat");

const line = "  predict rejection NotOperator:";
for (const t of grammar.tokenizeLine(line, null).tokens)
  console.log(JSON.stringify(line.slice(t.startIndex, t.endIndex)), t.scopes.at(-1));
```

Carry `ruleStack` from one `tokenizeLine` to the next to tokenize a whole file.

## Scopes

Every scope name ends in `.feat`. The grammar separates the four token classes
of the language (keywords, validated names, literals and freeform text) so a
spec reads as structure.

| Scope | What carries it |
| --- | --- |
| `keyword.control.pragma.feat`, `constant.numeric.version.feat` | `feat` and `1.0` in the version pragma |
| `keyword.declaration.spec.feat`, `entity.name.type.spec-id.feat`, `string.quoted.double.feat` | `spec`, the spec id, and its quoted name |
| `keyword.declaration.feat` | `context`, `aggregate`, `type`, `status` |
| `entity.name.namespace.feat` | the context and aggregate names |
| `constant.language.spec-type.feat`, `constant.language.status.feat` | `command`, `saga`, ...; `draft`, `agreed`, ... |
| `keyword.control.section.feat` | `construct`, `enforce`, `contract`, `examples` |
| `keyword.other.directive.feat` | `handler at`, `touches`, `imports`, `input`, `response`, `record`, `event`, `error`, `rejects`, `clock at`, `execute`, `fault` |
| `keyword.control.scenario.feat`, `string.quoted.double.scenario-name.feat` | `scenario` and `scenario outline`, and the scenario's name |
| `keyword.control.trigger.feat` | `when`, `deliver`, `to` |
| `keyword.other.actor.feat`, `variable.other.actor.feat` | `as`, and the actor name (`anonymous` included) |
| `entity.name.function.command.feat`, `entity.name.function.event.feat` | the command name after `when:` or `execute`; the event name after `deliver` |
| `keyword.control.predict.feat`, `constant.language.prediction-type.feat` | `predict`; `success`, `rejection`, `error` |
| `constant.other.rejection-id.feat`, `constant.other.error-code.feat` | the id after `predict rejection`; the code after `predict error` |
| `entity.name.type.schema.feat` | the schema name after `response` status, and after `with` |
| `variable.other.service.feat`, `keyword.other.assertion.feat`, `entity.name.type.record.feat` | the service key; `has` and `contains`; the record type (`INSERT`, `OrderPlaced`, ...) |
| `keyword.other.with.feat`, `keyword.other.ordering.feat` | `with`; `ordered`, `unordered` |
| `support.function.matcher.feat`, `support.type.matcher.feat` | `any`, `matching`, `absent`, `equals fixture`; the `uuid`, `timestamp`, `string`, `number`, `boolean` qualifiers |
| `variable.language.stimulus-ref.feat` | `@when.email`, `@deliver[1].orderId`, `@payments[0].id` |
| `variable.parameter.placeholder.feat` | outline placeholders such as `<email>` |
| `string.quoted.double.feat`, `constant.numeric.feat` | string and number literals, including a response's status code |
| `comment.line.number-sign.feat` | `#` to the end of the line |

These are the scopes a token of the language's own corpus produces. A theme
that styles the standard TextMate names (`keyword.control`, `constant.language`,
`entity.name.type`, `variable.language`, `support.function`) colours them with
no extra work.

### What the grammar does not scope

- The grammar defines `keyword.other.response.feat` and
  `constant.numeric.status.feat` for `response <status> <Schema>` lines, but the
  directive rule matches `response` first, so across the whole corpus neither
  scope is ever produced: `response` takes `keyword.other.directive.feat` and the
  status takes `constant.numeric.feat`.
- `given:`, `variables:` and `seed` carry no scope of their own. They read as
  plain text in a highlighted spec.
- On a `fault` line only the word `fault` is scoped (as a directive). The
  service, the `Operation`, the `Fault` and the `times` clause are plain text.
- `predict rejection` accepts any id made of letters, digits, `_` and `-`, so
  `not-operator` is coloured as a rejection id even though the parser refuses
  it. Both `UPPER_SNAKE` and `UpperCamel` ids are coloured.

## What changed in 0.1.8

- **`fault` is a directive keyword.** The rule that scopes `handler at`,
  `touches`, `rejects` and the other directives now includes `fault`, so the
  reserved word of `given:` fault lines highlights (ADR-0023, SPEC-CORE-001).
- **UpperCamel rejection ids are asserted by the tokenizer test.** The grammar
  already coloured `predict rejection NotOperator:` as a rejection id, and the
  test now pins it (ADR-0022, SPEC-CORE-001).

## Specs and decisions

- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md):
  the language this grammar colours, including the four token classes (ADR-0007)
- [ADR-0022: UpperCamel rejection ids](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0022-uppercamel-rejection-ids.md)
- [ADR-0023: adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)
  (the `fault` line)
- [SPEC-CORE-001](https://github.com/mmmnt/feature/blob/main/packages/feat-core/parse.feat):
  the parser's contract

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT
