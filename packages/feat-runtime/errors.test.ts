// The harness's configuration errors name their code in the message: the test runner prints only the
// message, so the code must be in it to be seen (the message still begins "Configuration error (exit 2):").
import { describe, expect, it } from "vitest";
import { HarnessConfigurationError } from "./src/errors.js";

describe("HarnessConfigurationError", () => {
  it("carries its code in the message and on the object", () => {
    const e = new HarnessConfigurationError("FAULT_UNSUPPORTED", "fault store Append Nonsense: not offered.", "store");
    expect(e.message).toBe("Configuration error (exit 2): [FAULT_UNSUPPORTED] fault store Append Nonsense: not offered.");
    expect(e.code).toBe("FAULT_UNSUPPORTED");
    expect(e.service).toBe("store");
  });
});
