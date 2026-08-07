// @mmmnt/feat-schema-json — JSON Schema resolution + validation.
// Compile-time only: the generate pipeline resolves schemas through this adapter
// and inlines them into generated tests; nothing resolves at run time.

import { createRequire } from "node:module";
import type { FeatSchemaAdapter, ResolvedSchema } from "@mmmnt/feat-types";
import { bundle } from "./bundle.js";

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

  // `normalized` is what gets inlined, so it must survive the move: cross-file `$ref`s
  // are followed here, against the source file's base URI, and their targets travel with
  // the document. `raw` stays verbatim — the contract as authored.
  async resolve(ref: string, fromPath: string): Promise<ResolvedSchema> {
    const bundled = bundle(ref, fromPath);
    return {
      id: bundled.id,
      format: "json-schema",
      raw: bundled.raw,
      normalized: bundled.schema,
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
