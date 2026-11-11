// The probe's per-case docker calls must not stop the event loop (vitest's worker RPC times out after 60 s of it).
// A fake `docker` on PATH takes 400 ms; the loop must keep ticking while the call is pending.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error the probe fixtures are plain modules, not part of the package's typed sources
import { dockerAsync } from "./fixtures/docker-async.mjs";

// The assertion is the loop's ticks, not elapsed time; the budget only has to cover spawning sh on a loaded machine,
// which can exceed vitest's 5 s default when container-heavy suites run beside it.
describe("dockerAsync", { timeout: 30_000 }, () => {
  let dir = "";
  let pathBefore: string | undefined;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "feat-fake-docker-"));
    writeFileSync(path.join(dir, "docker"), '#!/bin/sh\nsleep 0.4\nif [ "$1" = fail ]; then echo "no such container" >&2; exit 1; fi\necho "$@"\n');
    chmodSync(path.join(dir, "docker"), 0o755);
    pathBefore = process.env.PATH;
    process.env.PATH = `${dir}${path.delimiter}${pathBefore ?? ""}`;
  });

  afterAll(() => {
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns docker's trimmed output while the event loop keeps running", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 20);
    try {
      expect(await dockerAsync(["inspect", "--format", "x", "c"])).toBe("inspect --format x c");
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(5);
  });

  it("rejects when docker exits non-zero", async () => {
    await expect(dockerAsync(["fail"])).rejects.toThrow(/no such container/);
  });
});
