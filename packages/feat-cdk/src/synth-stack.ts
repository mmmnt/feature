// createSynthStackHandler — synthesis as a Feature response command, shipped
// in-package so a consumer authors ZERO handler code. A feat.config.json
// routes a command (e.g. SynthStack) to a handler this factory returns; the
// consumer's whole obligation is their own CDK app plus specs that predict
// the canonical surface.
//
// The handler runs `cdk synth` (via the consumer's configured app command),
// analyzes the resulting assembly, and returns the requested stack's
// canonical surface. Deterministic and side-effect-free beyond the synth the
// consumer's own toolchain performs.
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeAssembly, resolveStackClosure, type Assembly, type StackAnalysis } from "./assembly.js";
import { stackSurface, type StackSurface } from "./surface.js";

const execFile = promisify(execFileCb);

export interface SynthStackConfig {
  /** Directory of the CDK app (default: process cwd). */
  cwd?: string;
  /**
   * The `cdk synth --app` command. Default "npx cdk". Set to a project's own
   * entrypoint runner (e.g. "node bin/app.ts") when there is no cdk.json.
   */
  appCommand?: string;
  /**
   * Pre-synthesized assembly directory. When set, the handler skips synth and
   * reads this cdk.out — the deterministic path for CI and tests.
   */
  assemblyDir?: string;
  /** Extra environment for the synth subprocess (e.g. ENVIRONMENT). */
  env?: Record<string, string>;
  /** Binary that runs cdk (default "npx"); the appCommand is passed via --app. */
  cdkBin?: string;
  /**
   * Semantic projection: extra assertable fields merged OVER the canonical
   * surface (e.g. regulatory posture predicates derived from the template).
   * Pure — receives the analyzed assembly, the stack, its closure, and the
   * canonical surface; returns the fields to add.
   */
  project?: (ctx: {
    assembly: Assembly;
    stack: StackAnalysis;
    closure: string[];
    surface: StackSurface;
  }) => Record<string, unknown>;
}

interface SynthStackPayload {
  /** Stack artifact id to describe. */
  stack?: unknown;
}

export function createSynthStackHandler(config: SynthStackConfig = {}) {
  return async function synthStack(payload: SynthStackPayload) {
    const stackId = typeof payload.stack === "string" ? payload.stack : "";
    if (!stackId) {
      return { status: 400, body: { code: "MISSING_STACK", message: "payload.stack is required (the stack artifact id)." } };
    }

    let assemblyDir = config.assemblyDir;
    if (!assemblyDir) {
      const cwd = config.cwd ?? process.cwd();
      assemblyDir = mkdtempSync(path.join(tmpdir(), "feat-cdk-"));
      const cdkBin = config.cdkBin ?? "npx";
      // Synthesize the WHOLE app: the assembly is the contract, and stack
      // membership is ruled on by the analysis (an unknown stack must answer
      // 404 with the available stacks, not die inside the cdk CLI).
      const args = ["cdk", "synth", "--all", "--output", assemblyDir, "--quiet"];
      if (config.appCommand) args.push("--app", config.appCommand);
      await execFile(cdkBin, args, { cwd, env: { ...process.env, ...config.env } });
    }

    const assembly = analyzeAssembly(assemblyDir);
    const stack = assembly.byArtifact[stackId];
    if (!stack) {
      return {
        status: 404,
        body: {
          code: "UNKNOWN_STACK",
          message: `Stack '${stackId}' is not in the assembly — available: ${assembly.stacks.map((s) => s.artifactId).join(", ")}.`,
        },
      };
    }
    const closure = resolveStackClosure(assembly, [stackId]);
    const surface = stackSurface(assembly, stack, closure);
    const body = config.project
      ? { ...surface, ...config.project({ assembly, stack, closure, surface }) }
      : surface;
    return { status: 200, body };
  };
}
