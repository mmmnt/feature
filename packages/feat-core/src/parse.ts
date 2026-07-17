// SPEC-CORE-001 "Parse a .feat file to BuiltSpec IR" — @mmmnt/feat-core.
// Hand-rolled deterministic recursive-descent parser (amendment 2026-07-16; Langium → M6 LSP).
// The corpus at corpus/ is ground truth: every exemplar parses to its .ir.json exactly.
// The response body is the IR WITHOUT loc (ADR-0013 companion ruling).

import { readFileSync } from "node:fs";
import path from "node:path";

// ── Handler contract ─────────────────────────────────────────────────────────
export interface CapturedResponse {
  status: "OK" | "ERR";
  body: Record<string, unknown>;
}
export interface ParseInput {
  spec: string;
  config: string;
}

type ErrorCode =
  | "MISSING_PRAGMA" | "UNSUPPORTED_VERSION" | "MALFORMED_SYNTAX"
  | "UNKNOWN_SERVICE_KEY" | "UNKNOWN_COMMAND" | "UNDECLARED_SCHEMA"
  | "UNKNOWN_ACTOR" | "DUPLICATE_SCENARIO_NAME" | "TRIGGER_MISMATCH"
  | "QUERY_SIDE_EFFECT" | "INCOMPLETE_PREDICTION" | "MISSING_MINIMUM";

class ParseFailure extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public line?: number,
    public hint?: string,
  ) {
    super(message);
  }
}

interface ConfigContext {
  serviceKeys: string[];
  commands: string[];
  actors: string[];
}

// ── Statement scanner: comments, logical lines (bracket-balanced), pragma ────
interface Stmt {
  text: string;
  indent: number;
  line: number;
}

function scan(source: string): Stmt[] {
  const raw = source.split(/\r?\n/);
  const stmts: Stmt[] = [];
  let buf = "";
  let bufIndent = 0;
  let bufLine = 0;
  let depth = 0;

  const scanDepth = (s: string): number => {
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

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i]!;
    const trimmed = line.trim();
    if (depth === 0) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      buf = trimmed;
      bufIndent = line.length - line.trimStart().length;
      bufLine = i + 1;
      depth = scanDepth(trimmed);
    } else {
      buf += "\n" + trimmed;
      depth += scanDepth(trimmed);
    }
    if (depth <= 0) {
      stmts.push({ text: buf, indent: bufIndent, line: bufLine });
      buf = "";
      depth = 0;
    }
  }
  if (buf !== "") stmts.push({ text: buf, indent: bufIndent, line: bufLine });
  return stmts;
}

// ── Inline literal values (payloads, seed values, example cells) ─────────────
// Lenient object syntax: unquoted keys, JSON values, <placeholder> tokens.
class ValueCursor {
  pos = 0;
  constructor(public src: string) {}
  peek(): string {
    return this.src[this.pos] ?? "";
  }
  skipWs() {
    while (/[\s,]/.test(this.peek())) this.pos++;
  }
  fail(what: string): never {
    throw new ParseFailure("MALFORMED_SYNTAX", `Malformed ${what} near '${this.src.slice(this.pos, this.pos + 24)}'`);
  }
}

function parseLiteralValue(c: ValueCursor): unknown {
  c.skipWs();
  const ch = c.peek();
  if (ch === "{") return parseLiteralObject(c);
  if (ch === "[") {
    c.pos++;
    const arr: unknown[] = [];
    c.skipWs();
    while (c.peek() !== "]") {
      arr.push(parseLiteralValue(c));
      c.skipWs();
    }
    c.pos++;
    return arr;
  }
  if (ch === '"') return parseString(c);
  if (ch === "<") {
    const m = /^<([A-Za-z_][A-Za-z0-9_-]*)>/.exec(c.src.slice(c.pos));
    if (!m) c.fail("placeholder");
    c.pos += m[0].length;
    return { $placeholder: m[1] };
  }
  const m = /^(-?\d+(?:\.\d+)?|true|false|null)/.exec(c.src.slice(c.pos));
  if (!m) c.fail("value");
  c.pos += m[0].length;
  if (m[0] === "true") return true;
  if (m[0] === "false") return false;
  if (m[0] === "null") return null;
  return Number(m[0]);
}

