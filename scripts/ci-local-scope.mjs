#!/usr/bin/env node
// What a scoped check covers (founder ruling 2026-11-17, adopting flmnt's inner loop for Feature): the workspace
// packages a change touches plus every package that depends on them, at every tier the gate runs for them. A change
// to a shared root (the lockfile, the build and test configuration, the CI scripts, the language's schemas and
// corpus) widens to the full gate. A change that maps to nothing the gate runs is refused, never passed: a check
// that can pass on zero work is broken by construction.
//
// usage: node ci-local-scope.mjs --repo <dir> --base <ref> --head <ref>
// stdout: one JSON object
//   {"mode":"full","why":"..."}                                   run the full gate
//   {"mode":"none","why":"...","paths":[...]}                     refuse: nothing in scope
//   {"mode":"scoped","changed":[...],"packages":[...],"dirs":[...],"allSpecs":bool,"corpus":bool}
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A change here can affect anything the gate runs: the full gate.
const SHARED_ROOTS = [
  /^pnpm-lock\.yaml$/, /^package\.json$/, /^pnpm-workspace\.yaml$/, /^turbo\.json$/, /^tsconfig\.base\.json$/,
  /^vitest\.config\.ts$/, /^feat\.config\.json$/, /^feat\.integration\.config\.json$/, /^\.tool-versions$/,
  /^\.npmrc$/, /^\.github\//, /^\.githooks\//, /^scripts\//, /^schemas\//, /^corpus\//, /^docs\/grammar-reference\.md$/,
];
// Paths no gate step reads: a change only here leaves nothing to check.
const UNCHECKED = [/^docs\//, /^drafts\//, /^README\.md$/, /^CLAUDE\.md$/, /^LICENSE$/, /^\.gitignore$/];
// Every generated suite imports these, wherever its spec lives: a change to one runs every spec.
const TOOLCHAIN = new Set([
  "@mmmnt/feat-types", "@mmmnt/feat-runtime", "@mmmnt/feat-core", "@mmmnt/feat-derive", "@mmmnt/feat-emit-ts",
  "@mmmnt/feat-runner", "@mmmnt/feature", "@mmmnt/feat-grammar", "@mmmnt/feat-adapter-kit",
]);
// The corpus is the parser's ground truth: validated when the language packages change.
const LANGUAGE = new Set(["@mmmnt/feat-types", "@mmmnt/feat-core", "@mmmnt/feat-grammar"]);

function args(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i], v = argv[i + 1];
    if (!["--repo", "--base", "--head"].includes(k) || v === undefined) throw new Error(`ci-local-scope: bad option ${k}`);
    a[k.slice(2)] = v;
  }
  for (const k of ["repo", "base", "head"]) if (!a[k]) throw new Error(`ci-local-scope: --${k} is required`);
  return a;
}

export function workspace(repo) {
  const pkgs = [];
  for (const group of ["packages", "adapters"]) {
    const dir = path.join(repo, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const pj = path.join(dir, name, "package.json");
      if (!existsSync(pj)) continue;
      const p = JSON.parse(readFileSync(pj, "utf8"));
      const deps = new Set(Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies, ...p.optionalDependencies }));
      pkgs.push({ name: p.name, dir: `${group}/${name}`, deps });
    }
  }
  return pkgs;
}

// changed: repo-relative paths; pkgs: workspace(). Pure, so it is tested without git.
export function scope(changed, pkgs) {
  if (changed.length === 0) return { mode: "none", why: "no file changed", paths: [] };
  const shared = changed.find((f) => SHARED_ROOTS.some((r) => r.test(f)));
  if (shared) return { mode: "full", why: `${shared} is a shared root` };
  const touched = new Set();
  const unchecked = [];
  for (const f of changed) {
    const p = pkgs.find((k) => f === k.dir || f.startsWith(`${k.dir}/`));
    if (p) touched.add(p.name);
    else if (UNCHECKED.some((r) => r.test(f))) unchecked.push(f);
    else return { mode: "full", why: `${f} belongs to no package and is not a known unchecked path` };
  }
  if (touched.size === 0) return { mode: "none", why: "only paths no gate step reads changed", paths: unchecked };
  // Dependents, transitively.
  const affected = new Set(touched);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of pkgs) if (!affected.has(p.name) && [...p.deps].some((d) => affected.has(d))) { affected.add(p.name); grew = true; }
  }
  const list = pkgs.filter((p) => affected.has(p.name));
  return {
    mode: "scoped",
    changed,
    packages: list.map((p) => p.name).sort(),
    dirs: list.map((p) => p.dir).sort(),
    allSpecs: list.some((p) => TOOLCHAIN.has(p.name)),
    corpus: list.some((p) => LANGUAGE.has(p.name)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const a = args(process.argv.slice(2));
    const out = execFileSync("git", ["-C", a.repo, "diff", "--name-only", `${a.base}`, `${a.head}`], { encoding: "utf8" });
    const changed = out.split("\n").filter(Boolean);
    process.stdout.write(JSON.stringify(scope(changed, workspace(a.repo))) + "\n");
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exit(2);
  }
}
