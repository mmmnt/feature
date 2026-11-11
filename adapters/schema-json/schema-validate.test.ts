// Founder ruling 2026-11-10, release finding c2: validate() is idempotent across calls on one
// adapter. The same $id-bearing schema, validated twice (two specs sharing
// `event X from "contracts/identity/account-registered"`, or the seed check running per spec),
// compiles once; a DIFFERENT schema claiming a taken $id is a coded error, never an Ajv crash.
import { describe, expect, it } from "vitest";
import { createAdapter } from "./src/index.js";
import type { ResolvedSchema } from "@mmmnt/feat-types";

const wrap = (normalized: Record<string, unknown>, id = "x"): ResolvedSchema => ({
  id,
  format: "json-schema",
  raw: normalized,
  normalized,
});

describe("c2 — validate() is idempotent across calls", () => {
  const schema = (): Record<string, unknown> => ({
    $id: "contracts/identity/account-registered.json",
    type: "object",
    required: ["accountId"],
    properties: { accountId: { type: "string" } },
  });

  it("validates the same $id-bearing schema repeatedly, across 2020-12 too", () => {
    const adapter = createAdapter({});
    for (const dialect of [undefined, "https://json-schema.org/draft/2020-12/schema"]) {
      const s = { ...schema(), ...(dialect ? { $schema: dialect, $id: "contracts/other.json" } : {}) };
      expect(adapter.validate({ accountId: "a" }, wrap(s))).toEqual({ valid: true });
      expect(adapter.validate({ accountId: "a" }, wrap({ ...s }))).toEqual({ valid: true });
      expect(adapter.validate({}, wrap(s)).valid).toBe(false);
    }
  });

  it("refuses a different schema claiming a taken $id with a coded error", () => {
    const adapter = createAdapter({});
    adapter.validate({ accountId: "a" }, wrap(schema()));
    const other = { ...schema(), required: [] };
    let thrown: unknown;
    try {
      adapter.validate({}, wrap(other));
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { code?: string }).code).toBe("SCHEMA_ID_CONFLICT");
    expect((thrown as Error).message).toContain("contracts/identity/account-registered.json");
  });
});
