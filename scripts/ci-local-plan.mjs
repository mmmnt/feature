#!/usr/bin/env node
// Reads .github/workflows/ci.yml and writes, for every ubuntu job x matrix entry, a driver script that runs the
// job's `run:` steps in order with GitHub's step semantics. scripts/ci-local.sh runs each driver in a container.
// The jobs are derived from the workflow, never listed here, so the local run cannot drift from CI. Anything in
// the workflow this planner does not understand is an error, not a silent skip.
//
// usage: node ci-local-plan.mjs --workflow <ci.yml> --package <package.json> --images <images.json> --out <dir>
//                               [--job <id|name>]... [--node <major>]...
// stdout, one line per job instance:  JOB<TAB>key<TAB>node<TAB>image<TAB>name<TAB>driver
//                       per gap:      GAP<TAB>key<TAB>runs-on<TAB>name
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");

// js-yaml is in the dependency graph through the Kafka adapter's client (pnpm-lock: js-yaml 4.3.2). It is not
// hoisted, so resolve it along that chain from this script's own checkout.
function loadYaml() {
  const chain = [path.join(REPO, "adapters/kafka/package.json"), "@confluentinc/kafka-javascript/package.json", "js-yaml"];
  try {
    let req = createRequire(chain[0]);
    req = createRequire(req.resolve(chain[1]));
    return req(chain[2]);
  } catch (e) {
    throw new Error(`ci-local: cannot load js-yaml via ${chain.join(" -> ")} (run pnpm install in ${REPO}): ${e.message}`);
  }
}

function parseArgs(argv) {
  const a = { job: [], node: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[++i];
    if (v === undefined) throw new Error(`ci-local: ${k} needs a value`);
    if (k === "--job") a.job.push(v);
    else if (k === "--node") a.node.push(String(v));
    else if (["--workflow", "--package", "--images", "--out"].includes(k)) a[k.slice(2)] = v;
    else throw new Error(`ci-local: unknown option ${k}`);
  }
  for (const k of ["workflow", "package", "images", "out"]) if (!a[k]) throw new Error(`ci-local: --${k} is required`);
  return a;
}

// ---- expressions: the subset of GitHub's expression language, evaluated against matrix values and a job status.
function tokenize(src) {
  const toks = [];
  const re = /\s*(?:(\(|\)|==|!=|&&|\|\||!)|('(?:[^']|'')*')|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*))/y;
  let m;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    const at = re.lastIndex;
    if (!(m = re.exec(src))) throw new Error(`ci-local: cannot read expression "${src}" at ${at}`);
    if (m[1]) toks.push({ t: "op", v: m[1] });
    else if (m[2]) toks.push({ t: "lit", v: m[2].slice(1, -1).replace(/''/g, "'") });
    else if (m[3]) toks.push({ t: "lit", v: Number(m[3]) });
    else toks.push({ t: "id", v: m[4] });
  }
  return toks;
}

function evaluate(src, ctx) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const eat = (v) => {
    const t = toks[i];
    if (!t || t.v !== v) throw new Error(`ci-local: expected "${v}" in "${src}"`);
    i++;
  };
  const coerce = (x) => (typeof x === "string" && x.trim() !== "" && !Number.isNaN(Number(x)) ? Number(x) : x);
  function primary() {
    const t = toks[i++];
    if (!t) throw new Error(`ci-local: unexpected end of "${src}"`);
    if (t.t === "lit") return t.v;
    if (t.v === "(") { const v = or(); eat(")"); return v; }
    if (t.v === "!") return !primary();
    if (t.t === "id") {
      if (peek()?.v === "(") {
        eat("(");
        eat(")");
        if (t.v === "always") return true;
        if (t.v === "success") return ctx.status === "success";
        if (t.v === "failure") return ctx.status === "failure";
        if (t.v === "cancelled") return false;
        throw new Error(`ci-local: function ${t.v}() is not supported ("${src}")`);
      }
      if (t.v === "true") return true;
      if (t.v === "false") return false;
      const [scope, ...rest] = t.v.split(".");
      if (scope === "matrix" && rest.length === 1) {
        if (!(rest[0] in ctx.matrix)) throw new Error(`ci-local: matrix.${rest[0]} is not in the matrix ("${src}")`);
        return ctx.matrix[rest[0]];
      }
      throw new Error(`ci-local: "${t.v}" is not supported locally ("${src}")`);
    }
    throw new Error(`ci-local: unexpected "${t.v}" in "${src}"`);
  }
  function cmp() {
    let l = primary();
    while (peek()?.v === "==" || peek()?.v === "!=") {
      const op = toks[i++].v;
      const r = primary();
      const eq = coerce(l) === coerce(r);
      l = op === "==" ? eq : !eq;
    }
    return l;
  }
  function and() { let l = cmp(); while (peek()?.v === "&&") { i++; const r = cmp(); l = l && r; } return l; }
  function or() { let l = and(); while (peek()?.v === "||") { i++; const r = and(); l = l || r; } return l; }
  const v = or();
  if (i !== toks.length) throw new Error(`ci-local: trailing input in "${src}"`);
  return v;
}

