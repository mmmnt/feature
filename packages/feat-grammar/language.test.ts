// Shiki refuses a language whose aliases contain its own name ("Circular alias
// feat -> feat", Shiki 1.29, 3.2 and 4.6). shiki is not a dependency anywhere in
// this repo, so the test pins the exported shape Shiki validates instead.
import { describe, expect, it } from "vitest";
import featLanguage, { featLanguage as named, grammar } from "./index.js";

describe("featLanguage (Shiki LanguageRegistration)", () => {
  it("is the default and the named export", () => {
    expect(featLanguage).toBe(named);
  });

  it("is named feat and carries the grammar", () => {
    expect(featLanguage.name).toBe("feat");
    expect(featLanguage.scopeName).toBe(grammar.scopeName);
  });

  it("has no alias equal to its own name (Shiki: Circular alias)", () => {
    const aliases = (featLanguage.aliases ?? []) as string[];
    expect(aliases).not.toContain(featLanguage.name);
  });
});
