// The adapter kit's conformance suite, dogfooded on the handler adapter.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { responseAdapterContract } from "@mmmnt/feat-adapter-kit";
import { createAdapter } from "./src/index.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(PKG, "fixtures", "conformance");
mkdirSync(FIX, { recursive: true });
writeFileSync(path.join(FIX, "ping.mjs"), `export async function ping(payload) { return { status: "OK", body: { echo: payload.n } }; }\n`);

responseAdapterContract("@mmmnt/feat-adapter-handler", {
  factory: () =>
    createAdapter({
      projectRoot: FIX,
      commands: { Ping: { module: "ping.mjs", export: "ping" } },
    }),
  command: "Ping",
  payload: { n: 42 },
  expectStatus: "OK",
});
