// The harness's configuration errors name their code in the message: the test runner prints only the
// message, so the code must be in it to be seen (the message still begins "Configuration error (exit 2):").
import { describe, expect, it } from "vitest";
import { HarnessConfigurationError } from "./src/errors.js";
import { resolveEnvironment } from "./src/load-config.js";

describe("HarnessConfigurationError", () => {
  it("carries its code in the message and on the object", () => {
    const e = new HarnessConfigurationError("FAULT_UNSUPPORTED", "fault store Append Nonsense: not offered.", "store");
    expect(e.message).toBe("Configuration error (exit 2): [FAULT_UNSUPPORTED] fault store Append Nonsense: not offered.");
    expect(e.code).toBe("FAULT_UNSUPPORTED");
    expect(e.service).toBe("store");
  });

  it("keeps the refusal without its prefix as detail", () => {
    expect(new HarnessConfigurationError("NO_ENVIRONMENT", "nothing named.").detail).toBe("nothing named.");
  });
});

describe("resolveEnvironment", () => {
  it("names no environment as NO_ENVIRONMENT, a configuration error", () => {
    const prior = { a: process.env.ENVIRONMENT, b: process.env.FEAT_ENVIRONMENT };
    delete process.env.ENVIRONMENT;
    delete process.env.FEAT_ENVIRONMENT;
    try {
      const e = (() => { try { resolveEnvironment({}); } catch (x) { return x; } })();
      expect(e).toBeInstanceOf(HarnessConfigurationError);
      expect((e as HarnessConfigurationError).code).toBe("NO_ENVIRONMENT");
      expect((e as Error).message).toContain("Configuration error (exit 2): [NO_ENVIRONMENT] No environment declared");
      expect(resolveEnvironment({ environment: "spec" })).toBe("spec");
    } finally {
      if (prior.a !== undefined) process.env.ENVIRONMENT = prior.a;
      if (prior.b !== undefined) process.env.FEAT_ENVIRONMENT = prior.b;
    }
  });
});
