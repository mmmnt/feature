// The grammar's source of truth is packages/feat-grammar; the extension ships a copy.
import { copyFileSync } from "node:fs";
copyFileSync("../../packages/feat-grammar/feat.tmLanguage.json", "syntaxes/feat.tmLanguage.json");
