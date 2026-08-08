// `@given.response.<path>` — naming what a precondition produced.
//
// A scenario that establishes state with `execute` needs to reference the id the
// system minted during setup. Before this existed the literal string was passed
// straight through to the system under test, which then failed far from the cause
// — a booking id of "@given.response.appointmentId" looks like a missing record,
// not a missing language feature.
import { describe, expect, it } from "vitest";
import { resolveGivenRefs } from "./src/harness.js";
import type { CapturedResponse } from "@mmmnt/feat-types";

const BOOKED: CapturedResponse = {
  status: "OK",
  body: { appointmentId: "a1b2c3", googleEventId: "gcal-9", nested: { deep: "value" } }
};

const ANCHOR = "SPEC-T-001 › 'a case'";

describe("resolveGivenRefs", () => {
  it("replaces a reference with the value from the preceding response", () => {
    const out = resolveGivenRefs({ appointmentId: "@given.response.appointmentId" }, BOOKED, ANCHOR);
    expect(out).toEqual({ appointmentId: "a1b2c3" });
  });

  it("walks a dotted path", () => {
    expect(resolveGivenRefs("@given.response.nested.deep", BOOKED, ANCHOR)).toBe("value");
  });

  it("leaves every other string untouched — including other @ matchers", () => {
    const input = { a: "plain", b: "@when.email", c: "@deliver.flowId", d: "not@given.response.x" };
    expect(resolveGivenRefs(input, BOOKED, ANCHOR)).toEqual(input);
  });

  it("recurses through arrays and nested objects", () => {
    const out = resolveGivenRefs(
      { list: ["@given.response.appointmentId", { inner: "@given.response.googleEventId" }] },
      BOOKED,
      ANCHOR
    );
    expect(out).toEqual({ list: ["a1b2c3", { inner: "gcal-9" }] });
  });

  it("preserves non-string primitives", () => {
    const input = { n: 42, b: true, z: null };
    expect(resolveGivenRefs(input, BOOKED, ANCHOR)).toEqual(input);
  });

  it("FAILS LOUDLY when no execute precedes the reference", () => {
    expect(() => resolveGivenRefs("@given.response.appointmentId", undefined, ANCHOR)).toThrow(
      /no execute precedes it/
    );
  });

  it("FAILS LOUDLY when the response has no such field — never passes the literal through", () => {
    expect(() => resolveGivenRefs("@given.response.nope", BOOKED, ANCHOR)).toThrow(
      /has no 'nope'/
    );
  });

  it("fails on a partially-valid path rather than yielding undefined", () => {
    expect(() => resolveGivenRefs("@given.response.nested.missing", BOOKED, ANCHOR)).toThrow(
      /has no 'nested.missing'/
    );
  });

  it("names the case anchor in the error, so the failure points at the scenario", () => {
    expect(() => resolveGivenRefs("@given.response.nope", BOOKED, ANCHOR)).toThrow(/SPEC-T-001/);
  });

  it("handles a null response body without throwing the wrong error", () => {
    expect(() =>
      resolveGivenRefs("@given.response.x", { status: "OK", body: null }, ANCHOR)
    ).toThrow(/has no 'x'/);
  });
});
