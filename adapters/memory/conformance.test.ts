// The adapter kit's conformance suite, dogfooded on the memory adapter.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serviceAdapterContract } from "@mmmnt/feat-adapter-kit";
import { createAdapter } from "./src/index.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(PKG, "fixtures", "conformance");
mkdirSync(FIX, { recursive: true });
writeFileSync(
  path.join(FIX, "consumer.mjs"),
  `export function onPing(payload, ctx) { ctx.publish("Pong", { echo: payload.n }); }\n`,
);

serviceAdapterContract("@mmmnt/feat-adapter-memory", {
  factory: () =>
    createAdapter({
      projectRoot: FIX,
      options: { consumers: { Ping: { module: "consumer.mjs", export: "onPing" } } },
    }),
  // An effect = a consumer publish; the Ping stimulus itself is excluded.
  act: async (adapter) => adapter.deliver!("Ping", { n: 1 }),
  seedRecords: [{ type: "Seeded", values: { n: 0 } }],
  // No consumer for this event: nothing published, and the stimulus must not appear.
  deliverSample: { event: "UnconsumedEvent", payload: { x: 1 } },
});
