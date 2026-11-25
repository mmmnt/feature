# @mmmnt/feat-grammar

The TextMate grammar for `.feat`: one JSON file, scope `source.feat`, behind every place a spec is shown with colour
(the VS Code extension, a website rendered with Shiki, any TextMate-compatible highlighter). The grammar highlights;
it does not parse. A line can be coloured as a keyword and still be a parse error, so validate with `feat parse`
([`@mmmnt/feature`](../feature/README.md)) or [`@mmmnt/feat-core`](../feat-core/README.md).

This package is the source of truth for `.feat` highlighting. `editor/feat.tmLanguage.json` and
`editors/vscode/syntaxes/feat.tmLanguage.json` are byte-identical copies, refreshed by
`editors/vscode/scripts-sync-grammar.mjs`; `copies.test.ts` fails if either drifts. The grammar is tested by
tokenizing corpus exemplars with `vscode-textmate`, the engine VS Code uses.

## Installation

Requires Node.js 22 or newer.

```bash
npm install @mmmnt/feat-grammar
```

ESM only, no runtime dependencies. The package ships `index.js`, `index.d.ts` and `feat.tmLanguage.json`.

## Exports

```ts
export declare const grammar: Record<string, unknown>;       // the raw TextMate grammar, scopeName "source.feat"
export declare const featLanguage: Record<string, unknown>;  // grammar plus { name: "feat" }, no aliases
export default featLanguage;
```

`index.js` reads the JSON with `node:fs`, so it runs in Node. In a browser bundle, import the JSON file directly
(the package has no `exports` map, so the path resolves):

```js
import grammarJson from "@mmmnt/feat-grammar/feat.tmLanguage.json" with { type: "json" };
```

## Usage with Shiki

```js
import { createHighlighter } from "shiki";
import featLanguage from "@mmmnt/feat-grammar";

const highlighter = await createHighlighter({ themes: ["github-dark"], langs: [featLanguage] });
const html = highlighter.codeToHtml(specText, { lang: "feat", theme: "github-dark" });
```

The export carries no `aliases`: an alias equal to the language's own name makes Shiki stop with
`Circular alias 'feat -> feat'`. `language.test.ts` pins that shape.

## Editors

- **VS Code and its forks**: install the `feat-vscode` extension (publisher `mmmnt`, see
  [editors/vscode](../../editors/vscode/README.md)). It bundles this grammar.
- **JetBrains IDEs**: Settings › Editor › TextMate Bundles, then add a directory containing `feat.tmLanguage.json`.

## Tokenize without a highlighter

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

`vscode-textmate` and `vscode-oniguruma` are not dependencies of this package; install them to tokenize yourself.
Carry `ruleStack` from one `tokenizeLine` to the next to tokenize a whole file.

## Scopes

Every scope name ends in `.feat`.

| Scope | What carries it |
| --- | --- |
| `keyword.control.pragma.feat`, `constant.numeric.version.feat` | `feat` and `1.0` in the version pragma |
| `keyword.declaration.spec.feat`, `entity.name.type.spec-id.feat`, `string.quoted.double.feat` | `spec`, the spec id, and its quoted name |
| `keyword.declaration.feat` | `context`, `aggregate`, `type`, `status`, `observes` |
| `entity.name.namespace.feat` | the context and aggregate names |
| `constant.language.spec-type.feat`, `constant.language.status.feat` | `command`, `saga`, …; `draft`, `agreed`, … |
| `keyword.control.section.feat` | `construct`, `enforce`, `contract`, `examples` |
| `keyword.other.directive.feat` | `handler at`, `touches`, `imports`, `input`, `response`, `record`, `event`, `error`, `rejects`, `clock at`, `execute`, `fault` |
| `keyword.control.scenario.feat`, `string.quoted.double.scenario-name.feat` | `scenario` and `scenario outline`, and the scenario's name |
| `keyword.control.trigger.feat` | `when`, `deliver`, `to` |
| `keyword.other.actor.feat`, `variable.other.actor.feat` | `as`, and the actor name (`anonymous` included) |
| `entity.name.function.command.feat`, `entity.name.function.event.feat` | the command after `when:` or `execute`; the event after `deliver` |
| `keyword.control.predict.feat`, `constant.language.prediction-type.feat` | `predict`; `success`, `rejection`, `error` |
| `constant.other.rejection-id.feat`, `constant.other.error-code.feat` | the id after `predict rejection`; the code after `predict error` |
| `entity.name.type.schema.feat` | the schema name after `with` |
| `variable.other.service.feat`, `keyword.other.assertion.feat`, `entity.name.type.record.feat` | the service key (also each service on an `observes` line); `has` and `contains`; the record type (`INSERT`, `OrderPlaced`, …) |
| `keyword.other.with.feat`, `keyword.other.ordering.feat` | `with`; `ordered`, `unordered` |
| `support.function.matcher.feat`, `support.type.matcher.feat` | `any`, `matching`, `absent`, `not`, `partial`, `f32` and `sha256` (digest form), `equals fixture`; the `uuid`, `timestamp`, `string`, `number`, `boolean` qualifiers |
| `variable.language.stimulus-ref.feat` | `@when.email`, `@deliver[1].orderId`, `@payments[0].id` |
| `variable.parameter.placeholder.feat` | outline placeholders such as `<email>` |
| `string.quoted.double.feat`, `constant.numeric.feat` | string and number literals, including a response's status code |
| `comment.line.number-sign.feat` | `#` to the end of the line |

### What the grammar does not scope

- The grammar defines `keyword.other.response.feat` and `constant.numeric.status.feat` for `response <status>
  <Schema>` lines, but the directive rule matches `response` first, so `response` takes
  `keyword.other.directive.feat`, the status takes `constant.numeric.feat`, and the schema name after the status is
  plain text.
- `given:`, `variables:`, `seed` and `random seed` carry no scope of their own.
- On a `fault` line only the word `fault` is scoped. The service, operation, fault and `times` clause are plain text
  (a number takes `constant.numeric.feat`).
- `predict rejection` colours any id made of letters, digits, `_` and `-`, so `not-operator` is coloured although the
  parser refuses it.

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
