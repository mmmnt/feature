// One way to read a feat config (ADR-0024): through loadConfig, so a tier overlay (`extends`) is
// resolved and a drifting overlay (TIER_SPACE_MISMATCH), a missing base or a chain is refused the
// same way by every command — run, verify, audit, lint, fmt, watch, report, generate, parse.

import path from "node:path";
import type { FeatConfig } from "@mmmnt/feat-types";
import { HarnessConfigurationError, loadConfig, resolveEnvironment } from "@mmmnt/feat-runtime";

export class ConfigLoadError extends Error {
  constructor(public readonly code: string, message: string, public readonly detail?: string) {
    super(`[${code}] ${message}${detail ? ` — ${detail}` : ""}`);
  }
}

/** The merged config at `configPath` (relative to `root`); throws ConfigLoadError when loadConfig refuses it. */
export async function readConfig(root: string, configPath: string): Promise<FeatConfig> {
  const abs = path.resolve(root, configPath);
  const cwd = process.cwd();
  process.chdir(root);
  try {
    const r = await loadConfig({ path: abs });
    if (r.status === "ERR") {
      const b = r.body as { code: string; message: string; detail?: string };
      throw new ConfigLoadError(b.code, b.message, b.detail);
    }
    return r.body as unknown as FeatConfig;
  } finally {
    process.chdir(cwd);
  }
}

/** For a command's run(): print the refusal and exit 2 (configuration error). */
export async function readConfigOrExit(
  cmd: { logToStderr(m: string): void; exit(code: number): never },
  root: string,
  configPath: string,
): Promise<FeatConfig> {
  try {
    return await readConfig(root, configPath);
  } catch (e) {
    if (!(e instanceof ConfigLoadError)) throw e;
    cmd.logToStderr(`ERROR ${e.message}`);
    return cmd.exit(2);
  }
}

/** For a command's run(): the environment the config or the process names; none prints the refusal and exits 2. */
export function environmentOrExit(cmd: { logToStderr(m: string): void; exit(code: number): never }, config: FeatConfig): string {
  try {
    return resolveEnvironment(config);
  } catch (e) {
    if (!(e instanceof HarnessConfigurationError)) throw e;
    cmd.logToStderr(`ERROR ${e.message}`);
    return cmd.exit(2);
  }
}
