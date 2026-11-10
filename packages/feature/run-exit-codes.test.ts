// `feat run` exits 2 when the run failed because the harness refused its configuration (README: exit 2
// is a configuration error), and the refusal's code is in the output — vitest prints only the message.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(PKG, "bin/run.js");
const ROOT = path.join(PKG, "fixtures/fault");

function feat(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [BIN, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("a harness configuration error during feat run", { timeout: 60_000 }, () => {
  afterAll(() => rmSync(path.join(ROOT, "specs/ping.test.ts"), { force: true }));

  it("exits 2 and names its code (a fault the adapter does not offer)", () => {
    expect(feat(["generate"]).code).toBe(0);
    const r = feat(["run"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Configuration error (exit 2): [FAULT_UNSUPPORTED]");
  });

  it("exits 2 when createHarness itself refuses, and the suite's teardown tolerates a harness never created", () => {
    expect(feat(["generate"]).code).toBe(0);
    const r = feat(["run", "--config", "feat.namespaced.config.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Configuration error (exit 2): [NAMESPACE_CONFIGURED]");
    expect(r.out).not.toContain("reading 'teardown'");
  });
});
