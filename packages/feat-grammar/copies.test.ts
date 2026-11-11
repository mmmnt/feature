// The grammar's source of truth is this package. The editor copies must be
// byte-identical; editors/vscode/scripts-sync-grammar.mjs refreshes them.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PKG, "../..");
const source = readFileSync(path.join(PKG, "feat.tmLanguage.json"), "utf8");

describe("editor grammar copies", () => {
  for (const copy of ["editor/feat.tmLanguage.json", "editors/vscode/syntaxes/feat.tmLanguage.json"]) {
    it(`${copy} equals packages/feat-grammar (run editors/vscode/scripts-sync-grammar.mjs)`, () => {
      expect(readFileSync(path.join(ROOT, copy), "utf8")).toBe(source);
    });
  }
});
