// `feat run` exits 2 when the run failed because the harness refused its configuration (README: exit 2
// is a configuration error), and the refusal's code is in the output — vitest prints only the message.
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  function featIn(args: string[], cwd = TIER, extraEnv: Record<string, string> = {}): { code: number; out: string } {
    const env = { ...process.env };
    delete env.ENVIRONMENT;
    delete env.FEAT_ENVIRONMENT;
    Object.assign(env, extraEnv);
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

  // `feat run` generates in memory first. What fails there is told by its kind: a spec that does not parse and a
  // seed that violates its contract are validation failures (exit 1); an adapter the config cannot use is not.
  const RUN_ENV = { ENVIRONMENT: "spec" };
  it("feat run exits 2 when schemas.adapter cannot be resolved", () => {
    const r = featIn(["run"], path.join(PKG, "fixtures/schema-bundle-missing-adapter"), RUN_ENV);
    expect(r.code).toBe(2);
    expect(r.out).toContain("[INVALID_CONFIG]");
  });
  it("feat run stays exit 1 when a spec does not parse (a validation failure)", () => {
    const r = featIn(["run"], path.join(PKG, "fixtures/generation-parse-error"), RUN_ENV);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Parse failed");
  });
  it("feat run stays exit 1 when a seed violates its contract (a validation failure)", () => {
    const r = featIn(["run"], path.join(PKG, "fixtures/seed/bad-record"), RUN_ENV);
    expect(r.code).toBe(1);
  });
});

// SPEC-RT-010: `feat run` runs the project's own vitest and never fetches one. A project with no vitest
// installed is a configuration error before any test runs (it used to be `npx vitest`, which printed
// "npm warn exec The following package was not found and will be installed: vitest@<latest>" and fetched
// it). The project is built in the temporary directory, so no parent directory of it holds a vitest; its
// adapters link to the repository's. Stubs of npx, npm and pnpm come first on PATH and record any call.
describe("feat run in a project without vitest", { timeout: 60_000 }, () => {
  it("exits 2 with VITEST_NOT_INSTALLED, tells the user to add it, and fetches nothing", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "feat-no-vitest-"));
    try {
      const project = path.join(tmp, "app");
      mkdirSync(path.join(project, "specs"), { recursive: true });
      mkdirSync(path.join(project, "node_modules"));
      symlinkSync(path.resolve(PKG, "../../node_modules/@mmmnt"), path.join(project, "node_modules", "@mmmnt"), "junction");
      writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
      const fault = path.join(PKG, "fixtures/fault");
      copyFileSync(path.join(fault, "ping.mjs"), path.join(project, "ping.mjs"));
      copyFileSync(path.join(fault, "specs/ping.contract.json"), path.join(project, "specs/ping.contract.json"));
      const spec = readFileSync(path.join(fault, "specs/ping.feat"), "utf8").replace(/\n  given:\n    fault store Append Nonsense\n/, "\n").replace("    store has []", "    filesystem has []");
      writeFileSync(path.join(project, "specs/ping.feat"), spec);
      const config = JSON.parse(readFileSync(path.join(fault, "feat.config.json"), "utf8")) as Record<string, unknown>;
      config.services = { filesystem: { adapter: "@mmmnt/feat-adapter-fs", consistency: "acid", options: { scope: "specs" } } };
      writeFileSync(path.join(project, "feat.config.json"), JSON.stringify(config));
      const bin = path.join(tmp, "bin");
      const calls = path.join(tmp, "fetched");
      mkdirSync(bin);
      for (const name of ["npx", "npm", "pnpm"]) {
        writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(calls)}\nexit 0\n`);
        chmodSync(path.join(bin, name), 0o755);
      }
      const env = { ...process.env, ENVIRONMENT: "spec", PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
      const run = (args: string[]) => {
        try {
          return { code: 0, out: execFileSync("node", [BIN, ...args], { cwd: project, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env }) };
        } catch (e) {
          const err = e as { status: number | null; stdout?: string; stderr?: string };
          return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
        }
      };
      const g = run(["generate"]);
      expect(g.out).toContain("generated");
      expect(g.code).toBe(0);
      const r = run(["run"]);
      expect(r.out).toContain("Configuration error (exit 2): [VITEST_NOT_INSTALLED]");
      expect(r.out).toContain("add vitest as a dev dependency");
      expect(r.out).not.toContain("npm warn exec");
      expect(existsSync(calls) ? readFileSync(calls, "utf8") : "").toBe("");
      expect(r.code).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
