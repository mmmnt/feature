// The timing envelope is the one emit behavior the byte-lock gate cannot judge
// for correctness (verify locks whatever bytes emit produced) — so the formula
// is pinned here: per-invoke allowance × (executes + stimulus) + the shared
// convergence window + margin, and hooks carry their own timeout.
import { describe, expect, it } from "vitest";
import { emit, type EmitInputs } from "./src/index.js";

function inputs(overrides: Partial<EmitInputs> = {}): EmitInputs {
  return {
    topology: {
      specId: "SPEC-TST-001",
      specName: "Envelope",
      serviceKeys: ["stripe"],
      maxConvergenceTimeout: 20000,
      cases: [
        {
          anchor: "SPEC-TST-001 › \"one\"",
          name: "one",
          given: { executes: [{ command: "A", payload: {} }, { command: "B", payload: {} }] },
          when: { command: "C", payload: {} },
          prediction: { type: "success", services: {} },
        },
      ],
    } as unknown as EmitInputs["topology"],
    schemas: {},
    goldens: {},
    hashInputs: { specText: "x", contractText: "y", configSlice: {} },
    specPath: "specs/envelope.feat",
    configPath: "../feat.config.json",
    emitterVersion: "0.0.0-test",
    featVersion: "1.0",
    ...overrides,
  };
}

describe("emitted timing envelope", () => {
  it("bakes the config-derived constants and per-case formula into the file", () => {
    const out = emit(inputs({ invokeTimeoutMs: 180000 }));
    expect(out).toContain("const INVOKE_ALLOWANCE_MS = 180000;");
    expect(out).toContain("const CONVERGENCE_WINDOW_MS = 20000;");
    expect(out).toContain("caseTimeout(c)");
    expect(out).toContain("}, HOOK_TIMEOUT_MS);");
    // The formula in the emitted source: allowance × (executes + max(1, delivers)) + window + margin.
    expect(out).toContain(
      "INVOKE_ALLOWANCE_MS * ((c.given?.executes?.length ?? 0) + Math.max(1, c.delivers?.length ?? 0)) +",
    );
  });

  it("defaults the per-invoke allowance to 30s when the adapter declares none", () => {
    const out = emit(inputs());
    expect(out).toContain("const INVOKE_ALLOWANCE_MS = 30000;");
  });

  it("stays byte-deterministic for identical inputs", () => {
    expect(emit(inputs({ invokeTimeoutMs: 180000 }))).toBe(emit(inputs({ invokeTimeoutMs: 180000 })));
  });
});
