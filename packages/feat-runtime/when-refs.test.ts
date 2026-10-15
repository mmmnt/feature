// `@when.<path>` equals the value SENT in the `when:` payload (grammar-reference §matchers) — including
// a value the payload took from a preceding execute through `@given.response.<path>`.
//
// The bug this pins (found 2026-10-15 by the howie production regression lane, RG-REQ-03): the
// harness resolved `@given.response.*` in the `when:` payload before invoking, then handed the
// matchers the UNRESOLVED payload — so `@when.expect` compared against the literal string
// "@given.response.start" and a correct system failed its prediction.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, type HarnessCase } from "./src/harness.js";

const CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/when-ref/feat.config.json");
const INLINE = { schemas: { Booked: { type: "object" }, Seen: { type: "object" } }, goldens: {} };

const pick = (prediction: unknown): HarnessCase =>
  ({
    anchor: "SPEC-T-WHEN › 'a pick carries what was offered'",
    name: "a pick carries what was offered",
    specType: "command",
    given: { executes: [{ command: "Offer", payload: {} }] },
    when: { command: "Book", payload: { expect: "@given.response.start" } },
    prediction: {
      type: "success",
      services: { memory: { ordering: "unordered", records: [] } },
      response: { status: "OK", schemaName: "Booked", valueBlock: { booked: prediction } }
    }
  }) as unknown as HarnessCase;

describe("@when.<path> reads the payload as it was sent", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness({ configPath: CONFIG });
  });
  afterAll(async () => {
    await h.teardown();
  });

  it("equals a value the when-payload took from the preceding execute's response", async () => {
    await expect(h.runCase(pick({ matcher: "whenRef", path: "expect" }), INLINE as never)).resolves.toBeUndefined();
  });

  it("still fails when the response disagrees with what was sent", async () => {
    await expect(
      h.runCase(pick({ matcher: "literal", value: "2030-01-01T00:00:00Z" }), INLINE as never)
    ).rejects.toThrow(/booked/);
  });

  it("@deliver.<path> equals a delivered value the payload took from the preceding execute", async () => {
    const delivered = {
      anchor: "SPEC-T-WHEN › 'a delivery carries what was offered'",
      name: "a delivery carries what was offered",
      specType: "policy",
      given: { executes: [{ command: "Offer", payload: {} }] },
      delivers: [{ service: "memory", event: "Seen", payload: { expect: "@given.response.start" } }],
      prediction: {
        type: "success",
        services: {
          memory: {
            ordering: "unordered",
            records: [{ type: "Seen", schemaName: "Seen", valueBlock: { seen: { matcher: "deliverRef", path: "expect" } } }]
          }
        }
      }
    } as unknown as HarnessCase;
    await expect(h.runCase(delivered, INLINE as never)).resolves.toBeUndefined();
  });
});
