// The probe behind `ReadChanged` (SPEC-CHG-001): build a named throwaway git repository under os.tmpdir(),
// read its change with changedPaths and answer the paths only, then remove the directory, on a refusal too.
// The host's git settings and any enclosing repository are never read. Test fixture, not shipped.
//   committed | dirty | none | shallow | no-git
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedPaths } from "../../src/audit-changed.ts";

function isolation(tmp) {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: path.dirname(tmp),
  };
}

function gitIn(cwd, env, ...args) {
  execFileSync(
    "git",
    ["-c", "user.name=feat", "-c", "user.email=feat@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, env: { ...process.env, ...env }, stdio: "ignore" },
  );
}

const write = (dir, name, text) => writeFileSync(path.join(dir, name), text);

function committed(dir, env) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => gitIn(dir, env, ...a);
  git("init", "-q", "-b", "main");
  for (const f of ["a", "b", "m", "r-old"]) write(dir, `${f}.txt`, `${f} content line\n`);
  git("add", "-A");
  git("commit", "-q", "-m", "1");
  git("checkout", "-q", "-b", "topic");
  git("rm", "-q", "a.txt");
  appendFileSync(path.join(dir, "b.txt"), "x\n");
  write(dir, "c.txt", "c\n");
  git("mv", "r-old.txt", "r-new.txt");
  git("add", "-A");
  git("commit", "-q", "-m", "2");
  git("checkout", "-q", "main");
  appendFileSync(path.join(dir, "m.txt"), "y\n");
  git("commit", "-q", "-a", "-m", "3");
  git("checkout", "-q", "topic");
  write(dir, "d.txt", "d\n");
  return dir;
}

function dirty(dir, env) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => gitIn(dir, env, ...a);
  git("init", "-q", "-b", "main");
  write(dir, "a.txt", "a\n");
  write(dir, "b.txt", "b\n");
  write(dir, ".gitignore", "ignored.txt\n");
  git("add", "-A");
  git("commit", "-q", "-m", "1");
  appendFileSync(path.join(dir, "a.txt"), "a2\n");
  git("add", "a.txt");
  appendFileSync(path.join(dir, "b.txt"), "b2\n");
  write(dir, "new.txt", "n\n");
  write(dir, "ignored.txt", "i\n");
  return dir;
}

function shallow(tmp, env) {
  const origin = committed(path.join(tmp, "origin"), env);
  const clone = path.join(tmp, "clone");
  gitIn(tmp, env, "clone", "-q", "--depth", "1", "--no-single-branch", `file://${origin}`, clone);
  gitIn(clone, env, "checkout", "-q", "topic");
  return clone;
}

export async function readChanged(input) {
  const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), "feat-chg-")));
  const env = isolation(tmp);
  try {
    let cwd;
    let git;
    switch (input.repo) {
      case "committed": cwd = committed(path.join(tmp, "repo"), env); break;
      case "dirty": cwd = dirty(path.join(tmp, "repo"), env); break;
      case "none": cwd = path.join(tmp, "repo"); mkdirSync(cwd); break;
      case "shallow": cwd = shallow(tmp, env); break;
      case "no-git": cwd = dirty(path.join(tmp, "repo"), env); git = "/nonexistent/feat-no-git"; break;
      default: throw new Error(`unknown repo '${input.repo}'`);
    }
    const r = await changedPaths({ cwd, base: input.base, env, ...(git ? { git } : {}) });
    if (r.status !== "OK") return r;
    return { status: "OK", body: { paths: r.body.paths } };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
