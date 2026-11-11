// `feat report` summarises the last run from its JUnit file: one line per suite, under the suite's NAME.
// The machine's hostname is an attribute of the same element and is not the suite's name.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(PKG, "bin/run.js");
const ROOT = path.join(PKG, "fixtures/report");

function feat(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [BIN, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("feat report", () => {
  it("names each suite by its name, not by the machine's hostname", () => {
    const r = feat(["report"]);
    expect(r.out).toContain("✗ specs/alpha.test.ts — 2 test(s), 1 failure(s), 0 error(s)");
    expect(r.out).toContain("✓ specs/beta.test.ts — 1 test(s), 0 failure(s), 0 error(s)");
    expect(r.out).not.toContain("build-host-17");
  });
  it("totals the suites and exits 1 when any failed", () => {
    const r = feat(["report"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("3 test(s): 2 passed, 1 failed, 0 errored.");
  });
});
