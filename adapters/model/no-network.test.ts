// SPEC-ADPMODEL-001: the adapter opens no network connection and calls no model. Its source imports Node's file
// system and path modules and @mmmnt/feat-types, nothing else, and names no network API.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "index.ts"), "utf8");

describe("@mmmnt/feat-adapter-model has no network surface", () => {
  it("imports only node:fs, node:path and @mmmnt/feat-types", () => {
    const imported = [...SOURCE.matchAll(/^\s*import\b[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
    expect(imported).toEqual(["@mmmnt/feat-types", "node:fs", "node:path"]);
    expect(SOURCE).not.toMatch(/\bimport\s*\(/);
    expect(SOURCE).not.toMatch(/\brequire\s*\(/);
  });

  it("names no network API", () => {
    expect(SOURCE).not.toMatch(/\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|node:(net|http|https|http2|dgram|dns|tls)\b/);
  });
});
