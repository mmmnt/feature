// SPEC-CHG-001 — the `touches` gate behind `feat audit --changed <base>` (FLMNT-ADR-006 §3, SIFT-ADR-091 §6).
// checkChanged is the decision: changed paths + the specs of one or more workspaces -> a pass, or every finding
// of the first stage that has one. changedPaths is the git read: the commits since the merge base of <base> and
// HEAD, plus the working tree. Every path and glob is anchored at the repository root, never at a config's directory.

import { execFile } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { parse, type CapturedResponse } from "@mmmnt/feat-core";
import { ConfigLoadError, readConfig } from "./config.js";
import { discoverSpecs, globToRegExp } from "./pipeline.js";

export interface ChangedInput {
  root: string;
  configs: string[];
  paths: string[];
}

interface Finding {
  code: string;
  subject: string;
  reason: string;
}

interface Workspace {
  rel: string;
  abs: string;
  config: FeatConfig;
}

interface ReadSpec {
  rel: string;
  id: string;
  dir: string;
  handler?: string;
  touches: RegExp[];
}

const NEVER_ENTER = new Set(["node_modules", ".git"]);
const WILDCARD = /[*?]/;

/** Whether a -c value or config entry is a glob rather than a path. */
export const isGlob = (entry: string): boolean => WILDCARD.test(entry);

