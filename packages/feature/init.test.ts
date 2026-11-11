// `feat init` E2E: scaffold + dependency completion. Network-free — the
// install path is asserted via --no-install's printed command; package-manager
// detection via lockfile fixtures.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin/run.js");

function initIn(dir: string, args: string[] = ["--no-install"]): string {
  // Scrub the package-manager user agent: the test suite itself runs under
  // pnpm, and detection must reflect the TARGET project, not our harness.
  const env = { ...process.env };
  delete env.npm_config_user_agent;
  return execFileSync("node", [BIN, "init", ...args], { cwd: dir, encoding: "utf8", env });
}

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "feat-init-"));
}

describe("feat init dependency completion", () => {
  it("scaffolds, creates package.json, and prints the full install set", () => {
    const dir = tmp();
    try {
      const out = initIn(dir);
      expect(existsSync(path.join(dir, "feat.config.json"))).toBe(true);
      expect(existsSync(path.join(dir, "specs/greet.feat"))).toBe(true);
      expect(out).toContain("created package.json");
      expect(out).toContain("npm install -D");
      for (const dep of ["@mmmnt/feat-runtime", "@mmmnt/feat-adapter-handler", "@mmmnt/feat-adapter-fs", "@mmmnt/feat-schema-json", "vitest"]) {
        expect(out).toContain(dep);
      }
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
      expect(pkg.private).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects pnpm from the lockfile", () => {
    const dir = tmp();
    try {
      writeFileSync(path.join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", private: true }));
      const out = initIn(dir);
      expect(out).toContain("pnpm add -D");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only installs what's missing", () => {
    const dir = tmp();
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          private: true,
          devDependencies: { "@mmmnt/feat-runtime": "^0.1.7", vitest: "^3.2.0" },
        }),
      );
      const out = initIn(dir);
      expect(out).not.toContain("@mmmnt/feat-runtime ");
      expect(out).toContain("@mmmnt/feat-adapter-handler");
      expect(out.match(/vitest/g)?.length ?? 0).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports all-present and refuses re-init", () => {
    const dir = tmp();
    try {
      writeFileSync(
        path.join(dir, "package.json"),
        JSON.stringify({
          name: "x",
          private: true,
          devDependencies: {
            "@mmmnt/feat-runtime": "*",
            "@mmmnt/feat-adapter-handler": "*",
            "@mmmnt/feat-adapter-fs": "*",
            "@mmmnt/feat-schema-json": "*",
            vitest: "*",
          },
        }),
      );
      const out = initIn(dir);
      expect(out).toContain("dependencies: all present");
      expect(() => initIn(dir)).toThrowError();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function initResult(dir: string): { code: number; out: string } {
  const env = { ...process.env };
  delete env.npm_config_user_agent;
  try {
    const out = execFileSync("node", [BIN, "init", "--no-install"], { cwd: dir, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("feat init scaffolds a config that runs", () => {
  // The scaffold is the in-process spec tier (handler response, fs service), the base ADR-0024 recommends
  // `environment: "spec"` for. Without an environment `feat run` is a configuration error (NO_ENVIRONMENT).
  it("pins the spec tier's environment, so feat run needs no ENVIRONMENT", () => {
    const dir = tmp();
    try {
      initIn(dir);
      const config = JSON.parse(readFileSync(path.join(dir, "feat.config.json"), "utf8"));
      expect(config.environment).toBe("spec");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("feat init refuses to overwrite what is there", () => {
  // README contract: exit 2 is a configuration error; init already exits 2 for an existing config.
  it("an existing specs/greet.feat is ALREADY_INITIALIZED (exit 2) and is left as it was", () => {
    const dir = tmp();
    try {
      mkdirSync(path.join(dir, "specs"));
      writeFileSync(path.join(dir, "specs/greet.feat"), "my own spec\n");
      const r = initResult(dir);
      expect(r.code).toBe(2);
      expect(r.out).toContain("[ALREADY_INITIALIZED]");
      expect(r.out).toContain("specs/greet.feat");
      expect(readFileSync(path.join(dir, "specs/greet.feat"), "utf8")).toBe("my own spec\n");
      // nothing else was written: a refusal has no effect
      expect(existsSync(path.join(dir, "feat.config.json"))).toBe(false);
      expect(existsSync(path.join(dir, "specs/greet.contract.json"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("an existing specs/greet.contract.json is refused the same way", () => {
    const dir = tmp();
    try {
      mkdirSync(path.join(dir, "specs"));
      writeFileSync(path.join(dir, "specs/greet.contract.json"), "{}\n");
      const r = initResult(dir);
      expect(r.code).toBe(2);
      expect(r.out).toContain("specs/greet.contract.json");
      expect(readFileSync(path.join(dir, "specs/greet.contract.json"), "utf8")).toBe("{}\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("an existing feat.config.json is still ALREADY_INITIALIZED", () => {
    const dir = tmp();
    try {
      writeFileSync(path.join(dir, "feat.config.json"), "{}\n");
      const r = initResult(dir);
      expect(r.code).toBe(2);
      expect(r.out).toContain("[ALREADY_INITIALIZED] feat.config.json already exists.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
