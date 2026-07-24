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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

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
export function runConfigSource(root: string, absFiles: string[]): string {
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
    "  },",
    "};",
    "",
  ];
  return lines.join("\n");
}

export function runTests(opts: RunOptions): RunResult {
  if (opts.files.length === 0) {
    console.error("feat-runner: zero generated test files to execute — refusing a silently empty run.");
    return { exitCode: 1 };
  }
  const absFiles = opts.files.map((f) => path.resolve(opts.root, f));
  // Lives under node_modules/.cache so `vitest/config` and the consumer's own
  // imports resolve exactly as they would from the project root.
  const configPath = path.join(opts.root, "node_modules", ".cache", "feat", "feat-run.vitest.config.mjs");
  mkdirSync(path.dirname(configPath), { recursive: true });
  writeFileSync(configPath, runConfigSource(opts.root, absFiles));

  const args = ["vitest", "run", "--config", configPath];
  if (!opts.quiet) args.push("--reporter=default");
  if (opts.coverage) args.push("--coverage");
  // With multiple file-writing reporters vitest needs the dotted outputFile form.
  const outputs: [string, string][] = [];
  let junitPath: string | undefined;
  if (opts.junitOutput) {
    junitPath = path.resolve(opts.root, opts.junitOutput);
    outputs.push(["junit", junitPath]);
  }
  let jsonPath: string | undefined;
  if (opts.jsonOutput) {
    jsonPath = path.resolve(opts.root, opts.jsonOutput);
    outputs.push(["json", jsonPath]);
  }
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
    env: process.env,
    shell: win,
  });
  const out: RunResult = { exitCode: result.status ?? 1 };
  if (junitPath !== undefined) out.junitPath = junitPath;
  if (jsonPath !== undefined) out.jsonPath = jsonPath;
  return out;
}