const posix = (p: string) => p.split(path.sep).join("/");
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function refuse(findings: Finding[]): CapturedResponse {
  return {
    status: "ERR",
    body: {
      code: findings[0]!.code,
      count: findings.length,
      detail: findings.map((f) => `${f.code}: ${f.subject}: ${f.reason}`).join("\n"),
    },
  };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Root-relative files a glob matches, walking only the directories its segments can reach. */
function expandGlob(rootAbs: string, glob: string): string[] {
  const segs = glob.split("/");
  const out = new Set<string>();
  const rel = (p: string) => posix(path.relative(rootAbs, p));
  // A `**` inside a segment crosses segments in this dialect, so the walk cannot be pruned: match every file.
  if (segs.some((s) => s.includes("**") && s !== "**")) {
    const re = globToRegExp(glob);
    const walk = (dirAbs: string) => {
      for (const e of readdirSync(dirAbs)) {
        if (NEVER_ENTER.has(e)) continue;
        const p = path.join(dirAbs, e);
        if (isDir(p)) walk(p);
        else if (re.test(rel(p))) out.add(rel(p));
      }
    };
    if (isDir(rootAbs)) walk(rootAbs);
    return [...out].sort(byCodeUnit);
  }
  const step = (dirAbs: string, i: number) => {
    const seg = segs[i]!;
    const last = i === segs.length - 1;
    if (seg === "**") {
      if (!last) step(dirAbs, i + 1);
      for (const e of readdirSync(dirAbs)) {
        if (NEVER_ENTER.has(e)) continue;
        const p = path.join(dirAbs, e);
        if (isDir(p)) step(p, i);
        else if (last) out.add(rel(p));
      }
      return;
    }
    const names = isGlob(seg)
      ? readdirSync(dirAbs).filter((e) => !NEVER_ENTER.has(e) && globToRegExp(seg).test(e))
      : [seg];
    for (const e of names) {
      const p = path.join(dirAbs, e);
      if (last) {
        if (isFile(p)) out.add(rel(p));
      } else if (isDir(p)) step(p, i + 1);
    }
  };
  if (isDir(rootAbs)) step(rootAbs, 0);
  return [...out].sort(byCodeUnit);
}

function leavesRoot(p: string): string | undefined {
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return "is absolute";
  if (p.includes("\\")) return "holds a backslash";
  const bad = p.split("/").find((s) => s === "" || s === "." || s === "..");
  if (bad !== undefined) return bad === "" ? "has an empty segment" : `has a '${bad}' segment`;
  return undefined;
}

export async function checkChanged(input: ChangedInput): Promise<CapturedResponse> {
  const rootAbs = path.resolve(process.cwd(), input.root);
  const findings: Finding[] = [];

  // 1. The configs, in input order; a glob's matches in sorted order. A file matched twice counts once.
  const workspaces: Workspace[] = [];
  const seen = new Set<string>();
  for (const entry of input.configs) {
    let files: string[];
    if (isGlob(entry)) {
      files = expandGlob(rootAbs, entry);
      if (files.length === 0) {
        findings.push({ code: "CONFIG_NOT_FOUND", subject: entry, reason: "the glob matches no file under the root" });
        continue;
      }
    } else {
      if (!isFile(path.resolve(rootAbs, entry))) {
        findings.push({ code: "CONFIG_NOT_FOUND", subject: entry, reason: "no such file under the root" });
        continue;
      }
      files = [entry];
    }
    for (const file of files) {
      const abs = path.resolve(rootAbs, file);
      if (seen.has(abs)) continue;
      seen.add(abs);
      try {
        const config = await readConfig(path.dirname(abs), path.basename(abs));
        workspaces.push({ rel: posix(path.relative(rootAbs, abs)), abs, config });
      } catch (e) {
        if (!(e instanceof ConfigLoadError)) throw e;
        findings.push({ code: e.code, subject: file, reason: e.message });
      }
    }
  }
  if (findings.length > 0) return refuse(findings);

  // 2. The paths: each once, sorted by code unit.
  const paths = [...new Set(input.paths)].sort(byCodeUnit);
  for (const p of paths) {
    const why = leavesRoot(p);
    if (why) findings.push({ code: "PATH_OUTSIDE_ROOT", subject: p, reason: `${why}; a changed path is relative to the root` });
  }
  if (findings.length > 0) return refuse(findings);

  // 3. Discovery: every workspace must find a spec. specs.dir and specs.exclude resolve against the config's directory.
  const found: { abs: string; rel: string; ws: Workspace }[] = [];
  const specSeen = new Set<string>();
  for (const ws of workspaces) {
    const discovered = discoverSpecs(path.dirname(ws.abs), ws.config.specs.dir, ws.config.specs.exclude);
    if (discovered.length === 0) {
      findings.push({
        code: "NO_SPECS_FOUND",
        subject: ws.rel,
        reason: `specs.dir '${ws.config.specs.dir}' holds no spec, and a gate with no input proves nothing`,
      });
      continue;
    }
    for (const abs of discovered) {
      if (specSeen.has(abs)) continue;
      specSeen.add(abs);
      found.push({ abs, rel: posix(path.relative(rootAbs, abs)), ws });
    }
  }
  if (findings.length > 0) return refuse(findings);

  // 4. The parse, every spec with its workspace's config, in root-relative path order.
  found.sort((a, b) => byCodeUnit(a.rel, b.rel));
  const specs: ReadSpec[] = [];
  for (const { abs, rel, ws } of found) {
    let parsed: CapturedResponse;
    try {
      parsed = await parse({ spec: abs, config: ws.abs });
    } catch (e) {
      findings.push({ code: "SPEC_UNPARSEABLE", subject: rel, reason: (e as Error).message });
      continue;
    }
    if (parsed.status === "ERR") {
      const b = parsed.body as { code: string; message: string };
      findings.push({ code: "SPEC_UNPARSEABLE", subject: rel, reason: `[${b.code}] ${b.message}` });
      continue;
    }
    const spec = parsed.body as unknown as BuiltSpec;
    const dir = path.posix.dirname(rel);
    let handler: string | undefined;
    const touches: RegExp[] = [];
    for (const c of spec.construct) {
      if (c.kind === "handler") handler = c.path;
      else if (c.kind === "touches") touches.push(globToRegExp(c.glob));
    }
    specs.push({ rel, id: spec.identity.id, dir: dir === "." ? "" : dir, ...(handler !== undefined ? { handler } : {}), touches });
  }
  if (findings.length > 0) return refuse(findings);

  // 5. The paths against the boundaries. A path's feature directory is the nearest enclosing directory holding a spec.
  const byDir = new Map<string, ReadSpec[]>();
  for (const s of specs) byDir.set(s.dir, [...(byDir.get(s.dir) ?? []), s]);
  const nearest = (p: string): string | undefined => {
    for (let d = path.posix.dirname(p); ; d = path.posix.dirname(d)) {
      const key = d === "." ? "" : d;
      if (byDir.has(key)) return key;
      // "" is the root; a path that reached here unchecked (absolute, "/") must still end the walk.
      if (key === "" || path.posix.dirname(d) === d) return undefined;
    }
  };
  let specd = 0;
  for (const p of paths) {
    const dir = nearest(p);
    if (dir !== undefined) {
      specd++;
      const owners = byDir.get(dir)!;
      if (!owners.some((s) => s.touches.some((re) => re.test(p))))
        findings.push({
          code: "OUTSIDE_TOUCHES",
          subject: p,
          reason: `matches no touches glob of ${owners.map((s) => s.id).join(", ")}, whose feature directory '${dir || "."}' holds it`,
        });
    } else {
      const owners = specs.filter((s) => s.handler === p);
      if (owners.length > 0)
        findings.push({
          code: "HANDLER_OUTSIDE_FEATURE",
          subject: p,
          reason: `is the handler at path of ${owners.map((s) => s.id).join(", ")} and lies inside no feature directory`,
        });
    }
  }
  if (findings.length > 0) return refuse(findings);

  return {
    status: "OK",
    body: { workspaces: workspaces.length, specs: specs.length, checked: paths.length, specd, unspecd: paths.length - specd },
  };
}

export interface ChangedPathsInput {
  cwd: string;
  base: string;
  git?: string;
  env?: Record<string, string>;
}

// The program's absolute path, looked up on PATH once per process. Spawning a bare name makes libuv try one
// posix_spawn per PATH entry on macOS, about half a second under a package manager's long PATH, and seconds on a
// loaded host; changedPaths runs git six times. A name holding a separator, or found on no entry, is used as given,
// so a program that does not exist still fails to start (GIT_UNAVAILABLE).
const resolved = new Map<string, string>();
export function resolveProgram(name: string, envPath: string | undefined = process.env.PATH): string {
  if (name.includes("/") || name.includes("\\")) return name;
  const key = `${name}\0${envPath ?? ""}`;
  const hit = resolved.get(key);
  if (hit) return hit;
  let found = name;
  for (const dir of (envPath ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of process.platform === "win32" ? [`${name}.exe`, `${name}.cmd`, name] : [name]) {
      const p = path.join(dir, candidate);
      try {
        accessSync(p, constants.X_OK);
        if (statSync(p).isFile()) {
          found = p;
          break;
        }
      } catch {
        // not here
      }
    }
    if (found !== name) break;
  }
  resolved.set(key, found);
  return found;
}

function readRefusal(code: string, subject: string, reason: string): CapturedResponse {
  return { status: "ERR", body: { code, detail: `${code}: ${subject}: ${reason}` } };
}

export async function changedPaths(input: ChangedPathsInput): Promise<CapturedResponse> {
  const git = input.git ?? "git";
  // GIT_OPTIONAL_LOCKS=0: a read never takes the index lock to refresh stat data, so the gate writes nothing.
  const env: NodeJS.ProcessEnv = { ...process.env, ...(input.env ?? {}), GIT_OPTIONAL_LOCKS: "0" };
  const program = resolveProgram(git, env.PATH);
  // Asynchronous, so a caller's event loop is never held while git runs.
  const run = (args: string[]) =>
    new Promise<{ error?: NodeJS.ErrnoException; status: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(program, args, { cwd: input.cwd, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        // A program that cannot start fails with a string errno code; a git that ran and exited non-zero has a number.
        if (e && typeof e.code === "string") resolve({ error: e, status: null, stdout, stderr });
        else resolve({ status: e ? Number(e.code ?? 1) : 0, stdout, stderr });
      });
    });

  // Every command reads, and none needs another's answer, so all run at once from cwd; the answers are then read in
  // the refusal order. `<base>...HEAD` is the diff from the merge base of <base> and HEAD. Paths are root-relative
  // whatever cwd is: --no-relative for the diffs, --full-name and the `:/` (top level) pathspec for ls-files.
  const [top, verify, mb, committed, worktree, untracked] = await Promise.all([
    run(["rev-parse", "--show-toplevel"]),
    run(["rev-parse", "--verify", "--quiet", `${input.base}^{commit}`]),
    run(["merge-base", input.base, "HEAD"]),
    run(["diff", "-z", "--name-only", "--no-relative", "--no-renames", `${input.base}...HEAD`]),
    run(["diff", "-z", "--name-only", "--no-relative", "--no-renames", "HEAD"]),
    run(["ls-files", "-z", "--others", "--exclude-standard", "--full-name", ":/"]),
  ]);
  if (top.error)
    return readRefusal("GIT_UNAVAILABLE", git, `cannot be started (${top.error.code ?? top.error.message})`);
  if (top.status !== 0) return readRefusal("NOT_A_GIT_REPO", input.cwd, "is in no git repository");
  const root = top.stdout.replace(/\r?\n$/, "");
  if (verify.status !== 0) return readRefusal("BASE_NOT_FOUND", input.base, "names no commit");
  if (mb.status !== 0)
    return readRefusal(
      "NO_MERGE_BASE",
      input.base,
      `${input.base} and HEAD share no commit, as in a shallow clone; fetch the full history (git fetch --unshallow, or a checkout with fetch-depth 0)`,
    );

  const paths = new Set<string>();
  for (const [what, r] of [["the committed diff", committed], ["the working tree diff", worktree], ["the untracked files", untracked]] as const) {
    if (r.status !== 0) throw new Error(`git could not list ${what} (exit ${r.status}): ${r.stderr.trim()}`);
    for (const p of r.stdout.split("\0")) if (p !== "") paths.add(p);
  }
  return { status: "OK", body: { root, paths: [...paths].sort(byCodeUnit) } };
}
