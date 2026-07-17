// Real-instrument test: vscode-textmate (the engine VS Code itself uses)
// tokenizes an actual corpus exemplar with this grammar, and we assert the
// scopes that produce the language's visual separation. If a grammar edit
// stops distinguishing keywords from prose, this fails — not a reviewer.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Registry, parseRawGrammar, type IGrammar } from "vscode-textmate";
import { loadWASM, OnigScanner, OnigString } from "vscode-oniguruma";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let grammar: IGrammar;

function scopesAt(line: string, substring: string): string[] {
  const tokens = grammar.tokenizeLine(line, null).tokens;
  const idx = line.indexOf(substring);
  const token = tokens.find((t) => t.startIndex <= idx && idx < t.endIndex);
  return token?.scopes ?? [];
}

beforeAll(async () => {
  const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
  await loadWASM(wasm);
  const registry = new Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (patterns) => new OnigScanner(patterns),
      createOnigString: (s) => new OnigString(s),
    }),
    loadGrammar: async () => {
      const raw = readFileSync(path.join(PKG, "feat.tmLanguage.json"), "utf8");
      return parseRawGrammar(raw, "feat.tmLanguage.json");
    },
  });
  grammar = (await registry.loadGrammar("source.feat"))!;
});

describe("feat grammar tokenization", () => {
  it("tokenizes a full corpus exemplar without dying", () => {
    const spec = readFileSync(path.join(PKG, "../../corpus/create-user/create-user.feat"), "utf8");
    let state = null;
    for (const line of spec.split("\n")) {
      const r = grammar.tokenizeLine(line, state);
      state = r.ruleStack;
      expect(r.tokens.length).toBeGreaterThan(0);
    }
  });

  it("separates identity keywords from their values", () => {
    expect(scopesAt('spec SPEC-USR-001 "CreateUser"', "spec")).toContain("keyword.declaration.spec.feat");
    expect(scopesAt('spec SPEC-USR-001 "CreateUser"', "SPEC-USR-001")).toContain("entity.name.type.spec-id.feat");
    expect(scopesAt("type command", "command")).toContain("constant.language.spec-type.feat");
    expect(scopesAt("status agreed", "agreed")).toContain("constant.language.status.feat");
  });

  it("makes the trigger and prediction structure pop", () => {
    expect(scopesAt('  when: CreateUser { email: "a@b.c" }', "when")).toContain("keyword.control.trigger.feat");
    expect(scopesAt('  when: CreateUser { email: "a@b.c" }', "CreateUser")).toContain("entity.name.function.command.feat");
    expect(scopesAt("  predict success:", "predict")).toContain("keyword.control.predict.feat");
    expect(scopesAt("  predict rejection DUPLICATE_EMAIL:", "DUPLICATE_EMAIL")).toContain("constant.other.rejection-id.feat");
    expect(scopesAt("    database has [ INSERT with UserRow {", "has")).toContain("keyword.other.assertion.feat");
    expect(scopesAt("    database has [ INSERT with UserRow {", "database")).toContain("variable.other.service.feat");
  });

  it("highlights matchers and stimulus references", () => {
    expect(scopesAt("      id: any uuid", "any")).toContain("support.function.matcher.feat");
    expect(scopesAt("      deletedAt: absent", "absent")).toContain("support.function.matcher.feat");
    expect(scopesAt("      email: @when.email", "@when.email")).toContain("variable.language.stimulus-ref.feat");
    expect(scopesAt("  deliver OrderPublished { orderId: \"x\" } to eventBroker", "deliver")).toContain("keyword.control.trigger.feat");
  });

  it("treats comments and scenario names distinctly", () => {
    expect(scopesAt("# a comment line", "comment")).toContain("comment.line.number-sign.feat");
    expect(scopesAt('scenario "successful user creation":', "scenario")).toContain("keyword.control.scenario.feat");
  });
});
