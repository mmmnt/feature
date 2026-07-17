// HAND-DERIVED from parse.feat (SPEC-CORE-001) — bootstrap protocol.
// feat generate replaces this file at the M4 flip; the diff is the flip's measurement.
// Source: parse.feat (SPEC-CORE-001) · Language: feat 1.0
// Anchors: SPEC-CORE-001 › "<scenario>" › <surface>

import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PKG_DIR, "../..");

// ── Inlined resolved schemas (ADR-0001) ──
const BuiltSpecSchema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "schemas/builtspec.schema.json"), "utf8"),
) as object;
const ParseErrorSchema = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: {
      enum: [
        "MISSING_PRAGMA", "UNSUPPORTED_VERSION", "MALFORMED_SYNTAX",
        "UNKNOWN_SERVICE_KEY", "UNKNOWN_COMMAND", "UNDECLARED_SCHEMA",
        "UNKNOWN_ACTOR", "DUPLICATE_SCENARIO_NAME", "TRIGGER_MISMATCH",
        "QUERY_SIDE_EFFECT", "INCOMPLETE_PREDICTION", "MISSING_MINIMUM",
      ],
    },
    message: { type: "string" },
    line: { type: "integer", minimum: 1 },
    hint: { type: "string" },
  },
} as const;

const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validateBuiltSpec = ajv.compile(BuiltSpecSchema);
const validateParseError = ajv.compile(ParseErrorSchema);

// ── Response adapter (handler) invocation from feat.config.json commands ──
const featConfig = JSON.parse(readFileSync(path.join(REPO_ROOT, "feat.config.json"), "utf8"));
async function invoke(command: string, payload: Record<string, unknown>) {
  const route = featConfig.response.commands[command];
  if (!route) throw new Error(`Unknown command '${command}' — not in response.commands`);
  const mod = await import(path.join(REPO_ROOT, route.module));
  const handler = mod[route.export];
  if (typeof handler !== "function")
    throw new Error(`Module ${route.module} lacks export '${route.export}' (INV-10)`);
  return handler(payload) as Promise<{ status: string; body: Record<string, unknown> | null }>;
}

// ── filesystem capture stand-in (`filesystem has []` → zero writes in the window) ──
function snapshotTree(dir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".turbo") continue;
      const p = path.join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else out.set(p, s.mtimeMs);
    }
  };
  walk(dir);
  return out;
}
async function withFsCapture<T>(fn: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const before = snapshotTree(PKG_DIR);
  const result = await fn();
  const after = snapshotTree(PKG_DIR);
  const writes: string[] = [];
  for (const [p, mtime] of after) if (!before.has(p) || before.get(p) !== mtime) writes.push(p);
  for (const p of before.keys()) if (!after.has(p)) writes.push(`${p} (deleted)`);
  return { result, writes };
}

// ── Golden fixture assertion (ADR-0013): deep structural equality, inlined at derive time ──
function golden(fixturePathFromSpec: string): unknown {
  return JSON.parse(readFileSync(path.join(PKG_DIR, fixturePathFromSpec), "utf8"));
}

// ══════════════════════════════════════════════════════════════════════════════
describe('SPEC-CORE-001: Parse a .feat file to BuiltSpec IR', () => {
  // Golden scenarios — one per corpus exemplar. The corpus is the executable contract.
  const goldens = [
    { scenario: "parses the founding exemplar (create-flow)", dir: "create-flow", file: "create-flow" },
    { scenario: "parses the CRUD exemplar (create-user)", dir: "create-user", file: "create-user" },
    { scenario: "parses the seeds exemplar (tenant-at-limit)", dir: "tenant-at-limit", file: "tenant-at-limit" },
    { scenario: "parses the ordering exemplar (publish-order)", dir: "publish-order", file: "publish-order" },
    { scenario: "parses the compiler-shaped exemplar (emit-test-file)", dir: "emit-test-file", file: "emit-test-file" },
    { scenario: "parses the projection exemplar (flow-view)", dir: "flow-view", file: "flow-view" },
    { scenario: "parses the query exemplar (get-flow)", dir: "get-flow", file: "get-flow" },
    { scenario: "parses the expressiveness exemplar (suspend-user)", dir: "suspend-user", file: "suspend-user" },
  ];
  for (const g of goldens) {
    it(g.scenario, async () => {
      const anchor = `SPEC-CORE-001 › "${g.scenario}"`;
      const when = {
        spec: `../../corpus/${g.dir}/${g.file}.feat`,
        config: `../../corpus/${g.dir}/feat.config.json`,
      };
      const { result: response, writes } = await withFsCapture(() => invoke("Parse", when));

      // response OK BuiltSpec equals fixture "../../corpus/<dir>/<file>.ir.json"
      expect(response.status, `${anchor} › response`).toBe("OK");
      expect(validateBuiltSpec(response.body), `${anchor} › response schema`).toBe(true);
      expect(response.body, `${anchor} › response golden`).toEqual(
        golden(`../../corpus/${g.dir}/${g.file}.ir.json`),
      );

      // filesystem has []
      expect(writes, `${anchor} › filesystem[]`).toEqual([]);
    });
  }

  // scenario outline "rejects invalid specs with the precise code" — one case per row
  const rows = [
    { spec: "fixtures/bad/missing-pragma.feat", code: "MISSING_PRAGMA" },
    { spec: "fixtures/bad/unsupported-version.feat", code: "UNSUPPORTED_VERSION" },
    { spec: "fixtures/bad/malformed-syntax.feat", code: "MALFORMED_SYNTAX" },
    { spec: "fixtures/bad/unknown-service.feat", code: "UNKNOWN_SERVICE_KEY" },
    { spec: "fixtures/bad/unknown-command.feat", code: "UNKNOWN_COMMAND" },
    { spec: "fixtures/bad/undeclared-schema.feat", code: "UNDECLARED_SCHEMA" },
    { spec: "fixtures/bad/unknown-actor.feat", code: "UNKNOWN_ACTOR" },
    { spec: "fixtures/bad/duplicate-scenario.feat", code: "DUPLICATE_SCENARIO_NAME" },
    { spec: "fixtures/bad/trigger-mismatch.feat", code: "TRIGGER_MISMATCH" },
    { spec: "fixtures/bad/query-side-effect.feat", code: "QUERY_SIDE_EFFECT" },
    { spec: "fixtures/bad/incomplete-prediction.feat", code: "INCOMPLETE_PREDICTION" },
    { spec: "fixtures/bad/missing-minimum.feat", code: "MISSING_MINIMUM" },
  ];
  rows.forEach((row, i) => {
    it(`rejects invalid specs with the precise code › row[${i + 1}] (${row.code})`, async () => {
      const anchor = `SPEC-CORE-001 › "rejects invalid specs with the precise code" › row[${i + 1}]`;
      const when = { spec: row.spec, config: "fixtures/parse.config.json" };
      const { result: response, writes } = await withFsCapture(() => invoke("Parse", when));

      expect(response.status, `${anchor} › response`).toBe("ERR");
      expect(validateParseError(response.body), `${anchor} › response schema`).toBe(true);
      expect((response.body as { code: string }).code, `${anchor} › response.code`).toBe(row.code);

      expect(writes, `${anchor} › filesystem[]`).toEqual([]);
    });
  });
});
