// Generate-path proof for founder ruling 2026-11-10, release findings c1 and c2, on a project shaped like
// a consumer's layout: specs under features/, shared schemas under contracts/ at the project root. Two specs carry
// the same `$id`-bearing inline schema (c2: the seed check validates it twice on one adapter), and that
// schema's relative `$id` re-bases its `../` `$ref` to contracts/adrs/ (c1), not to features/adrs/.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateAll } from "./src/pipeline.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/schema-id");

async function generate(root: string): Promise<{ outputPath: string; content: string }[]> {
  const cwd = process.cwd();
  process.chdir(root);
  try {
    return await generateAll(root, "feat.config.json");
  } finally {
    process.chdir(cwd);
  }
}

describe("generate with a root $id on an inline schema", () => {
  it("generates both specs: the shared $id validates twice and its ../ ref lands in contracts/adrs", async () => {
    const files = await generate(FIXTURE);
    expect(files).toHaveLength(2);
    for (const f of files) {
      // the envelope was bundled (no $ref leaves the file) and carries its own constraints
      expect(f.content).toContain("occurredAt");
      for (const m of f.content.matchAll(/"\$ref":\s*"([^"]*)"/g)) expect(m[1]).toMatch(/^#/);
      expect(f.content).toContain("contracts/identity/account-registered.json");
    }
  });
});
