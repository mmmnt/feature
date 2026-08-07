// Resolution is compile-time only: whatever `resolve()` returns as `normalized` is
// inlined verbatim into a generated test that lives in a DIFFERENT directory than the
// contract it came from. A relative cross-file `$ref` authored against the contract's
// directory is meaningless there — the base URI is lost in transit — so `normalized`
// must already be self-contained. These fixtures are draft-07 throughout.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAdapter } from "./src/index.js";
import type { ResolvedSchema } from "@mmmnt/feat-types";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const CONTRACT = path.join(PKG, "fixtures", "features", "account.contract.json");

const contractRefs = (
  JSON.parse(readFileSync(CONTRACT, "utf8")) as { schemas: Record<string, { $ref: string }> }
).schemas;

/** What the generate pipeline does to `normalized`: serialise it into a file elsewhere. */
function inline(resolved: ResolvedSchema): ResolvedSchema {
  return { ...resolved, normalized: JSON.parse(JSON.stringify(resolved.normalized)) as Record<string, unknown> };
}

function refsIn(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) for (const n of node) refsIn(n, out);
  else if (typeof node === "object" && node !== null)
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") out.push(v);
      else refsIn(v, out);
    }
  return out;
}

describe("resolve() produces a self-contained schema", () => {
  it("carries a cross-file $ref's target with it", async () => {
    const adapter = createAdapter({});
    const resolved = await adapter.resolve(contractRefs.AccountRegistered!.$ref, CONTRACT);

    // No reference may point outside the document: once inlined there is no base URI left.
    for (const ref of refsIn(resolved.normalized)) expect(ref).toMatch(/^#/);

    const valid = {
      eventId: "11111111-2222-3333-4444-555555555555",
      occurredAt: "2026-08-07T00:00:00Z",
      accountId: "acct_123",
    };
    expect(adapter.validate(valid, inline(resolved))).toEqual({ valid: true });
  });

  it("still enforces the referenced document's constraints", async () => {
    const adapter = createAdapter({});
    const resolved = inline(await adapter.resolve(contractRefs.AccountRegistered!.$ref, CONTRACT));

    // `occurredAt` comes only from the referenced envelope — if the ref were dropped
    // rather than resolved, this payload would wrongly pass.
    const result = adapter.validate({ eventId: "x".repeat(36), accountId: "acct_1" }, resolved);
    expect(result.valid).toBe(false);
    expect(result.errors?.join(" ")).toContain("occurredAt");
  });

  it("preserves internal #/$defs pointers rather than flattening them", async () => {
    const adapter = createAdapter({});
    const resolved = await adapter.resolve(contractRefs.AccountRegistered!.$ref, CONTRACT);
    expect(refsIn(resolved.normalized)).toContain("#/$defs/accountId");
  });

  it("leaves raw verbatim", async () => {
    const adapter = createAdapter({});
    const resolved = await adapter.resolve(contractRefs.AccountRegistered!.$ref, CONTRACT);
    const onDisk = JSON.parse(
      readFileSync(path.join(PKG, "fixtures/contracts/identity/account-registered.json"), "utf8"),
    ) as unknown;
    expect(resolved.raw).toEqual(onDisk);
  });

  it("terminates on a cyclic cross-file reference", async () => {
    const adapter = createAdapter({});
    const resolved = inline(await adapter.resolve(contractRefs.Node!.$ref, CONTRACT));
    for (const ref of refsIn(resolved.normalized)) expect(ref).toMatch(/^#/);

    expect(adapter.validate({ id: "a", edges: [{ to: { id: "b" }, weight: 1 }] }, resolved)).toEqual({
      valid: true,
    });
    expect(adapter.validate({ id: "a", edges: [{ weight: 1 }] }, resolved).valid).toBe(false);
  });
});
