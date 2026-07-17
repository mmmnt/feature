// @mmmnt/feat-grammar — the TextMate grammar for .feat, ready for Shiki and any
// TextMate-compatible highlighter. The JSON file is the artifact; this module
// wraps it in the shapes the common consumers want.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const grammarPath = fileURLToPath(new URL("./feat.tmLanguage.json", import.meta.url));

/** The raw TextMate grammar object (scopeName: source.feat). */
export const grammar = JSON.parse(readFileSync(grammarPath, "utf8"));

/**
 * Shiki LanguageRegistration: pass straight to `createHighlighter({ langs: [featLanguage] })`
 * or `highlighter.loadLanguage(featLanguage)`, then highlight with `lang: "feat"`.
 */
export const featLanguage = {
  ...grammar,
  name: "feat",
  aliases: ["feat"],
};

export default featLanguage;
