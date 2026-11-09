// ADR-0024: every command reads its config through loadConfig, so a tier overlay that drifts from its
// base (here: an added command) is refused with TIER_SPACE_MISMATCH by run, verify, audit, lint, fmt,
// generate and report alike — and a well-formed overlay is read by them as the merged config.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(PKG, "bin/run.js");
const ROOT = path.join(PKG, "fixtures/tier");

function feat(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [BIN, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("every command reads the config through loadConfig", { timeout: 30_000 }, () => {
  for (const cmd of ["lint", "audit", "verify", "fmt", "report --evidence"]) {
    it(`feat ${cmd} refuses a drifting overlay`, () => {
      const r = feat([...cmd.split(" "), "--config", "feat.drifting.config.json"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("TIER_SPACE_MISMATCH");
    });
  }
  for (const cmd of ["generate", "run"]) {
    it(`feat ${cmd} refuses a drifting overlay`, () => {
      const r = feat([cmd, "--config", "feat.drifting.config.json"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("TIER_SPACE_MISMATCH");
    });
  }
  it("feat lint reads a well-formed overlay as the merged config", () => {
    const r = feat(["lint", "--config", "feat.integration.config.json"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lint: 1 spec(s)");
  });
});
