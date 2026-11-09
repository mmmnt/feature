// ADR-0024: the default ordering of a `has` is decided by the harness from the ACTIVE config's
// consistency — a sequence for anything but an eventual service, which is a multiset — because the
// generated file is the same in every tier.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, type HarnessCase } from "./src/index.js";

function projectWith(consistency: "strong" | "eventual"): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feat-ordering-"));
  writeFileSync(
    path.join(dir, "adapter.mjs"),
    `export function createAdapter() {
       return {
         setup: async () => {}, teardown: async () => {}, reset: async () => {}, startCapture: async () => {},
         stopCapture: async () => [
           { type: "B", payload: {}, timestamp: 2 }, { type: "A", payload: {}, timestamp: 1 },
         ],
         read: async () => [],
       };
     }\n`,
  );
  writeFileSync(
    path.join(dir, "feat.config.json"),
    JSON.stringify({
      featVersion: "1.0",
      schemas: { adapter: "@mmmnt/feat-schema-json" },
      services: { feed: { adapter: "./adapter.mjs", consistency, ...(consistency === "eventual" ? { convergenceTimeout: 10 } : {}) } },
      specs: { dir: ".", pattern: "*.feat", contractPattern: "*.contract.json", outputPattern: "{name}.test.ts" },
    }),
  );
  return path.join(dir, "feat.config.json");
}

const inline = { schemas: { S: { type: "object" } }, goldens: {} };
const wrote = (extra: Record<string, unknown> = {}): HarnessCase =>
  ({
    anchor: "t",
    name: "t",
    delivers: [],
    prediction: {
      type: "success",
      services: { feed: { ...extra, records: [{ type: "A", schemaName: "S" }, { type: "B", schemaName: "S" }] } },
    },
  }) as unknown as HarnessCase;

describe("default ordering follows the active config", () => {
  it("a strong service is a sequence: capture B,A does not satisfy A,B", async () => {
    const h = await createHarness({ configPath: projectWith("strong") });
    await expect(h.runCase(wrote(), inline)).rejects.toThrow(/Prediction violated/);
    await h.teardown();
  });
  it("an eventual service is a multiset: capture B,A satisfies A,B", async () => {
    const h = await createHarness({ configPath: projectWith("eventual") });
    await h.runCase(wrote(), inline);
    await h.teardown();
  });
  it("an ordering the spec wrote wins over the default", async () => {
    const h = await createHarness({ configPath: projectWith("strong") });
    await h.runCase(wrote({ ordering: "unordered" }), inline);
    await h.teardown();
  });
});
