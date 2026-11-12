// CLI tests for `feat audit --changed <base>` (SPEC-CHG-001's glue, under TCR). The decision and the git read are
// spec-tested (audit-changed.feat); this covers the CLI around them: the flags, the root being git's top level,
// -c resolving against the working directory, the output lines and the exit codes. Requires `pnpm build`.
// Each case copies a fixture workspace into a throwaway git repository under os.tmpdir(), never this checkout.

import { describe, it, expect, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProgram } from "./src/audit-changed.js";

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

// Every process runs asynchronously: a synchronous wait of seconds under a loaded host starves the worker's RPC to
// vitest ("Timeout calling onTaskUpdate").
function exec(file: string, args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env: GIT_ENV, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

// Absolute: a bare name costs one posix_spawn per PATH entry on every start (see resolveProgram).
const GIT = resolveProgram("git");
const NODE = process.execPath;

async function git(cwd: string, ...args: string[]): Promise<void> {
  const r = await exec(GIT, ["-c", "user.name=feat", "-c", "user.email=feat@example.invalid", "-c", "commit.gpgsign=false", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

let n = 0;
/** A repository holding the fixture `name` committed on main, with HEAD on a fresh branch `topic`. */
async function repo(name: string): Promise<string> {
  const dir = path.join(TMP, `${name}-${n++}`);
  copyDir(path.join(FIXTURES, name), dir);
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "fixture");
  await git(dir, "checkout", "-q", "-b", "topic");
  return dir;
}

function write(dir: string, rel: string, text = "x\n"): void {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}

const feat = (cwd: string, args: string[]) => exec(NODE, [BIN, ...args], cwd);

describe("feat audit --changed (CLI)", () => {
  it("passes with exit 0 and one line naming what it checked", async () => {
    const dir = await repo("mono");
    write(dir, "crates/a/src/features/one/handler.rs");
    write(dir, "Cargo.lock");
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", "change");
    write(dir, "crates/b/src/features/two/extra.rs"); // untracked: the working tree is part of the change
    const r = await feat(dir, ["audit", "--changed", "main", "--config", "crates/*/feat.config.json"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(
      "audit --changed main: 3 path(s) checked against 2 spec(s) in 2 workspace(s): 2 inside a feature directory, 1 outside every one.",
    );
  });

  it("resolves -c against the working directory and reads the whole change from git's top level", async () => {
    const dir = await repo("mono");
    write(dir, "crates/a/src/features/one/handler.rs");
    write(dir, "Cargo.lock"); // untracked and outside the working directory: still part of the change
    const r = await feat(path.join(dir, "crates"), ["audit", "--changed", "main", "-c", "a/feat.config.json", "-c", "b/feat.config.json"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("2 path(s) checked against 2 spec(s) in 2 workspace(s): 1 inside a feature directory, 1 outside every one.");
  });

  it("a violation is exit 1 on stdout, with the code, the count and each finding indented", async () => {
    const dir = await repo("ws");
    write(dir, "src/features/beta/mod.rs");
    write(dir, "src/features/beta/extra.rs");
    const r = await feat(dir, ["audit", "--changed", "main"]);
    expect(r.code).toBe(1);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe("ERROR [OUTSIDE_TOUCHES] 2 finding(s)");
    expect(lines[1]).toMatch(/^ {4}OUTSIDE_TOUCHES: src\/features\/beta\/extra\.rs: .*SPEC-CHGFX-002/);
    expect(lines[2]).toMatch(/^ {4}OUTSIDE_TOUCHES: src\/features\/beta\/mod\.rs: /);
  });

  it("an unparseable spec is exit 1", async () => {
    const dir = await repo("broken");
    write(dir, "src/lib.rs");
    const r = await feat(dir, ["audit", "--changed", "main"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("ERROR [SPEC_UNPARSEABLE] 1 finding(s)");
  });

  it("a config glob that matches nothing is exit 2 on stderr", async () => {
    const dir = await repo("mono");
    const r = await feat(dir, ["audit", "--changed", "main", "-c", "crates/*/feat.integration.config.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [CONFIG_NOT_FOUND] 1 finding(s)");
    expect(r.stdout).toBe("");
  });

  it("a base that names no commit is exit 2", async () => {
    const dir = await repo("ws");
    const r = await feat(dir, ["audit", "--changed", "no-such-ref"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [BASE_NOT_FOUND] 1 finding(s)");
    expect(r.stderr).toContain("    BASE_NOT_FOUND: no-such-ref: names no commit");
  });

  it("a directory in no repository is exit 2", async () => {
    const dir = path.join(TMP, `none-${n++}`);
    copyDir(path.join(FIXTURES, "ws"), dir);
    const r = await feat(dir, ["audit", "--changed", "main"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [NOT_A_GIT_REPO]");
  });

  it("--changed without a base is the flag parser's exit 2", async () => {
    const dir = await repo("ws");
    const r = await feat(dir, ["audit", "--changed"]);
    expect(r.code).toBe(2);
  });

  it("without --changed, a second -c is refused with exit 2 and CONFIG_MULTIPLE", async () => {
    const dir = await repo("mono");
    const r = await feat(dir, ["audit", "-c", "crates/a/feat.config.json", "-c", "crates/b/feat.config.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [CONFIG_MULTIPLE]");
  });

  it("without --changed, a -c holding a wildcard is refused with exit 2 and CONFIG_MULTIPLE", async () => {
    const dir = await repo("mono");
    const r = await feat(dir, ["audit", "-c", "crates/*/feat.config.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ERROR [CONFIG_MULTIPLE]");
  });

  it("without --changed, feat audit is unchanged: one config, the buildability audit", async () => {
    const dir = await repo("ws");
    const r = await feat(dir, ["audit"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("audit: 4 spec(s), 0 with errors");
  });
});
