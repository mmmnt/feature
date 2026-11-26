// @mmmnt/feat-runner — thin subprocess orchestrator (GAP-D09, ADR-0001).
// Generated tests own their lifecycle; the runner spawns `vitest run`, passes
// through the exit code, and points reporters at the configured outputs.
//
// The vitest it spawns is the project's own, resolved from the root and run
// with this Node (SPEC-RT-010, ADR-0026). It never runs npx, npm exec or
// pnpm dlx, which fetch a missing package from the registry at run time,
// outside the project's lockfile; a project without vitest is refused.
//
// The runner OWNS test selection: it writes a run config that extends the
// project's own vitest config (coverage settings survive) but forces
// `include` to exactly the generated files and makes an empty run FATAL. A
// consumer vitest config scoped to its unit layer must never silently eat
// generated suites — a run that collects zero of them is a failure, loudly.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlan, runPlanAsync, type Plan } from "./plan.js";

export { faultsOf, plan, runPlan, runPlanAsync } from "./plan.js";
export type { Plan, PlannedSpec, SweptCase } from "./plan.js";

export interface RunOptions {
  /** Generated test files to execute (repo-root-relative). */
  files: string[];
  /** Project root (where feat.config.json lives). */
  root: string;
  /** Write a JUnit XML report to this path (root-relative), if set. */
  junitOutput?: string;
  /** Write the runner's JSON results to this path (root-relative), if set. */
  jsonOutput?: string;
  /** Collect coverage via the test runner's coverage provider. */
  coverage?: boolean;
  /** Suppress the runner's console output (machine-consumption mode). */
  quiet?: boolean;
  /**
   * Files (a subset of `files`) that arm an exclusive fault (SPEC-RT-005): they run in a second vitest
   * invocation with one worker and FEAT_SERIAL=1, after the rest; the report merges both passes.
   */
  serialFiles?: string[];
  /** Per-test and hook timeouts, computed by the caller from the ACTIVE config (ADR-0024). */
  testTimeoutMs?: number;
  hookTimeoutMs?: number;
  /** Absolute path of the active config; handed to the generated suites as FEAT_CONFIG. */
  configPath?: string;
}

export interface RunResult {
  exitCode: number;
  /** Set when the runner refused to run before any pass (SPEC-RT-010): exitCode is 2 and configurationError true. */
  refusal?: RunnerRefusal;
  /** True when a failure was a harness configuration error (message "Configuration error (exit 2): …"): the caller exits 2. */
  configurationError?: boolean;
  junitPath?: string;
  jsonPath?: string;
}

/** The runner's own refusals, each a configuration error (exit 2). */
export type RunnerRefusalCode = "VITEST_NOT_INSTALLED";

export interface RunnerRefusal {
  code: RunnerRefusalCode;
  /** The full line, `Configuration error (exit 2): [CODE] ...`, as printed to stderr. */
  message: string;
}

/** Thrown by resolveVitest when the project has no vitest (SPEC-RT-010). */
export class VitestNotInstalledError extends Error {
  public readonly code = "VITEST_NOT_INSTALLED" as const;
  constructor(root: string, cause?: string) {
    super(
      `Configuration error (exit 2): [VITEST_NOT_INSTALLED] vitest is not installed in the project at ${root}` +
        `${cause ? ` (${cause})` : ""}. feat run runs the project's own vitest and never fetches one; ` +
        `add vitest as a dev dependency of the project (for example \`npm install --save-dev vitest\`, ` +
        `\`pnpm add -D vitest\`), then run again.`,
    );
    this.name = "VitestNotInstalledError";
  }
}

export interface ResolvedVitest {
  /** Absolute path of vitest's CLI entry (its package.json `bin`). */
  bin: string;
  /** The installed vitest's version. */
  version: string;
}

/**
 * The project's own vitest: the first `node_modules/vitest/package.json` found from `root` upward, as an
 * ES module import from a file at `root` finds it, and the file its `bin` names. Throws
 * VitestNotInstalledError when vitest does not resolve or names no bin. Nothing is fetched (SPEC-RT-010).
 */
