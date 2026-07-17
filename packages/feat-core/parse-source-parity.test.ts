// parseSource (text-based) must be indistinguishable from parse() (file-based):
// every corpus exemplar, parsed from source text with a context derived from its
// own config, must produce the checked-in expected IR byte-for-byte. The corpus
// is the parser's ground truth; this locks the embedder surface to it.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contextFromConfig, parseSource } from "./src/parse.js";

const CORPUS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../corpus");

const exemplars = readdirSync(CORPUS).filter((d) => existsSync(path.join(CORPUS, d, `${d}.feat`)));

describe("parseSource corpus parity", () => {
  it("found the corpus", () => {
    expect(exemplars.length).toBeGreaterThanOrEqual(9);
  });

  for (const name of exemplars) {
    it(`${name}: text parse === expected IR`, () => {
      const dir = path.join(CORPUS, name);
      const source = readFileSync(path.join(dir, `${name}.feat`), "utf8");
      const config = JSON.parse(readFileSync(path.join(dir, "feat.config.json"), "utf8"));
      const expected = JSON.parse(readFileSync(path.join(dir, `${name}.ir.json`), "utf8"));
      const result = parseSource(source, contextFromConfig(config));
      expect(result.status).toBe("OK");
      expect(result.body).toEqual(expected);
    });
  }
});
