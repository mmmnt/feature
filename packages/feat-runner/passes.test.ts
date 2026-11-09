// The serial pass (SPEC-RT-005): files named serial run second, in their own vitest invocation with
// FEAT_SERIAL=1; a failing parallel pass does not skip them; one merged JUnit report.
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { mergeJunit, runTests } from "./src/index.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PKG, "../..");
const f = (n: string) => path.relative(ROOT, path.join(PKG, "fixtures/passes", n));

describe("runTests with a serial set", { timeout: 120_000 }, () => {
  it("runs the serial files second with FEAT_SERIAL=1 and the rest without it", () => {
    const r = runTests({ files: [f("parallel.probe.ts"), f("serial.probe.ts")], serialFiles: [f("serial.probe.ts")], root: ROOT, quiet: true });
    expect(r.exitCode).toBe(0);
  });
  it("a serial file in the parallel pass would fail (the env is the proof)", () => {
    const r = runTests({ files: [f("serial.probe.ts")], root: ROOT, quiet: true });
    expect(r.exitCode).not.toBe(0);
  });
  it("a failing parallel pass does not skip the serial pass, and the run fails; the report holds both", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "feat-pass-"));
    const junit = path.join(dir, "junit.xml");
    const r = runTests({
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