export function resolveVitest(root: string): ResolvedVitest {
  // The node_modules directories an `import "vitest"` from a file at root searches: root's, then each parent's.
  // Not NODE_PATH or the global folders, which an ES module import (a generated suite's) never reads.
  let manifestPath: string | undefined;
  for (let dir = path.resolve(root); manifestPath === undefined; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", "vitest", "package.json");
    if (existsSync(candidate)) manifestPath = candidate;
    else if (path.dirname(dir) === dir) throw new VitestNotInstalledError(root);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string; bin?: string | Record<string, string> };
  const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (rel === undefined) throw new VitestNotInstalledError(root, `${manifestPath} names no vitest bin`);
  const bin = path.resolve(path.dirname(manifestPath), rel);
  if (!existsSync(bin)) throw new VitestNotInstalledError(root, `${bin} does not exist`);
  return { bin, version: manifest.version ?? "" };
}

const CONSUMER_CONFIGS = ["vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs"];

/**
 * The runner's vitest config source: statically extends the project config
 * when one exists (static import — vitest's config bundler handles TS), then
 * overrides test selection. Exported for unit testing.
 */
export function runConfigSource(
  root: string,
  absFiles: string[],
  timeouts: { testTimeoutMs?: number; hookTimeoutMs?: number } = {},
): string {
  const consumer = CONSUMER_CONFIGS.map((f) => path.join(root, f)).find((f) => existsSync(f));
  const globs = absFiles.map((f) => f.split(path.sep).join("/"));
  const lines = [
    "// Written by @mmmnt/feat-runner for a single `feat run` — not yours to edit.",
    ...(consumer ? [`import base from ${JSON.stringify(consumer.split(path.sep).join("/"))};`] : ["const base = {};"]),
    'const resolved = typeof base === "function" ? await base({ command: "serve", mode: "test" }) : base;',
    "export default {",
    "  ...resolved,",
    "  test: {",
    "    ...(resolved.test ?? {}),",
    `    include: ${JSON.stringify(globs)},`,
    "    passWithNoTests: false,",
    ...(timeouts.testTimeoutMs !== undefined ? [`    testTimeout: ${timeouts.testTimeoutMs},`] : []),
    ...(timeouts.hookTimeoutMs !== undefined ? [`    hookTimeout: ${timeouts.hookTimeoutMs},`] : []),
    "  },",
    "};",
    "",
  ];
  return lines.join("\n");
}

/** Merge two vitest JUnit reports: the counts add, every suite is kept (SPEC-RT-005). */
export function mergeJunit(a: string, b: string): string {
  const head = /<testsuites\b([^>]*)>/;
  const attr = (xml: string, name: string): number => Number(new RegExp(`\\b${name}="([^"]*)"`).exec(head.exec(xml)?.[1] ?? "")?.[1] ?? 0);
  const inner = (xml: string): string => xml.slice(xml.indexOf(">", xml.search(head)) + 1, xml.lastIndexOf("</testsuites>"));
  let attrs = head.exec(a)?.[1] ?? "";
  for (const name of ["tests", "failures", "errors", "time"]) {
    const sum = attr(a, name) + attr(b, name);
    const value = name === "time" ? String(Math.round(sum * 1000) / 1000) : String(sum);
    attrs = new RegExp(`\\b${name}="`).test(attrs) ? attrs.replace(new RegExp(`\\b${name}="[^"]*"`), `${name}="${value}"`) : `${attrs} ${name}="${value}"`;
  }
  const prolog = a.slice(0, a.search(head));
  return `${prolog}<testsuites${attrs}>${inner(a)}${inner(b)}</testsuites>\n`;
}

/** What every pass of one run shares: the plan, the resolved vitest and where the reports go. */
interface PreparedRun {
  vitest: ResolvedVitest;
  plan: Plan;
  parallelFiles: string[];
  junitMain: string | undefined;
  first: { ran?: boolean };
  seen: { configurationError: boolean };
}

