// SPEC-RT-001 "Load and validate feat.config.json" — @mmmnt/feat-runtime (ADR-0001).
// Handler contract: returns a CapturedResponse-shaped result ({ status, body });
// invoked via the handler response adapter (feat.config.json → response.commands.LoadConfig).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";
import { HarnessConfigurationError } from "./errors.js";

// CJS interop under NodeNext: ajv/ajv-formats ship CJS with default-shaped exports.
const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

// The schema ships inside this package (schemas/ is copied from the repo root
// at build; see schema-sync.test.ts) so resolution works from node_modules,
// where the monorepo's root schemas/ directory does not exist.
const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_SCHEMA = JSON.parse(
  readFileSync(path.resolve(PKG_DIR, "../schemas/feat.config.schema.json"), "utf8"),
) as object;

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const validateConfig = ajv.compile(CONFIG_SCHEMA);

export interface CapturedResponse {
  status: "OK" | "ERR";
  body: Record<string, unknown>;
}

export interface LoadConfigInput {
  path: string;
}

interface ServiceConfig {
  adapter: string;
  consistency: "acid" | "strong" | "eventual";
  convergenceTimeout?: number;
}

export type ConfigErrorCode =
  | "CONFIG_NOT_FOUND"
  | "INVALID_CONFIG"
  | "MISSING_CONVERGENCE_TIMEOUT"
  | "EXTENDS_NOT_FOUND"
  | "EXTENDS_CHAIN"
  | "TIER_SPACE_MISMATCH";

function err(
  code: ConfigErrorCode,
  message: string,
  extra: Record<string, unknown> = {},
): CapturedResponse {
  return { status: "ERR", body: { code, message, ...extra } };
}

function describeAjvError(e: ErrorObject): string {
  const where = e.instancePath === "" ? "config root" : e.instancePath;
  const allowed =
    e.params && "allowedValues" in e.params
      ? ` (allowed: ${(e.params.allowedValues as unknown[]).join(", ")})`
      : "";
  const missing =
    e.params && "missingProperty" in e.params ? ` '${e.params.missingProperty as string}'` : "";
  return `${where} ${e.message ?? "is invalid"}${missing}${allowed}`;
}

function schemaProblem(doc: unknown): string | undefined {
  if (validateConfig(doc)) return undefined;
  const first = (validateConfig.errors ?? [])[0];
  return first ? describeAjvError(first) : "schema validation failed";
}

type Doc = Record<string, unknown>;
const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);

/** What an overlay (ADR-0024) may carry: the keys it replaces whole, and the pointer to its base. */
const OVERLAY_KEYS = new Set(["extends", "environment", "response", "services", "specs", "report"]);

function readJson(file: string): { doc: Doc } | { error: string } {
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return isObj(doc) ? { doc } : { error: "not a JSON object" };
  } catch (cause) {
    return { error: `Not valid JSON: ${(cause as Error).message}` };
  }
}

