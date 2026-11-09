// The probe behind `RunHarnessCase` (SPEC-RT-002): build a harness from a fixture config whose adapters
// are the recording stub, run the cases in order, and answer what happened as data.
import path from "node:path";
import { createHarness, PredictionViolation, HarnessConfigurationError } from "../../src/index.ts";

const INLINE = { schemas: { Placed: { type: "object" } }, goldens: {} };

export async function runCases(input) {
  globalThis.__featHarnessProbe = { calls: [], readHint: undefined };
  const state = globalThis.__featHarnessProbe;
  const harness = await createHarness({ configPath: path.resolve(process.cwd(), input.config) });
  let outcome = "passed";
  const violations = [];
  try {
    for (const c of input.cases) {
      try {
        await harness.runCase(c, INLINE);
      } catch (e) {
        if (e instanceof PredictionViolation) {
          outcome = "failed";
          violations.push(...e.violations);
        } else if (e instanceof HarnessConfigurationError) {
          const body = { code: e.code, calls: state.calls.join(" "), detail: e.message };
          if (e.service !== undefined) body.service = e.service;
          if (e.mode !== undefined) body.mode = e.mode;
          return { status: "ERR", body };
        } else throw e;
      }
    }
  } finally {
    await harness.teardown();
  }
  const body = { outcome, calls: state.calls.join(" ") };
  if (state.readHint !== undefined) body.readHint = state.readHint;
  if (violations.length > 0) body.violations = violations;
  return { status: "OK", body };
}