function parseString(c: ValueCursor): string {
  if (c.peek() !== '"') c.fail("string");
  c.pos++;
  let out = "";
  while (c.peek() !== '"') {
    if (c.peek() === "") c.fail("string (unterminated)");
    if (c.peek() === "\\") {
      c.pos++;
      out += JSON.parse(`"\\${c.peek()}"`);
    } else out += c.peek();
    c.pos++;
  }
  c.pos++;
  return out;
}

function parseKey(c: ValueCursor): string {
  c.skipWs();
  const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(c.src.slice(c.pos));
  if (!m) c.fail("key");
  c.pos += m[0].length;
  c.skipWs();
  if (c.peek() !== ":") c.fail("key (expected ':')");
  c.pos++;
  return m[0];
}

function parseLiteralObject(c: ValueCursor): Record<string, unknown> {
  c.skipWs();
  if (c.peek() !== "{") c.fail("object");
  c.pos++;
  const out: Record<string, unknown> = {};
  c.skipWs();
  while (c.peek() !== "}") {
    if (c.peek() === "") c.fail("object (unterminated)");
    const key = parseKey(c);
    out[key] = parseLiteralValue(c);
    c.skipWs();
  }
  c.pos++;
  return out;
}

function parseInlinePayload(src: string): Record<string, unknown> {
  const c = new ValueCursor(src.trim());
  const obj = parseLiteralObject(c);
  c.skipWs();
  if (c.pos < c.src.length) c.fail("payload (trailing content)");
  return obj;
}

// ── Value blocks: field → matcher (ADR-0002/0011/0012/0013) ──────────────────
type Matcher = Record<string, unknown>;

function parseMatcher(c: ValueCursor): Matcher {
  c.skipWs();
  const rest = () => c.src.slice(c.pos);
  if (c.peek() === "{") return { matcher: "nested", fields: parseValueBlock(c) };
  let m: RegExpExecArray | null;
  if ((m = /^@when\.([A-Za-z0-9_.\-]+)/.exec(rest()))) {
    c.pos += m[0].length;
    return { matcher: "whenRef", path: m[1] };
  }
  if ((m = /^@deliver(?:\[(\d+)\])?\.([A-Za-z0-9_.\-]+)/.exec(rest()))) {
    c.pos += m[0].length;
    const out: Matcher = { matcher: "deliverRef", path: m[2] };
    if (m[1] !== undefined) out.index = Number(m[1]);
    return out;
  }
  if ((m = /^any\b(?:[ \t]+(uuid|timestamp|string|number|boolean))?/.exec(rest()))) {
    c.pos += m[0].length;
    const out: Matcher = { matcher: "any" };
    if (m[1]) out.ofType = m[1];
    return out;
  }
  if ((m = /^matching[ \t]+/.exec(rest()))) {
    c.pos += m[0].length;
    return { matcher: "regex", pattern: parseString(c) };
  }
  if (/^absent\b/.test(rest())) {
    c.pos += 6;
    return { matcher: "absent" };
  }
  if (c.peek() === "<") {
    const p = parseLiteralValue(c) as { $placeholder: string };
    return { matcher: "placeholder", name: p.$placeholder };
  }
  const value = parseLiteralValue(c);
  return { matcher: "literal", value };
}

function parseValueBlock(c: ValueCursor): Record<string, Matcher> {
  c.skipWs();
  if (c.peek() !== "{") c.fail("value block");
  c.pos++;
  const out: Record<string, Matcher> = {};
  c.skipWs();
  while (c.peek() !== "}") {
    if (c.peek() === "") c.fail("value block (unterminated)");
    const key = parseKey(c);
    const matcher = parseMatcher(c);
    // nested blocks come back as {matcher: nested, fields}; keep nested form
    out[key] = matcher;
    c.skipWs();
  }
  c.pos++;
  return out;
}

// ── Records (predictions and seeds) ──────────────────────────────────────────
interface PredictedRecord {
  type: string;
  schemaName: string;
  valueBlock?: Record<string, Matcher>;
  golden?: string;
}
interface SeedRecord {
  type: string;
  schemaName?: string;
  values: Record<string, unknown>;
}

