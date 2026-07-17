// CLI smoke tests for `feat parse` — exercises the built binary end-to-end.
// (The parsing logic itself is spec-tested in feat-core; this covers the
// orchestration surface: exit codes, stdout/stderr shape. Requires `pnpm build`.)

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PKG_DIR, "../..");
const BIN = path.join(PKG_DIR, "bin/run.js");

function feat(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("feat parse (CLI)", () => {
  it("exit 0 + IR on stdout for a valid spec", () => {
    const r = feat([
      "parse",
      "corpus/create-flow/create-flow.feat",
      "--config",
      "corpus/create-flow/feat.config.json",
    ]);
    expect(r.code).toBe(0);
    const ir = JSON.parse(r.stdout);
    expect(ir.identity.id).toBe("SPEC-AUT-001");
    expect(ir.featVersion).toBe("1.0");
  });

  it("exit 1 + coded error on stderr for a validation failure", () => {
    const r = feat([
      "parse",
      "packages/feat-core/fixtures/bad/unknown-service.feat",
      "--config",
      "packages/feat-core/fixtures/parse.config.json",
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ERROR [UNKNOWN_SERVICE_KEY]");
    expect(r.stderr).toContain("Hint:");
  });

  it("exit 2 for a config error", () => {
    const r = feat(["parse", "corpus/create-flow/create-flow.feat", "--config", "does-not-exist.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [CONFIG_NOT_FOUND]");
  });
});
