import { describe, expect, it } from "vitest";
import { derive } from "./src/index.ts";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

/**
 * The query guarantee, and the line it does NOT cross.
 *
 * ADR-0011 makes a query's side-effect freedom unwritable: `has [X]` is a parse error and the
 * empty assertion is synthesised here whether or not the author wrote one. `contains` is a
 * different clause entirely — a subset assertion against RESULTING STATE via the adapter's
 * `read()` — and it claims no write at all. grammar-reference §Predictions is explicit:
 * "Queries predict `response` (+ optional `contains`)."
 *
 * ⚠ REGRESSION. Until this test, the query branch overwrote every service wholesale, so a
 * `contains` in a query spec was silently discarded and a `contains` naming a record that did
 * not exist PASSED. Found downstream in Marilou's SPEC-NET-001, whose six `calendar contains`
 * assertions had never once executed.
 */

const config = {
  services: {
    projectionStore: { consistency: "eventual" },
    ledger: { consistency: "acid" }
  }
} as unknown as FeatConfig;

function specWith(type: string, services: unknown): BuiltSpec {
  return {
    identity: { id: "SPEC-Q-001", name: "Query", type },
    scenarios: [{ name: "reads", prediction: { type: "success", services } }]
  } as unknown as BuiltSpec;
}

const row = [
  {
    type: "FlowView",
    schemaName: "FlowViewSchema",
    valueBlock: { flowId: { matcher: "literal", value: "f1" } }
  }
];

describe("derive — the query guarantee preserves `contains`", () => {
  it("keeps a query's contains assertion instead of discarding it", () => {
    const out = derive(specWith("query", { projectionStore: { contains: row } }), config);
    const svc = out.cases[0]!.prediction.services.projectionStore!;

    expect(svc.contains).toEqual(row);
    // …and still synthesises the absence proof alongside it. Both, not either.
    expect(svc.records).toEqual([]);
  });

  it("still synthesises `has []` for a service the query never mentioned", () => {
    const out = derive(specWith("query", { projectionStore: { contains: row } }), config);
    expect(out.cases[0]!.prediction.services.ledger).toEqual({ ordering: "ordered", records: [] });
  });

  it("never lets a query assert a write, however the prediction was written", () => {
    const out = derive(specWith("query", { ledger: { records: row, contains: row } }), config);
    const svc = out.cases[0]!.prediction.services.ledger!;
    // The author's `records` is discarded — that is the guarantee, and it is unchanged.
    expect(svc.records).toEqual([]);
    expect(svc.contains).toEqual(row);
  });

  it("leaves non-query specs alone", () => {
    const out = derive(specWith("command", { ledger: { records: row, contains: row } }), config);
    const svc = out.cases[0]!.prediction.services.ledger!;
    expect(svc.records).toEqual(row);
    expect(svc.contains).toEqual(row);
  });
});
