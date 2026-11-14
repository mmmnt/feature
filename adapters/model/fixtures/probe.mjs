// The probe behind `ObserveModel` (SPEC-ADPMODEL-001). Part of the build, inside touches, not shipped.
// It creates the adapter in a fresh temporary project root, removed after the call, and runs the script. Where a
// step says so it plays the system under test, writing and reading the record file directly as another process
// would. It opens no socket and calls no model.
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAdapter, ModelAdapterError } from "../src/index.ts";

const NAMESPACE = "s0123456789ab";

// The payloads of the consumer's specs (Sift: extraction, preparer, on_candidate_matched, gate_run, on_gap_opened).
const PAYLOADS = {
  "judgment.answer": { purpose: "extraction", unitId: "ws:ws-1/entry:e-42", chunk: 0, candidates: [{ type: "Aggregate", name: "Order", context: "Sales" }] },
  "judgment.answered": { unit: "u-1", chunk: 0, ask: 0, answer: { outcome: { kind: "New" }, rationale: "no live construct states this rule", alternatives: [] } },
  CoherenceVerdict: { pair: ["con-1", "con-2"], verdict: "Same" },
  RecordLagJudgment: { requestKey: "evt-go-1", holds: true, field: "owner", passage: { customerWorkspace: "ws-1", kind: "section", position: 33 }, documentVersion: "v2" },
  MeaningAnswer: { pair: ["con-1", "con-2"], definitionHashes: ["h-1", "h-2"], verdict: "Same", rationale: "both define an order" },
  "judgment.ask": { purpose: "extraction", unitId: "ws:ws-1/entry:e-42", chunk: 0, judgmentId: "0123456789abcdef0123456789abcdef" },
  "judgment.requested": { step: 4, unit: "u-1", chunk: 0, ask: 0, offerSet: ["con-1"], budgetCap: 3 },
  MeaningJudgmentAsked: { pair: ["con-1", "con-2"], definitionHashes: ["h-1", "h-2"], budgetCap: { bound: 1 } },
};

function payloadOf(type) {
  const payload = PAYLOADS[type];
  if (payload === undefined) throw new Error(`the probe has no payload for '${type}'`);
  return payload;
}

const PARTIAL = JSON.stringify({ type: "judgment.ask", payload: PAYLOADS["judgment.ask"] });
const HALF = Math.floor(PARTIAL.length / 2);

export async function observe(input) {
  const root = mkdtempSync(path.join(os.tmpdir(), "feat-model-probe-"));
  try {
    const absolute = path.join(root, "abs-judge");
    const options = {
      absolute: { dir: absolute },
      relative: { dir: "judge" },
      missing: {},
      unknownKey: { dir: absolute, url: "http://localhost:1" },
      notString: { dir: 5 },
    }[input.options ?? "absolute"];
    const namespace = { valid: NAMESPACE, none: undefined, bad: "Bad" }[input.namespace ?? "valid"];
    const dir = input.options === "relative" ? path.join(root, "judge") : absolute;
    const file = path.join(dir, `${NAMESPACE}.jsonl`);

    const trace = [];
    let lastTypes;
    let lastPayload;
    const report = (records) => {
      lastTypes = records.map((r) => r.type).join(",");
      lastPayload = records.length > 0 ? records[records.length - 1].payload : undefined;
    };

    const adapter = createAdapter({ key: "model", adapter: "@mmmnt/feat-adapter-model", projectRoot: root, options, ...(namespace !== undefined ? { namespace } : {}) });
    for (const step of input.script.split(/\s+/).filter(Boolean)) {
      if (step === "setup" || step === "teardown" || step === "reset") {
        await adapter[step]();
        trace.push(step);
      } else if (step === "start") {
        await adapter.startCapture();
        trace.push(step);
      } else if (step === "stop" || step === "peek") {
        const records = step === "stop" ? await adapter.stopCapture() : await adapter.peekCapture();
        report(records);
        trace.push(`${step}=${records.length}`);
      } else if (step === "read") {
        const records = await adapter.read({});
        report(records);
        trace.push(`read=${records.length}`);
      } else if (step === "settle") {
        trace.push(`settle=${await adapter.settle()}`);
      } else if (step.startsWith("seed:")) {
        const type = step.slice("seed:".length);
        await adapter.seed([{ type, values: payloadOf(type) }]);
        trace.push(step);
      } else if (step.startsWith("ask:")) {
        const type = step.slice("ask:".length);
        appendFileSync(file, `${JSON.stringify({ type, payload: payloadOf(type) })}\n`);
        trace.push(step);
      } else if (step === "partial") {
        appendFileSync(file, PARTIAL.slice(0, HALF));
        trace.push(step);
      } else if (step === "complete") {
        appendFileSync(file, `${PARTIAL.slice(HALF)}\n`);
        trace.push(step);
      } else if (step === "malformed") {
        appendFileSync(file, "not json\n");
        trace.push(step);
      } else if (step === "systemReads") {
        const text = existsSync(file) ? readFileSync(file, "utf8") : "";
        const complete = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
        const types = complete.split("\n").filter(Boolean).map((line) => JSON.parse(line).type);
        trace.push(`systemReads=${types.join(",")}`);
      } else if (step === "exists") {
        trace.push(`exists=${existsSync(file)}`);
      } else if (step === "where") {
        trace.push(`where=${path.relative(dir, file)}`);
      } else throw new Error(`unknown step '${step}'`);
    }
    const body = { trace: trace.join(" ") };
    if (lastTypes) body.lastTypes = lastTypes;
    if (lastPayload !== undefined) body.lastPayload = lastPayload;
    return { status: "OK", body };
  } catch (err) {
    if (err instanceof ModelAdapterError) return { status: "ERR", body: { code: err.code, detail: err.detail } };
    throw err;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
