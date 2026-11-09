// ADR-0024: specs.exclude removes spec files from a tier's run, by glob relative to specs.dir.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSpecs } from "./src/pipeline.js";

function tree(files: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), "feat-exclude-"));
  for (const f of files) {
    mkdirSync(path.dirname(path.join(root, "specs", f)), { recursive: true });
    writeFileSync(path.join(root, "specs", f), "feat 1.0\n");
  }
  return root;
}

describe("discoverSpecs with specs.exclude", () => {
  const root = tree(["a.feat", "kafka/observe.feat", "kafka/broker.transport.feat", "x.transport.feat"]);
  const rel = (abs: string[]) => abs.map((p) => path.relative(path.join(root, "specs"), p));

  it("keeps everything when nothing is excluded", () => {
    expect(rel(discoverSpecs(root, "specs"))).toEqual(["a.feat", "kafka/broker.transport.feat", "kafka/observe.feat", "x.transport.feat"]);
  });
  it("removes the files a glob matches, at any depth with **", () => {
    expect(rel(discoverSpecs(root, "specs", ["**/*.transport.feat"]))).toEqual(["a.feat", "kafka/observe.feat"]);
  });
  it("a single * does not cross a directory", () => {
    expect(rel(discoverSpecs(root, "specs", ["*.transport.feat"]))).toEqual(["a.feat", "kafka/broker.transport.feat", "kafka/observe.feat"]);
  });
  it("a directory glob removes the directory", () => {
    expect(rel(discoverSpecs(root, "specs", ["kafka/**"]))).toEqual(["a.feat", "x.transport.feat"]);
  });
});
