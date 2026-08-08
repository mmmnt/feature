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

// ── Offsets and ISO rendering (ADR-0017 + ADR-0012) ──────────────────────────
// A fixture written as an absolute calendar date silently expires: it passes
// until the date arrives, then fails with no commit to blame. An offset from the
// scenario clock keeps a "three days out" fixture three days out forever.
describe("offset sources", () => {
  const HOUR = 3_600_000;
  const CLOCK = "2030-08-13T12:00:00.000Z";

  it("iso() renders the frozen clock as an ISO-8601 instant", () => {
    const r = resolveVariables(
      [{ name: "t", type: "string", definition: { kind: "call", fn: "iso" } }],
      CLOCK
    );
    expect(r.t).toBe(CLOCK);
  });

  it("applies a positive offset — the future", () => {
    const r = resolveVariables(
      [{ name: "t", type: "string", definition: { kind: "call", fn: "iso", offsetMs: 2 * HOUR } }],
      CLOCK
    );
    expect(r.t).toBe("2030-08-13T14:00:00.000Z");
  });

  it("applies a negative offset — the past, which is what an expired-credential fixture needs", () => {
    const r = resolveVariables(
      [{ name: "t", type: "string", definition: { kind: "call", fn: "iso", offsetMs: -HOUR } }],
      CLOCK
    );
    expect(r.t).toBe("2030-08-13T11:00:00.000Z");
    expect(Date.parse(r.t as string)).toBeLessThan(Date.parse(CLOCK));
  });

  it("now(ms) offsets epoch millis from the same clock", () => {
    const r = resolveVariables(
      [{ name: "n", type: "number", definition: { kind: "call", fn: "now", offsetMs: HOUR } }],
      CLOCK
    );
    expect(r.n).toBe(Date.parse(CLOCK) + HOUR);
  });

  it("without a frozen clock, an offset is measured from wall time", () => {
    const before = Date.now();
    const r = resolveVariables([
      { name: "t", type: "string", definition: { kind: "call", fn: "iso", offsetMs: 24 * HOUR } }
    ]);
    const after = Date.now();
    const got = Date.parse(r.t as string);
    expect(got).toBeGreaterThanOrEqual(before + 24 * HOUR);
    expect(got).toBeLessThanOrEqual(after + 24 * HOUR);
  });

  it("an offset fixture stays relative — it cannot age into the past", () => {
    const r = resolveVariables([
      { name: "t", type: "string", definition: { kind: "call", fn: "iso", offsetMs: 72 * HOUR } }
    ]);
    expect(Date.parse(r.t as string)).toBeGreaterThan(Date.now());
  });

  it("composes into templates, so a payload can carry the instant as a string", () => {
    const r = resolveVariables(
      [
        { name: "t", type: "string", definition: { kind: "call", fn: "iso", offsetMs: HOUR } },
        { name: "title", type: "string", definition: { kind: "template", parts: ["meeting at ", { ref: "t" }] } }
      ],
      CLOCK
    );
    expect(r.title).toBe("meeting at 2030-08-13T13:00:00.000Z");
  });

  it("resolves once per case — two references to one variable never disagree", () => {
    const r = resolveVariables([
      { name: "t", type: "string", definition: { kind: "call", fn: "iso", offsetMs: HOUR } },
      { name: "a", type: "string", definition: { kind: "template", parts: [{ ref: "t" }] } },
      { name: "b", type: "string", definition: { kind: "template", parts: [{ ref: "t" }] } }
    ]);
    expect(r.a).toBe(r.b);
  });
});
