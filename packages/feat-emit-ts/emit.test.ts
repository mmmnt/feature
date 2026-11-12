// The timing envelope is the one behavior the byte-lock gate cannot judge for correctness (verify locks
// whatever bytes emit produced) — so the formula is pinned here: per-invoke allowance × (executes +
// stimulus) + the shared convergence window + margin. It is computed per RUN from the active config
// (ADR-0024), never baked into the generated file.
import { describe, expect, it } from "vitest";
import { emit, timingEnvelope, type EmitInputs } from "./src/index.js";

function inputs(overrides: Partial<EmitInputs> = {}): EmitInputs {
  return {
    topology: {
      specId: "SPEC-TST-001",
      specName: "Envelope",
      serviceKeys: ["stripe"],
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
    namespacePath: "specs/envelope.feat",
    configPath: "../feat.config.json",
    emitterVersion: "0.0.0-test",
    featVersion: "1.0",
    ...overrides,
  };
}

describe("emitted file is environment-agnostic (ADR-0024)", () => {
  it("bakes no timing constants and no per-case timeouts", () => {
    const out = emit(inputs());
    expect(out).not.toContain("CONVERGENCE_WINDOW_MS");
    expect(out).not.toContain("INVOKE_ALLOWANCE_MS");
    expect(out).not.toContain("caseTimeout");
    expect(out).toContain("it(c.name, async () => {");
  });

  it("resolves the config from FEAT_CONFIG, falling back to the path relative to the file", () => {
    const out = emit(inputs());
    expect(out).toContain("process.env.FEAT_CONFIG");
    expect(out).toContain('"../feat.config.json"');
  });

  it("tears down only a harness that was created (createHarness may have thrown)", () => {
    const out = emit(inputs());
    expect(out).toContain("await h?.teardown();");
    expect(out).not.toContain("await h.teardown();");
  });

  it("stays byte-deterministic for identical inputs", () => {
    expect(emit(inputs())).toBe(emit(inputs()));
  });

  it("hands the harness the spec path its namespace derives from (SPEC-RT-006)", () => {
    const out = emit(inputs({ namespacePath: "adapters/kurrent/observe.feat" }));
    expect(out).toContain('const SPEC_PATH = "adapters/kurrent/observe.feat";');
    expect(out).toContain("createHarness({ configPath: CONFIG_PATH, specPath: SPEC_PATH, cases: CASES })");
  });

  it("hands the harness the file's cases, so the response adapter is set up with their commands (SPEC-RT-008)", () => {
    const out = emit(inputs());
    expect(out.indexOf("const CASES: HarnessCase[] =")).toBeGreaterThan(-1);
    expect(out.indexOf("const CASES: HarnessCase[] =")).toBeLessThan(out.indexOf("cases: CASES"));
  });
});

describe("timingEnvelope — computed by `feat run` from the ACTIVE config", () => {
  const cases = [
    { given: { executes: [{}, {}] } },
    { given: {}, delivers: [{}, {}, {}] },
  ];
  it("allowance × (executes + stimulus) of the worst case + the eventual window + margin", () => {
    const t = timingEnvelope(cases, {
      services: { a: { consistency: "eventual", convergenceTimeout: 20000 }, b: { consistency: "acid" } },
      response: { invoke: { timeout: 180000 } },
    });
    expect(t.testTimeoutMs).toBe(180000 * 3 + 20000 + 30000);
    expect(t.hookTimeoutMs).toBe(120000);
  });
  it("defaults the allowance to 30s and ignores the window of a non-eventual service", () => {
    const t = timingEnvelope(cases, { services: { a: { consistency: "strong", convergenceTimeout: 99999 } } });
    expect(t.testTimeoutMs).toBe(30000 * 3 + 0 + 30000);
  });
  it("differs between tiers, which is why it is not in the generated file", () => {
    const spec = { services: { a: { consistency: "strong" } } };
    const integ = { services: { a: { consistency: "eventual", convergenceTimeout: 5000 } } };
    expect(timingEnvelope(cases, integ).testTimeoutMs).toBeGreaterThan(timingEnvelope(cases, spec).testTimeoutMs);
  });
});
