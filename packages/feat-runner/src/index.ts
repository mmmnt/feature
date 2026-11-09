// @mmmnt/feat-runner — thin subprocess orchestrator (GAP-D09, ADR-0001).
// Generated tests own their lifecycle; the runner spawns `vitest run`, passes
// through the exit code, and points reporters at the configured outputs.
//
// The runner OWNS test selection: it writes a run config that extends the
// project's own vitest config (coverage settings survive) but forces
// `include` to exactly the generated files and makes an empty run FATAL. A
// consumer vitest config scoped to its unit layer must never silently eat
// generated suites — a run that collects zero of them is a failure, loudly.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runPlan, type Plan } from "./plan.js";

export { plan, runPlan } from "./plan.js";
export type { Plan, PlannedSpec } from "./plan.js";

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
  junitPath?: string;
  jsonPath?: string;
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

export function runTests(opts: RunOptions): RunResult {
  if (opts.files.length === 0) {
    console.error("feat-runner: zero generated test files to execute — refusing a silently empty run.");
    return { exitCode: 1 };
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
  const first: { ran?: boolean } = {};
  const result = runPlan(p, (files, pass) => {
    // The serial pass writes beside the main report when a parallel pass already wrote it; merged below.
    const writesSeparately = pass.serial && first.ran === true && junitMain !== undefined;
    const junit = junitMain === undefined ? undefined : writesSeparately ? `${junitMain}.serial` : junitMain;
    first.ran = true;
    return runOnce(opts, files, pass.serial, junit);
  });
  if (junitMain !== undefined && existsSync(`${junitMain}.serial`)) {
    writeFileSync(junitMain, mergeJunit(readFileSync(junitMain, "utf8"), readFileSync(`${junitMain}.serial`, "utf8")));
    rmSync(`${junitMain}.serial`, { force: true });
  }
  const out: RunResult = { exitCode: result.exitCode };
  if (junitMain !== undefined) out.junitPath = junitMain;
  if (opts.jsonOutput !== undefined) out.jsonPath = path.resolve(opts.root, opts.jsonOutput);
  return out;
}

function runOnce(opts: RunOptions, files: string[], serial: boolean, junitAbs: string | undefined): number {
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

  const args = ["vitest", "run", "--config", configPath];
  if (serial) args.push("--no-file-parallelism", "--maxWorkers=1");
  if (!opts.quiet) args.push("--reporter=default");
  if (opts.coverage) args.push("--coverage");
  // With multiple file-writing reporters vitest needs the dotted outputFile form.
  const outputs: [string, string][] = [];
  if (junitAbs !== undefined) outputs.push(["junit", junitAbs]);
  // the JSON report belongs to the main pass only (the serial pass would overwrite it)
  if (opts.jsonOutput && !serial) outputs.push(["json", path.resolve(opts.root, opts.jsonOutput)]);
  for (const [reporter, file] of outputs) {
    mkdirSync(path.dirname(file), { recursive: true });
    args.push(`--reporter=${reporter}`);
    args.push(outputs.length > 1 ? `--outputFile.${reporter}=${file}` : `--outputFile=${file}`);
  }
  // npx is a .cmd shim on Windows — execFile/spawn refuse it without a shell.
  const win = process.platform === "win32";
  const quote = (a: string) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const result = spawnSync(win ? "npx.cmd" : "npx", win ? args.map(quote) : args, {
    cwd: opts.root,
    stdio: opts.quiet ? "ignore" : "inherit",
    env: {
      ...process.env,
      ...(opts.configPath !== undefined ? { FEAT_CONFIG: opts.configPath } : {}),
      // The serial pass is the only place an exclusive fault may be armed (SPEC-RT-005).
      ...(serial ? { FEAT_SERIAL: "1" } : {}),
    },
    shell: win,
  });
  return result.status ?? 1;
}
