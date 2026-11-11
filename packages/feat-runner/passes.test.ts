// The serial pass (SPEC-RT-005): files named serial run second, in their own vitest invocation with
// FEAT_SERIAL=1; a failing parallel pass does not skip them; one merged JUnit report.
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { mergeJunit } from "./src/index.js";

const exec = promisify(execFile);
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/run-passes.mjs");

/** runTests, in its own process (see fixtures/run-passes.mjs): resolves with its exit code and the RunResult it printed. */
async function runTests(opts: object): Promise<{ exitCode: number; result?: { junitPath?: string; jsonPath?: string } }> {
  const parsed = (stdout: string | undefined) => {
    try {
      return JSON.parse(stdout ?? "") as { junitPath?: string; jsonPath?: string };
    } catch {
      return undefined;
    }
  };
  try {
    const { stdout } = await exec("node", [RUNNER, JSON.stringify(opts)], { encoding: "utf8" });
    return { exitCode: 0, result: parsed(stdout) };
  } catch (e) {
    return { exitCode: (e as { code?: number }).code ?? 1, result: parsed((e as { stdout?: string }).stdout) };
  }
}

const PKG = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PKG, "../..");
const f = (n: string) => path.relative(ROOT, path.join(PKG, "fixtures/passes", n));

describe("runTests with a serial set", { timeout: 120_000 }, () => {
  it("runs the serial files second with FEAT_SERIAL=1 and the rest without it", async () => {
    const r = await runTests({ files: [f("parallel.probe.ts"), f("serial.probe.ts")], serialFiles: [f("serial.probe.ts")], root: ROOT, quiet: true });
    expect(r.exitCode).toBe(0);
  });
  it("a serial file in the parallel pass would fail (the env is the proof)", async () => {
    const r = await runTests({ files: [f("serial.probe.ts")], root: ROOT, quiet: true });
    expect(r.exitCode).not.toBe(0);
  });
  it("a failing parallel pass does not skip the serial pass, and the run fails; the report holds both", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feat-pass-"));
    const junit = path.join(dir, "junit.xml");
    const r = await runTests({
      files: [f("failing.probe.ts"), f("serial.probe.ts")],
      serialFiles: [f("serial.probe.ts")],
      root: ROOT,
      quiet: true,
      junitOutput: junit,
    });
    expect(r.exitCode).not.toBe(0);
    const xml = readFileSync(junit, "utf8");
    expect(xml).toContain("fails on purpose");
    expect(xml).toContain("runs in the serial pass");
  });
});

// RunOptions.jsonOutput: "vitest's JSON results, from the main pass". A run whose files are all serial has no
// other pass, so the serial pass is the main one: the file the result names must exist.
describe("runTests with jsonOutput", { timeout: 120_000 }, () => {
  it("writes the file it returns when every file is serial", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feat-pass-"));
    const json = path.join(dir, "results.json");
    const r = await runTests({ files: [f("serial.probe.ts")], serialFiles: [f("serial.probe.ts")], root: ROOT, quiet: true, jsonOutput: json });
    expect(r.exitCode).toBe(0);
    expect(r.result?.jsonPath).toBe(json);
    expect(existsSync(json)).toBe(true);
    expect(JSON.parse(readFileSync(json, "utf8")).numTotalTests).toBeGreaterThan(0);
  });
  it("writes the parallel pass's results when a serial pass follows, and not the serial pass's", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feat-pass-"));
    const json = path.join(dir, "results.json");
    const r = await runTests({ files: [f("parallel.probe.ts"), f("serial.probe.ts")], serialFiles: [f("serial.probe.ts")], root: ROOT, quiet: true, jsonOutput: json });
    expect(r.exitCode).toBe(0);
    expect(r.result?.jsonPath).toBe(json);
    const results = readFileSync(json, "utf8");
    expect(results).toContain("parallel.probe.ts");
    expect(results).not.toContain("serial.probe.ts");
  });
});

describe("a harness configuration error", { timeout: 120_000 }, () => {
  it("is told apart from a test failure: the run fails and says it was a configuration error", async () => {
    const r = await runTests({ files: [f("misconfigured.probe.ts")], root: ROOT, quiet: true });
    expect(r.exitCode).toBe(2);
  });
  it("is found in the serial pass too, and a plain failure beside it stays a plain failure", async () => {
    const r = await runTests({ files: [f("failing.probe.ts"), f("misconfigured.probe.ts")], serialFiles: [f("misconfigured.probe.ts")], root: ROOT, quiet: true });
    expect(r.exitCode).toBe(2);
    expect((await runTests({ files: [f("failing.probe.ts")], root: ROOT, quiet: true })).exitCode).toBe(1);
  });
});

describe("mergeJunit", () => {
  const a = '<?xml version="1.0"?>\n<testsuites name="vitest tests" tests="2" failures="1" errors="0" time="1.5">\n<testsuite name="a"></testsuite>\n</testsuites>\n';
  const b = '<?xml version="1.0"?>\n<testsuites name="vitest tests" tests="3" failures="0" errors="1" time="0.5">\n<testsuite name="b"></testsuite>\n</testsuites>\n';
  it("sums the counts and keeps every suite", () => {
    const m = mergeJunit(a, b);
    expect(m).toContain('tests="5"');
    expect(m).toContain('failures="1"');
    expect(m).toContain('errors="1"');
    expect(m).toContain('time="2"');
    expect(m).toContain('<testsuite name="a">');
    expect(m).toContain('<testsuite name="b">');
  });
});
