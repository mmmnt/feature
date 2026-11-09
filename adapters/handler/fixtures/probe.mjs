// The probe behind `ProbeHandlerClock` (SPEC-ADPHND-001): create the handler adapter, run a
// space-separated script against it and answer the trace. Test fixture, not shipped.
//   clock:<iso> | clock:null | invoke:Now | invoke:Legacy
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "../src/index.ts";

const HANDLERS = path.join(path.dirname(fileURLToPath(import.meta.url)), "handlers.mjs");

export async function probe(input) {
  const adapter = createAdapter({
    projectRoot: path.dirname(HANDLERS),
    commands: {
      Now: { module: "handlers.mjs", export: "now" },
      Legacy: { module: "handlers.mjs", export: "legacy" },
    },
    actors: { default: "operator", operator: { role: "operator" } },
  });
  const trace = [];
  try {
    for (const step of String(input.script).split(" ")) {
      if (step.startsWith("clock:")) {
        const value = step.slice("clock:".length);
        await adapter.setClock(value === "null" ? null : value);
        trace.push(step);
      } else if (step === "invoke:Now") {
        const { body } = await adapter.invoke("Now", {});
        trace.push(
          body.frozen
            ? `invoke:Now now=${body.now} iso=${body.iso} frozen=true`
            : `invoke:Now frozen=false wall=${Math.abs(body.now - Date.now()) < 60_000}`,
        );
      } else if (step === "invoke:Legacy") {
        const { body } = await adapter.invoke("Legacy", {});
        trace.push(`invoke:Legacy role=${body.role}`);
      } else throw new Error(`unknown probe step '${step}'`);
    }
  } catch (e) {
    if (e && e.code === "INVALID_CLOCK") return { status: "ERR", body: { code: e.code, detail: e.message } };
    throw e;
  } finally {
    await adapter.teardown();
  }
  return { status: "OK", body: { trace: trace.join(" ") } };
}
