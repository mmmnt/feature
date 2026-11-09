// The packaged copy of the protocol schema must byte-match the repo-root source of truth.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.dirname(fileURLToPath(import.meta.url));

describe("packaged protocol schema", () => {
  it("matches the repo-root source of truth", () => {
    expect(readFileSync(path.join(PKG, "schemas/feat-host-protocol.schema.json"), "utf8")).toBe(
      readFileSync(path.join(PKG, "../../schemas/feat-host-protocol.schema.json"), "utf8"),
    );
  });
});
