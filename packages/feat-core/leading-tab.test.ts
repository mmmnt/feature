// docs/grammar-reference.md §1.2: indentation is spaces only; a tab in leading
// whitespace is a parse error (`feat fmt` reports the same). The parser refuses it
// as MALFORMED_SYNTAX with the line and a hint, instead of counting it as one space.
import { describe, expect, it } from "vitest";
import { contextFromConfig, parseSource } from "./src/parse.js";

const CTX = contextFromConfig({
  services: { eventstore: {} },
  response: { commands: { DoThing: {} } }
});

const LINES = [
  "feat 1.0",
  "",
  'spec SPEC-T-001 "tabs"',
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
  'scenario "a case":',
  "  when: DoThing {}",
  "  predict success:",
  "    response OK ThingResponse { ok: true }",
  "    eventstore has []",
  ""
];

function parsed(lines: string[]): { status: string; body: Record<string, unknown> } {
  return parseSource(lines.join("\n"), CTX) as unknown as { status: string; body: Record<string, unknown> };
}

describe("leading tab", () => {
  it("the space-indented control parses", () => {
    expect(parsed(LINES).status).toBe("OK");
  });

  it("refuses a tab-indented directive with its line and a hint", () => {
    const lines = [...LINES];
    lines[9] = "\thandler at handlers/thing.ts";
    const r = parsed(lines);
    expect(r.status).toBe("ERR");
    expect(r.body.code).toBe("MALFORMED_SYNTAX");
    expect(r.body.line).toBe(10);
    expect(String(r.body.hint)).toMatch(/spaces/i);
  });

  it("refuses a tab mixed after spaces in the leading whitespace", () => {
    const lines = [...LINES];
    lines[21] = "  \t  response OK ThingResponse { ok: true }";
    const r = parsed(lines);
    expect(r.status).toBe("ERR");
    expect(r.body.code).toBe("MALFORMED_SYNTAX");
    expect(r.body.line).toBe(22);
  });

  it("allows a tab inside a line (after the first non-blank character)", () => {
    const lines = [...LINES];
    lines[9] = "  handler\tat handlers/thing.ts";
    expect(parsed(lines).status).toBe("OK");
  });
});
