// Founder ruling 2026-11-10, release finding c1.
//
// c1: a root `$id` on an inline contract schema re-bases its relative `$ref`s (JSON Schema, draft-07
// and 2020-12). A relative `$id` is a path under the PROJECT ROOT (the directory of feat.config.json,
// handed to the adapter as `projectRoot`), the same project-relative convention as a spec's
// `error RFC7807 from "contracts/adrs/error-format"`. Without a projectRoot the contract file's
// directory is the only anchor there is.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createAdapter } from "./src/index.js";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const CONTRACT = path.join(FIX, "features", "id-rebase.contract.json");
const entries = (JSON.parse(readFileSync(CONTRACT, "utf8")) as { schemas: Record<string, Record<string, unknown>> }).schemas;

describe("a root $id re-bases relative refs", () => {
  it("resolves ../ against the project-relative $id, not the contract's directory (draft-07)", async () => {
    const adapter = createAdapter({ projectRoot: FIX });
    const resolved = await adapter.resolveInline!(entries.AccountRegistered!, CONTRACT);
    const ok = { envelope: { eventId: "x".repeat(36), occurredAt: "2026-01-01" }, accountId: "acct_1" };
    expect(adapter.validate(ok, resolved)).toEqual({ valid: true });
    // the envelope's constraints travel with it: occurredAt is required there
    const bad = adapter.validate({ envelope: { eventId: "x".repeat(36) }, accountId: "acct_1" }, resolved);
    expect(bad.valid).toBe(false);
    expect(bad.errors?.join(" ")).toContain("occurredAt");
    // the root keeps its $id
    expect(resolved.normalized.$id).toBe("contracts/identity/account-registered.json");
  });

  it("does the same under 2020-12", async () => {
    const adapter = createAdapter({ projectRoot: FIX });
    const resolved = await adapter.resolveInline!(entries.Draft2020!, CONTRACT);
    expect(adapter.validate({ envelope: { eventId: "x".repeat(36), occurredAt: "t" } }, resolved).valid).toBe(true);
    expect(adapter.validate({ envelope: { eventId: "short", occurredAt: "t" } }, resolved).valid).toBe(false);
  });

  it("leaves an absolute-URI $id alone: refs still resolve against the contract's directory", async () => {
    const adapter = createAdapter({ projectRoot: FIX });
    const resolved = await adapter.resolveInline!(entries.Absolute!, CONTRACT);
    expect(adapter.validate({ envelope: { eventId: "x".repeat(36), occurredAt: "t" } }, resolved).valid).toBe(true);
  });

  it("without a projectRoot a relative $id keeps resolving against the contract's directory", async () => {
    const adapter = createAdapter({});
    await expect(adapter.resolveInline!(entries.AccountRegistered!, CONTRACT)).rejects.toThrow(
      /fixtures\/adrs\/event-envelope\.json' could not be read/,
    );
  });
});

