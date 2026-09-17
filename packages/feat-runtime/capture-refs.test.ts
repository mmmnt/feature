// `@<service>[i].<path>` — the value on this surface must equal the value captured on that one.
//
// The gap it closes: a system-minted value that travels between surfaces. A handler mints an id,
// writes it to an external instrument, and records what the instrument answered. Nobody — not the
// spec author, not the compiler — can know that value, so a literal cannot name it and `any string`
// pins nothing: a scenario asserting both sides with `any` passes even when the two disagree,
// which is precisely the failure (a local record pointing at something that exists nowhere).
//
// ⚠ THE REFUSAL PATHS ARE THE POINT. A reference that cannot resolve must be a VIOLATION. If an
// unresolvable reference compared against `undefined` and passed, the strongest assertion in the
// language would be its weakest exactly when the thing it points at failed to happen.
import { describe, expect, it } from "vitest";
import { applyMatcher, type MatchContext } from "./src/matcher.js";
import type { CapturedRecord, Matcher } from "@mmmnt/feat-types";

const ANCHOR = "SPEC-T-001 › 'a case' › database[0].chargeRef";

const charge = (id: string): CapturedRecord => ({
  type: "charge.succeeded",
  payload: { id, amount: 4900, nested: { ref: id } }
});

const ctx = (records: CapturedRecord[]): MatchContext => ({
  captures: new Map([["payments", records]]),
  inline: { schemas: {}, goldens: {} }
});

const ref = (over: Partial<Matcher & { service: string; path: string; index: number }> = {}): Matcher =>
  ({ matcher: "captureRef", service: "payments", path: "id", ...over }) as Matcher;

describe("captureRef", () => {
  it("passes when this surface carries the value that one captured", () => {
    const out: string[] = [];
    applyMatcher("ch_123", true, ref(), ctx([charge("ch_123")]), ANCHOR, out);
    expect(out).toEqual([]);
  });

  it("fails when the two surfaces disagree — the whole reason it exists", () => {
    const out: string[] = [];
    applyMatcher("ch_invented", true, ref(), ctx([charge("ch_123")]), ANCHOR, out);
    expect(out).toHaveLength(1);
    // The message names the reference AND the value it resolved to, so the reader learns which
    // two surfaces disagreed rather than only that a string was wrong.
    expect(out[0]).toContain("@payments[0].id");
    expect(out[0]).toContain('"ch_123"');
    expect(out[0]).toContain('"ch_invented"');
  });

  it("defaults to the first captured record, and honours an explicit index", () => {
    const two = ctx([charge("ch_first"), charge("ch_second")]);
    const a: string[] = [];
    applyMatcher("ch_first", true, ref(), two, ANCHOR, a);
    expect(a).toEqual([]);
    const b: string[] = [];
    applyMatcher("ch_second", true, ref({ index: 1 }), two, ANCHOR, b);
    expect(b).toEqual([]);
  });

  it("walks a dotted path into the captured payload", () => {
    const out: string[] = [];
    applyMatcher("ch_9", true, ref({ path: "nested.ref" }), ctx([charge("ch_9")]), ANCHOR, out);
    expect(out).toEqual([]);
  });

  it("refuses an index the surface never captured, saying how many it did", () => {
    const out: string[] = [];
    applyMatcher("anything", true, ref({ index: 3 }), ctx([charge("ch_1")]), ANCHOR, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("out of range");
    expect(out[0]).toContain("captured 1 record(s)");
  });

  it("refuses a service that captured nothing in this case", () => {
    const out: string[] = [];
    applyMatcher("anything", true, ref({ service: "ledger" }), ctx([charge("ch_1")]), ANCHOR, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("captured nothing");
  });

  it("refuses a path that resolves to nothing rather than comparing against undefined", () => {
    const out: string[] = [];
    applyMatcher(undefined, false, ref({ path: "nosuchfield" }), ctx([charge("ch_1")]), ANCHOR, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("resolved to nothing");
  });

  /** An absent field on THIS surface is still a failure — the reference resolved, the value did not. */
  it("fails when this surface is missing the field entirely", () => {
    const out: string[] = [];
    applyMatcher(undefined, false, ref(), ctx([charge("ch_1")]), ANCHOR, out);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("(absent)");
  });
});