function parseRecordList(src: string, mode: "predict" | "seed"): (PredictedRecord | SeedRecord)[] {
  const c = new ValueCursor(src.trim());
  c.skipWs();
  if (c.peek() !== "[") c.fail("record list");
  c.pos++;
  const out: (PredictedRecord | SeedRecord)[] = [];
  c.skipWs();
  while (c.peek() !== "]") {
    if (c.peek() === "") c.fail("record list (unterminated)");
    const head = /^([A-Za-z_][A-Za-z0-9_]*)[ \t\n]+with[ \t\n]+([A-Za-z_][A-Za-z0-9_]*)/.exec(c.src.slice(c.pos));
    if (head === null)
      throw new ParseFailure(
        "MALFORMED_SYNTAX",
        `Malformed record near '${c.src.slice(c.pos, c.pos + 24)}' (expected '<Type> with <Schema>').`,
      );
    c.pos += head[0].length;
    c.skipWs();
    if (mode === "seed") {
      const values = parseLiteralObject(c);
      out.push({ type: head[1]!, schemaName: head[2]!, values });
    } else {
      const rec: PredictedRecord = { type: head[1]!, schemaName: head[2]! };
      const g = /^equals[ \t]+fixture[ \t]+/.exec(c.src.slice(c.pos));
      if (g) {
        c.pos += g[0].length;
        rec.golden = parseString(c);
      } else if (c.peek() === "{") {
        rec.valueBlock = parseValueBlock(c);
      }
      out.push(rec);
    }
    c.skipWs();
  }
  c.pos++;
  return out;
}

// ── The parser ────────────────────────────────────────────────────────────────
const SPEC_TYPES = ["command", "query", "policy", "projection", "saga", "infrastructure", "integration", "scaffold"];
const STATUSES = ["draft", "agreed", "built", "verified"];
const CONTRACT_KINDS = ["input", "response", "event", "record", "error"];
const DELIVER_TYPES = new Set(["projection", "policy", "saga"]);

