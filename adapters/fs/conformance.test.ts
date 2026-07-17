// The adapter kit's conformance suite, dogfooded on the fs adapter.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serviceAdapterContract } from "@mmmnt/feat-adapter-kit";
import { createAdapter } from "./src/index.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(PKG, "fixtures", "conformance");
rmSync(FIX, { recursive: true, force: true });
mkdirSync(path.join(FIX, "scope"), { recursive: true });

serviceAdapterContract("@mmmnt/feat-adapter-fs", {
  factory: () => createAdapter({ projectRoot: FIX, options: { scope: "scope" } }),
  act: async () => {
    writeFileSync(path.join(FIX, "scope", `${randomUUID()}.json`), "{}");
  },
  // fs does not support seeding; the kit asserts its seed() rejects clearly.
});
