// The probe behind `ObserveMemory` (SPEC-ADPMEM-001): runs a script against a memory adapter.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "../src/index.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function observe(input) {
  const adapter = createAdapter({
    projectRoot: HERE,
    options: { consumers: { Ping: { module: "consumers.mjs", export: "onPing" } } },
  });
  const trace = [];
  let lastTypes;
  let lastPeek;
  let peekEqualsStop;
  for (const step of input.script.split(/\s+/).filter(Boolean)) {
    if (step === "seed") {
      await adapter.seed([{ type: "Seeded", values: { n: 0 } }]);
      trace.push(step);
    } else if (step.startsWith("deliver:")) {
      await adapter.deliver(step.slice("deliver:".length), { n: 1 });
      trace.push(step);
    } else if (step === "start") {
      await adapter.startCapture();
      trace.push(step);
    } else if (step === "peek") {
      lastPeek = await adapter.peekCapture();
      lastTypes = lastPeek.map((r) => r.type).join(",");
      trace.push(`peek=${lastPeek.length}`);
    } else if (step === "stop") {
      const records = await adapter.stopCapture();
      lastTypes = records.map((r) => r.type).join(",");
      if (lastPeek !== undefined) peekEqualsStop = JSON.stringify(lastPeek) === JSON.stringify(records);
      lastPeek = undefined;
      trace.push(`stop=${records.length}`);
    } else if (step === "settle") {
      trace.push(`settle=${await adapter.settle()}`);
    } else if (step === "reset") {
      await adapter.reset();
      trace.push(step);
    } else throw new Error(`unknown step '${step}'`);
  }
  const body = { trace: trace.join(" ") };
  if (lastTypes) body.lastTypes = lastTypes;
  if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
  return { status: "OK", body };
}
