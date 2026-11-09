import { describe, expect, it } from "vitest";
import { derive } from "./src/index.ts";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

// ADR-0023: faults declared in `given:` travel into every derived case, in written order, and an
// outline placeholder inside a fault's detail is substituted per row like any other given value.
const config = { services: { eventStore: { consistency: "strong" } } } as unknown as FeatConfig;

const spec = {
  identity: { id: "SPEC-F-001", name: "Faults", type: "command" },
  scenarios: [
    {
      name: "refuses",
      given: {
        faults: [
          { service: "eventStore", operation: "AppendToStream", fault: "NotLeader", times: 1 },
          { service: "eventStore", operation: "AppendToStream", fault: "AccessDenied", detail: { stream: { $placeholder: "stream" } }, times: "reset" },
        ],
      },
      when: { command: "Do", payload: {} },
      prediction: { type: "success", services: { eventStore: { records: [] } } },
      examples: [{ stream: "orders" }, { stream: "carts" }],
    },
  ],
} as unknown as BuiltSpec;

describe("derive — given.faults", () => {
  it("carries the faults into each case in written order, substituting the detail per row", () => {
    const out = derive(spec, config);
    expect(out.cases).toHaveLength(2);
    expect(out.cases[0]!.given!.faults).toEqual([
      { service: "eventStore", operation: "AppendToStream", fault: "NotLeader", times: 1 },
      { service: "eventStore", operation: "AppendToStream", fault: "AccessDenied", detail: { stream: "orders" }, times: "reset" },
    ]);
    expect(out.cases[1]!.given!.faults![1]!.detail).toEqual({ stream: "carts" });
  });
});

describe("derive — ordering is the harness's to default (ADR-0024)", () => {
  const mk = (ordering?: string): BuiltSpec =>
    ({
      identity: { id: "SPEC-O-001", name: "Order", type: "command" },
      scenarios: [{ name: "w", when: { command: "Do", payload: {} }, prediction: { type: "success", services: { eventStore: { ...(ordering ? { ordering } : {}), records: [] } } } }],
    }) as unknown as BuiltSpec;
  const strong = { services: { eventStore: { consistency: "strong" } } } as unknown as FeatConfig;
  const eventual = { services: { eventStore: { consistency: "eventual", convergenceTimeout: 100 } } } as unknown as FeatConfig;

  it("leaves ordering out when the spec wrote none, whatever the consistency", () => {
    expect(derive(mk(), strong).cases[0]!.prediction.services.eventStore).toEqual({ records: [] });
    expect(derive(mk(), eventual).cases[0]!.prediction.services.eventStore).toEqual({ records: [] });
  });
  it("keeps an ordering the spec wrote", () => {
    expect(derive(mk("unordered"), strong).cases[0]!.prediction.services.eventStore!.ordering).toBe("unordered");
  });
});
