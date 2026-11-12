// CLI tests for `feat audit --changed <base>` (SPEC-CHG-001's glue, under TCR). The decision and the git read are
// spec-tested (audit-changed.feat); this covers the CLI around them: the flags, the root being git's top level,
// -c resolving against the working directory, the output lines and the exit codes. Requires `pnpm build`.
// Each case copies a fixture workspace into a throwaway git repository under os.tmpdir(), never this checkout.

import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(PKG_DIR, "bin/run.js");
const FIXTURES = path.join(PKG_DIR, "fixtures/changed");
// Unresolved on purpose: where os.tmpdir() is behind a symlink (macOS /var -> /private/var), a run started through
// the link must still resolve -c against git's top level.
const TMP = mkdtempSync(path.join(os.tmpdir(), "feat-chg-cli-"));
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CEILING_DIRECTORIES: [...new Set([TMP, realpathSync(TMP)])].join(path.delimiter),
};

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// File by file: fs.cpSync is refused with EACCES on the Docker Desktop bind mount ci-local runs the tree from.
function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from)) {
    const s = path.join(from, e);
    if (statSync(s).isDirectory()) copyDir(s, path.join(to, e));
    else copyFileSync(s, path.join(to, e));
  }
}

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=feat", "-c", "user.email=feat@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: GIT_ENV,
    stdio: "ignore",
  });
}

let n = 0;
/** A repository holding the fixture `name` committed on main, with HEAD on a fresh branch `topic`. */
function repo(name: string): string {
  const dir = path.join(TMP, `${name}-${n++}`);
  copyDir(path.join(FIXTURES, name), dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "fixture");
  git(dir, "checkout", "-q", "-b", "topic");
  return dir;
}

function write(dir: string, rel: string, text = "x\n"): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}

function feat(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], { cwd, env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("feat audit --changed (CLI)", () => {
  it("passes with exit 0 and one line naming what it checked", () => {
    const dir = repo("mono");
    write(dir, "crates/a/src/features/one/handler.rs");
    write(dir, "Cargo.lock");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "change");
    write(dir, "crates/b/src/features/two/extra.rs"); // untracked: the working tree is part of the change
    const r = feat(dir, ["audit", "--changed", "main", "--config", "crates/*/feat.config.json"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(
      "audit --changed main: 3 path(s) checked against 2 spec(s) in 2 workspace(s): 2 inside a feature directory, 1 outside every one.",
    );
  });

  it("resolves -c against the working directory and anchors at git's top level", () => {
    const dir = repo("mono");
    write(dir, "crates/a/src/features/one/handler.rs");
    const r = feat(path.join(dir, "crates"), ["audit", "--changed", "main", "-c", "a/feat.config.json", "-c", "b/feat.config.json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 path(s) checked against 2 spec(s) in 2 workspace(s): 1 inside a feature directory, 0 outside every one.");
  });

  it("a violation is exit 1 on stdout, with the code, the count and each finding indented", () => {
    const dir = repo("ws");
    write(dir, "src/features/beta/mod.rs");
    write(dir, "src/features/beta/extra.rs");
    const r = feat(dir, ["audit", "--changed", "main"]);
    expect(r.code).toBe(1);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("ERROR [OUTSIDE_TOUCHES] 2 finding(s)");
    expect(lines[1]).toMatch(/^ {4}OUTSIDE_TOUCHES: src\/features\/beta\/extra\.rs: .*SPEC-CHGFX-002/);
    expect(lines[2]).toMatch(/^ {4}OUTSIDE_TOUCHES: src\/features\/beta\/mod\.rs: /);
  });

  it("an unparseable spec is exit 1", () => {
    const dir = repo("broken");
    write(dir, "src/lib.rs");
    const r = feat(dir, ["audit", "--changed", "main"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("ERROR [SPEC_UNPARSEABLE] 1 finding(s)");
  });

  it("a config glob that matches nothing is exit 2 on stderr", () => {
    const dir = repo("mono");
    const r = feat(dir, ["audit", "--changed", "main", "-c", "crates/*/feat.integration.config.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [CONFIG_NOT_FOUND] 1 finding(s)");
    expect(r.stdout).toBe("");
  });

  it("a base that names no commit is exit 2", () => {
    const dir = repo("ws");
    const r = feat(dir, ["audit", "--changed", "no-such-ref"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [BASE_NOT_FOUND] 1 finding(s)");
    expect(r.stderr).toContain("    BASE_NOT_FOUND: no-such-ref: names no commit");
  });

  it("a directory in no repository is exit 2", () => {
    const dir = path.join(TMP, `none-${n++}`);
    copyDir(path.join(FIXTURES, "ws"), dir);
    const r = feat(dir, ["audit", "--changed", "main"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [NOT_A_GIT_REPO]");
  });

  it("--changed without a base is the flag parser's exit 2", () => {
    const dir = repo("ws");
    const r = feat(dir, ["audit", "--changed"]);
    expect(r.code).toBe(2);
  });

  it("without --changed, a second -c is refused with exit 2 and CONFIG_MULTIPLE", () => {
    const dir = repo("mono");
    const r = feat(dir, ["audit", "-c", "crates/a/feat.config.json", "-c", "crates/b/feat.config.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [CONFIG_MULTIPLE]");
  });

  it("without --changed, a -c holding a wildcard is refused with exit 2 and CONFIG_MULTIPLE", () => {
    const dir = repo("mono");
    const r = feat(dir, ["audit", "-c", "crates/*/feat.config.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [CONFIG_MULTIPLE]");
  });

  it("without --changed, feat audit is unchanged: one config, the buildability audit", () => {
    const dir = repo("ws");
    const r = feat(dir, ["audit"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("audit: 4 spec(s), 0 with errors");
  });
});
