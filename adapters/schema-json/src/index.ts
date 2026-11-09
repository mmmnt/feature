// @mmmnt/feat-schema-json — JSON Schema resolution + validation.
// Compile-time only: the generate pipeline resolves schemas through this adapter
// and inlines them into generated tests; nothing resolves at run time.

import { createRequire } from "node:module";
import type { FeatSchemaAdapter, ResolvedSchema } from "@mmmnt/feat-types";
import { bundle } from "./bundle.js";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const Ajv2020: typeof import("ajv/dist/2020.js").default = require("ajv/dist/2020.js");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

// Dialect follows the document: Ajv's default export knows draft-07 only, and refuses to compile a
// draft/2020-12 `$schema` (bundling preserves it). Same rule as the run-time matcher's.
const DIALECT_2020 = /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema\/?#?$/;

class JsonSchemaAdapter implements FeatSchemaAdapter {
  private ajv = new (Ajv as new (opts: object) => InstanceType<typeof Ajv>)({
    strict: false,
    allErrors: true,
  });

  private ajv2020 = new (Ajv2020 as new (opts: object) => InstanceType<typeof Ajv2020>)({
    strict: false,
    allErrors: true,
  });

  constructor() {
    addFormats(this.ajv as never);
    addFormats(this.ajv2020 as never);
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
    const dialect = schema.normalized.$schema;
    const ajv = typeof dialect === "string" && DIALECT_2020.test(dialect) ? this.ajv2020 : this.ajv;
    const validator = ajv.compile(schema.normalized);
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
