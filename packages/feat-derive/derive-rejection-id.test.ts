import { describe, expect, it } from "vitest";
import { derive } from "./src/index.ts";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

// Regression (founder ruling 2026-11-10, release finding d1): a `<name>` placeholder in a rejection-id
// position is refused like every other placeholder surface, never turned into the string "undefined".
const config = { services: { eventStore: { consistency: "strong" } } } as unknown as FeatConfig;

const mk = (rejectionId: string, examples: Record<string, unknown>[]): BuiltSpec =>
  ({
    identity: { id: "SPEC-R-001", name: "Reject", type: "command" },
    scenarios: [
      {
        name: "rejects",
        when: { command: "Do", payload: {} },
        prediction: { type: "rejection", rejectionId, services: { eventStore: { records: [] } } },
        examples,
      },
    ],
  }) as unknown as BuiltSpec;

describe("derive — rejection id placeholder", () => {
  it("takes the row's value for the column", () => {
    const out = derive(mk("<why>", [{ why: "NOT_FOUND" }, { why: "CONFLICT" }]), config);
    expect(out.cases.map((c) => c.prediction.rejectionId)).toEqual(["NOT_FOUND", "CONFLICT"]);
  });

  it("throws the shared message when the row has no column of that name", () => {
    expect(() => derive(mk("<why>", [{ other: "x" }]), config)).toThrow(
      "Outline row is missing a value for placeholder '<why>'",
    );
  });

  it("keeps a literal id untouched", () => {
    expect(derive(mk("NOT_FOUND", [{ other: "x" }]), config).cases[0]!.prediction.rejectionId).toBe("NOT_FOUND");
  });
});
