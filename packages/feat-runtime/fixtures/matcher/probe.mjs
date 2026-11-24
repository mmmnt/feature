// The probe behind `MatchValue` (SPEC-RT-011): run one matcher of the IR against one value through
// applyMatcher, at the anchor "a", and answer what it reported as data. The field is present when the
// input has a `value` key (null included) and absent otherwise. `captures` maps a service key to the
// payloads it captured, in capture order; `when` and `delivers` are the stimulus as sent; `given` is the
// response bodies of the given's executes, in written order (SPEC-RT-012).
import { applyMatcher } from "../../src/index.ts";

export async function matchValue(input) {
  if (input.predicted !== undefined || input.expect !== undefined) {
    const out = diffPrediction(input);
    const body = { outcome: out.length === 0 ? "passed" : "failed", count: out.length };
    if (out.length > 0) body.violation = out[0];
    return { status: "OK", body };
  }
  const captures = new Map(
    Object.entries(input.captures ?? {}).map(([service, payloads]) => [service, payloads.map((payload) => ({ type: "Captured", payload }))]),
  );
  const ctx = { when: input.when, delivers: input.delivers, captures, given: input.given, inline: { schemas: {}, goldens: {} } };
  const out = [];
  const present = Object.prototype.hasOwnProperty.call(input, "value");
  applyMatcher(present ? input.value : undefined, present, input.matcher, ctx, "a", out);
  const body = { outcome: out.length === 0 ? "passed" : "failed", count: out.length };
  if (out.length > 0) body.violation = out[0];
  return { status: "OK", body };
}

// ── The diff form of `MatchValue` (drafts/exact-nested-blocks, SPEC-RT-017): an input with `predicted` runs the
// record diff on `records` (`has` ordered, or unordered / `contains` per `mode`); an input with `expect` runs the
// response diff on `response`. At the anchor "a"; every schema the prediction names is inlined open
// (`{ "type": "object" }`), so only the value block decides. Records are `{ type, payload }`; a response is
// `{ status, body }`.
import { diffContains, diffRecords, diffResponse } from "../../src/matcher.ts";

function diffPrediction(input) {
  const names = [...(input.predicted ?? []).map((p) => p.schemaName), input.expect?.schemaName].filter(Boolean);
  const ctx = { inline: { schemas: Object.fromEntries(names.map((n) => [n, { type: "object" }])), goldens: {} } };
  const out = [];
  if (input.expect !== undefined) diffResponse(input.response, input.expect, ctx, "a", out);
  else {
    const captured = (input.records ?? []).map((r) => ({ type: r.type, payload: r.payload, timestamp: 0 }));
    if (input.mode === "contains") diffContains(captured, input.predicted, ctx, "a", out);
    else diffRecords(captured, input.predicted, input.mode === "unordered" ? "unordered" : "ordered", ctx, "a", out);
  }
  return out;
}
