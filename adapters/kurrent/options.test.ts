// Option validation at setup(), hand-written: SPEC-ADPKUR-004 types options.nodeMajor as "an integer, 1 or more"
// and no agreed scenario passes anything else. Founder ruling 2026-11-10: "Adapters validate options".
// A refusal comes before any connection, so these cases need no node.
import { describe, expect, it } from "vitest";
import { createAdapter, KurrentAdapterError } from "./src/index.js";

const NAMESPACE = "s0123456789ab";

function adapter(nodeMajor: unknown) {
  return createAdapter({
    namespace: NAMESPACE,
    options: { connectionString: "kurrentdb://admin:x@localhost:1?tls=false", nodeMajor },
  });
}

describe("kurrent options.nodeMajor", () => {
  it.each([0, -1, 26.5, Number.NaN, Number.POSITIVE_INFINITY, "26", null, true])("setup refuses %j with OPTIONS_INVALID", async (bad) => {
    const error = await adapter(bad)
      .setup()
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(KurrentAdapterError);
    expect((error as KurrentAdapterError).code).toBe("OPTIONS_INVALID");
    expect((error as KurrentAdapterError).detail).toContain("nodeMajor");
  });
});
