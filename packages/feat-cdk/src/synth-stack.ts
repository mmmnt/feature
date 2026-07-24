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
import { createRequire } from "node:module";
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
  /**
   * Binary that runs cdk. By default the consumer's own `aws-cdk` install is
   * resolved and run with the current Node executable — cross-platform, no
   * shell. Setting this forces the shim path instead (spawned through a
   * shell on Windows, where npx is a .cmd file execFile cannot run).
   */
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

/**
 * The consumer's own aws-cdk CLI entry, resolved from `cwd` — running it via
 * process.execPath is the cross-platform path (no .cmd shim involved).
 * Null when aws-cdk is not installed there (the npx fallback applies).
 */
export function resolveCdkEntry(cwd: string): string | null {
  try {
    return createRequire(path.join(cwd, "__feat-cdk-resolve__.js")).resolve("aws-cdk/bin/cdk");
  } catch {
    return null;
  }
}

// cmd.exe quoting for the shell:true fallback (temp paths may carry spaces).
function quoteForShell(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
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
      // Synthesize the WHOLE app: the assembly is the contract, and stack
      // membership is ruled on by the analysis (an unknown stack must answer
      // 404 with the available stacks, not die inside the cdk CLI).
      const synthArgs = ["synth", "--all", "--output", assemblyDir, "--quiet"];
      if (config.appCommand) synthArgs.push("--app", config.appCommand);
      const env = { ...process.env, ...config.env };
      const entry = config.cdkBin ? null : resolveCdkEntry(cwd);
      if (entry) {
        await execFile(process.execPath, [entry, ...synthArgs], { cwd, env });
      } else {
        const win = process.platform === "win32";
        const bin = config.cdkBin ?? (win ? "npx.cmd" : "npx");
        const args = ["cdk", ...synthArgs];
        await execFile(bin, win ? args.map(quoteForShell) : args, { cwd, env, shell: win });
      }
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
