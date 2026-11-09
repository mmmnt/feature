// The probe behind `ObserveFs` (SPEC-ADPFS-001): runs a script against an fs adapter scoped to a scratch directory.
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter } from "../src/index.ts";

export async function observe(input) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "feat-fs-observe-"));
  try {
    const adapter = createAdapter({ projectRoot: dir, options: { scope: "." } });
    const trace = [];
    let lastTypes;
    let lastPeek;
    let peekEqualsStop;
    for (const step of input.script.split(/\s+/).filter(Boolean)) {
      if (step.startsWith("write:")) {
        writeFileSync(path.join(dir, step.slice("write:".length)), "x");
        trace.push(step);
      } else if (step.startsWith("delete:")) {
        unlinkSync(path.join(dir, step.slice("delete:".length)));
        trace.push(step);
      } else if (step === "start") {
        await adapter.startCapture();
        trace.push(step);
      } else if (step === "peek") {
        lastPeek = await adapter.peekCapture();
        lastTypes = lastPeek.map((r) => r.type).join(",");
        trace.push(`peek=${lastPeek.length}`);
      } else if (step === "stop") {
        const records = await adapter.stopCapture();
        lastTypes = records.map((r) => r.type).join(",");
        if (lastPeek !== undefined) peekEqualsStop = JSON.stringify(lastPeek) === JSON.stringify(records);
        lastPeek = undefined;
        trace.push(`stop=${records.length}`);
      } else if (step === "settle") {
        trace.push(`settle=${await adapter.settle()}`);
      } else throw new Error(`unknown step '${step}'`);
    }
    const body = { trace: trace.join(" ") };
    if (lastTypes) body.lastTypes = lastTypes;
    if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
    return { status: "OK", body };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
