# @mmmnt/feat-grammar

The TextMate grammar for `.feat` — the single highlighting artifact behind every
surface. Editor extensions, websites, and any TextMate-compatible tool consume
this package; the grammar is tested by tokenizing real corpus exemplars with
`vscode-textmate` (the engine VS Code itself uses).

## Websites (Shiki)

```js
import { createHighlighter } from "shiki";
import featLanguage from "@mmmnt/feat-grammar";

const highlighter = await createHighlighter({
  themes: ["github-dark"],
  langs: [featLanguage],
});
const html = highlighter.codeToHtml(specText, { lang: "feat", theme: "github-dark" });
```

## Editors

- **VS Code / Windsurf / Cursor / Devin**: install the `feat-vscode` extension
  (VS Code Marketplace + Open VSX) — it bundles this grammar.
- **JetBrains IDEs**: Settings → Editor → TextMate Bundles → add a directory
  containing `feat.tmLanguage.json`.
- **GitHub.com rendering**: requires a `github-linguist` submission (planned
  once the language has public usage).

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT
