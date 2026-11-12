// The probe behind `ReadChanged` (SPEC-CHG-001): read the change of a named throwaway git repository with
// changedPaths and answer the paths only. The host's git settings and any enclosing repository are never read.
// Test fixture, not shipped.   committed | dirty | none | shallow | no-git
// The repositories are built once, when the module is evaluated (as the product probes start their environments at
// load), so the build runs in beforeAll under the hook timeout and no case is charged for it: under a full parallel
// `feat run` each git process can take seconds to start. They live in one directory under os.tmpdir(), removed when
// the process exits. changedPaths only reads them, so cases sharing one cannot see each other. History is written with
// one `git fast-import` per repository, and every git runs asynchronously by its absolute path.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { changedPaths, resolveProgram } from "../../src/audit-changed.ts";

// Looked up once: a bare name costs one posix_spawn per PATH entry on every start (see resolveProgram).
const GIT = resolveProgram("git");

function isolation(tmp) {
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: path.dirname(tmp),
  };
}

function gitIn(cwd, env, args, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      GIT,
      ["-c", "user.name=feat", "-c", "user.email=feat@example.invalid", "-c", "commit.gpgsign=false", ...args],
      { cwd, env: { ...process.env, ...env } },
      (err, _stdout, stderr) => (err ? reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`)) : resolve()),
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

// A fast-import stream. commits: [{ ref, from?, files: { name: content | null } }], null deleting the file.
function history(commits) {
  let out = "";
  commits.forEach((c, i) => {
    out += `commit ${c.ref}\nmark :${i + 1}\ncommitter feat <feat@example.invalid> ${1700000000 + i} +0000\ndata 1\n${i + 1}\n`;
    if (c.from) out += `from ${c.from}\n`;
    for (const [name, content] of Object.entries(c.files)) {
      if (content === null) out += `D ${name}\n`;
      else out += `M 100644 inline ${name}\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    }
    out += "\n";
  });
  return out;
}

const write = (dir, name, text) => writeFileSync(path.join(dir, name), text);

async function committed(dir, env) {
  mkdirSync(dir, { recursive: true });
  await gitIn(dir, env, ["init", "-q", "-b", "main"]);
  const base = { "a.txt": "a content line\n", "b.txt": "b content line\n", "m.txt": "m content line\n", "r-old.txt": "r-old content line\n" };
  await gitIn(
    dir,
    env,
    ["fast-import", "--quiet"],
    history([
      { ref: "refs/heads/main", files: base },
      {
        ref: "refs/heads/topic",
        from: ":1",
        files: { "a.txt": null, "b.txt": "b content line\nx\n", "c.txt": "c\n", "r-old.txt": null, "r-new.txt": base["r-old.txt"] },
      },
      { ref: "refs/heads/main", from: ":1", files: { "m.txt": "m content line\ny\n" } },
    ]),
  );
  await gitIn(dir, env, ["checkout", "-q", "-f", "topic"]);
  write(dir, "d.txt", "d\n");
  return dir;
}

async function dirty(dir, env) {
  mkdirSync(dir, { recursive: true });
  await gitIn(dir, env, ["init", "-q", "-b", "main"]);
  await gitIn(
    dir,
    env,
    ["fast-import", "--quiet"],
    history([{ ref: "refs/heads/main", files: { "a.txt": "a\n", "b.txt": "b\n", ".gitignore": "ignored.txt\n" } }]),
  );
  await gitIn(dir, env, ["checkout", "-q", "-f", "main"]);
  appendFileSync(path.join(dir, "a.txt"), "a2\n");
  await gitIn(dir, env, ["add", "a.txt"]);
  appendFileSync(path.join(dir, "b.txt"), "b2\n");
  write(dir, "new.txt", "n\n");
  write(dir, "ignored.txt", "i\n");
  return dir;
}


const TMP = realpathSync(mkdtempSync(path.join(os.tmpdir(), "feat-chg-")));
process.on("exit", () => rmSync(TMP, { recursive: true, force: true }));
const ENV = isolation(TMP);

async function build() {
  const none = path.join(TMP, "none");
  mkdirSync(none);
  const shallowFrom = async () => {
    const origin = await committed(path.join(TMP, "committed"), ENV);
    const clone = path.join(TMP, "shallow");
    await gitIn(TMP, ENV, ["clone", "-q", "--depth", "1", "--no-single-branch", `file://${origin}`, clone]);
    await gitIn(clone, ENV, ["checkout", "-q", "topic"]);
    return { committed: origin, shallow: clone };
  };
  const [c, d] = await Promise.all([shallowFrom(), dirty(path.join(TMP, "dirty"), ENV)]);
  return { committed: c.committed, shallow: c.shallow, dirty: d, none };
}

const REPOS = await build();

export async function readChanged(input) {
  const cwd = { committed: REPOS.committed, dirty: REPOS.dirty, none: REPOS.none, shallow: REPOS.shallow, "no-git": REPOS.dirty }[input.repo];
  if (!cwd) throw new Error(`unknown repo '${input.repo}'`);
  const r = await changedPaths({ cwd, base: input.base, env: ENV, ...(input.repo === "no-git" ? { git: "/nonexistent/feat-no-git" } : {}) });
  if (r.status !== "OK") return r;
  return { status: "OK", body: { paths: r.body.paths } };
}
