// Dialect follows the document. Bundling preserves the bundle ROOT's `$schema`, so a
// draft/2020-12 contract arrives in the generated test still declaring 2020-12 — and
// Ajv's default export is draft-07, which refuses to compile it at all. These are the
// two dialects a generated suite can actually carry, through the real matcher entry.
import { describe, expect, it } from "vitest";
import { diffResponse, type MatchContext } from "./src/matcher.js";

/** The shape the schema-json bundler emits: referenced documents relocated into $defs. */
const bundled2020 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://feat.dev/fixtures/flow-view.json",
  type: "object",
  required: ["flowId", "name"],
  additionalProperties: false,
  properties: {
    flowId: { $ref: "#/$defs/identifiers/$defs/uuid" },
    name: { $ref: "#/$defs/displayName" },
    // prefixItems is 2020-12 only — draft-07 Ajv ignores it, so its enforcement
    // below is itself evidence that the 2020 compiler ran.
    span: { type: "array", prefixItems: [{ type: "integer" }, { type: "integer" }] },
  },
  $defs: {
    displayName: { type: "string", minLength: 1 },
    identifiers: { $defs: { uuid: { type: "string", format: "uuid" } } },
  },
};

const bundled07 = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["flowId", "name"],
  additionalProperties: false,
  properties: {
    flowId: { $ref: "#/definitions/identifiers/definitions/uuid" },
    name: { $ref: "#/definitions/displayName" },
  },
  definitions: {
    displayName: { type: "string", minLength: 1 },
    identifiers: { definitions: { uuid: { type: "string", format: "uuid" } } },
  },
};

const UUID = "5e2a7c90-1b3d-4e5f-8a6b-9c0d1e2f3a4b";

function violations(schema: object, body: Record<string, unknown> | null): string[] {
  const ctx: MatchContext = { inline: { schemas: { FlowView: schema }, goldens: {} } };
  const out: string[] = [];
  diffResponse({ status: 200, body }, { status: 200, schemaName: "FlowView" }, ctx, "SPEC", out);
  return out;
}

describe("schema validation is dialect-aware", () => {
  it("compiles and enforces a bundled draft/2020-12 schema", () => {
    expect(violations(bundled2020, { flowId: UUID, name: "Welcome" })).toEqual([]);
    expect(violations(bundled2020, { flowId: "nope", name: "Welcome" }).join(" ")).toContain("flowId");
    expect(violations(bundled2020, { flowId: UUID, name: "" }).join(" ")).toContain("name");
    // 2020-12 keyword: draft-07 would not know prefixItems and would let this pass.
    expect(violations(bundled2020, { flowId: UUID, name: "Welcome", span: ["a", 2] }).join(" ")).toContain("span");
  });

  it("still compiles and enforces draft-07", () => {
    expect(violations(bundled07, { flowId: UUID, name: "Welcome" })).toEqual([]);
    expect(violations(bundled07, { flowId: "nope", name: "Welcome" }).join(" ")).toContain("flowId");
    expect(violations(bundled07, { flowId: UUID, name: "" }).join(" ")).toContain("name");
  });

  it("caches per schema, not per name — two dialects under one name stay apart", () => {
    // A suite that validated a 2020-12 document must not hand its validator to a
    // draft-07 document that happens to share the schema name, or the reverse.
    const body = { flowId: UUID, name: "Welcome", span: [1, 2] };
    expect(violations(bundled2020, body)).toEqual([]);
    // The draft-07 document declares no `span` at all — its verdict must be its own.
    expect(violations(bundled07, body).join(" ")).toContain("must NOT have additional properties");
    expect(violations(bundled2020, body)).toEqual([]);
    expect(violations(bundled2020, { flowId: UUID, name: "Welcome", span: ["a", 2] }).join(" ")).toContain("span");
  });
});
