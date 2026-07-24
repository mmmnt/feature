// ADR-0017 variable lint: declared-but-unused = warning, same discipline as
// schema declarations (the parser already errors on undeclared refs).
import { describe, expect, it } from "vitest";
import { lintSpec } from "./src/index.js";

const base = {
  featVersion: "1.0",
  identity: { id: "S", name: "n", context: "c", aggregate: "a", type: "command", status: "agreed" },
  construct: [],
  enforce: [],
  contract: [],
};

describe("ADR-0017 variable lint", () => {
  it("warns on a declared-but-unreferenced variable", () => {
    const spec = {
      ...base,
      variables: [
        { name: "stamp", type: "number", definition: { kind: "call", fn: "now" } },
        { name: "orphan", type: "string", definition: { kind: "call", fn: "unique" } },
      ],
      scenarios: [
        { name: "s", when: { command: "C", payload: { email: "x+${stamp}@y.z" } }, prediction: { type: "success", services: {} } },
      ],
    };
    const msgs = lintSpec(spec as never).map((f) => f.message);
    expect(msgs.some((m) => m.includes("'orphan'"))).toBe(true);
    expect(msgs.some((m) => m.includes("'stamp'"))).toBe(false);
  });

  it("a variable referenced only by another variable's template counts as used", () => {
    const spec = {
      ...base,
      variables: [
        { name: "stamp", type: "number", definition: { kind: "call", fn: "now" } },
        { name: "email", type: "string", definition: { kind: "template", parts: ["t+", { ref: "stamp" }, "@y.z"] } },
      ],
      scenarios: [
        { name: "s", when: { command: "C", payload: { email: "${email}" } }, prediction: { type: "success", services: {} } },
      ],
    };
    expect(lintSpec(spec as never).some((f) => f.message.includes("stamp"))).toBe(false);
  });
});
