// The runner's namespace (SPEC-RT-006): one per spec file, derived from the file's path alone, so every
// adapter and the spec host of a file isolate their data under one value, and two files running in
// parallel against one product never see each other's. Namespaces isolate DATA, not availability.

import { createHash } from "node:crypto";
import path from "node:path";
import { HarnessConfigurationError } from "./errors.js";

/** What every product binding and the Feat Host Protocol accept: a lowercase token starting with a letter. */
export const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;

export type Digest = (normalisedPath: string) => string;
const sha256Hex: Digest = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** `path` relative to the config directory, "/" separators, no leading "./", case kept. */
export function normalizeSpecPath(specPath: string, configDir: string): string {
  const slashed = specPath.replace(/\\/g, "/");
  const rel = path.isAbsolute(specPath) ? path.relative(configDir, specPath).replace(/\\/g, "/") : slashed;
  return path.posix.normalize(rel).replace(/^(\.\/)+/, "");
}

/** "s" + the first 12 hex characters of the SHA-256 of the normalised path: 13 characters. */
export function deriveNamespace(specPath: string, configDir: string, digest: Digest = sha256Hex): string {
  return `s${digest(normalizeSpecPath(specPath, configDir)).slice(0, 12)}`;
}

/** The whole run's spec set, checked before any file starts: two files with one namespace stop the run. */
export function assertNoNamespaceCollision(specPaths: readonly string[], configDir: string, digest: Digest = sha256Hex): void {
  const seen = new Map<string, string>();
  for (const sp of specPaths) {
    const ns = deriveNamespace(sp, configDir, digest);
    const first = seen.get(ns);
    const norm = normalizeSpecPath(sp, configDir);
    if (first !== undefined && first !== norm)
      throw new HarnessConfigurationError("NAMESPACE_COLLISION", `${norm} and ${first} derive the same namespace ${ns}; one of them must move.`);
    seen.set(ns, norm);
  }
}

/**
 * A `namespace` written in a config file (the response config or any service's options) is shared by
 * every file and defeats the isolation. Checked on the MERGED config, after loadConfig's own checks.
 */
export function assertNamespaceNotConfigured(
  config: { extends?: string; response?: Record<string, unknown>; services: Record<string, { options?: Record<string, unknown> }> },
  configPath: string,
): void {
  const via = config.extends !== undefined ? ` (a tier overlay of ${config.extends})` : "";
  const bad = (where: string) =>
    new HarnessConfigurationError(
      "NAMESPACE_CONFIGURED",
      `${configPath}${via}: ${where} carries a 'namespace' key. The runner derives one namespace per spec file; a configured value is shared by every file.`,
    );
  const resp = config.response ?? {};
  if ("namespace" in resp || (typeof resp.invoke === "object" && resp.invoke !== null && "namespace" in resp.invoke)) throw bad("the response config");
  for (const [key, svc] of Object.entries(config.services))
    if (svc.options !== undefined && "namespace" in svc.options) throw bad(`service '${key}' options`);
}
