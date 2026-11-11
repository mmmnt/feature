// The probes behind `PlanRun` and `PreflightSerial` (SPEC-RT-005).
import path from "node:path";
import { faultsOf, plan, runPlan } from "../src/plan.ts";
import { createHarness, HarnessConfigurationError } from "../../feat-runtime/src/index.ts";

export async function planRun(input) {
  const specs = input.specs ?? [];
  // A spec gives its faults, or its IR cases for the sweep feat run applies (faultsOf).
  const faultsFor = (s) => s.faults ?? (s.cases === undefined ? [] : faultsOf(s.cases, input.exclusive));
  const p = plan(specs.map((s) => ({ path: s.path, faults: faultsFor(s) })), input.exclusive);
  const body = {
    parallel: p.parallel.join(","),
    serial: p.serial.join(","),
    order: p.order,
    serialWorkers: p.serialWorkers,
  };
  if (specs.some((s) => s.outcome !== undefined)) {
    const outcome = new Map(specs.map((s) => [s.path, s.outcome ?? "passed"]));
    const reported = [];
    const r = runPlan(p, (files) => {
      for (const f of files) reported.push(`${f}=${outcome.get(f)}`);
      return files.some((f) => outcome.get(f) === "failed") ? 1 : 0;
    });
    body.exit = r.exitCode;
    body.reported = reported.join(",");
  }
  return { status: "OK", body };
}

export async function preflightSerial(input) {
  const [operation, fault] = input.fault.split(".");
  const saved = process.env.FEAT_SERIAL;
  if (input.worker === "serial") process.env.FEAT_SERIAL = "1";
  else delete process.env.FEAT_SERIAL;
  const harness = await createHarness({ configPath: path.resolve(process.cwd(), "packages/feat-runner/fixtures/serial.config.json") });
  try {
    await harness.runCase(
      {
        anchor: "c1",
        name: "c1",
        given: { faults: [{ service: "store", operation, fault, times: "reset" }] },
        when: { command: "Ping", payload: {} },
        prediction: { type: "success", services: { store: { records: [] } } },
      },
      { schemas: {}, goldens: {} },
    );
  } catch (e) {
    if (e instanceof HarnessConfigurationError) return { status: "ERR", body: { code: e.code, detail: e.message } };
    throw e;
  } finally {
    await harness.teardown();
    if (saved === undefined) delete process.env.FEAT_SERIAL;
    else process.env.FEAT_SERIAL = saved;
  }
  return { status: "OK", body: { order: "armed" } };
}
