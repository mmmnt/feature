// End-to-end proof of the ADR-0011 runtime: deliver-triggered execution and
// contains state assertions through the REAL harness (createHarness → runCase),
// using this adapter as the event service. Fixtures under fixtures/e2e/.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, PredictionViolation, type Harness, type HarnessCase } from "@mmmnt/feat-runtime";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const E2E = path.join(PKG, "fixtures", "e2e");

const CONFIG = {
  featVersion: "1.0",
  schemas: { adapter: "@mmmnt/feat-schema-json" },
  services: {
    eventBus: {
      adapter: path.join(PKG, "dist", "index.js"),
      consistency: "acid",
      options: {
        consumers: {
          OrderPublished: { module: "consumer.mjs", export: "onOrderPublished" },
        },
      },
    },
  },
  specs: { dir: ".", pattern: "*.feat", contractPattern: "*.contract.json", outputPattern: "{name}.test.ts" },
  report: { format: ["console"] },
};

// A saga-ish consumer: on OrderPublished it publishes ShipmentRequested.
const CONSUMER = `export function onOrderPublished(payload, ctx) {
  ctx.publish("ShipmentRequested", { orderId: payload.orderId, source: "projection" });
}
`;

const INLINE = {
  schemas: {
    ShipmentRequestedEvent: {
      type: "object",
      required: ["orderId"],
      properties: { orderId: { type: "string" }, source: { type: "string" } },
    },
  },
  goldens: {},
};

function deliverCase(overrides: Partial<HarnessCase>): HarnessCase {
  return {
    anchor: "SPEC-E2E-001 › \"deliver\"",
    name: "deliver",
    delivers: [{ event: "OrderPublished", payload: { orderId: "ord-1" }, service: "eventBus" }],
    prediction: {
      type: "success",
      services: {
        eventBus: {
          ordering: "unordered",
          records: [
            {
              type: "ShipmentRequested",
              schemaName: "ShipmentRequestedEvent",
              valueBlock: { orderId: { matcher: "literal", value: "ord-1" } },
            },
          ],
        },
      },
    },
    ...overrides,
  } as HarnessCase;
}

describe("deliver + contains through the real harness", () => {
  let h: Harness;

  beforeAll(async () => {
    rmSync(E2E, { recursive: true, force: true });
    mkdirSync(E2E, { recursive: true });
    writeFileSync(path.join(E2E, "consumer.mjs"), CONSUMER);
    writeFileSync(path.join(E2E, "feat.config.json"), JSON.stringify(CONFIG, null, 2));
    h = await createHarness({ configPath: path.join(E2E, "feat.config.json") });
  });

  afterAll(async () => {
    await h.teardown();
    rmSync(E2E, { recursive: true, force: true });
  });

  it("delivers the stimulus, captures only consumer-published events, and matches", async () => {
    await h.runCase(deliverCase({}), INLINE);
  });

  it("excludes the delivered stimulus from capture (flow-view rule)", async () => {
    // If the stimulus were captured, the single-record prediction would see an
    // UNPREDICTED OrderPublished record and this case would throw.
    await h.runCase(deliverCase({}), INLINE);
  });

  it("fails on an unpredicted consumer-published event", async () => {
    const c = deliverCase({});
    c.prediction.services.eventBus!.records = [];
    await expect(h.runCase(c, INLINE)).rejects.toThrowError(PredictionViolation);
    await expect(h.runCase(c, INLINE)).rejects.toThrowError(/UNPREDICTED record ShipmentRequested/);
  });

  it("contains asserts resulting state via read(), subset semantics", async () => {
    const c = deliverCase({});
    // State after the run includes the stimulus AND the published event; contains
    // asserts a subset — extra state entries are not violations.
    c.prediction.services.eventBus!.contains = [
      {
        type: "ShipmentRequested",
        schemaName: "ShipmentRequestedEvent",
        valueBlock: { orderId: { matcher: "literal", value: "ord-1" } },
      },
    ];
    await h.runCase(c, INLINE);
  });

  it("contains fails when the state lacks the predicted record", async () => {
    const c = deliverCase({});
    c.prediction.services.eventBus!.contains = [
      {
        type: "ShipmentRequested",
        schemaName: "ShipmentRequestedEvent",
        valueBlock: { orderId: { matcher: "literal", value: "ord-MISSING" } },
      },
    ];
    await expect(h.runCase(c, INLINE)).rejects.toThrowError(/state does not contain predicted record/);
  });

  it("errors clearly when deliver targets a non-event adapter", async () => {
    const c = deliverCase({});
    c.delivers = [{ event: "X", payload: {}, service: "nowhere" }];
    await expect(h.runCase(c, INLINE)).rejects.toThrowError(/unknown service 'nowhere'/);
  });
});
