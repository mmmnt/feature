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
        } else if (e instanceof Error && typeof e.code !== "string") {
          // SPEC-RT-009: an uncoded Error the harness throws for a malformed case (CASE_THREW is the probe's label).
          return { status: "ERR", body: { code: "CASE_THREW", calls: state.calls.join(" "), detail: e.message } };
        } else throw e;
      }
    }
  } finally {
    await harness.teardown();
  }
  const body = { outcome, calls: state.calls.join(" ") };
  if (state.readHint !== undefined) body.readHint = state.readHint;
  if (violations.length > 0) {
    body.violations = violations;
    body.violationCodes = violations.map((v) => /^([A-Z_]+):/.exec(v)?.[1]).filter(Boolean).join(",");
  }
  if (state.armedDetail !== undefined) body.armedDetail = state.armedDetail;
  return { status: "OK", body };
}

// ── SPEC-RT-008: BuildHarness ──
// Build a harness (with the input's cases when it has them) and run nothing: answer what the response
// stub's setup() was handed, or the configuration error createHarness threw.
export async function buildHarness(input) {
  globalThis.__featHarnessProbe = { calls: [], readHint: undefined };
  const state = globalThis.__featHarnessProbe;
  let harness;
  try {
    harness = await createHarness({
      configPath: path.resolve(process.cwd(), input.config),
      ...(input.cases !== undefined ? { cases: input.cases } : {}),
    });
  } catch (e) {
    if (e instanceof HarnessConfigurationError) return { status: "ERR", body: { code: e.code, detail: e.message } };
    throw e;
  }
  await harness.teardown();
  return { status: "OK", body: { setup: state.setup } };
}

// ── SPEC-RT-007: RunOverlappingCases ──
// The held case is started and not awaited; its trigger blocks in the stub until release(). The next
// case runs to the end, then the held invoke is released and the held case is awaited.
export async function runOverlapping(input) {
  globalThis.__featHarnessProbe = { calls: [], readHint: undefined };
  const state = globalThis.__featHarnessProbe;
  const harness = await createHarness({ configPath: path.resolve(process.cwd(), input.config) });
  const outcomeOf = (p) =>
    p.then(
      () => "passed",
      (e) => (typeof e?.code === "string" ? e.code : e instanceof PredictionViolation ? "failed" : Promise.reject(e)),
    );
  try {
    const held = outcomeOf(harness.runCase(input.held, INLINE));
    while (state.release === undefined) await new Promise((r) => setImmediate(r));
    const next = await outcomeOf(harness.runCase(input.next, INLINE));
    state.release();
    return { status: "OK", body: { next, held: await held, calls: state.calls.join(" ") } };
  } finally {
    await harness.teardown();
  }
}

// ── SPEC-RT-006: RunHarnessNamespace ──
import { assertNoNamespaceCollision, deriveNamespace, normalizeSpecPath, NAMESPACE_PATTERN } from "../../src/index.ts";

export async function runNamespace(input) {
  const st = (globalThis.__featNamespaceProbe = { trace: [], hostKind: input.hostKind, hostEcho: input.hostEcho ?? "ok", serviceEcho: input.serviceEcho });
  const configName = { configured: "namespace-configured", "configured-overlay": "namespace-configured-overlay" }[input.config ?? ""] ?? "namespace";
  const configPath = path.resolve(process.cwd(), `packages/feat-runtime/fixtures/harness/${configName}.config.json`);
  const configDir = path.dirname(configPath);
  const specs = input.specs ?? [];
  const digest = input.digest === "collide" ? () => "abcdef0123456789" : undefined;
  const envName = input.env;
  const prior = envName ? process.env[envName] : undefined;
  const harnesses = [];
  const fail = (e) => {
    if (typeof e?.code !== "string") throw e;
    return { status: "ERR", body: { code: e.code, trace: st.trace.join(" "), detail: e.message } };
  };
  try {
    assertNoNamespaceCollision(specs, configDir, digest);
    for (const specPath of specs) harnesses.push(await createHarness({ configPath, specPath }));
    for (const h of harnesses) {
      for (let i = 1; i <= (input.cases ?? 0); i++) {
        st.trace.push(`case:c${i}`);
        await h.runCase(
          { anchor: `c${i}`, name: `c${i}`, when: { command: "Ping", payload: {} }, prediction: { type: "success", services: { store: { records: input.wrongPrediction ? [{ type: "Never", schemaName: "S" }] : [] } } } },
          { schemas: { S: { type: "object" } }, goldens: {} },
        );
        if (envName) st.trace.push(`env=${process.env[envName]}`);
      }
    }
  } catch (e) {
    for (const h of harnesses.reverse()) await h.teardown();
    return fail(e);
  }
  if (envName) st.trace.push("teardown");
  for (const h of harnesses.reverse()) await h.teardown();
  if (envName) st.trace.push(process.env[envName] === prior ? "env=restored" : `env=${process.env[envName]}`);
  const namespaces = specs.map((sp) => `${normalizeSpecPath(sp, configDir)}=${deriveNamespace(sp, configDir)}`);
  return {
    status: "OK",
    body: {
      namespaces: namespaces.join(","),
      trace: st.trace.join(" "),
      valid: specs.every((sp) => NAMESPACE_PATTERN.test(deriveNamespace(sp, configDir))),
    },
  };
}
