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
  /** Collect coverage via the test runner's coverage provider. */
  coverage?: boolean;
}

export interface RunResult {
  exitCode: number;
  junitPath?: string;
}

export function runTests(opts: RunOptions): RunResult {
  const args = ["vitest", "run", ...opts.files, "--reporter=default"];
  if (opts.coverage) args.push("--coverage");
  let junitPath: string | undefined;
  if (opts.junitOutput) {
    junitPath = path.resolve(opts.root, opts.junitOutput);
    mkdirSync(path.dirname(junitPath), { recursive: true });
    args.push("--reporter=junit", `--outputFile=${junitPath}`);
  }
  const result = spawnSync("npx", args, {
    cwd: opts.root,
    stdio: "inherit",
    env: process.env,
  });
  const out: RunResult = { exitCode: result.status ?? 1 };
  if (junitPath !== undefined) out.junitPath = junitPath;
  return out;
}
