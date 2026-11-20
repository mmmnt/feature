import { describe, expect, it } from "vitest";
import { derive } from "./src/index.ts";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

// SPEC-RT-015 (ADR-0034): an outline placeholder inside a list that holds matchers, or inside an object in one,
// takes the row's value, as it does outside one: a literal item's `<tag>`, a field's `matching <prefix>`, and a
// field's `not <status>`, at any depth.
const config = { services: { files: { consistency: "strong" } } } as unknown as FeatConfig;

const members = {
  matcher: "list",
  items: [
    { matcher: "literal", value: { name: { $placeholder: "tag" } } },
    {
      matcher: "object",
      fields: {
        name: { matcher: "regex", pattern: { $placeholder: "prefix" } },
        status: { matcher: "not", operand: { matcher: "placeholder", name: "status" } },
        inner: { matcher: "list", items: [{ matcher: "object", fields: { s: { matcher: "placeholder", name: "status" }, t: { matcher: "any" } } }] },
      },
    },
  ],
};

const spec = (examples?: Record<string, unknown>[]) =>
  ({
    identity: { id: "SPEC-LST-001", name: "List", type: "command" },
    scenarios: [
      {
        name: "listed",
        when: { command: "Write", payload: {} },
        prediction: {
          type: "success",
          response: { status: 200, schemaName: "Receipt", valueBlock: { members } },
          services: { files: { records: [{ type: "R", schemaName: "R", valueBlock: { members } }] } },
        },
        ...(examples ? { examples } : {}),
      },
    ],
  }) as unknown as BuiltSpec;

const expected = (tag: string, prefix: string, status: string) => ({
  matcher: "list",
  items: [
    { matcher: "literal", value: { name: tag } },
    {
      matcher: "object",
      fields: {
        name: { matcher: "regex", pattern: prefix },
        status: { matcher: "not", operand: { matcher: "literal", value: status } },
        inner: { matcher: "list", items: [{ matcher: "object", fields: { s: { matcher: "literal", value: status }, t: { matcher: "any" } } }] },
      },
    },
  ],
});

describe("derive — list", () => {
  it("substitutes a placeholder inside a list and its objects, in a response and a record", () => {
    const [a, b] = derive(spec([{ tag: "daily", prefix: "^m", status: "Failed" }, { tag: "weekly", prefix: "^w", status: "Aborted" }]), config).cases;
    expect(a!.prediction.response!.valueBlock).toEqual({ members: expected("daily", "^m", "Failed") });
    expect(b!.prediction.services.files!.records[0]!.valueBlock).toEqual({ members: expected("weekly", "^w", "Aborted") });
  });

  it("throws derive's missing-placeholder error for a column the row lacks", () => {
    expect(() => derive(spec([{ tag: "x", prefix: "^x" }]), config)).toThrow("Outline row is missing a value for placeholder '<status>'");
  });
});
