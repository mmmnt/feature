// createSynthStackHandler — synthesis as a Feature response command, shipped
// in-package so a consumer authors ZERO handler code. A feat.config.json
// routes a command (e.g. SynthStack) to a handler this factory returns; the
// consumer's whole obligation is their own CDK app plus specs that predict
// the canonical surface.
//
// The handler runs `cdk synth` (via the consumer's own aws-cdk install or a
// configured cdkBin; never a fetched one, SPEC-CDK-001), analyzes the resulting assembly, and returns the
// requested stack's canonical surface. With a stage configured, the "<env>"
// token is a two-way contract: it resolves to the stage in the requested
// stack id, and the stage normalizes back to "<env>" in the response — one
// spec text, every environment. Payload `select` queries run the generic
// resource selection (path / type / partial match / regex) for relational
// and absence predictions.
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { analyzeAssembly, resolveStackClosure, type Assembly, type StackAnalysis } from "./assembly.js";
import { normalizeStage, type SelectQuery } from "./resources.js";
import { stackSurface, type StackSurface } from "./surface.js";

const execFile = promisify(execFileCb);

export interface SynthStackConfig {
  /** Directory of the CDK app (default: process cwd). */
  cwd?: string;
  /**
   * The `cdk synth --app` command. By default cdk runs the app its cdk.json names. Set to a project's own
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
   * Binary that runs cdk, with `cdk` as its first argument. By default the
   * consumer's own `aws-cdk` install is resolved and run with the current
   * Node executable — cross-platform, no shell — and a missing one is refused
   * (AWS_CDK_NOT_INSTALLED), never fetched. Setting this runs that binary
   * instead (through a shell on Windows, for a .cmd shim).
   */
  cdkBin?: string;
  /**
   * Active stage (e.g. "local", "staging"). Enables the two-way "<env>"
   * token: resolved to this value in the requested stack id, normalized back
   * to "<env>" in every response string.
   */
  stage?: string;
  /**
   * SSM names published OUTSIDE this app's assembly (another plane/repo).
   * Exact names; "<env>" resolves to the stage. A consumed name in this list
   * with no in-assembly publisher is a declared cross-plane edge — accepted,
   * surfaced in `consumes`, never a closure member. Undeclared dangling
   * consumes still throw.
   */
  externalPublications?: string[];
  /**
   * Semantic projection: extra assertable fields merged OVER the canonical
   * surface. Pure — receives the analyzed assembly, the stack, its closure,
   * and the canonical surface; returns the fields to add. Rarely needed now
   * that `select` queries cover relational claims; kept as an escape hatch.
   */
  project?: (ctx: {
    assembly: Assembly;
    stack: StackAnalysis;
    closure: string[];
    surface: StackSurface;
  }) => Record<string, unknown>;
}

interface SynthStackPayload {
  /** Stack to describe: artifact id or stack name; "<env>" resolves to the stage. */
  stack?: unknown;
  /** Named select queries over the stack's normalized resources. */
  select?: unknown;
}

/**
 * The consumer's own aws-cdk CLI entry: the first `node_modules/aws-cdk/package.json` from `cwd` upward
 * (a workspace-hoisted install is found; NODE_PATH is not read) and the file its `bin.cdk` (or string
 * `bin`) names. Running it via process.execPath is the cross-platform path (no .cmd shim involved).
 * Null when aws-cdk is not installed there, it names no bin, or the bin is absent (SPEC-CDK-001).
 */
