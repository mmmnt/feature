// The grammar's source of truth is packages/feat-grammar; the extension and editor/ ship copies.
import { copyFileSync } from "node:fs";
copyFileSync("../../packages/feat-grammar/feat.tmLanguage.json", "syntaxes/feat.tmLanguage.json");
copyFileSync("../../packages/feat-grammar/feat.tmLanguage.json", "../../editor/feat.tmLanguage.json");
