// @mmmnt/feat-schema-json — JSON Schema resolution + validation.
// Compile-time only: the generate pipeline resolves schemas through this adapter
// and inlines them into generated tests; nothing resolves at run time.

import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { FeatSchemaAdapter, ResolvedSchema } from "@mmmnt/feat-types";
import { bundle, bundleInline } from "./bundle.js";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const Ajv2020: typeof import("ajv/dist/2020.js").default = require("ajv/dist/2020.js");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

// Dialect follows the document: Ajv's default export knows draft-07 only, and refuses to compile a
// draft/2020-12 `$schema` (bundling preserves it). Same rule as the run-time matcher's.
const DIALECT_2020 = /^https?:\/\/json-schema\.org\/draft\/2020-12\/schema\/?#?$/;

type Ajv = InstanceType<typeof import("ajv").default>;
type ValidateFunction = import("ajv").ValidateFunction;

class JsonSchemaAdapter implements FeatSchemaAdapter {
  private ajv = new (Ajv as new (opts: object) => InstanceType<typeof Ajv>)({
    strict: false,
    allErrors: true,
  });

  private ajv2020 = new (Ajv2020 as new (opts: object) => InstanceType<typeof Ajv2020>)({
    strict: false,
    allErrors: true,
  });

  /** Compiled validators of $id-bearing schemas, by $id: Ajv refuses a second compile of an id it holds. */
  private compiled = new Map<string, { schema: Record<string, unknown>; validator: ValidateFunction }>();

  private readonly projectRoot: string | undefined;

  constructor(config: Record<string, unknown> = {}) {
    this.projectRoot = typeof config.projectRoot === "string" ? config.projectRoot : undefined;
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

  // A schema authored inline in the contract: same bundling, but its own local pointers keep
  // meaning the schema itself (it becomes its own document in the generated test).
  async resolveInline(schema: Record<string, unknown>, fromPath: string): Promise<ResolvedSchema> {
    const bundled = bundleInline(schema, fromPath, this.projectRoot);
    return { id: bundled.id, format: "json-schema", raw: bundled.raw, normalized: bundled.schema };
  }

  // Idempotent per schema: the same document under the same $id reuses its compiled validator; a
  // different document claiming a taken $id is a coded error, not an Ajv crash. $id-less schemas
  // register nothing in Ajv, so they compile freely.
  private compile(ajv: Ajv, schema: Record<string, unknown>): ValidateFunction {
    const id = schema.$id;
    if (typeof id !== "string") return ajv.compile(schema);
    const seen = this.compiled.get(id);
    if (seen) {
      if (isDeepStrictEqual(seen.schema, schema)) return seen.validator;
      const err = new Error(
        `SCHEMA_ID_CONFLICT: two different schemas claim the $id '${id}'. ` +
          `Give each schema its own $id, or make the two identical.`,
      ) as Error & { code: string };
      err.code = "SCHEMA_ID_CONFLICT";
      throw err;
    }
    const validator = ajv.compile(schema);
    this.compiled.set(id, { schema: structuredClone(schema), validator });
    return validator;
  }

  validate(data: unknown, schema: ResolvedSchema): { valid: boolean; errors?: string[] } {
    const dialect = schema.normalized.$schema;
    const ajv = typeof dialect === "string" && DIALECT_2020.test(dialect) ? this.ajv2020 : this.ajv;
    const validator = this.compile(ajv, schema.normalized);
    if (validator(data)) return { valid: true };
    const errors = (validator.errors ?? []).map(
      (e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`,
    );
    return { valid: false, errors };
  }
}

export function createAdapter(config: Record<string, unknown>): FeatSchemaAdapter {
  return new JsonSchemaAdapter(config);
}
