// `feat run --shard i/n` — split one suite across machines that share NOTHING.
//
// A suite whose services share one store must run its files one at a time (a capture window
// over a shared log bleeds between concurrent files). The way to run it in parallel is to run it
// on separate stores: N jobs, each with its own instruments, each taking a disjoint slice of the
// generated files. These are the laws that make the slices safe to hand to N machines.
import { describe, expect, it } from "vitest";
import { parseShard, selectShard, shardJunitPath } from "./src/shard.js";

const files = ["c.test.ts", "a.test.ts", "e.test.ts", "b.test.ts", "d.test.ts"];

describe("feat run --shard", () => {
  it("every file runs in exactly one shard — the slices partition the suite", () => {
    const slices = [1, 2, 3].map((i) => selectShard(files, { index: i, total: 3 }));
    const all = slices.flat().sort();
    expect(all).toEqual([...files].sort());
    expect(new Set(all).size).toBe(files.length);
  });

  it("a slice does not depend on the order the files were listed in", () => {
    const reversed = [...files].reverse();
    expect(selectShard(reversed, { index: 2, total: 3 })).toEqual(selectShard(files, { index: 2, total: 3 }));
  });

  it("slices are balanced to within one file", () => {
    const sizes = [1, 2, 3].map((i) => selectShard(files, { index: i, total: 3 }).length);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
  });

  it("parses i/n, and refuses what cannot be a slice", () => {
    expect(parseShard("2/4")).toEqual({ index: 2, total: 4 });
    for (const bad of ["0/4", "5/4", "2", "a/b", "2/0", "-1/3"]) {
      expect(() => parseShard(bad), bad).toThrow(/--shard/);
    }
  });

  it("each shard writes its own junit file, so parallel evidence never collides", () => {
    expect(shardJunitPath(".feature/run/feat-junit.xml", { index: 2, total: 4 })).toBe(
      ".feature/run/feat-junit.shard-2-of-4.xml"
    );
    expect(shardJunitPath(".feature/run/feat-junit.xml", undefined)).toBe(".feature/run/feat-junit.xml");
  });
});
