// The runner-owned run config: consumer config extended, selection forced,
// empty runs fatal. The dashboard incident this guards against: a root vitest
// config scoped to its unit layer silently collected ZERO generated suites
// and passWithNoTests turned the gate green.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVitest, runConfigSource, runTests, VitestNotInstalledError } from "./src/index.js";

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

  it("carries the timeouts the caller computed from the active config (ADR-0024)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "feat-runner-"));
    const src = runConfigSource(root, [path.join(root, "g.test.ts")], { testTimeoutMs: 123456, hookTimeoutMs: 120000 });
    expect(src).toContain("testTimeout: 123456,");
    expect(src).toContain("hookTimeout: 120000,");
    expect(runConfigSource(root, [path.join(root, "g.test.ts")])).not.toContain("testTimeout");
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

// SPEC-RT-010: the bin forms of vitest's package.json; the probe of the spec covers the run itself.
describe("resolveVitest", () => {
  const withVitest = (manifest: object, files: string[] = []) => {
    const root = mkdtempSync(path.join(tmpdir(), "feat-runner-vitest-"));
    const pkg = path.join(root, "node_modules", "vitest");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "vitest", ...manifest }));
    for (const f of files) writeFileSync(path.join(pkg, f), "");
    return { root, pkg };
  };

  it("takes bin.vitest, and a bin given as a string", () => {
    const a = withVitest({ version: "3.2.4", bin: { vitest: "./vitest.mjs" } }, ["vitest.mjs"]);
    expect(resolveVitest(a.root)).toEqual({ bin: path.join(a.pkg, "vitest.mjs"), version: "3.2.4" });
    const b = withVitest({ version: "5.1.0", bin: "./cli.mjs" }, ["cli.mjs"]);
    expect(resolveVitest(b.root)).toEqual({ bin: path.join(b.pkg, "cli.mjs"), version: "5.1.0" });
  });

  it("refuses a vitest that names no bin, or whose bin is not there, as not installed", () => {
    expect(() => resolveVitest(withVitest({ version: "3.2.4" }).root)).toThrow(VitestNotInstalledError);
    expect(() => resolveVitest(withVitest({ version: "3.2.4", bin: { vitest: "./gone.mjs" } }).root)).toThrow(/\[VITEST_NOT_INSTALLED\]/);
  });
});
