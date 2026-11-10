// The serial pass (SPEC-RT-005): files named serial run second, in their own vitest invocation with
// FEAT_SERIAL=1; a failing parallel pass does not skip them; one merged JUnit report.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { promisify } from "node:util";
import { mergeJunit } from "./src/index.js";

const exec = promisify(execFile);
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/run-passes.mjs");

/** runTests, in its own process (see fixtures/run-passes.mjs): resolves with its exit code. */
async function runTests(opts: object): Promise<{ exitCode: number }> {
  try {
    await exec("node", [RUNNER, JSON.stringify(opts)], { encoding: "utf8" });
    return { exitCode: 0 };
  } catch (e) {
    return { exitCode: (e as { code?: number }).code ?? 1 };
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
