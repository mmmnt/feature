// The probe behind `ProbeHandlerClock` (SPEC-ADPHND-001): create the handler adapter, run a
// space-separated script against it and answer the trace. Test fixture, not shipped.
//   clock:<iso> | clock:null | invoke:Now | invoke:Legacy
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "../src/index.ts";
import { createHarness } from "../../../packages/feat-runtime/src/index.ts";

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

// ── SPEC-ADPHND-002: ProbeHandlerNamespace ──
//   script mode:  invoke:Namespace | invoke:Quiet | invoke:Legacy | clock:<iso> | report
//   harness mode: harness (Namespace | Quiet | Legacy) + spec, a real harness over fixtures/namespace.config.json
export async function probeNamespace(input) {
  if (input.harness !== undefined) return harnessMode(input);
  const adapter = createAdapter({
    projectRoot: path.dirname(HANDLERS),
    commands: {
      Namespace: { module: "handlers.mjs", export: "namespace", namespace: true },
      Quiet: { module: "handlers.mjs", export: "quiet", namespace: true },
      Legacy: { module: "handlers.mjs", export: "legacy", namespace: true },
      Plain: { module: "handlers.mjs", export: "quiet" },
    },
    actors: { default: "operator", operator: { role: "operator" } },
    ...(input.namespace !== undefined ? { namespace: input.namespace } : {}),
  });
  const trace = [];
  try {
    for (const step of String(input.script).split(" ")) {
      if (step.startsWith("clock:")) {
        await adapter.setClock(step.slice("clock:".length));
        trace.push(step);
      } else if (step === "invoke:Namespace") {
        const { body } = await adapter.invoke("Namespace", {});
        trace.push(`invoke:Namespace ns=${body.ns ?? "none"}`);
      } else if (step === "invoke:Quiet" || step === "invoke:Plain") {
        await adapter.invoke(step.slice("invoke:".length), {});
        trace.push(step);
      } else if (step === "invoke:Legacy") {
        const { body } = await adapter.invoke("Legacy", {});
        trace.push(`invoke:Legacy role=${body.role}`);
      } else if (step === "report") {
        trace.push(`report=${(await adapter.reportedNamespace()) ?? "none"}`);
      } else throw new Error(`unknown probe step '${step}'`);
    }
  } finally {
    await adapter.teardown();
  }
  return { status: "OK", body: { trace: trace.join(" ") } };
}

async function harnessMode(input) {
  globalThis.__adphnd2Mode = input.harness;
  const configPath = path.resolve(path.dirname(HANDLERS), "namespace.config.json");
  let harness;
  try {
    harness = await createHarness({ configPath, ...(input.spec !== undefined ? { specPath: input.spec } : {}) });
    await harness.runCase(
      { anchor: "c1", name: "c1", when: { command: input.harness === "Plain" ? "PingPlain" : "Ping", payload: {} }, prediction: { type: "success", services: { store: { records: [] } } } },
      { schemas: {}, goldens: {} },
    );
    return { status: "OK", body: { trace: `case:${input.harness} passed` } };
  } catch (e) {
    if (e && typeof e.code === "string") return { status: "ERR", body: { code: e.code, detail: e.message } };
    throw e;
  } finally {
    if (harness) await harness.teardown();
    delete globalThis.__adphnd2Mode;
  }
}