function parseFeat(source: string, ctx: ConfigContext): Record<string, unknown> {
  const stmts = scan(source);

  // 1. Version pragma (ADR-0005)
  const first = stmts[0];
  const pragma = first ? /^feat[ \t]+(\d+)\.(\d+)$/.exec(first.text) : null;
  if (!first || !pragma)
    throw new ParseFailure("MISSING_PRAGMA", "The first non-comment line must be a version pragma, e.g. 'feat 1.0'.", first?.line ?? 1, "Add 'feat 1.0' as the first line.");
  if (pragma[1] !== "1")
    throw new ParseFailure("UNSUPPORTED_VERSION", `This toolchain supports feat 1.x; the file declares feat ${pragma[1]}.${pragma[2]}.`, first.line);

  const ir: Record<string, unknown> = { featVersion: `${pragma[1]}.${pragma[2]}` };
  const identity: Record<string, unknown> = {};
  const construct: Record<string, unknown>[] = [];
  const enforce: Record<string, unknown>[] = [];
  const contract: Record<string, unknown>[] = [];
  const declaredSchemas = new Set<string>();
  const scenarios: Record<string, unknown>[] = [];

  type Section = "none" | "construct" | "enforce" | "contract" | "scenario";
  let section: Section = "none";
  let scenario: Record<string, unknown> | null = null;
  let scenarioPhase: "given" | "predict" | "examples" | "none" = "none";
  let exampleHeaders: string[] | null = null;

  const finishScenario = () => {
    if (scenario) scenarios.push(scenario);
    scenario = null;
    scenarioPhase = "none";
    exampleHeaders = null;
  };

  for (let i = 1; i < stmts.length; i++) {
    const s = stmts[i]!;
    const t = s.text;
    let m: RegExpExecArray | null;

    // ── Header ──
    if ((m = /^spec[ \t]+(\S+)[ \t]+"((?:[^"\\]|\\.)*)"$/.exec(t))) {
      identity.id = m[1];
      identity.name = m[2];
      continue;
    }
    if ((m = /^context[ \t]+(\S+)$/.exec(t))) { identity.context = m[1]; continue; }
    if ((m = /^aggregate[ \t]+(\S+)$/.exec(t))) { identity.aggregate = m[1]; continue; }
    if ((m = /^type[ \t]+(\S+)$/.exec(t))) {
      if (!SPEC_TYPES.includes(m[1]!))
        throw new ParseFailure("MALFORMED_SYNTAX", `Unknown spec type '${m[1]}'.`, s.line, `Valid types: ${SPEC_TYPES.join(", ")}`);
      identity.type = m[1];
      continue;
    }
    if ((m = /^status[ \t]+(\S+)$/.exec(t))) {
      if (!STATUSES.includes(m[1]!))
        throw new ParseFailure("MALFORMED_SYNTAX", `Unknown status '${m[1]}'.`, s.line, `Valid statuses: ${STATUSES.join(", ")}`);
      identity.status = m[1];
      continue;
    }

    // ── Section openers ──
    if (t === "construct:") { finishScenario(); section = "construct"; continue; }
    if (t === "enforce:") { finishScenario(); section = "enforce"; continue; }
    if (t === "contract:") { finishScenario(); section = "contract"; continue; }
    if ((m = /^scenario([ \t]+outline)?[ \t]+"((?:[^"\\]|\\.)*)":$/.exec(t))) {
      finishScenario();
      section = "scenario";
      scenario = { name: m[2] };
      scenarioPhase = "none";
      continue;
    }

    // ── Section bodies ──
    if (section === "construct") {
      if ((m = /^handler[ \t]+at[ \t]+(\S+)$/.exec(t))) construct.push({ kind: "handler", path: m[1] });
      else if ((m = /^imports[ \t]+(\S+)[ \t]+from[ \t]+(\S+)$/.exec(t))) construct.push({ kind: "import", symbol: m[1], path: m[2] });
      else if ((m = /^register[ \t]+(\S+)[ \t]+(\S+)[ \t]+in[ \t]+(\S+)$/.exec(t))) construct.push({ kind: "register", registrationKind: m[1], name: m[2], path: m[3] });
      else if ((m = /^emit[ \t]+to[ \t]+(\S+)$/.exec(t))) construct.push({ kind: "emitsTo", streamPattern: m[1] });
      else if ((m = /^touches[ \t]+(\S+)$/.exec(t))) construct.push({ kind: "touches", glob: m[1] });
      else if ((m = /^needs[ \t]+(\S+)$/.exec(t))) construct.push({ kind: "needs", specId: m[1] });
      else construct.push({ kind: "custom", text: t.replace(/\n/g, " ") });
      continue;
    }

    if (section === "enforce") {
      if ((m = /^rejects[ \t]+([A-Z0-9_]+)[ \t]+when[ \t]+(.+)$/s.exec(t)))
        enforce.push({ kind: "rejects", rejectionId: m[1], text: m[2]!.replace(/\n/g, " ") });
      else if (/^validate[ \t]/.test(t)) enforce.push({ kind: "validate", text: t });
      else if (/^load[ \t]/.test(t)) enforce.push({ kind: "load", text: t });
      else if (/^apply[ \t]/.test(t)) enforce.push({ kind: "apply", text: t });
      else if (/^on[ \t]+success[ \t]/.test(t)) enforce.push({ kind: "onSuccess", text: t });
      else if (/^on[ \t]+rejection[ \t]/.test(t)) enforce.push({ kind: "onRejection", text: t });
      else enforce.push({ kind: "constraint", text: t.replace(/\n/g, " ") });
      continue;
    }

    if (section === "contract") {
      if ((m = /^(input|response|event|record|error)[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+from[ \t]+"((?:[^"\\]|\\.)*)")?$/.exec(t))) {
        const entry: Record<string, unknown> = { kind: m[1], schemaName: m[2] };
        if (m[3] !== undefined) entry.from = m[3];
        contract.push(entry);
        declaredSchemas.add(m[2]!);
        continue;
      }
      if ((m = /^stream[ \t]+"((?:[^"\\]|\\.)*)"$/.exec(t))) {
        contract.push({ kind: "stream", pattern: m[1] });
        continue;
      }
      throw new ParseFailure("MALFORMED_SYNTAX", `Unrecognized contract line: '${t}'.`, s.line, `Contract roles: ${CONTRACT_KINDS.join(", ")}, stream`);
    }

    if (section === "scenario" && scenario) {
      // given:
      if (t === "given:") { scenarioPhase = "given"; continue; }

      // when [(as actor)]:
      if ((m = /^when(?:[ \t]*\(as[ \t]+([A-Za-z0-9_-]+)\))?:[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(\{[\s\S]*\})$/.exec(t))) {
        const when: Record<string, unknown> = { command: m[2] };
        if (m[1]) when.actor = m[1];
        when.payload = parseInlinePayload(m[3]!);
        scenario.when = when;
        scenarioPhase = "none";
        continue;
      }

      // deliver <Event> { } to <service>
      if ((m = /^deliver[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(\{[\s\S]*\})[ \t]+to[ \t]+([A-Za-z_][A-Za-z0-9_]*)$/.exec(t))) {
        const delivers = (scenario.delivers as unknown[] | undefined) ?? [];
        delivers.push({ event: m[1], payload: parseInlinePayload(m[2]!), service: m[3] });
        scenario.delivers = delivers;
        scenarioPhase = "none";
        continue;
      }

      // predict …:
      if ((m = /^predict[ \t]+(success|rejection|error)(?:[ \t]+([A-Z0-9_<>-]+))?:$/.exec(t))) {
        const prediction: Record<string, unknown> = { type: m[1] };
        if (m[1] === "rejection" && m[2]) prediction.rejectionId = m[2];
        if (m[1] === "error" && m[2]) prediction.errorCode = m[2];
        scenario.prediction = prediction;
        scenarioPhase = "predict";
        continue;
      }
      if (/^predict[ \t]/.test(t))
        throw new ParseFailure("MALFORMED_SYNTAX", `Unknown prediction form: '${t}'.`, s.line, "Use 'predict success:', 'predict rejection <ID>:', or 'predict error <CODE>:'");

      // examples:
      if (t === "examples:") { scenarioPhase = "examples"; continue; }

      if (scenarioPhase === "given") {
        const given = (scenario.given as Record<string, unknown> | undefined) ?? {};
        if ((m = /^clock[ \t]+at[ \t]+"((?:[^"\\]|\\.)*)"$/.exec(t))) {
          given.clock = m[1];
        } else if ((m = /^execute(?:[ \t]*\(as[ \t]+([A-Za-z0-9_-]+)\))?[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(\{[\s\S]*\})$/.exec(t))) {
          const executes = (given.executes as unknown[] | undefined) ?? [];
          const inv: Record<string, unknown> = { command: m[2] };
          if (m[1]) inv.actor = m[1];
          inv.payload = parseInlinePayload(m[3]!);
          executes.push(inv);
          given.executes = executes;
        } else if ((m = /^seed[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+from[ \t]+"((?:[^"\\]|\\.)*)"$/.exec(t))) {
          const seeds = (given.seeds as unknown[] | undefined) ?? [];
          seeds.push({ service: m[1], fixture: m[2] });
          given.seeds = seeds;
        } else if ((m = /^seed[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+(\[[\s\S]*\])$/.exec(t))) {
          const seeds = (given.seeds as unknown[] | undefined) ?? [];
          seeds.push({ service: m[1], records: parseRecordList(m[2]!, "seed") });
          given.seeds = seeds;
        } else {
          const context = (given.context as string[] | undefined) ?? [];
          context.push(t.replace(/\n/g, " "));
          given.context = context;
        }
        scenario.given = given;
        continue;
      }

      if (scenarioPhase === "predict") {
        const prediction = scenario.prediction as Record<string, unknown>;
        if ((m = /^response[ \t]+(\S+)[ \t]+([A-Za-z_][A-Za-z0-9_]*)(?:[ \t]+([\s\S]+))?$/.exec(t))) {
          const status: string | number = /^\d+$/.test(m[1]!) ? Number(m[1]) : m[1]!;
          const response: Record<string, unknown> = { status, schemaName: m[2] };
          if (m[3]) {
            const rest = m[3].trim();
            const g = /^equals[ \t]+fixture[ \t]+"((?:[^"\\]|\\.)*)"$/.exec(rest);
            if (g) response.golden = g[1];
            else if (rest.startsWith("{")) response.valueBlock = parseValueBlock(new ValueCursor(rest));
            else throw new ParseFailure("MALFORMED_SYNTAX", `Unrecognized response tail: '${rest}'.`, s.line);
          }
          prediction.response = response;
          continue;
        }
        if ((m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]+(has|contains)[ \t]+(?:(ordered|unordered)[ \t]+)?(\[[\s\S]*\])$/.exec(t))) {
          const services = (prediction.services as Record<string, Record<string, unknown>> | undefined) ?? {};
          const entry = services[m[1]!] ?? {};
          if (m[3]) entry.ordering = m[3];
          const records = parseRecordList(m[4]!, "predict");
          if (m[2] === "has") entry.records = records;
          else entry.contains = records;
          services[m[1]!] = entry;
          prediction.services = services;
          continue;
        }
        throw new ParseFailure("MALFORMED_SYNTAX", `Unrecognized prediction line: '${t}'.`, s.line);
      }

      if (scenarioPhase === "examples") {
        if (t.startsWith("|")) {
          const cells = t.split("|").slice(1, -1).map((x) => x.trim());
          if (!exampleHeaders) {
            exampleHeaders = cells;
          } else {
            const row: Record<string, unknown> = {};
            cells.forEach((cell, idx) => {
              const key = exampleHeaders![idx];
              if (key === undefined) return;
              const c = new ValueCursor(cell);
              row[key] = parseLiteralValue(c);
            });
            const examples = (scenario.examples as unknown[] | undefined) ?? [];
            examples.push(row);
            scenario.examples = examples;
          }
          continue;
        }
        throw new ParseFailure("MALFORMED_SYNTAX", `Expected an examples table row, got '${t}'.`, s.line);
      }

      throw new ParseFailure("MALFORMED_SYNTAX", `Unrecognized scenario line: '${t}'.`, s.line);
    }

    throw new ParseFailure("MALFORMED_SYNTAX", `Unrecognized top-level line: '${t}'.`, s.line);
  }
  finishScenario();

  // ── MISSING_MINIMUM (no-escape-hatch) ──
  const headerComplete = ["id", "name", "context", "aggregate", "type", "status"].every((k) => identity[k] !== undefined);
  if (!headerComplete || construct.length === 0 || enforce.length === 0 || contract.length === 0 || scenarios.length === 0)
    throw new ParseFailure("MISSING_MINIMUM", "A spec requires a complete header, one construct directive, one enforce directive, one contract entry, and one scenario.", undefined, "See grammar reference §1.2.");

  // ── DUPLICATE_SCENARIO_NAME (ADR-0010) ──
  const seen = new Set<string>();
  for (const sc of scenarios) {
    const name = sc.name as string;
    if (seen.has(name))
      throw new ParseFailure("DUPLICATE_SCENARIO_NAME", `Scenario name '${name}' is used more than once.`, undefined, "Scenario names are failure anchors and must be unique per spec.");
    seen.add(name);
  }

  const specType = identity.type as string;
  for (const sc of scenarios) {
    const hasWhen = sc.when !== undefined;
    const hasDeliver = sc.delivers !== undefined;

    // ── TRIGGER_MISMATCH (ADR-0011) ──
    if (DELIVER_TYPES.has(specType) && hasWhen)
      throw new ParseFailure("TRIGGER_MISMATCH", `type ${specType} scenarios are triggered by 'deliver', not 'when:'.`);
    if (!DELIVER_TYPES.has(specType) && hasDeliver)
      throw new ParseFailure("TRIGGER_MISMATCH", `type ${specType} scenarios are triggered by 'when:', not 'deliver'.`);
    if (!hasWhen && !hasDeliver)
      throw new ParseFailure("MALFORMED_SYNTAX", `Scenario '${sc.name}' has no trigger.`);

    // ── Closed spaces: commands, actors, services, schemas ──
    const invocations: Record<string, unknown>[] = [];
    if (hasWhen) invocations.push(sc.when as Record<string, unknown>);
    const given = sc.given as Record<string, unknown> | undefined;
    for (const ex of (given?.executes as Record<string, unknown>[] | undefined) ?? []) invocations.push(ex);
    for (const inv of invocations) {
      if (!ctx.commands.includes(inv.command as string))
        throw new ParseFailure("UNKNOWN_COMMAND", `Command '${inv.command}' is not configured.`, undefined, `Configured commands: ${ctx.commands.join(", ") || "(none)"}`);
      const actor = inv.actor as string | undefined;
      if (actor && actor !== "anonymous" && !ctx.actors.includes(actor))
        throw new ParseFailure("UNKNOWN_ACTOR", `Actor '${actor}' is not configured.`, undefined, `Configured actors: ${ctx.actors.join(", ") || "(none)"}`);
    }

    const serviceRefs: string[] = [];
    const prediction = sc.prediction as Record<string, unknown>;
    const services = prediction.services as Record<string, Record<string, unknown>> | undefined;
    for (const key of Object.keys(services ?? {})) serviceRefs.push(key);
    for (const seed of (given?.seeds as Record<string, unknown>[] | undefined) ?? []) serviceRefs.push(seed.service as string);
    for (const del of (sc.delivers as Record<string, unknown>[] | undefined) ?? []) serviceRefs.push(del.service as string);
    for (const key of serviceRefs)
      if (!ctx.serviceKeys.includes(key))
        throw new ParseFailure("UNKNOWN_SERVICE_KEY", `Service '${key}' is not configured.`, undefined, `Configured services: ${ctx.serviceKeys.join(", ")}`);

    const schemaRefs: string[] = [];
    const response = prediction.response as Record<string, unknown> | undefined;
    if (response) schemaRefs.push(response.schemaName as string);
    for (const entry of Object.values(services ?? {})) {
      for (const rec of [...((entry.records as PredictedRecord[] | undefined) ?? []), ...((entry.contains as PredictedRecord[] | undefined) ?? [])])
        schemaRefs.push(rec.schemaName);
    }
    for (const seed of (given?.seeds as Record<string, unknown>[] | undefined) ?? [])
      for (const rec of (seed.records as SeedRecord[] | undefined) ?? [])
        if (rec.schemaName) schemaRefs.push(rec.schemaName);
    for (const ref of schemaRefs)
      if (!declaredSchemas.has(ref))
        throw new ParseFailure("UNDECLARED_SCHEMA", `Schema '${ref}' is not declared in the contract block.`, undefined, `Declared schemas: ${[...declaredSchemas].join(", ")}`);

    // ── QUERY_SIDE_EFFECT (ADR-0011) ──
    if (specType === "query") {
      for (const [key, entry] of Object.entries(services ?? {})) {
        const records = (entry.records as unknown[] | undefined) ?? [];
        if (records.length > 0)
          throw new ParseFailure("QUERY_SIDE_EFFECT", `type query cannot predict a write on '${key}' — side-effect freedom is a language guarantee.`);
      }
    }

    // ── INCOMPLETE_PREDICTION (INV-6, query-exempt) ──
    if (specType !== "query") {
      for (const key of ctx.serviceKeys) {
        const entry = services?.[key];
        if (!entry || entry.records === undefined)
          throw new ParseFailure("INCOMPLETE_PREDICTION", `Prediction in scenario '${sc.name}' omits configured service '${key}'.`, undefined, "Every configured service must appear; 'has []' is the explicit zero-assertion.");
      }
    }
  }

  ir.identity = identity;
  ir.construct = construct;
  ir.enforce = enforce;
  ir.contract = contract;
  ir.scenarios = scenarios;
  return ir;
}

// ── Handler ───────────────────────────────────────────────────────────────────
export async function parse(input: ParseInput): Promise<CapturedResponse> {
  const specPath = path.resolve(process.cwd(), input.spec);
  const configPath = path.resolve(process.cwd(), input.config);
  const source = readFileSync(specPath, "utf8");
  const configDoc = JSON.parse(readFileSync(configPath, "utf8")) as {
    services?: Record<string, unknown>;
    response?: { commands?: Record<string, unknown>; actors?: Record<string, unknown> };
  };
  const ctx: ConfigContext = {
    serviceKeys: Object.keys(configDoc.services ?? {}),
    commands: Object.keys(configDoc.response?.commands ?? {}),
    actors: Object.keys(configDoc.response?.actors ?? {}).filter((a) => a !== "default"),
  };

  try {
    const ir = parseFeat(source, ctx);
    return { status: "OK", body: ir };
  } catch (e) {
    if (e instanceof ParseFailure) {
      const body: Record<string, unknown> = { code: e.code, message: e.message };
      if (e.line !== undefined) body.line = e.line;
      if (e.hint !== undefined) body.hint = e.hint;
      return { status: "ERR", body };
    }
    throw e;
  }
}
