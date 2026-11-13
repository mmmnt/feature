import { describe, expect, it } from "vitest";
import { parseSource } from "../feat-core/src/index.ts";
import { derive } from "./src/index.ts";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

// grammar-reference §5.6: a `<placeholder>` is valid in a value block. A whole-value placeholder that
// sits inside an array or an object of a literal (`roles: [<role>]`, `owner: { id: <id> }` written as
// JSON) is parsed into the literal matcher's value as `{ $placeholder }`. Derive substituted only a
// matcher that is itself a placeholder, so the case predicted the literal `{"$placeholder":"role"}`
// and failed against the row's value (found by a consumer's Wave 1 build, 2026-11-12).
const source = `feat 1.0

spec SPEC-PV-001 "Grant a role"
context Test
aggregate Grant
type command
status agreed

construct:
  handler at src/grant.ts

enforce:
  grant a role

contract:
  input GrantInput
  response Granted

scenario outline "grants the row's role":
  when: Grant { role: <role> }
  predict success:
    response OK Granted { roles: [<role>, "base"], owner: { tags: [<role>] }, label: "r-<role>" }
    store has []
  examples:
    | role      |
    | "admin"   |
    | 7         |
`;

const config = {
  services: { store: { consistency: "strong" } },
  response: { commands: { Grant: {} } },
} as unknown as FeatConfig;

function topology() {
  const parsed = parseSource(source, { serviceKeys: ["store"], commands: ["Grant"], actors: [] });
  if (parsed.status !== "OK") throw new Error(`parse failed: ${JSON.stringify(parsed.body)}`);
  return derive(parsed.body as BuiltSpec, config);
}

describe("derive — whole-value placeholders inside a literal's arrays and objects", () => {
  it("substitutes the row's value into an array of a prediction's value block", () => {
    const [row1, row2] = topology().cases;
    expect(row1!.prediction.response!.valueBlock!.roles).toEqual({ matcher: "literal", value: ["admin", "base"] });
    expect(row2!.prediction.response!.valueBlock!.roles).toEqual({ matcher: "literal", value: [7, "base"] });
  });

  it("substitutes at any depth of the literal, and leaves a placeholder inside a string as written", () => {
    const [row1] = topology().cases;
    const block = row1!.prediction.response!.valueBlock!;
    expect(JSON.stringify(block)).not.toContain("$placeholder");
    expect(block.label).toEqual({ matcher: "literal", value: "r-<role>" });
  });

  it("refuses an array placeholder whose column the row lacks, with derive's existing message", () => {
    const parsed = parseSource(source.replace("[<role>, \"base\"]", "[<missing>]"), { serviceKeys: ["store"], commands: ["Grant"], actors: [] });
    if (parsed.status !== "OK") throw new Error(`parse failed: ${JSON.stringify(parsed.body)}`);
    expect(() => derive(parsed.body as BuiltSpec, config)).toThrow("Outline row is missing a value for placeholder '<missing>'");
  });
});

describe("derive — a scenario that is not an outline", () => {
  it("keeps a { $placeholder } inside a literal as the data the spec wrote", () => {
    const plain = {
      identity: { id: "SPEC-PV-002", name: "Plain", type: "command" },
      scenarios: [
        {
          name: "plain",
          when: { command: "Grant", payload: {} },
          prediction: {
            type: "success",
            response: { status: "OK", schemaName: "Granted", valueBlock: { cases: { matcher: "literal", value: [{ $placeholder: "x" }] } } },
            services: { store: { records: [] } },
          },
        },
      ],
    } as unknown as BuiltSpec;
    expect(derive(plain, config).cases[0]!.prediction.response!.valueBlock!.cases).toEqual({ matcher: "literal", value: [{ $placeholder: "x" }] });
  });
});
