// The probe behind `MatchValue` (SPEC-RT-011): run one matcher of the IR against one value through
// applyMatcher, at the anchor "a", and answer what it reported as data. The field is present when the
// input has a `value` key (null included) and absent otherwise. `captures` maps a service key to the
// payloads it captured, in capture order; `when` and `delivers` are the stimulus as sent.
import { applyMatcher } from "../../src/index.ts";

export async function matchValue(input) {
  const captures = new Map(
    Object.entries(input.captures ?? {}).map(([service, payloads]) => [service, payloads.map((payload) => ({ type: "Captured", payload }))]),
  );
  const ctx = { when: input.when, delivers: input.delivers, captures, inline: { schemas: {}, goldens: {} } };
  const out = [];
  const present = Object.prototype.hasOwnProperty.call(input, "value");
  applyMatcher(present ? input.value : undefined, present, input.matcher, ctx, "a", out);
  const body = { outcome: out.length === 0 ? "passed" : "failed", count: out.length };
  if (out.length > 0) body.violation = out[0];
  return { status: "OK", body };
}
