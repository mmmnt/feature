// HAND-DERIVED from load-config.feat (SPEC-RT-001) — bootstrap protocol.
// Derivation rules applied mechanically; feat generate replaces this file at the M4 flip
// and the diff between the two is the flip's measurement.
// Source: load-config.feat (SPEC-RT-001) · Language: feat 1.0
// Anchors: SPEC-RT-001 › "<scenario>" › <surface>

import { describe, it, expect } from "vitest";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PKG_DIR, "../..");

// ── Inlined resolved schemas (ADR-0001: schema resolution is compile-time only) ──
const FeatConfigResultSchema = JSON.parse(
  readFileSync(path.join(REPO_ROOT, "schemas/feat.config.schema.json"), "utf8"),
) as object;
const ConfigErrorSchema = {
  type: "object",
  required: ["code", "message"],
  properties: {
    code: { enum: ["CONFIG_NOT_FOUND", "INVALID_CONFIG", "MISSING_CONVERGENCE_TIMEOUT"] },
    message: { type: "string" },
    path: { type: "string" },
    detail: { type: "string" },
  },
} as const;

const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validateFeatConfigResult = ajv.compile(FeatConfigResultSchema);
const validateConfigError = ajv.compile(ConfigErrorSchema);

// ── Response adapter (handler) invocation, derived from feat.config.json commands ──
// (Stand-in for @mmmnt/feat-adapter-handler until M5; same resolution semantics.)
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

// ── filesystem service capture (stand-in for @mmmnt/feat-adapter-fs, acid) ──
// `filesystem has []` derives to: zero writes captured during the window.
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

// ── Value-block matcher application (stand-in for toMatchPrediction, ADR-0002) ──
function expectValueBlock(actual: unknown, block: Record<string, unknown>, anchor: string) {
  expect(actual, `${anchor}: body is not an object`).toBeTypeOf("object");
  const obj = actual as Record<string, unknown>;
  for (const [field, matcher] of Object.entries(block)) {
    const v = obj[field];
    if (matcher !== null && typeof matcher === "object" && "regex" in (matcher as object)) {
      expect(String(v), `${anchor} › ${field}`).toMatch(new RegExp((matcher as { regex: string }).regex));
    } else if (matcher !== null && typeof matcher === "object") {
      expectValueBlock(v, matcher as Record<string, unknown>, `${anchor} › ${field}`);
    } else {
      expect(v, `${anchor} › ${field}`).toEqual(matcher);
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
describe('SPEC-RT-001: Load and validate feat.config.json', () => {
  it('loads a valid config', async () => {
    const anchor = 'SPEC-RT-001 › "loads a valid config"';
    const when = { path: "fixtures/valid.config.json" };
    const { result: response, writes } = await withFsCapture(() => invoke("LoadConfig", when));

    // response OK FeatConfigResult { featVersion, services.filesystem.consistency }
    expect(response.status, `${anchor} › response`).toBe("OK");
    expect(validateFeatConfigResult(response.body), `${anchor} › response schema`).toBe(true);
    expectValueBlock(response.body, {
      featVersion: "1.0",
      services: { filesystem: { consistency: "acid" } },
    }, `${anchor} › response`);

    // filesystem has []
    expect(writes, `${anchor} › filesystem[]`).toEqual([]);
  });

  it('missing file', async () => {
    const anchor = 'SPEC-RT-001 › "missing file"';
    const when = { path: "fixtures/does-not-exist.config.json" };
    const { result: response, writes } = await withFsCapture(() => invoke("LoadConfig", when));

    expect(response.status, `${anchor} › response`).toBe("ERR");
    expect(validateConfigError(response.body), `${anchor} › response schema`).toBe(true);
    expectValueBlock(response.body, {
      code: "CONFIG_NOT_FOUND",
      path: when.path, // @when.path
    }, `${anchor} › response`);

    expect(writes, `${anchor} › filesystem[]`).toEqual([]);
  });

  it('eventual service without convergence timeout', async () => {
    const anchor = 'SPEC-RT-001 › "eventual service without convergence timeout"';
    const when = { path: "fixtures/missing-timeout.config.json" };
    const { result: response, writes } = await withFsCapture(() => invoke("LoadConfig", when));

    expect(response.status, `${anchor} › response`).toBe("ERR");
    expect(validateConfigError(response.body), `${anchor} › response schema`).toBe(true);
    expectValueBlock(response.body, {
      code: "MISSING_CONVERGENCE_TIMEOUT",
      detail: { regex: "eventStore" }, // matching "eventStore"
    }, `${anchor} › response`);

    expect(writes, `${anchor} › filesystem[]`).toEqual([]);
  });

  // scenario outline "schema-invalid configs are rejected" — one case per examples row
  const rows = [
    { path: "fixtures/no-services.config.json", detail: "services" },
    { path: "fixtures/bad-consistency.config.json", detail: "consistency" },
    { path: "fixtures/empty-commands.config.json", detail: "commands" },
    { path: "fixtures/not-json.config.json", detail: "JSON" },
  ];
  rows.forEach((row, i) => {
    it(`schema-invalid configs are rejected › row[${i + 1}]`, async () => {
      const anchor = `SPEC-RT-001 › "schema-invalid configs are rejected" › row[${i + 1}]`;
      const when = { path: row.path };
      const { result: response, writes } = await withFsCapture(() => invoke("LoadConfig", when));

      expect(response.status, `${anchor} › response`).toBe("ERR");
      expect(validateConfigError(response.body), `${anchor} › response schema`).toBe(true);
      expectValueBlock(response.body, {
        code: "INVALID_CONFIG",
        detail: { regex: row.detail }, // matching <detail>
      }, `${anchor} › response`);

      expect(writes, `${anchor} › filesystem[]`).toEqual([]);
    });
  });
});
