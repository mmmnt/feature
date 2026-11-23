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

// ADR-0038 (founder rulings 7d3026eb and 55fb39c4): an omitted optional property is an error unless the block is partial.
import { lintOptionalFields } from "./src/index.js";

describe("ADR-0038 optional-field lint", () => {
  const registry = {
    Row: { type: "object", required: ["id"], properties: { id: { type: "string" }, note: { type: "string" } } },
    Env: { type: "object", required: ["entryType", "id"], properties: { entryType: {}, id: {} } },
    // entryType is declared at the top and made required only by the allOf part the local $ref names
    Entry: {
      properties: { entryType: {}, extra: {} },
      required: ["extra"],
      allOf: [{ $ref: "#/$defs/env" }],
      $defs: { env: { required: ["entryType"], properties: { entryType: {} } } },
    },
    Closed: { type: "object", required: ["id"], properties: { id: {} } },
  };
  const spec = (prediction: unknown) => ({ ...base, scenarios: [{ name: "s", prediction }] }) as never;
  const lit = (value: unknown) => ({ matcher: "literal", value });

  it("refuses a response block that leaves out an optional property, naming it", () => {
    const f = lintOptionalFields(spec({ type: "success", response: { status: 200, schemaName: "Row", valueBlock: { id: lit("a") } } }), registry);
    expect(f).toHaveLength(1);
    expect(f[0]!.level).toBe("error");
    expect(f[0]!.message).toMatch(/OPTIONAL_UNSTATED.*Row leaves out optional 'note'/);
  });
  it("refuses a record block that leaves one out, naming the service and record type", () => {
    const f = lintOptionalFields(
      spec({ type: "success", services: { log: { records: [{ type: "row.written", schemaName: "Row", valueBlock: { id: lit("a") } }] } } }),
      registry,
    );
    expect(f[0]!.message).toMatch(/› log row\.written: Row/);
  });
  it("accepts a block that states the property, absent or otherwise", () => {
    const f = lintOptionalFields(
      spec({ type: "success", response: { status: 200, schemaName: "Row", valueBlock: { id: lit("a"), note: { matcher: "absent" } } } }),
      registry,
    );
    expect(f).toEqual([]);
  });
  it("accepts a block marked partial", () => {
    const f = lintOptionalFields(
      spec({ type: "success", response: { status: 200, schemaName: "Row", partial: true, valueBlock: { id: lit("a") } } }),
      registry,
    );
    expect(f).toEqual([]);
  });
  it("does not treat a property required through an allOf part reached by a local $ref as optional", () => {
    const f = lintOptionalFields(
      spec({ type: "success", response: { status: 200, schemaName: "Entry", valueBlock: { extra: lit(1) } } }),
      registry,
    );
    expect(f).toEqual([]);
  });
  it("never flags a schema with no optional property, nor a golden", () => {
    const f = lintOptionalFields(
      spec({
        type: "success",
        response: { status: 200, schemaName: "Closed", valueBlock: { id: lit("a") } },
        services: { log: { records: [{ type: "x", schemaName: "Row", golden: "row.json" }] } },
      }),
      registry,
    );
    expect(f).toEqual([]);
  });
});