/** Resolve a tier overlay against its base (ADR-0024): replace whole, per key; closed spaces must match. */
function resolveOverlay(overlay: Doc, overlayFile: string, input: LoadConfigInput): CapturedResponse | { merged: Doc } {
  for (const key of Object.keys(overlay))
    if (!OVERLAY_KEYS.has(key) && (key === "featVersion" || key === "schemas"))
      return err("INVALID_CONFIG", `Overlay '${input.path}' redeclares '${key}'.`, {
        detail: `${key} is inherited from the base and may not be redeclared by an overlay`,
      });
  const written = overlay.extends as string;
  const baseFile = path.resolve(path.dirname(overlayFile), written);
  if (!existsSync(baseFile))
    return err("EXTENDS_NOT_FOUND", `Overlay '${input.path}' extends a file that does not exist.`, {
      detail: `extends '${written}' resolved to '${baseFile}'`,
    });
  const read = readJson(baseFile);
  if ("error" in read)
    return err("INVALID_CONFIG", `Base config '${baseFile}' is not readable.`, { detail: `${path.basename(baseFile)}: ${read.error}` });
  const base = read.doc;
  if (base.extends !== undefined)
    return err("EXTENDS_CHAIN", `'${input.path}' extends '${path.basename(baseFile)}', which itself extends '${String(base.extends)}'.`, {
      detail: `${overlayFile} → ${baseFile} → ${path.resolve(path.dirname(baseFile), String(base.extends))}; one level only`,
    });
  const baseProblem = schemaProblem(base);
  if (baseProblem !== undefined)
    return err("INVALID_CONFIG", `Base config '${baseFile}' violates the config schema.`, {
      detail: `${path.basename(baseFile)} (${baseFile}): ${baseProblem}`,
    });

  // The closed spaces (INV-7): an overlay can add a service, and add or remove a command or an actor.
  const baseSvc = Object.keys((base.services as Doc) ?? {});
  for (const k of Object.keys((overlay.services as Doc) ?? {}))
    if (!baseSvc.includes(k))
      return err("TIER_SPACE_MISMATCH", `Overlay '${input.path}' adds service '${k}', which the base does not declare.`, {
        space: "service", change: "added", detail: k,
      });
  if (overlay.response !== undefined) {
    const b = (base.response as Doc | undefined) ?? {};
    const o = overlay.response as Doc;
    const spaces: ["command" | "actor", string[], string[]][] = [
      ["command", Object.keys((b.commands as Doc) ?? {}), Object.keys((o.commands as Doc) ?? {})],
      ["actor", Object.keys((b.actors as Doc) ?? {}).filter((k) => k !== "default"), Object.keys((o.actors as Doc) ?? {}).filter((k) => k !== "default")],
    ];
    for (const [space, was, now] of spaces) {
      for (const k of now) if (!was.includes(k))
        return err("TIER_SPACE_MISMATCH", `Overlay '${input.path}' adds ${space} '${k}', which the base does not declare.`, { space, change: "added", detail: k });
      for (const k of was) if (!now.includes(k))
        return err("TIER_SPACE_MISMATCH", `Overlay '${input.path}' removes ${space} '${k}', which the base declares.`, { space, change: "removed", detail: k });
    }
  }

  // Replace whole, per key; `environment` is not inherited; featVersion and schemas are.
  const merged: Doc = { ...base };
  delete merged.environment;
  for (const key of ["environment", "response", "specs", "report"]) if (overlay[key] !== undefined) merged[key] = overlay[key];
  merged.services = { ...(base.services as Doc), ...((overlay.services as Doc) ?? {}) };
  merged.extends = overlay.extends;
  return { merged };
}

export async function loadConfig(input: LoadConfigInput): Promise<CapturedResponse> {
  const filePath = path.resolve(process.cwd(), input.path);

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return err("CONFIG_NOT_FOUND", `No config file exists at '${input.path}'.`, {
      path: input.path,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return err("INVALID_CONFIG", `Config at '${input.path}' is not readable.`, {
      detail: `Not valid JSON: ${(cause as Error).message}`,
    });
  }

  let doc: unknown = parsed;
  if (isObj(parsed) && typeof parsed.extends === "string") {
    const resolved = resolveOverlay(parsed, filePath, input);
    if (!("merged" in resolved)) return resolved;
    doc = resolved.merged;
  }

  const problem = schemaProblem(doc);
  if (problem !== undefined)
    return err("INVALID_CONFIG", `Config at '${input.path}' violates the config schema.`, { detail: problem });

  const config = doc as { services: Record<string, ServiceConfig> };
  for (const [key, svc] of Object.entries(config.services)) {
    if (svc.consistency === "eventual" && svc.convergenceTimeout === undefined) {
      return err(
        "MISSING_CONVERGENCE_TIMEOUT",
        `Service '${key}' declares eventual consistency but no convergenceTimeout.`,
        { detail: key },
      );
    }
  }

  return { status: "OK", body: doc as Record<string, unknown> };
}

/**
 * Runtime environment resolution (supersedes ADR-0016's static-only field):
 * config.environment is an explicit OVERRIDE (e.g. "synth" for
 * environment-independent synthesis truth); otherwise the environment names
 * itself via FEAT_ENVIRONMENT then ENVIRONMENT; none = immediate failure, a
 * configuration error (NO_ENVIRONMENT, exit 2).
 */
export function resolveEnvironment(config: { environment?: string }): string {
  const env = config.environment ?? process.env.FEAT_ENVIRONMENT ?? process.env.ENVIRONMENT;
  if (!env)
    throw new HarnessConfigurationError(
      "NO_ENVIRONMENT",
      "No environment declared — set ENVIRONMENT or FEAT_ENVIRONMENT, or pin config.environment.",
    );
  return env;
}

/** The .feature/ home for generated run artifacts (dot = generated, gitignored). */
export function variablesSidecarPath(projectRoot: string, configPath: string): string {
  const base = configPath.split(/[\\/]/).pop()!.replace(/\.json$/, "");
  return `${projectRoot}/.feature/run/${base}-variables.jsonl`;
}
