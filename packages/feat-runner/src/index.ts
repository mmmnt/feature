// @mmmnt/feat-runner — thin subprocess orchestrator (GAP-D09, ADR-0001).
// Generated tests own their lifecycle; the runner only spawns `vitest run`,
// passes through the exit code, and points reporters at the configured outputs.

import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
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

export function runTests(opts: RunOptions): RunResult {
  const args = ["vitest", "run", ...opts.files];
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
  const result = spawnSync("npx", args, {
    cwd: opts.root,
    stdio: opts.quiet ? "ignore" : "inherit",
    env: process.env,
  });
  const out: RunResult = { exitCode: result.status ?? 1 };
  if (junitPath !== undefined) out.junitPath = junitPath;
  if (jsonPath !== undefined) out.jsonPath = jsonPath;
  return out;
}
