// The probe behind `ObserveStripe` (SPEC-ADPSTR-001): runs a script against a stripe adapter
// pointed at a local stub of the Events API. No live network call.
import { createAdapter } from "../src/index.ts";
import { startFakeStripe } from "./fake-stripe.mjs";

export async function observe(input) {
  const stub = await startFakeStripe();
  const envName = "FEAT_STRIPE_PROBE_KEY";
  process.env[envName] = "sk_test_probe";
  try {
    const options = { apiKeyEnv: envName, baseUrl: stub.baseUrl };
    if (input.types) options.types = input.types;
    const adapter = createAdapter({ options });
    const trace = [];
    let lastTypes;
    let lastPeek;
    let peekEqualsStop;
    for (const step of input.script.split(/\s+/).filter(Boolean)) {
      if (step.startsWith("emit:")) {
        stub.emit(step.slice("emit:".length));
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
      } else throw new Error(`unknown step '${step}'`);
    }
    const body = { trace: trace.join(" ") };
    if (lastTypes) body.lastTypes = lastTypes;
    if (peekEqualsStop !== undefined) body.peekEqualsStop = peekEqualsStop;
    return { status: "OK", body };
  } finally {
    delete process.env[envName];
    await stub.close();
  }
}
