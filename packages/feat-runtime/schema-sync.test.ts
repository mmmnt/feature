// The packaged copy of feat.config.schema.json must byte-match the repo-root
// source of truth (schemas/). copy-schema.mjs refreshes it on every build;
// this test fails if the copy is stale relative to a root schema edit.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.dirname(fileURLToPath(import.meta.url));

describe("packaged config schema", () => {
  it("matches the repo-root source of truth", () => {
    const packaged = readFileSync(path.join(PKG, "schemas/feat.config.schema.json"), "utf8");
    const root = readFileSync(path.join(PKG, "../../schemas/feat.config.schema.json"), "utf8");
    expect(packaged).toBe(root);
  });
});
