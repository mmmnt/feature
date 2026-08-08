// ADR-0017 source offsets: `now(ms)` / `iso(ms)`.
//
// The problem these exist to solve: a fixture written as an absolute calendar
// date silently expires. It passes until the date arrives, then fails with no
// commit to blame — the worst kind of red to debug. An offset from the scenario
// clock keeps a "three days out" fixture three days out forever, and lets a spec
// express a deliberately-stale fixture (an expired credential) as a negative
// offset rather than a date somebody must remember to keep in the past.
import { describe, expect, it } from "vitest";
import { contextFromConfig, parseSource } from "./src/parse.js";

const CTX = contextFromConfig({
  services: { eventstore: {} },
  response: { commands: { DoThing: {} } }
});

/** Minimal well-formed spec carrying one variables: block. */
function specWith(variablesBlock: string): string {
  return [
    "feat 1.0",
    "",
    'spec SPEC-T-001 "offsets"',
    "context Testing",
    "aggregate Thing",
    "type command",
    "status agreed",
    "",
    "construct:",
    "  handler at handlers/thing.ts",
    "",
    "enforce:",
    "  do the thing",
    "",
    "contract:",
    "  input ThingInput",
    "  response ThingResponse",
    "",
    "variables:",
    variablesBlock,
    "",
    'scenario "a case":',
    '  when: DoThing { at: "${t}" }',
    "  predict success:",
    "    response OK ThingResponse { ok: true }",
    "    eventstore has []",
    ""
  ].join("\n");
}

function parsed(src: string): { status: string; body: Record<string, unknown> } {
  return parseSource(src, CTX) as unknown as { status: string; body: Record<string, unknown> };
}

function definitions(src: string): unknown[] {
  const r = parsed(src);
  if (r.status !== "OK") throw new Error(`parse failed: ${JSON.stringify(r.body)}`);
  const vars = (r.body as { variables?: { definition: unknown }[] }).variables ?? [];
  return vars.map((v) => v.definition);
}

describe("source offsets", () => {
  it("parses a bare source call with no offset, exactly as before", () => {
    expect(definitions(specWith("  t: number = now()"))).toEqual([{ kind: "call", fn: "now" }]);
  });

  it("parses a positive offset — a fixture in the future", () => {
    expect(definitions(specWith("  t: string = iso(259200000)"))).toEqual([
      { kind: "call", fn: "iso", offsetMs: 259_200_000 }
    ]);
  });

  it("parses a negative offset — the deliberately-stale fixture", () => {
    expect(definitions(specWith("  t: string = iso(-3600000)"))).toEqual([
      { kind: "call", fn: "iso", offsetMs: -3_600_000 }
    ]);
  });

  it("tolerates whitespace inside the parentheses", () => {
    expect(definitions(specWith("  t: string = iso( 1000 )"))).toEqual([
      { kind: "call", fn: "iso", offsetMs: 1000 }
    ]);
  });

  it("accepts iso() as a string source alongside now() as a number source", () => {
    expect(definitions(specWith("  t: string = iso()\n  b: number = now()"))).toEqual([
      { kind: "call", fn: "iso" },
      { kind: "call", fn: "now" }
    ]);
  });

  it("refuses an offset on unique() — it has no time axis", () => {
    const r = parsed(specWith("  t: string = unique(500)"));
    expect(r.status).toBe("ERR");
    expect(String(r.body.message)).toMatch(/takes no offset/);
  });

  it("still refuses an unknown source, with or without an offset", () => {
    expect(parsed(specWith("  t: string = soon(500)")).status).toBe("ERR");
    expect(parsed(specWith("  t: string = soon()")).status).toBe("ERR");
  });

  it("refuses a fractional offset rather than silently truncating it", () => {
    expect(parsed(specWith("  t: string = iso(1.5)")).status).toBe("ERR");
  });
});