const stripWrapper = (s) => String(s).trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
const usesStatus = (s) => /\b(always|success|failure|cancelled)\s*\(/.test(s);
// A step's `if:` as two booleans: does it run when every earlier step passed, and when one failed.
function condition(ifExpr, matrix) {
  if (ifExpr === undefined) return { onSuccess: true, onFailure: false };
  const src = stripWrapper(ifExpr);
  // GitHub wraps a condition with no status function in success() && (...).
  const full = usesStatus(src) ? src : `success() && (${src})`;
  return {
    onSuccess: Boolean(evaluate(full, { matrix, status: "success" })),
    onFailure: Boolean(evaluate(full, { matrix, status: "failure" })),
  };
}

// ${{ matrix.x }} in names and run scripts; any other ${{ }} is refused.
function interpolate(s, matrix, where) {
  return String(s).replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => {
    const m = /^\s*matrix\.([A-Za-z_][A-Za-z0-9_-]*)\s*$/.exec(e);
    if (!m || !(m[1] in matrix)) throw new Error(`ci-local: ${where}: expression \${{${e}}} is not supported locally`);
    return String(matrix[m[1]]);
  });
}

function expandMatrix(job, key) {
  const m = job.strategy?.matrix;
  if (m === undefined) return [{}];
  if (typeof m !== "object" || Array.isArray(m)) throw new Error(`ci-local: job ${key}: matrix must be a mapping`);
  for (const k of Object.keys(m)) {
    if (k === "include" || k === "exclude") throw new Error(`ci-local: job ${key}: matrix ${k} is not supported locally`);
    if (!Array.isArray(m[k])) throw new Error(`ci-local: job ${key}: matrix.${k} must be a list`);
  }
  let out = [{}];
  for (const [k, vals] of Object.entries(m)) out = out.flatMap((o) => vals.map((v) => ({ ...o, [k]: v })));
  return out;
}

