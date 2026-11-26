// The probe behind `Tokenize` and `SweepCorpus` (SPEC-GRM-001). It loads feat.tmLanguage.json with vscode-textmate
// and vscode-oniguruma, the engine VS Code uses, as tokenize.test.ts does, and answers scopes as data. Part of the
// build, not shipped (package.json "files" leaves fixtures/ out).
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vsctm from "vscode-textmate";
import oniguruma from "vscode-oniguruma";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(PKG, "../..");
const require = createRequire(import.meta.url);

let grammarPromise;
function loadGrammar() {
  grammarPromise ??= (async () => {
    const wasm = readFileSync(require.resolve("vscode-oniguruma/release/onig.wasm")).buffer;
    await oniguruma.loadWASM(wasm);
    const registry = new vsctm.Registry({
      onigLib: Promise.resolve({
        createOnigScanner: (patterns) => new oniguruma.OnigScanner(patterns),
        createOnigString: (s) => new oniguruma.OnigString(s),
      }),
      loadGrammar: async () => vsctm.parseRawGrammar(readFileSync(path.join(PKG, "feat.tmLanguage.json"), "utf8"), "feat.tmLanguage.json"),
    });
    return registry.loadGrammar("source.feat");
  })();
  return grammarPromise;
}

/** The scopes of the token holding index `idx`, without source.feat, space-joined ("" for none). */
function scopesOf(tokens, idx) {
  const token = tokens.find((t) => t.startIndex <= idx && idx < t.endIndex);
  return (token?.scopes ?? []).filter((s) => s !== "source.feat").join(" ");
}

/**
 * `Tokenize { line, at }`: `line` alone (a fresh rule stack), the token holding the first occurrence of `at`.
 * `Tokenize { file, lineNo, column }`: the file tokenized up to that line, the rule stack carried, the token at
 * that 1-based column.
 */
export async function tokenize(input) {
  const grammar = await loadGrammar();
  if (input.file !== undefined) {
    const lines = readFileSync(path.resolve(process.cwd(), input.file), "utf8").split(/\r?\n/);
    let stack = vsctm.INITIAL;
    for (let i = 0; i < input.lineNo; i++) {
      const r = grammar.tokenizeLine(lines[i] ?? "", stack);
      if (i === input.lineNo - 1) return { status: "OK", body: { scopes: scopesOf(r.tokens, input.column - 1) } };
      stack = r.ruleStack;
    }
  }
  const idx = input.line.indexOf(input.at);
  if (idx < 0) return { status: "ERR", body: { code: "NOT_IN_LINE", detail: `'${input.at}' is not in '${input.line}'` } };
  return { status: "OK", body: { scopes: scopesOf(grammar.tokenizeLine(input.line, vsctm.INITIAL).tokens, idx) } };
}

