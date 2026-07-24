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

    expect(bundle.verify.status).toBe("pass");
    expect(bundle.specs.length).toBeGreaterThanOrEqual(2);
    expect(bundle.specs.every((s: { content_digest: string }) => s.content_digest.startsWith("sha256:"))).toBe(true);
    expect(bundle.signature).toBeNull();
    expect(bundle.producer.toolchain["@mmmnt/feat-core"]).toBeTruthy();
    // ADR-0016: the repo's own config declares no environment, so the bundle
    // must not claim one — env presence is driven solely by the config used.
    expect(bundle.project.environment).toBe("toolchain");
  });
});