/** The zero-files and vitest checks, then the plan; a RunResult when the run is refused before any pass. */
function prepareRun(opts: RunOptions): PreparedRun | RunResult {
  if (opts.files.length === 0) {
    console.error("feat-runner: zero generated test files to execute — refusing a silently empty run.");
    return { exitCode: 1 };
  }
  // Resolved once, before any pass writes or spawns anything: a missing vitest is refused, never fetched.
  let vitest: ResolvedVitest;
  try {
    vitest = resolveVitest(opts.root);
  } catch (e) {
    if (!(e instanceof VitestNotInstalledError)) throw e;
    console.error(e.message);
    return { exitCode: 2, configurationError: true, refusal: { code: e.code, message: e.message } };
  }
  const serial = new Set(opts.serialFiles ?? []);
  const serialFiles = opts.files.filter((f) => serial.has(f));
  const parallelFiles = opts.files.filter((f) => !serial.has(f));
  const p: Plan = {
    parallel: parallelFiles,
    serial: serialFiles,
    order: serialFiles.length === 0 ? "parallel" : parallelFiles.length === 0 ? "serial" : "parallel then serial",
    serialWorkers: serialFiles.length > 0 ? 1 : 0,
  };
  const junitMain = opts.junitOutput !== undefined ? path.resolve(opts.root, opts.junitOutput) : undefined;
  return { vitest, plan: p, parallelFiles, junitMain, first: {}, seen: { configurationError: false } };
}

/** One pass's spawn: the vitest command line, its working directory and environment, and the marker it may write. */
function passFor(opts: RunOptions, run: PreparedRun, files: string[], serial: boolean): PassSpawn {
  // The serial pass writes beside the main report when a parallel pass already wrote it; merged in finishRun.
  const writesSeparately = serial && run.first.ran === true && run.junitMain !== undefined;
  const junit = run.junitMain === undefined ? undefined : writesSeparately ? `${run.junitMain}.serial` : run.junitMain;
  run.first.ran = true;
  // The JSON report is the main pass's: the parallel pass, or the serial pass when it is the only one.
  return passSpawn(opts, run.vitest, files, serial, junit, !serial || run.parallelFiles.length === 0);
}

/** After a pass: a configuration error is told from a failed test by the marker the reporter writes. */
function afterPass(run: PreparedRun, pass: PassSpawn, status: number | null): number {
  if (existsSync(pass.markerPath)) run.seen.configurationError = true;
  return status ?? 1;
}

function finishRun(opts: RunOptions, run: PreparedRun, result: { exitCode: number }): RunResult {
  const { junitMain, seen } = run;
  if (junitMain !== undefined && existsSync(`${junitMain}.serial`)) {
    writeFileSync(junitMain, mergeJunit(readFileSync(junitMain, "utf8"), readFileSync(`${junitMain}.serial`, "utf8")));
    rmSync(`${junitMain}.serial`, { force: true });
  }
  const out: RunResult = { exitCode: result.exitCode };
  if (seen.configurationError) out.configurationError = true;
  if (junitMain !== undefined) out.junitPath = junitMain;
  if (opts.jsonOutput !== undefined) out.jsonPath = path.resolve(opts.root, opts.jsonOutput);
  return out;
}

/**
 * Run the generated suites: one vitest pass, or a parallel pass then a serial one (SPEC-RT-005). It blocks until
 * vitest exits (spawnSync), which suits a CLI. A caller that must keep its event loop turning, a test running
 * inside a vitest worker above all, uses runTestsAsync.
 */
export function runTests(opts: RunOptions): RunResult {
  const run = prepareRun(opts);
  if (!("plan" in run)) return run;
  const result = runPlan(run.plan, (files, pass) => {
    const spawned = passFor(opts, run, files, pass.serial);
    return afterPass(run, spawned, spawnSync(process.execPath, spawned.args, spawned.options).status);
  });
  return finishRun(opts, run, result);
}

/**
 * runTests with the same passes, reports and result, without blocking the caller: each pass is awaited, so the
 * caller's event loop keeps turning while vitest runs. A vitest worker that blocks for 60 s misses vitest's RPC
 * timeout ("Timeout calling onTaskUpdate"), and a nested vitest run takes that long under load.
 */
export async function runTestsAsync(opts: RunOptions): Promise<RunResult> {
  const run = prepareRun(opts);
  if (!("plan" in run)) return run;
  const result = await runPlanAsync(run.plan, async (files, pass) => {
    const spawned = passFor(opts, run, files, pass.serial);
    const status = await new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, spawned.args, spawned.options);
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code));
    });
    return afterPass(run, spawned, status);
  });
  return finishRun(opts, run, result);
}

