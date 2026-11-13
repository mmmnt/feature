import { describe, expect, it } from "vitest";
import { derive } from "./src/index.ts";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

// SPEC-RT-009 (ADR-0025): the written order of a given's seeds and executes travels into every derived
// case, an outline row's included, so the harness can run them in it.
const config = { services: { store: { consistency: "strong" } } } as unknown as FeatConfig;

const spec = (examples?: Record<string, unknown>[]) => {
  const id = examples ? { $placeholder: "id" } : "w-0";
  return {
    identity: { id: "SPEC-GO-001", name: "Given order", type: "command" },
    scenarios: [
      {
        name: "ordered",
        given: {
          executes: [{ command: "Enable", payload: { id } }],
          seeds: [{ service: "store", records: [{ type: "Disabled", values: { id } }] }],
          order: ["execute", "seed"],
        },
        when: { command: "Review", payload: {} },
        prediction: { type: "success", services: { store: { records: [] } } },
        ...(examples ? { examples } : {}),
      },
    ],
  } as unknown as BuiltSpec;
};

describe("derive — given.order", () => {
  it("carries the written order into a plain scenario's case", () => {
    expect(derive(spec(), config).cases[0]!.given!.order).toEqual(["execute", "seed"]);
  });

  it("carries it into every outline row, each with its own array", () => {
    const cases = derive(spec([{ id: "w-1" }, { id: "w-2" }]), config).cases;
    expect(cases.map((c) => c.given!.order)).toEqual([["execute", "seed"], ["execute", "seed"]]);
    expect(cases[0]!.given!.order).not.toBe(cases[1]!.given!.order);
  });

  it("writes no order for a given that has none", () => {
    const s = spec();
    delete (s.scenarios[0]!.given as { order?: unknown }).order;
    expect(derive(s, config).cases[0]!.given).not.toHaveProperty("order");
  });
});
