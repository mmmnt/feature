import { beforeAll, it } from "vitest";
// what a generated suite does when createHarness refuses the run (HarnessConfigurationError's message)
beforeAll(() => { throw new Error("Configuration error (exit 2): [FAULT_UNSUPPORTED] nothing offers that fault."); });
it("never runs", () => {});