/** The keywords the grammar reference lists in §9, read from docs/grammar-reference.md, as single words. */
function referenceKeywords() {
  const ref = readFileSync(path.join(ROOT, "docs/grammar-reference.md"), "utf8");
  const start = ref.indexOf("## 9. Reserved keyword summary");
  if (start < 0) throw new Error("docs/grammar-reference.md has no '## 9. Reserved keyword summary'");
  const rest = ref.slice(start + 1);
  const end = rest.search(/\n---\n|\n## /);
  const section = end < 0 ? rest : rest.slice(0, end);
  const words = new Set();
  for (const [, chunk] of section.matchAll(/`([^`]+)`/g))
    for (const w of chunk.split(/\s+/)) {
      const word = w.replace(/:$/, "");
      if (/^[a-z][a-z0-9]*$/.test(word)) words.add(word);
    }
  return words;
}

// feat-core's section rules (packages/feat-core/src/parse.ts): what kind of line each statement is.
const OPENERS = new Set(["construct:", "enforce:", "contract:", "variables:"]);
const SCENARIO_OPENER = /^scenario([ \t]+outline)?[ \t]+"((?:[^"\\]|\\.)*)":$/;
const CONSTRUCT_TYPED = [
  /^handler[ \t]+at[ \t]+(\S+)$/,
  /^imports[ \t]+(\S+)[ \t]+from[ \t]+(\S+)$/,
  /^register[ \t]+(\S+)[ \t]+(\S+)[ \t]+in[ \t]+(\S+)$/,
  /^emit[ \t]+to[ \t]+(\S+)$/,
  /^touches[ \t]+(\S+)$/,
  /^needs[ \t]+(\S+)$/,
];
const isGivenStep = (t) =>
  /^(?:execute|seed|fault)(?:[ \t(]|$)/.test(t) || /^clock[ \t]+at(?:[ \t]|$)/.test(t) || /^random[ \t]+seed(?:[ \t]|$)/.test(t);
const isScenarioLevel = (t) =>
  t === "given:" || t === "examples:" || /^when(?:[ \t]*\(|[ \t]*:)/.test(t) || /^deliver[ \t]/.test(t) || /^predict[ \t]/.test(t);

const depthOf = (s) => {
  let d = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{" || c === "[") d++;
    else if (c === "}" || c === "]") d--;
  }
  return d;
};

/**
 * The lines of one spec the parser reads by a keyword, with that keyword: each statement's first line (a value
 * that spans lines continues a statement), classified by the parser's sections. Header lines, section openers,
 * contract and variables lines, scenario lines (a given's context lines are prose and left out) and construct
 * lines in a typed form. The keyword is the line's first word, or `has`/`contains` on a prediction line; a line
 * whose first word is not one of the reference's keywords is read by its form, not a keyword (a variable
 * definition, an examples row), and is not swept.
 */
function keywordLines(source, keywords) {
  const out = [];
  let section = "none";
  let phase = "none";
  let depth = 0;
  const lines = source.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const t = raw.trim();
    if (depth > 0) {
      depth += depthOf(t);
      return;
    }
    if (t === "" || t.startsWith("#")) return;
    depth = Math.max(0, depthOf(t));
    let read = false;
    if (OPENERS.has(t)) {
      section = t.slice(0, -1);
      read = true;
    } else if (SCENARIO_OPENER.test(t)) {
      section = "scenario";
      phase = "none";
      read = true;
    } else if (section === "none" || section === "contract" || section === "variables") read = true;
    else if (section === "construct") read = CONSTRUCT_TYPED.some((r) => r.test(t));
    else if (section === "scenario") {
      if (t === "given:") phase = "given";
      else if (/^predict[ \t]/.test(t)) phase = "predict";
      else if (t === "examples:") phase = "examples";
      else if (/^when(?:[ \t]*\(|[ \t]*:)/.test(t) || /^deliver[ \t]/.test(t)) phase = "none";
      if (t.startsWith("|")) read = false;
      else if (phase === "given" && t !== "given:") read = isGivenStep(t) || isScenarioLevel(t);
      else read = true;
    }
    if (!read) return;
    const first = /^[A-Za-z_][A-Za-z0-9_]*/.exec(t)?.[0];
    let word = first !== undefined && keywords.has(first) ? first : undefined;
    const hc = /^[A-Za-z_][A-Za-z0-9_]*[ \t]+(has|contains)\b/.exec(t);
    if (word === undefined && hc && keywords.has(hc[1])) word = hc[1];
    if (word === undefined) return;
    const col = new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`).exec(raw).index;
    out.push({ lineNo: i + 1, word, col });
  });
  return out;
}

/** `SweepCorpus {}`: every corpus exemplar line the parser reads by a keyword whose keyword token has no scope. */
export async function sweepCorpus() {
  const grammar = await loadGrammar();
  const keywords = referenceKeywords();
  const corpus = path.join(ROOT, "corpus");
  const unscoped = [];
  let checked = 0;
  for (const dir of readdirSync(corpus, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const file = path.join(corpus, dir, `${dir}.feat`);
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    const want = new Map(keywordLines(source, keywords).map((k) => [k.lineNo, k]));
    let stack = vsctm.INITIAL;
    source.split(/\r?\n/).forEach((line, i) => {
      const r = grammar.tokenizeLine(line, stack);
      stack = r.ruleStack;
      const k = want.get(i + 1);
      if (!k) return;
      checked++;
      if (scopesOf(r.tokens, k.col) === "") unscoped.push(`${dir}:${k.lineNo}:${k.word}`);
    });
  }
  return { status: "OK", body: { unscoped: unscoped.join(","), checked } };
}
