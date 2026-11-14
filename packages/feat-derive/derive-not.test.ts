import { describe, expect, it } from "vitest";
import { derive } from "./src/index.ts";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

// SPEC-RT-011 (ADR-0027): an outline placeholder inside a negation's operand takes the row's value, as it
// does outside one: `not <status>` becomes `not "<row value>"`, `not matching <prefix>` a pattern.
const config = { services: { log: { consistency: "strong" } } } as unknown as FeatConfig;

const spec = (examples?: Record<string, unknown>[]) =>
  ({
    identity: { id: "SPEC-NOT-001", name: "Negation", type: "command" },
    scenarios: [
      {
        name: "negated",
        when: { command: "Redo", payload: {} },
        prediction: {
          type: "success",
          response: {
            status: 202,
            schemaName: "Receipt",
            valueBlock: {
              status: { matcher: "not", operand: { matcher: "placeholder", name: "status" } },
              ref: { matcher: "not", operand: { matcher: "regex", pattern: { $placeholder: "prefix" } } },
              cycleId: { matcher: "not", operand: { matcher: "whenRef", path: "cycleId" } },
              nested: { matcher: "nested", fields: { s: { matcher: "not", operand: { matcher: "placeholder", name: "status" } } } },
            },
          },
          services: { log: { records: [{ type: "R", schemaName: "R", valueBlock: { s: { matcher: "not", operand: { matcher: "placeholder", name: "status" } } } }] } },
        },
        ...(examples ? { examples } : {}),
      },
    ],
  }) as unknown as BuiltSpec;

describe("derive — not", () => {
  it("substitutes a placeholder inside a negation, in a response, a nested block and a record", () => {
    const [a, b] = derive(spec([{ status: "Failed", prefix: "^tmp-" }, { status: "Aborted", prefix: "^draft" }]), config).cases;
    expect(a!.prediction.response!.valueBlock).toEqual({
      status: { matcher: "not", operand: { matcher: "literal", value: "Failed" } },
      ref: { matcher: "not", operand: { matcher: "regex", pattern: "^tmp-" } },
      cycleId: { matcher: "not", operand: { matcher: "whenRef", path: "cycleId" } },
      nested: { matcher: "nested", fields: { s: { matcher: "not", operand: { matcher: "literal", value: "Failed" } } } },
    });
    expect(b!.prediction.services.log!.records[0]!.valueBlock).toEqual({ s: { matcher: "not", operand: { matcher: "literal", value: "Aborted" } } });
  });

  it("throws derive's missing-placeholder error for a column the row lacks", () => {
    expect(() => derive(spec([{ prefix: "^x" }]), config)).toThrow("Outline row is missing a value for placeholder '<status>'");
  });
});
