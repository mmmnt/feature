// SPEC-RT-001 "Load and validate feat.config.json" — @mmmnt/feat-runtime (ADR-0001).
// Handler contract: returns a CapturedResponse-shaped result ({ status, body });
// invoked via the handler response adapter (feat.config.json → response.commands.LoadConfig).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";

// CJS interop under NodeNext: ajv/ajv-formats ship CJS with default-shaped exports.
const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_SCHEMA = JSON.parse(
  readFileSync(path.resolve(PKG_DIR, "../../../schemas/feat.config.schema.json"), "utf8"),
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

function err(
  code: "CONFIG_NOT_FOUND" | "INVALID_CONFIG" | "MISSING_CONVERGENCE_TIMEOUT",
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

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (cause) {
    return err("INVALID_CONFIG", `Config at '${input.path}' is not readable.`, {
      detail: `Not valid JSON: ${(cause as Error).message}`,
    });
  }

  if (!validateConfig(doc)) {
    const first = (validateConfig.errors ?? [])[0];
    const detail = first ? describeAjvError(first) : "schema validation failed";
    return err("INVALID_CONFIG", `Config at '${input.path}' violates the config schema.`, {
      detail,
    });
  }

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