/**
 * A vitest reporter that records a harness configuration error. The JSON reporter drops a failed hook's
 * error (a suite whose createHarness threw has only skipped tests), so the reporter reads the reported tree:
 * module, suite and test errors alike, at any depth, and the run's unhandled errors. It writes the marker
 * named by FEAT_CONFIG_ERROR_MARKER.
 *
 * It implements `onTestRunEnd` only (SPEC-RT-010): vitest 4 and 5 no longer call a reporter's `onFinished`,
 * and 3.2 calls `onTestRunEnd` too, so one hook is one code path on every version the peer range admits.
 */
export const CONFIG_ERROR_REPORTER_SOURCE = [
  'import { writeFileSync } from "node:fs";',
  "const isConfigError = (e) => /Configuration error \\(exit 2\\):/.test(String(e?.message));",
  // A module and a suite answer errors(); a test answers result().errors.
  'const errorsOf = (t) => (typeof t.errors === "function" ? t.errors() : typeof t.result === "function" ? t.result()?.errors : undefined) ?? [];',
  "const hit = (t) => errorsOf(t).some(isConfigError) || Array.from(t.children ?? []).some(hit);",
  "export default class FeatConfigErrorReporter {",
  "  onTestRunEnd(testModules = [], unhandledErrors = []) {",
  "    if (testModules.some(hit) || unhandledErrors.some(isConfigError)) {",
  '      writeFileSync(process.env.FEAT_CONFIG_ERROR_MARKER, "1");',
  "    }",
  "  }",
  "}",
  "",
].join("\n");

interface PassSpawn {
  args: string[];
  options: { cwd: string; stdio: "ignore" | "inherit"; env: NodeJS.ProcessEnv };
  markerPath: string;
}

function passSpawn(opts: RunOptions, vitest: ResolvedVitest, files: string[], serial: boolean, junitAbs: string | undefined, writesJson: boolean): PassSpawn {
  const absFiles = files.map((f) => path.resolve(opts.root, f));
  // Lives under node_modules/.cache so `vitest/config` and the consumer's own
  // imports resolve exactly as they would from the project root.
  const configPath = path.join(opts.root, "node_modules", ".cache", "feat", "feat-run.vitest.config.mjs");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(
    configPath,
    runConfigSource(opts.root, absFiles, {
      ...(opts.testTimeoutMs !== undefined ? { testTimeoutMs: opts.testTimeoutMs } : {}),
      ...(opts.hookTimeoutMs !== undefined ? { hookTimeoutMs: opts.hookTimeoutMs } : {}),
    }),
  );

  // A configuration error is told from a failed test by a reporter that marks it (see above).
  const reporterPath = path.join(path.dirname(configPath), "feat-run.config-error-reporter.mjs");
  const markerPath = path.join(path.dirname(configPath), serial ? "feat-run.serial.config-error" : "feat-run.config-error");
  writeFileSync(reporterPath, CONFIG_ERROR_REPORTER_SOURCE);
  rmSync(markerPath, { force: true });

  const args = [vitest.bin, "run", "--config", configPath, `--reporter=${reporterPath}`];
  if (serial) args.push("--no-file-parallelism", "--maxWorkers=1");
  if (!opts.quiet) args.push("--reporter=default");
  if (opts.coverage) args.push("--coverage");
  // With multiple file-writing reporters vitest needs the dotted outputFile form.
  const outputs: [string, string][] = [];
  if (junitAbs !== undefined) outputs.push(["junit", junitAbs]);
  // the JSON report belongs to the main pass only (a serial pass after a parallel one would overwrite it)
  if (opts.jsonOutput && writesJson) outputs.push(["json", path.resolve(opts.root, opts.jsonOutput)]);
  for (const [reporter, file] of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
    args.push(`--reporter=${reporter}`);
    args.push(outputs.length > 1 ? `--outputFile.${reporter}=${file}` : `--outputFile=${file}`);
  }
  // The project's vitest, run by this Node: no npx, no package manager, no shell on any platform.
  return {
    args,
    options: {
      cwd: opts.root,
      stdio: opts.quiet ? "ignore" : "inherit",
      env: {
        ...process.env,
        FEAT_CONFIG_ERROR_MARKER: markerPath,
        ...(opts.configPath !== undefined ? { FEAT_CONFIG: opts.configPath } : {}),
        // The serial pass is the only place an exclusive fault may be armed (SPEC-RT-005).
        ...(serial ? { FEAT_SERIAL: "1" } : {}),
      },
    },
    markerPath,
  };
}
