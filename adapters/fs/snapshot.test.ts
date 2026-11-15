// The snapshot walk is asynchronous: a capture window over a large scope must not hold the caller's event loop.
// The harness awaits startCapture and stopCapture case after case; when the walk is synchronous, a suite of many
// cases never turns its loop between them, and on a slow filesystem (a container's bind mount) a vitest worker went
// 70 s without a turn and missed vitest's RPC timeout ("Timeout calling onTaskUpdate").
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAdapter } from "./src/index.js";

const root = mkdtempSync(path.join(tmpdir(), "feat-fs-walk-"));
for (let d = 0; d < 200; d++) {
  const dir = path.join(root, "scope", `d${d}`, "inner");
  mkdirSync(dir, { recursive: true });
  for (let f = 0; f < 10; f++) writeFileSync(path.join(dir, `f${f}.txt`), "x");
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the snapshot walk", () => {
  it("lets the event loop turn while it reads the scope", async () => {
    const adapter = createAdapter({ projectRoot: root, options: { scope: "scope" } });
    let turns = 0;
    const tick = () => {
      turns++;
      pending = setImmediate(tick);
    };
    let pending = setImmediate(tick);
    try {
      await adapter.startCapture();
      await adapter.stopCapture();
    } finally {
      clearImmediate(pending);
    }
    expect(turns).toBeGreaterThan(0);
  });

  it("still reports what was written and deleted in the window, and ignores a file gone before it is read", async () => {
    const adapter = createAdapter({ projectRoot: root, options: { scope: "scope" } });
    await adapter.startCapture();
    writeFileSync(path.join(root, "scope", "d0", "new.txt"), "y");
    rmSync(path.join(root, "scope", "d1", "inner", "f0.txt"));
    const records = await adapter.stopCapture();
    expect(records.map((r) => `${r.type} ${r.key}`).sort()).toEqual([
      `FILE_DELETED ${path.join("d1", "inner", "f0.txt")}`,
      `FILE_WRITTEN ${path.join("d0", "new.txt")}`,
    ]);
  });
});
