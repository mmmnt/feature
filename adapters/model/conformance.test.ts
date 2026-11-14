// The adapter kit's conformance suite, dogfooded on the model adapter: the system under test is played by
// appending an ask to the record file, as another process would (ADR-0028).
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { serviceAdapterContract } from "@mmmnt/feat-adapter-kit";
import { createAdapter } from "./src/index.js";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "feat-model-conformance-"));
const NAMESPACE = "s00000000c0f1";
const FILE = path.join(ROOT, "judge", `${NAMESPACE}.jsonl`);

afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

serviceAdapterContract("@mmmnt/feat-adapter-model", {
  factory: () => createAdapter({ projectRoot: ROOT, namespace: NAMESPACE, options: { dir: "judge" } }),
  act: async () => {
    appendFileSync(FILE, `${JSON.stringify({ type: "judgment.ask", payload: { unitId: "u-1", chunk: 0 } })}\n`);
  },
  seedRecords: [{ type: "judgment.answer", values: { unitId: "u-1", chunk: 0, candidates: [] } }],
});
