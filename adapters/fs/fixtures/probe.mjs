// The probe behind `ObserveFs` (SPEC-ADPFS-001, SPEC-ADPFS-002): runs a script against an fs adapter whose project
// root is a scratch directory. `options` is handed to the adapter as is (default { scope: "." }).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "../src/index.ts";

const ARCHIVES = path.join(path.dirname(fileURLToPath(import.meta.url)), "archives");

/** Every file and directory under `dir`, walked with fs (so the names the adapter skips are listed too), sorted. */
function list(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      out.push(path.relative(dir, p).split(path.sep).join("/"));
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

export async function observe(input) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "feat-fs-observe-"));
  try {
    const options = input.options ?? { scope: "." };
    const adapter = createAdapter({ projectRoot: dir, options });
    const scope = path.resolve(dir, typeof options.scope === "string" ? options.scope : ".");
    const trace = [];
    let lastTypes;
    let lastPeek;
    let lastPayloads;
    let peekEqualsStop;
    const at = (rel) => {
      const p = path.join(dir, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      return p;
    };
    try {
      for (const step of input.script.split(/\s+/).filter(Boolean)) {
        if (step.startsWith("write:")) {
          writeFileSync(at(step.slice("write:".length)), "x");
          trace.push(step);
        } else if (step.startsWith("delete:")) {
          unlinkSync(path.join(dir, step.slice("delete:".length)));
          trace.push(step);
        } else if (step.startsWith("mkdir:")) {
          mkdirSync(path.join(dir, step.slice("mkdir:".length)), { recursive: true });
          trace.push(step);
        } else if (step.startsWith("put:")) {
          const [fixture, dest] = step.slice("put:".length).split(":");
          copyFileSync(path.join(ARCHIVES, fixture), at(dest));
          trace.push(step);
        } else if (step === "ls") {
          trace.push(`ls=${existsSync(scope) ? list(scope).join(",") : "absent"}`);
        } else if (step === "setup") {
          await adapter.setup();
          trace.push(step);
        } else if (step === "reset") {
          await adapter.reset();
          trace.push(step);
        } else if (step === "start") {
          await adapter.startCapture();
          trace.push(step);
        } else if (step === "peek") {
          lastPeek = await adapter.peekCapture();
          lastTypes = lastPeek.map((r) => r.type).join(",");
          lastPayloads = lastPeek.map((r) => r.payload);
          trace.push(`peek=${lastPeek.length}`);
        } else if (step === "stop") {
          const records = await adapter.stopCapture();
          lastTypes = records.map((r) => r.type).join(",");
          lastPayloads = records.map((r) => r.payload);
          if (lastPeek !== undefined) peekEqualsStop = JSON.stringify(lastPeek) === JSON.stringify(records);
          lastPeek = undefined;
          trace.push(`stop=${records.length}`);
        } else if (step === "settle") {
          trace.push(`settle=${await adapter.settle()}`);
        } else throw new Error(`unknown step '${step}'`);
      }
    } catch (e) {
      if (typeof e?.code === "string" && e.name === "FsAdapterError") return { status: "ERR", body: { code: e.code, detail: e.message } };
      throw e;
    }
    const body = { trace: trace.join(" ") };
    if (lastTypes) body.lastTypes = lastTypes;
    if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
    // lastPayloads is SPEC-ADPFS-002's: answered only when the case hands options, so SPEC-ADPFS-001's answers are as before.
    if (input.options !== undefined && lastPayloads !== undefined && lastPayloads.length > 0) body.lastPayloads = lastPayloads;
    return { status: "OK", body };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