// `uses:` steps the container replaces: the source is already extracted, Node is the image's, pnpm is installed
// from package.json's packageManager (what pnpm/action-setup reads), and upload-artifact has nowhere to upload.
const REPLACED = {
  "actions/checkout": "source = git archive of the commit, extracted fresh for this job",
  "pnpm/action-setup": "npm i -g pnpm@<packageManager>",
  "actions/setup-node": "the image's Node",
  "actions/upload-artifact": "no artifact store locally; the files stay in the job's tree until it is removed",
};

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function main() {
  const args = parseArgs(process.argv.slice(2));
  const yaml = loadYaml();
  const wf = yaml.load(readFileSync(args.workflow, "utf8"));
  const pkg = JSON.parse(readFileSync(args.package, "utf8"));
  const images = JSON.parse(readFileSync(args.images, "utf8"));
  const pm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager ?? "");
  if (!pm) throw new Error(`ci-local: package.json packageManager "${pkg.packageManager}" is not pnpm@x.y.z`);
  for (const k of ["env", "defaults"]) if (wf[k] !== undefined) throw new Error(`ci-local: workflow-level ${k} is not supported locally`);

  const lines = [];
  const known = new Set();
  for (const [key, job] of Object.entries(wf.jobs ?? {})) {
    known.add(key);
    if (job.name) known.add(String(job.name).replace(/\s*\(.*\)\s*$/, ""));
    const jobPicked = args.job.length === 0 || args.job.some((j) => j === key || String(job.name ?? "").startsWith(j));
    const runsOn = String(job["runs-on"] ?? "");
    if (!/^ubuntu-/.test(runsOn)) {
      const nodes = expandMatrix(job, key).map((matrix) => {
        const setup = (job.steps ?? []).find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/setup-node@"));
        return setup?.with?.["node-version"] === undefined ? undefined : interpolate(setup.with["node-version"], matrix, `job ${key}`);
      });
      const nodePicked = args.node.length === 0 || nodes.some((v) => v === undefined || args.node.includes(v));
      if (jobPicked && nodePicked) lines.push(["GAP", key, runsOn, job.name ?? key].join("\t"));
      continue;
    }
    for (const k of ["env", "defaults", "container", "services"]) {
      if (job[k] !== undefined) throw new Error(`ci-local: job ${key}: ${k} is not supported locally`);
    }
    if (!jobPicked) continue;
    for (const matrix of expandMatrix(job, key)) {
      const name = interpolate(job.name ?? key, matrix, `job ${key} name`);
      const setup = (job.steps ?? []).find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/setup-node@"));
      if (!setup?.with?.["node-version"]) throw new Error(`ci-local: job ${key}: no actions/setup-node node-version`);
      const node = interpolate(setup.with["node-version"], matrix, `job ${key} node-version`);
      if (!/^\d+$/.test(node)) throw new Error(`ci-local: job ${key}: node-version "${node}" is not a major version`);
      if (args.node.length > 0 && !args.node.includes(node)) continue;
      const image = images.node?.[node];
      if (!image) throw new Error(`ci-local: no pinned image for Node ${node} in ${args.images}`);

      const dir = path.join(args.out, `${key}-${node}`);
      mkdirSync(dir, { recursive: true });
      const d = [
        "#!/usr/bin/env bash",
        `# Generated by scripts/ci-local-plan.mjs from ${path.basename(args.workflow)}: job ${key}, ${JSON.stringify(matrix)}.`,
        "set -uo pipefail",
        "failed=0",
        "say() { printf '\\n::ci-local:: %s\\n' \"$*\"; }",
        "step() { # idx onSuccess onFailure name shell file [workdir]",
        "  local idx=$1 ok=$2 ko=$3 name=$4 sh=$5 file=$6 wd=${7:-.} run=$2 rc t0",
        "  [ \"$failed\" = 1 ] && run=$ko",
        "  if [ \"$run\" != 1 ]; then say \"step $idx SKIP (if:) $name\"; return 0; fi",
        "  say \"step $idx RUN $name\"; t0=$(date +%s)",
        "  ( cd \"$wd\" && $sh \"$file\" ); rc=$?",
        "  say \"step $idx rc=$rc $(( $(date +%s) - t0 ))s $name\"",
        "  [ \"$rc\" = 0 ] || failed=1",
        "}",
        `say "job ${key} (${name}) on $(node -v) in $(pwd)"`,
      ];
      let n = 0;
      for (const s of job.steps ?? []) {
        n++;
        const idx = String(n).padStart(2, "0");
        if (s.uses !== undefined) {
          const action = String(s.uses).split("@")[0];
          if (!(action in REPLACED)) throw new Error(`ci-local: job ${key}: step uses ${s.uses}, which ci-local cannot replace`);
          if (action === "pnpm/action-setup") {
            d.push(`say "step ${idx} USES ${s.uses} -> npm i -g pnpm@${pm[1]}"`);
            d.push(`npm i -g --no-audit --no-fund pnpm@${pm[1]} >/dev/null || { say "pnpm@${pm[1]} install failed"; exit 1; }`);
          } else {
            d.push(`say ${shq(`step ${idx} USES ${s.uses} -> ${REPLACED[action]}`)}`);
          }
          continue;
        }
        if (s.run === undefined) throw new Error(`ci-local: job ${key}: step ${n} has neither run nor uses`);
        for (const k of Object.keys(s)) {
          if (!["name", "run", "if", "shell", "working-directory", "env", "id"].includes(k)) {
            throw new Error(`ci-local: job ${key}: step ${n} key "${k}" is not supported locally`);
          }
        }
        const stepName = interpolate(s.name ?? s.run.split("\n")[0], matrix, `job ${key} step ${n} name`);
        const { onSuccess, onFailure } = condition(s.if, matrix);
        // GitHub's ubuntu default is `bash -e {0}`; an explicit `shell: bash` is `bash --noprofile --norc -eo pipefail {0}`.
        let shell;
        if (s.shell === undefined) shell = "bash -e";
        else if (s.shell === "bash") shell = "bash --noprofile --norc -eo pipefail";
        else if (s.shell === "sh") shell = "sh -e";
        else throw new Error(`ci-local: job ${key}: step ${n} shell "${s.shell}" is not supported locally`);
        const file = path.join(dir, `step-${idx}.sh`);
        const env = Object.entries(s.env ?? {}).map(([k, v]) => `export ${k}=${shq(interpolate(v, matrix, `job ${key} step ${n} env`))}`);
        writeFileSync(file, [...env, interpolate(s.run, matrix, `job ${key} step ${n} run`), ""].join("\n"));
        const wd = s["working-directory"] ? shq(interpolate(s["working-directory"], matrix, `job ${key} step ${n}`)) : "";
        d.push(`step ${idx} ${onSuccess ? 1 : 0} ${onFailure ? 1 : 0} ${shq(stepName)} ${shq(shell)} ${shq(file)} ${wd}`.trimEnd());
      }
      d.push('say "job result failed=$failed"', 'exit "$failed"', "");
      const driver = path.join(dir, "job.sh");
      writeFileSync(driver, d.join("\n"), { mode: 0o755 });
      lines.push(["JOB", key, node, image, name, driver].join("\t"));
    }
  }
  for (const j of args.job) {
    if (![...known].some((k) => k === j || k.startsWith(j))) throw new Error(`ci-local: --job ${j} matches no job in ${args.workflow}`);
  }
  if (!lines.some((l) => l.startsWith("JOB\t")) && !lines.some((l) => l.startsWith("GAP\t"))) {
    throw new Error("ci-local: the filters select no job");
  }
  process.stdout.write(lines.join("\n") + "\n");
}

try {
  main();
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exit(2);
}
