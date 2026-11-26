# @mmmnt/feat-grammar

The TextMate grammar for `.feat`: one JSON file, scope `source.feat`, behind every place a spec is shown with colour
(the VS Code extension, a website rendered with Shiki, any TextMate-compatible highlighter). The grammar highlights;
it does not parse. A line can be coloured as a keyword and still be a parse error, so validate with `feat parse`
([`@mmmnt/feature`](../feature/README.md)) or [`@mmmnt/feat-core`](../feat-core/README.md).

This package is the source of truth for `.feat` highlighting. `editor/feat.tmLanguage.json` and
`editors/vscode/syntaxes/feat.tmLanguage.json` are byte-identical copies, refreshed by
`editors/vscode/scripts-sync-grammar.mjs`; `copies.test.ts` fails if either drifts. The grammar is tested by
tokenizing corpus exemplars with `vscode-textmate`, the engine VS Code uses. Its spec is SPEC-GRM-001
([`grammar.feat`](grammar.feat)): every keyword the parser reads is scoped in the forms the parser reads it, the same
word in prose is not, and a sweep of the corpus, keyed to the keyword list in §9 of the grammar reference, fails when a
keyword the parser reads goes unscoped.

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
| `keyword.control.section.feat` | `construct`, `enforce`, `contract`, `variables`, `given`, `examples`, indented or not |
| `keyword.other.directive.feat` | `handler at`, `touches`, `needs`, `imports … from`, `register … in`, `emit to`, each in its typed form; `rejects`; a contract entry's `input`, `response`, `record`, `event`, `error`, `stream` and `from`; a given's `execute`, `seed` (and its `from`), `clock at`, `random seed` and `fault` |
| `keyword.other.fault-count.feat` | `once`, `times`, `until reset` at the end of a `fault` line |
| `keyword.control.scenario.feat`, `string.quoted.double.scenario-name.feat` | `scenario` and `scenario outline`, and the scenario's name |
| `keyword.control.trigger.feat` | `when` (also `when (as <actor>):`), `deliver`, `to` |
| `keyword.other.response.feat` | `response` in `deliver … to response` (ADR-0036: never a service), and a prediction's `response` |
| `constant.numeric.status.feat` | the status of a prediction's `response <status> <Schema>` |
| `keyword.other.actor.feat`, `variable.other.actor.feat` | `as`, and the actor name (`anonymous` included) |
| `entity.name.function.command.feat`, `entity.name.function.event.feat` | the command after `when:` or `execute`; the event after `deliver` |
| `keyword.control.predict.feat`, `constant.language.prediction-type.feat` | `predict`; `success`, `rejection`, `error` |
| `constant.other.rejection-id.feat`, `constant.other.error-code.feat` | the id after `predict rejection`; the code after `predict error` |
| `entity.name.type.schema.feat` | the schema name after `with`, and after a prediction's `response <status>` |
| `variable.other.service.feat`, `keyword.other.assertion.feat`, `entity.name.type.record.feat` | the service key (also each service on an `observes` line); `has` and `contains`; the record type (`INSERT`, `OrderPlaced`, `stripe.charge`, `userCreated`, …) |
| `keyword.other.with.feat`, `keyword.other.ordering.feat` | `with`; `ordered`, `unordered` |
| `support.function.matcher.feat`, `support.type.matcher.feat` | `any` (bare or typed, in a value position), `matching`, `absent`, `not`, `partial`, `f32` and `sha256` (digest form), `equals fixture`; the `uuid`, `timestamp`, `string`, `number`, `boolean` qualifiers |
| `variable.language.stimulus-ref.feat` | `@when.email`, `@deliver[1].orderId`, `@payments[0].id` |
| `variable.parameter.placeholder.feat` | outline placeholders such as `<email>`; a spec-variable reference `${name}` inside the string that holds it |
| `string.quoted.double.feat`, `constant.numeric.feat` | string and number literals |
| `constant.character.escape.feat` | a JSON escape inside a string: `\"`, `\\`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX` |
| `comment.line.number-sign.feat` | a line whose first non-blank character is `#`; a trailing `#` is not a comment (ADR-0040: the parser refuses it on a line it reads by keyword, and keeps it as text in prose) |

### What the grammar does not scope

- On a `fault` line the service, operation and fault are plain text (a number takes `constant.numeric.feat`).
- A `deliver` whose payload spans lines scopes `to` and its target only when they are on the `deliver` line.
- `predict rejection` colours any id made of letters, digits, `_` and `-`, so `not-operator` is coloured although the
  parser refuses it.

## Changelog

Per-release changes are in [CHANGELOG.md](CHANGELOG.md). Every `@mmmnt` package is released at the same version.

## Contributing

This package is part of the [Feature monorepo](https://github.com/mmmnt/feature). See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the development setup, the spec-driven rules and the
local gate.

```bash
git clone https://github.com/mmmnt/feature.git
cd feature
pnpm install
pnpm build --filter=@mmmnt/feat-grammar
pnpm --filter @mmmnt/feat-grammar test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
