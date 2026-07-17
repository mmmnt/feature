// @mmmnt/feat-schema-json — JSON Schema resolution + validation.
// Compile-time only: the generate pipeline resolves schemas through this adapter
// and inlines them into generated tests; nothing resolves at run time.

import { readFileSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { FeatSchemaAdapter, ResolvedSchema } from "@mmmnt/feat-types";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

class JsonSchemaAdapter implements FeatSchemaAdapter {
  private ajv = new (Ajv as new (opts: object) => InstanceType<typeof Ajv>)({
    strict: false,
    allErrors: true,
  });

  constructor() {
    addFormats(this.ajv as never);
  }

  async resolve(ref: string, fromPath: string): Promise<ResolvedSchema> {
    const abs = path.resolve(path.dirname(fromPath), ref);
    const raw = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
    return {
      id: abs,
      format: "json-schema",
      raw,
      normalized: raw,
    };
  }

  validate(data: unknown, schema: ResolvedSchema): { valid: boolean; errors?: string[] } {
    const validator = this.ajv.compile(schema.normalized);
    if (validator(data)) return { valid: true };
    const errors = (validator.errors ?? []).map(
      (e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`,
    );
    return { valid: false, errors };
  }
}

export function createAdapter(_config: Record<string, unknown>): FeatSchemaAdapter {
  return new JsonSchemaAdapter();
}
