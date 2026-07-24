// The runner-owned run config: consumer config extended, selection forced,
// empty runs fatal. The dashboard incident this guards against: a root vitest
// config scoped to its unit layer silently collected ZERO generated suites
// and passWithNoTests turned the gate green.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runConfigSource, runTests } from "./src/index.js";

describe("runConfigSource", () => {
  it("without a consumer config: bare base, forced include, fatal-on-empty", () => {
    const root = mkdtempSync(path.join(tmpdir(), "feat-runner-"));
    const src = runConfigSource(root, [path.join(root, "a", "x.test.ts")]);
    expect(src).toContain("const base = {};");
    expect(src).toContain("passWithNoTests: false");
    expect(src).toContain(`${root.split(path.sep).join("/")}/a/x.test.ts`);
  });

  it("with a consumer config: statically extends it, include still forced over its own", () => {
    const root = mkdtempSync(path.join(tmpdir(), "feat-runner-"));
    writeFileSync(path.join(root, "vitest.config.ts"), "export default { test: { include: ['unit only'] } };");
    const src = runConfigSource(root, [path.join(root, "gen.test.ts")]);
    expect(src).toContain("import base from");
    expect(src).toContain("vitest.config.ts");
    // the forced include appears AFTER the spread of the consumer's test block
    expect(src.indexOf("...(resolved.test ?? {})")).toBeLessThan(src.indexOf("include:"));
    expect(src).toContain("passWithNoTests: false");
  });

  it("config-function consumers are awaited, not spread raw", () => {
    const root = mkdtempSync(path.join(tmpdir(), "feat-runner-"));
    const src = runConfigSource(root, [path.join(root, "g.test.ts")]);
    expect(src).toContain('typeof base === "function"');
  });
});

describe("runTests guardrails", () => {
  it("zero files is a loud failure, never an empty green run", () => {
    const r = runTests({ files: [], root: tmpdir() });
    expect(r.exitCode).toBe(1);
  });
});
