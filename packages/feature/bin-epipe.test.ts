// A reader that closes stdout early (`feat lint | head -1`) ends the CLI with exit 0 and no warning, as it did
// on @oclif/core 4. On 5, execute() awaits a flush that waits for a 'drain' a closed pipe never emits behind an
// unref'd timer, so the top-level await in bin/run.js is left unsettled: Node prints a warning and exits 13.
// Requires `pnpm build`.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(PKG, "bin/run.js");

function featClosedEarly(args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [BIN, ...args], { cwd: PKG, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (stderr += d));
    child.stdout.once("data", () => child.stdout.destroy());
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

describe("a reader that closes stdout early", () => {
  it("leaves feat --help with exit 0 and no unsettled top-level await", async () => {
    const r = await featClosedEarly(["--help"]);
    expect(r.stderr).not.toContain("unsettled top-level await");
    expect(r.code).toBe(0);
  });
});
