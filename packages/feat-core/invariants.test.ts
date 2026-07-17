// INVARIANT TESTS — not spec-derived (invariant tier, outside scenario scope by design).
// INV-1 Parse Determinism: same .feat file + config = identical BuiltSpec IR, every invocation.
// Property-tested over the entire corpus; loc is absent from the Parse command surface
// (ADR-0013 companion ruling), so no stripping is needed here.

import { describe, it, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "./src/parse.ts";

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(PKG_DIR, "../..");
const CORPUS = path.join(REPO_ROOT, "corpus");

const exemplars = readdirSync(CORPUS).filter((d) =>
  existsSync(path.join(CORPUS, d, `${d}.feat`)),
);

describe("INV-1: parse determinism (property over the corpus)", () => {
  it("has a non-empty corpus to test against", () => {
    expect(exemplars.length).toBeGreaterThanOrEqual(8);
  });

  for (const dir of exemplars) {
    it(`${dir}: repeated parses are byte-identical`, async () => {
      const input = {
        spec: `../../corpus/${dir}/${dir}.feat`,
        config: `../../corpus/${dir}/feat.config.json`,
      };
      const runs = await Promise.all([parse(input), parse(input), parse(input)]);
      expect(runs[0]!.status).toBe("OK");
      const canonical = JSON.stringify(runs[0]!.body);
      expect(JSON.stringify(runs[1]!.body), `${dir}: run 2 diverged`).toBe(canonical);
      expect(JSON.stringify(runs[2]!.body), `${dir}: run 3 diverged`).toBe(canonical);
    });
  }
});
