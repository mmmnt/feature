// Evidence production E2E: run the real CLI against this repo's own dogfood
// specs, validate the bundle against the schema, and guard the packaged
// schema copy against drift from the repo-root source of truth.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";
import { parseJunitRuns } from "./src/evidence.js";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const PKG = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PKG, "../..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "feat-evidence-"));

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("evidence bundle", () => {
  it("packaged schema matches the repo-root source of truth", () => {
    const packaged = readFileSync(path.join(PKG, "schemas/evidence.schema.json"), "utf8");
    const root = readFileSync(path.join(ROOT, "schemas/evidence.schema.json"), "utf8");
    expect(packaged).toBe(root);
  });

  it("produces a schema-valid bundle from the repo's own specs", () => {
    const out = path.join(tmp, "evidence.json");
    const stdout = execFileSync("node", [path.join(PKG, "bin/run.js"), "report", "--evidence", "--force", "--out", out], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(stdout).toContain("evidence:");

    const bundle = JSON.parse(readFileSync(out, "utf8"));
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(readFileSync(path.join(ROOT, "schemas/evidence.schema.json"), "utf8")));
    expect(validate(bundle), JSON.stringify(validate.errors, null, 2)).toBe(true);

    expect(bundle.contract).toBe("feat-evidence/2");
    expect(bundle.verify.status).toBe("pass");
    // /2: runs ride with the run block — both present or both absent.
    expect(Array.isArray(bundle.runs)).toBe(bundle.run !== undefined);
    expect(bundle.specs.length).toBeGreaterThanOrEqual(2);
    expect(bundle.specs.every((s: { content_digest: string }) => s.content_digest.startsWith("sha256:"))).toBe(true);
    expect(bundle.signature).toBeNull();
    expect(bundle.producer.toolchain["@mmmnt/feat-core"]).toBeTruthy();
    // ADR-0016: the repo's own config declares no environment, so the bundle
    // must not claim one — env presence is driven solely by the config used.
    expect(bundle.project.environment).toBe("toolchain");

    // The spec's face: identity, handler, and the zone-tagged excerpt ride
    // every parseable inventory entry — deterministic, capped at 60 lines.
    const faced = bundle.specs.find((s: Record<string, unknown>) => s.spec_id !== "UNPARSEABLE");
    expect(faced.name).toBeTruthy();
    expect(faced.type).toBeTruthy();
    expect(Array.isArray(faced.excerpt)).toBe(true);
    expect(faced.excerpt.length).toBeGreaterThan(0);
    expect(faced.excerpt.length).toBeLessThanOrEqual(60);
    expect(faced.excerpt[0]).toMatchObject({ n: 1, zone: "header" });
    const zones = new Set(faced.excerpt.map((l: { zone: string }) => l.zone));
    for (const z of zones) expect(["header", "agent", "compiler", "blank"]).toContain(z);
    // At most one scenario in the excerpt — the face stops before the second.
    const scenarioLines = faced.excerpt.filter((l: { text: string }) => /^scenario\b/.test(l.text.trim()));
    expect(scenarioLines.length).toBeLessThanOrEqual(1);
  });

  it("folds JUnit testcases into per-scenario runs with parsed violations (feat-evidence/2)", () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="api/ledger.test.ts" tests="2" failures="1" errors="0">
    <testcase name="SPEC-FD-018: Evidence ingestion &gt; the first bundle opens the chain" time="2.51"/>
    <testcase name="SPEC-FD-018: Evidence ingestion &gt; a viewer cannot ingest" time="1.02">
      <failure message="Prediction violated">Error: Prediction violated:
  SPEC-FD-018 › &quot;a viewer cannot ingest&quot; › response › status: expected 403, got 200
  SPEC-FD-018 › &quot;a viewer cannot ingest&quot; › database › INSERT: expected [], got [1 record]
      </failure>
    </testcase>
    <testcase name="loose harness case"/>
  </testsuite>
</testsuites>`;
    const runs = parseJunitRuns(xml);
    expect(runs).toEqual([
      {
        name: "SPEC-FD-018: Evidence ingestion > the first bundle opens the chain",
        spec_id: "SPEC-FD-018",
        status: "pass",
        time: 2.51,
        violations: [],
      },
      {
        name: "SPEC-FD-018: Evidence ingestion > a viewer cannot ingest",
        spec_id: "SPEC-FD-018",
        status: "fail",
        time: 1.02,
        violations: [
          { path: "response › status", expected: "403", got: "200" },
          { path: "database › INSERT", expected: "[]", got: "[1 record]" },
        ],
      },
      { name: "loose harness case", spec_id: null, status: "pass", violations: [] },
    ]);
  });
});
