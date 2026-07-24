// ADR-0017 spec variables: sources resolve once per case, composition via
// definition-side interpolation, substitution touches declared names only,
// now() honors the frozen scenario clock (ADR-0012).
import { describe, expect, it } from "vitest";
import { resolveVariables, substituteVariables, type CaseVariable } from "./src/harness.js";

const VARS: CaseVariable[] = [
  { name: "stamp", type: "number", definition: { kind: "call", fn: "now" } },
  { name: "email", type: "string", definition: { kind: "template", parts: ["test+", { ref: "stamp" }, "@flmnt.ai"] } },
];

describe("resolveVariables", () => {
  it("resolves once per call; references share the value by construction", () => {
    const r = resolveVariables(VARS);
    expect(typeof r.stamp).toBe("number");
    expect(r.email).toBe(`test+${r.stamp}@flmnt.ai`);
  });

  it("now() honors a frozen scenario clock — one time concept", () => {
    const r = resolveVariables(VARS, "2026-07-16T00:00:00Z");
    expect(r.stamp).toBe(Date.parse("2026-07-16T00:00:00Z"));
    expect(r.email).toBe(`test+${r.stamp}@flmnt.ai`);
  });

  it("unique() never repeats across resolutions", () => {
    const u: CaseVariable[] = [{ name: "id", type: "string", definition: { kind: "call", fn: "unique" } }];
    expect(resolveVariables(u).id).not.toBe(resolveVariables(u).id);
  });

  it("number literals pass through typed", () => {
    expect(resolveVariables([{ name: "n", type: "number", definition: { kind: "number", value: 7 } }]).n).toBe(7);
  });
});

describe("substituteVariables", () => {
  it("replaces declared references everywhere in a value tree, leaves the rest", () => {
    const resolved = { stamp: 123, email: "test+123@flmnt.ai" };
    const out = substituteVariables(
      {
        when: { payload: { email: "test+${stamp}@flmnt.ai", note: "${undeclared} stays" } },
        deep: [{ sk: "REQUEST#${email}" }],
      },
      resolved,
    );
    expect(out.when.payload.email).toBe("test+123@flmnt.ai");
    expect(out.when.payload.note).toBe("${undeclared} stays");
    expect(out.deep[0]!.sk).toBe("REQUEST#test+123@flmnt.ai");
  });
});
