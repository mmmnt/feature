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

// README contract: exit 2 is a configuration error. A run with no environment to name, and `feat diff` with a
// config that cannot be loaded, are configuration errors too (founder ruling 2026-11-10), each with its [CODE].
describe("a configuration error before any work exits 2 with its code", { timeout: 60_000 }, () => {
  const TIER = path.join(PKG, "fixtures/tier");
  // an overlay does not inherit `environment`, so this config names none; the process must not either
  function featIn(args: string[], cwd = TIER): { code: number; out: string } {
    const env = { ...process.env };
    delete env.ENVIRONMENT;
    delete env.FEAT_ENVIRONMENT;
    try {
      const out = execFileSync("node", [BIN, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status: number | null; stdout?: string; stderr?: string };
      return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
    }
  }

  it("feat run with no environment resolvable exits 2 with NO_ENVIRONMENT", () => {
    const r = featIn(["run", "--config", "feat.no-environment.config.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("[NO_ENVIRONMENT]");
  });
  it("feat report --evidence with no environment resolvable exits 2 with NO_ENVIRONMENT", () => {
    const r = featIn(["report", "--evidence", "--config", "feat.no-environment.config.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("[NO_ENVIRONMENT]");
  });
  it("feat diff with a config that does not exist exits 2 with CONFIG_NOT_FOUND", () => {
    const r = featIn(["diff", "specs/ping.feat", "--config", "feat.nowhere.config.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("[CONFIG_NOT_FOUND]");
  });
  it("feat diff with an overlay that drifts exits 2 with TIER_SPACE_MISMATCH", () => {
    const r = featIn(["diff", "specs/ping.feat", "--config", "feat.drifting.config.json"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("[TIER_SPACE_MISMATCH]");
  });
  it("feat diff of a spec that does not parse stays exit 1 (a validation failure)", () => {
    const r = featIn(["diff", "specs/no-such.feat", "--config", "feat.config.json"]);
    expect(r.code).toBe(1);
  });
  // the schema adapter is named by the config and loaded through the same door as every adapter
  for (const cmd of ["generate", "verify"]) {
    it(`feat ${cmd} exits 2 with INVALID_CONFIG when schemas.adapter cannot be resolved`, () => {
      const r = featIn([cmd], path.join(PKG, "fixtures/schema-bundle-missing-adapter"));
      expect(r.code).toBe(2);
      expect(r.out).toContain("[INVALID_CONFIG]");
      expect(r.out).toContain("schemas.adapter");
    });
  }
});
