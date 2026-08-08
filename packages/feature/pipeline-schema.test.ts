// Generate-path proof for schema resolution (INV-10). The pipeline resolves contract
// `$ref`s through the adapter named by `schemas.adapter`, and what that adapter returns
// is what lands in the generated test — which lives in a different directory than the
// contract and resolves nothing at run time. So the assertion that matters is made on
// the PIPELINE's output, not on the adapter in isolation: no reference in a generated
// file may point outside the document.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffResponse, type MatchContext } from "@mmmnt/feat-runtime";
import { generateAll } from "./src/pipeline.js";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const PKG = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(PKG, "fixtures/schema-bundle");

/** Run the real generate pipeline the way the CLI does: from the project root. */
async function generate(root: string): Promise<{ outputPath: string; content: string }[]> {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return await generateAll(root, "feat.config.json");
  } finally {
    process.chdir(cwd);
  }
}

/** Every `$ref` string in a generated file, wherever it sits. */
function refsIn(text: string): string[] {
  return [...text.matchAll(/"\$ref":\s*"([^"]*)"/g)].map((m) => m[1] as string);
}

/** The `const INLINE: InlineData = { … };` block the emitter writes, as data. */
function inlineOf(content: string): { schemas: Record<string, Record<string, unknown>> } {
  const marker = "const INLINE: InlineData = ";
  const start = content.indexOf(marker) + marker.length;
  const end = content.indexOf("\n};\n", start);
  return JSON.parse(content.slice(start, end + 2)) as {
    schemas: Record<string, Record<string, unknown>>;
  };
}

describe("generate resolves contract schemas through the configured adapter", () => {
  it("emits a self-contained schema — no $ref leaves the generated file", async () => {
    const files = await generate(FIXTURE);
    expect(files).toHaveLength(1);
    const content = files[0]!.content;

    const refs = refsIn(content);
    // The fixture contract points at ./contracts/flow-view.json, which points at
    // ../shared/identifiers.json — both relative to the CONTRACT's directory.
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) expect(ref).toMatch(/^#/);
    expect(refs.some((r) => r.startsWith("#/$defs/"))).toBe(true);
  });

  it("keeps the referenced documents' constraints, compiled from the emitted schema", async () => {
    const files = await generate(FIXTURE);
    const schemas = inlineOf(files[0]!.content).schemas;

    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schemas.FlowViewResponse!);

    expect(
      validate({
        flowId: "5e2a7c90-1b3d-4e5f-8a6b-9c0d1e2f3a4b",
        tenantId: "7f0e8a52-4b1c-4d2e-9f3a-1b2c3d4e5f60",
        name: "Welcome",
      }),
    ).toBe(true);
    // `uuid` lives only in shared/identifiers.json — if the cross-file ref had been
    // dropped rather than bundled, this would wrongly pass.
    expect(
      validate({ flowId: "not-a-uuid", tenantId: "7f0e8a52-4b1c-4d2e-9f3a-1b2c3d4e5f60", name: "Welcome" }),
    ).toBe(false);
    // `displayName` lives in the referenced document's own `$defs`.
    expect(
      validate({
        flowId: "5e2a7c90-1b3d-4e5f-8a6b-9c0d1e2f3a4b",
        tenantId: "7f0e8a52-4b1c-4d2e-9f3a-1b2c3d4e5f60",
        name: "",
      }),
    ).toBe(false);
  });

  it("fails loudly when schemas.adapter cannot be loaded — never silently verbatim", async () => {
    const root = path.join(PKG, "fixtures/schema-bundle-missing-adapter");
    await expect(generate(root)).rejects.toThrow(/schemas\.adapter/);
  });

  // Bundling preserves the root's `$schema`, so a draft/2020-12 contract reaches the
  // generated test still declaring 2020-12. The runtime that reads it must agree.
  it("carries a draft/2020-12 contract through to a matcher that can compile it", async () => {
    const files = await generate(path.join(PKG, "fixtures/schema-bundle-2020"));
    const schemas = inlineOf(files[0]!.content).schemas;
    const schema = schemas.FlowViewResponse!;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    for (const ref of refsIn(JSON.stringify(schema))) expect(ref).toMatch(/^#/);

    const ctx: MatchContext = { inline: { schemas: { FlowView: schema }, goldens: {} } };
    const check = (body: Record<string, unknown>): string[] => {
      const out: string[] = [];
      diffResponse({ status: 200, body }, { status: 200, schemaName: "FlowView" }, ctx, "SPEC", out);
      return out;
    };
    const ok = {
      flowId: "5e2a7c90-1b3d-4e5f-8a6b-9c0d1e2f3a4b",
      tenantId: "7f0e8a52-4b1c-4d2e-9f3a-1b2c3d4e5f60",
      name: "Welcome",
      span: [1, 2],
    };
    expect(check(ok)).toEqual([]);
    // The cross-file `uuid` and the 2020-only `prefixItems` both had to survive.
    expect(check({ ...ok, flowId: "not-a-uuid" }).join(" ")).toContain("flowId");
    expect(check({ ...ok, span: ["a", 2] }).join(" ")).toContain("span");
  });
});
