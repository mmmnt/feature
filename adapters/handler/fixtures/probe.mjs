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

// ── SPEC-ADPHND-003: ProbeHandlerRoutes ──
//   routes: comma-separated route names from ROUTES below
//   script mode:  setup | setup:<Route,...> | invoke:<Route> | teardown | imports
//   harness mode: harness: <Route,...>, a real harness over a config with those routes, one case per command
// Each call copies fixtures/routes/ to a fresh project root under .feature/, so every module is evaluated
// anew; each module appends its file name to globalThis.__featHandlerRouteImports when it is evaluated.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";

const ROUTES = {
  Alpha: { module: "alpha.mjs", export: "alpha" },
  AlphaTwo: { module: "alpha.mjs", export: "alphaTwo" },
  Beta: { module: "beta.mjs", export: "beta" },
  Missing: { module: "missing.mjs", export: "missing" },
  Throws: { module: "throws.mjs", export: "throws" },
  NoExport: { module: "noexport.mjs", export: "handler" },
  NotFunction: { module: "notfunction.mjs", export: "handler" },
};
const ROUTE_FIXTURES = path.join(path.dirname(HANDLERS), "routes");
const REPO = path.resolve(path.dirname(HANDLERS), "../../..");

export async function probeRoutes(input) {
  const names = String(input.routes).split(",");
  const commands = Object.fromEntries(names.map((n) => [n, ROUTES[n]]));
  mkdirSync(path.join(REPO, ".feature"), { recursive: true });
  const root = mkdtempSync(path.join(REPO, ".feature", "handler-routes-"));
  cpSync(ROUTE_FIXTURES, root, { recursive: true });
  const imports = (globalThis.__featHandlerRouteImports = []);
  const shown = () => `imports=${imports.length > 0 ? imports.join(",") : "none"}`;
  const refused = (e) => {
    if (e && e.code === "ROUTE_UNLOADABLE") return { status: "ERR", body: { code: e.code, detail: e.message } };
    throw e;
  };
  try {
    if (input.harness !== undefined) {
      const configPath = path.join(root, "feat.config.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          featVersion: "1.0",
          schemas: { adapter: "@mmmnt/feat-schema-json" },
          response: { adapter: path.resolve(path.dirname(HANDLERS), "../src/index.ts"), commands },
          services: { store: { adapter: path.resolve(path.dirname(HANDLERS), "../../memory/src/index.ts"), consistency: "strong" } },
          specs: { dir: ".", pattern: "**/*.feat", contractPattern: "**/*.contract.json", outputPattern: "{name}.test.ts" },
        }),
      );
      const cases = String(input.harness)
        .split(",")
        .map((command, i) => ({ anchor: `c${i + 1}`, name: `c${i + 1}`, when: { command, payload: {} }, prediction: { type: "success", services: { store: { records: [] } } } }));
      let harness;
      try {
        harness = await createHarness({ configPath, cases });
      } catch (e) {
        return refused(e);
      }
      await harness.teardown();
      return { status: "OK", body: { trace: `harness:ready ${shown()}` } };
    }
    const adapter = createAdapter({ projectRoot: root, commands });
    const trace = [];
    try {
      for (const step of String(input.script).split(" ")) {
        if (step === "setup") await adapter.setup({});
        else if (step.startsWith("setup:")) await adapter.setup({}, { commands: step.slice("setup:".length).split(",") });
        else if (step.startsWith("invoke:")) await adapter.invoke(step.slice("invoke:".length), {});
        else if (step === "teardown") await adapter.teardown();
        else if (step === "imports") {
          trace.push(shown());
          continue;
        } else throw new Error(`unknown probe step '${step}'`);
        trace.push(step);
      }
    } catch (e) {
      return refused(e);
    } finally {
      await adapter.teardown();
    }
    return { status: "OK", body: { trace: trace.join(" ") } };
  } finally {
    rmSync(root, { recursive: true, force: true });
    delete globalThis.__featHandlerRouteImports;
  }
}
