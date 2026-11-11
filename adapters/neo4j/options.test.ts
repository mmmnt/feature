// Option validation at setup(), hand-written: SPEC-ADPNEO-001 and Neo4jOptions say options.keys is required, so a
// config without it is refused at setup() and not at the first snapshot with NODE_KEY_UNDECLARED. No agreed scenario
// omits keys (the probe always declares them). Founder ruling 2026-11-10: "Adapters validate options".
// The refusal comes before any connection, so these cases need no server.
import { describe, expect, it } from "vitest";
import { createAdapter, Neo4jAdapterError } from "./src/index.js";

const NAMESPACE = "s0123456789ab";
const URI = "bolt://127.0.0.1:1";

function setupOutcome(options: unknown) {
  return createAdapter({ namespace: NAMESPACE, ...(options === undefined ? {} : { options }) })
    .setup()
    .then(
      () => undefined,
      (e: unknown) => e as Neo4jAdapterError,
    );
}

describe("neo4j options.keys", () => {
  it.each([
    ["no options at all", undefined],
    ["options without keys", { uri: URI }],
    ["keys null", { uri: URI, keys: null }],
    ["keys an array", { uri: URI, keys: ["orderId"] }],
    ["keys a string", { uri: URI, keys: "orderId" }],
    ["a key property that is not a non-empty string", { uri: URI, keys: { Order: 7 } }],
    ["an empty key property", { uri: URI, keys: { Order: "" } }],
  ])("setup refuses %s with OPTIONS_INVALID", async (_name, options) => {
    const error = await setupOutcome(options);
    expect(error).toBeInstanceOf(Neo4jAdapterError);
    expect(error!.code).toBe("OPTIONS_INVALID");
    expect(error!.detail).toContain("keys");
  });

  it("an empty keys object is declared, so it passes validation and reaches the connection", async () => {
    const error = await setupOutcome({ uri: URI, keys: {} });
    expect(error).toBeInstanceOf(Neo4jAdapterError);
    expect(error!.code).toBe("NEO4J_UNREACHABLE");
  });
});