export function resolveCdkEntry(cwd: string): string | null {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const manifestPath = path.join(dir, "node_modules", "aws-cdk", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.cdk;
      if (rel === undefined) return null;
      const entry = path.resolve(path.dirname(manifestPath), rel);
      return existsSync(entry) ? entry : null;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** Thrown when SynthStack must synthesize and the app has no aws-cdk (SPEC-CDK-001): a configuration error, exit 2. */
export class CdkNotInstalledError extends Error {
  public readonly code = "AWS_CDK_NOT_INSTALLED" as const;
  constructor(cwd: string) {
    super(
      `Configuration error (exit 2): [AWS_CDK_NOT_INSTALLED] aws-cdk is not installed for the CDK app at ${cwd}. ` +
        `SynthStack runs the project's own aws-cdk and never fetches one; add aws-cdk as a dev dependency ` +
        `(for example \`npm install --save-dev aws-cdk\`, \`pnpm add -D aws-cdk\`), set invoke.cdkBin, or point ` +
        `invoke.assemblyDir at a synthesized cdk.out.`,
    );
    this.name = "CdkNotInstalledError";
  }
}

// cmd.exe quoting for the shell:true fallback (temp paths may carry spaces).
function quoteForShell(arg: string): string {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

export function createSynthStackHandler(config: SynthStackConfig = {}) {
  return async function synthStack(payload: SynthStackPayload) {
    const requested = typeof payload.stack === "string" ? payload.stack : "";
    if (!requested) {
      return { status: 400, body: { code: "MISSING_STACK", message: "payload.stack is required (stack name or artifact id; <env> resolves to the configured stage)." } };
    }
    const stackId = config.stage !== undefined ? requested.replaceAll("<env>", config.stage) : requested;

    let assemblyDir = config.assemblyDir;
    if (!assemblyDir) {
      const cwd = config.cwd ?? process.cwd();
      // The app's own aws-cdk, run by this Node; a missing one is refused before anything is written or
      // spawned, never fetched (SPEC-CDK-001). A configured cdkBin is the user's choice and runs instead.
      const entry = config.cdkBin ? null : resolveCdkEntry(cwd);
      if (!config.cdkBin && entry === null) throw new CdkNotInstalledError(cwd);
      assemblyDir = mkdtempSync(path.join(tmpdir(), "feat-cdk-"));
      // Synthesize the WHOLE app: the assembly is the contract, and stack
      // membership is ruled on by the analysis (an unknown stack must answer
      // 404 with the available stacks, not die inside the cdk CLI).
      const synthArgs = ["synth", "--all", "--output", assemblyDir, "--quiet"];
      if (config.appCommand) synthArgs.push("--app", config.appCommand);
      const env = { ...process.env, ...config.env };
      if (entry !== null) {
        await execFile(process.execPath, [entry, ...synthArgs], { cwd, env });
      } else {
        // The user's own cdkBin, as configured (a .cmd shim needs a shell on Windows).
        const win = process.platform === "win32";
        const args = ["cdk", ...synthArgs];
        await execFile(config.cdkBin!, win ? args.map(quoteForShell) : args, { cwd, env, shell: win });
      }
    }

    const assembly = analyzeAssembly(assemblyDir);
    const stack = assembly.byArtifact[stackId] ?? assembly.byStackName[stackId];
    if (!stack) {
      const available = normalizeStage(assembly.stacks.map((s) => s.stackName), config.stage).join(", ");
      return {
        status: 404,
        body: {
          code: "UNKNOWN_STACK",
          message: `Stack '${requested}' is not in the assembly — available: ${available}.`,
        },
      };
    }
    const external = new Set(
      (config.externalPublications ?? []).map((name) =>
        config.stage !== undefined ? name.replaceAll("<env>", config.stage) : name,
      ),
    );
    const closure = resolveStackClosure(assembly, [stack.artifactId], external);
    const select =
      payload.select !== null && typeof payload.select === "object" && !Array.isArray(payload.select)
        ? (payload.select as Record<string, SelectQuery>)
        : undefined;
    const options: Parameters<typeof stackSurface>[3] = {};
    if (config.stage !== undefined) options.stage = config.stage;
    if (select !== undefined) options.select = select;
    const surface = stackSurface(assembly, stack, closure, options);
    const body = config.project
      ? { ...surface, ...config.project({ assembly, stack, closure, surface }) }
      : surface;
    return { status: 200, body };
  };
}
