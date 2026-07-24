// @mmmnt/feat-cdk as a first-class response adapter — the consumer authors
// ZERO code. feat.config.json declares everything (all of it data: the app
// command, per-command env such as a posture flag, and where the stage comes
// from); the runtime loads this package by name and every synth command runs
// in-package:
//
//   "response": {
//     "adapter": "@mmmnt/feat-cdk",
//     "invoke": {
//       "appCommand": "node bin/app.ts",
//       "stage": { "fromEnv": "ENVIRONMENT", "default": "local" }
//     },
//     "commands": {
//       "SynthDeployed": { "env": { "FEAT_POSTURE": "deployed" } },
//       "SynthHarness":  { "env": { "FEAT_POSTURE": "harness" } }
//     }
//   }
//
// The resolved stage is exported to the synth subprocess as ENVIRONMENT and
// drives the two-way <env> token. Config is committed and hashed; the stage
// arrives by environment reference (12-factor) — nothing secret lives here.
import type { CapturedResponse, FeatResponseAdapter } from "@mmmnt/feat-types";
import { createSynthStackHandler, type SynthStackConfig } from "./synth-stack.js";

export interface StageConfig {
  /** Environment variable the stage is read from at run time. */
  fromEnv?: string;
  /** Stage when the variable is unset (e.g. "local"). */
  default?: string;
}

export interface CdkInvokeConfig {
  /** The `cdk synth --app` command (e.g. "node bin/app.ts"). */
  appCommand?: string;
  /** CDK app directory; defaults to the project root Feature runs from. */
  cwd?: string;
  /** Pre-synthesized assembly (skip synth — the deterministic CI seam). */
  assemblyDir?: string;
  /** Binary that runs cdk when the consumer's own install can't be resolved. */
  cdkBin?: string;
  /** Base environment for every synth subprocess. */
  env?: Record<string, string>;
  /** Active stage: a literal, or an environment reference with a default. */
  stage?: string | StageConfig;
  /**
   * SSM names published outside this app's assembly (another plane/repo);
   * "<env>" resolves to the stage. Declared cross-plane edges — reviewed
   * like imports; undeclared dangling consumes remain loud failures.
   */
  externalPublications?: string[];
}

export interface CdkCommandConfig {
  /** Per-command environment (e.g. a posture flag), merged over the base. */
  env?: Record<string, string>;
  /** Per-command pre-synthesized assembly override. */
  assemblyDir?: string;
}

interface CdkAdapterConfig {
  invoke?: CdkInvokeConfig;
  commands: Record<string, CdkCommandConfig>;
  projectRoot?: string;
}

/** Resolve the configured stage: literal, env reference, or undefined. */
export function resolveStage(stage: string | StageConfig | undefined): string | undefined {
  if (stage === undefined || typeof stage === "string") return stage;
  const fromEnv = stage.fromEnv !== undefined ? process.env[stage.fromEnv] : undefined;
  return fromEnv ?? stage.default;
}

class CdkAdapter implements FeatResponseAdapter {
  private handlers = new Map<string, ReturnType<typeof createSynthStackHandler>>();

  constructor(private config: CdkAdapterConfig) {}

  async setup(): Promise<void> {
    // Handlers build lazily per command; synthesis happens at invoke time.
  }

  async teardown(): Promise<void> {
    this.handlers.clear();
  }

  async invoke(command: string, input: Record<string, unknown>): Promise<CapturedResponse> {
    let handler = this.handlers.get(command);
    if (!handler) {
      const cmd = this.config.commands[command];
      if (!cmd) throw new Error(`Command '${command}' is not routed in response.commands — configuration error.`);
      const inv = this.config.invoke ?? {};
      const stage = resolveStage(inv.stage);
      const synth: SynthStackConfig = {};
      if (inv.appCommand !== undefined) synth.appCommand = inv.appCommand;
      if (inv.cdkBin !== undefined) synth.cdkBin = inv.cdkBin;
      if (inv.externalPublications !== undefined) synth.externalPublications = inv.externalPublications;
      const cwd = inv.cwd ?? this.config.projectRoot;
      if (cwd !== undefined) synth.cwd = cwd;
      const assemblyDir = cmd.assemblyDir ?? inv.assemblyDir;
      if (assemblyDir !== undefined) synth.assemblyDir = assemblyDir;
      if (stage !== undefined) synth.stage = stage;
      const env = { ...inv.env, ...cmd.env, ...(stage !== undefined ? { ENVIRONMENT: stage } : {}) };
      if (Object.keys(env).length > 0) synth.env = env;
      handler = createSynthStackHandler(synth);
      this.handlers.set(command, handler);
    }
    return (await handler(input)) as CapturedResponse;
  }
}

export function createAdapter(config: Record<string, unknown>): FeatResponseAdapter {
  return new CdkAdapter(config as unknown as CdkAdapterConfig);
}
