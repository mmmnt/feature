// toMatchPrediction semantics (ADR-0002/0004/0011/0013) — the prediction diff.
// Pure: returns a list of violations, each carrying its anchor; the harness throws.

import type { CapturedRecord, CapturedResponse, Matcher, PredictedRecord, ValueBlock } from "@mmmnt/feat-types";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
const compiled = new Map<string, ReturnType<typeof ajv.compile>>();

export interface InlineData {
  schemas: Record<string, object>;
  goldens: Record<string, unknown>;
}

export interface MatchContext {
  when?: Record<string, unknown> | undefined;
  delivers?: Record<string, unknown>[] | undefined;
  inline: InlineData;
}

function validateSchema(schemaName: string, data: unknown, ctx: MatchContext, anchor: string, out: string[]) {
  const schema = ctx.inline.schemas[schemaName];
  if (!schema) {
    out.push(`${anchor}: schema '${schemaName}' was not inlined at generate time`);
    return;
  }
  let v = compiled.get(schemaName);
  if (!v) {
    v = ajv.compile(schema);
    compiled.set(schemaName, v);
  }
  if (!v(data)) {
    const first = (v.errors ?? [])[0];
    out.push(`${anchor}: schema '${schemaName}' violation — ${first?.instancePath ?? ""} ${first?.message ?? "invalid"}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (!deepEqual(ka, kb)) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const RX = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
};

function pathGet(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function applyMatcher(actual: unknown, present: boolean, m: Matcher, ctx: MatchContext, anchor: string, out: string[]) {
  switch (m.matcher) {
    case "absent":
      if (present) out.push(`${anchor}: expected field to be absent, found ${JSON.stringify(actual)}`);
      return;
    case "literal":
      if (!present || !deepEqual(actual, m.value))
        out.push(`${anchor}: expected ${JSON.stringify(m.value)}, got ${present ? JSON.stringify(actual) : "(absent)"}`);
      return;
    case "whenRef": {
      const expected = pathGet(ctx.when ?? {}, m.path);
      if (!present || !deepEqual(actual, expected))
        out.push(`${anchor}: expected @when.${m.path} = ${JSON.stringify(expected)}, got ${present ? JSON.stringify(actual) : "(absent)"}`);
      return;
    }
    case "deliverRef": {
      const delivery = (ctx.delivers ?? [])[m.index ?? 0];
      const expected = pathGet(delivery ?? {}, m.path);
      if (!present || !deepEqual(actual, expected))
        out.push(`${anchor}: expected @deliver.${m.path} = ${JSON.stringify(expected)}, got ${present ? JSON.stringify(actual) : "(absent)"}`);
      return;
    }
    case "any": {
      if (!present) {
        out.push(`${anchor}: expected a value (any${m.ofType ? ` ${m.ofType}` : ""}), field is absent`);
        return;
      }
      if (m.ofType === "uuid" && !(typeof actual === "string" && RX.uuid.test(actual)))
        out.push(`${anchor}: expected any uuid, got ${JSON.stringify(actual)}`);
      else if (m.ofType === "timestamp" && !(typeof actual === "string" && RX.timestamp.test(actual)))
        out.push(`${anchor}: expected any timestamp, got ${JSON.stringify(actual)}`);
      else if (m.ofType === "string" && typeof actual !== "string")
        out.push(`${anchor}: expected any string, got ${JSON.stringify(actual)}`);
      else if (m.ofType === "number" && typeof actual !== "number")
        out.push(`${anchor}: expected any number, got ${JSON.stringify(actual)}`);
      else if (m.ofType === "boolean" && typeof actual !== "boolean")
        out.push(`${anchor}: expected any boolean, got ${JSON.stringify(actual)}`);
      return;
    }
    case "regex": {
      if (typeof m.pattern !== "string") {
        out.push(`${anchor}: unresolved placeholder in matching-argument reached the runtime (derive bug)`);
        return;
      }
      if (!present || typeof actual !== "string" || !new RegExp(m.pattern).test(actual))
        out.push(`${anchor}: expected string matching /${m.pattern}/, got ${present ? JSON.stringify(actual) : "(absent)"}`);
      return;
    }
    case "goldenFixture": {
      const golden = ctx.inline.goldens[m.path];
      if (golden === undefined) out.push(`${anchor}: golden fixture '${m.path}' was not inlined at generate time`);
      else if (!present || !deepEqual(actual, golden)) out.push(`${anchor}: value does not equal golden fixture '${m.path}'`);
      return;
    }
    case "nested": {
      if (!present || typeof actual !== "object" || actual === null) {
        out.push(`${anchor}: expected an object for nested block, got ${present ? JSON.stringify(actual) : "(absent)"}`);
        return;
      }
      applyValueBlock(actual as Record<string, unknown>, m.fields, ctx, anchor, out);
      return;
    }
    case "placeholder":
      out.push(`${anchor}: unresolved placeholder '<${m.name}>' reached the runtime (derive bug)`);
      return;
  }
}

export function applyValueBlock(actual: Record<string, unknown>, block: ValueBlock, ctx: MatchContext, anchor: string, out: string[]) {
  for (const [field, m] of Object.entries(block)) {
    const present = Object.prototype.hasOwnProperty.call(actual, field);
    applyMatcher(actual[field], present, m, ctx, `${anchor} › ${field}`, out);
  }
}

function recordMatches(captured: CapturedRecord, predicted: PredictedRecord, ctx: MatchContext): boolean {
  if (captured.type !== predicted.type) return false;
  const probe: string[] = [];
  validateSchema(predicted.schemaName, captured.payload, ctx, "", probe);
  if (probe.length > 0) return false;
  if (predicted.golden !== undefined) {
    const golden = ctx.inline.goldens[predicted.golden];
    return golden !== undefined && deepEqual(captured.payload, golden);
  }
  if (predicted.valueBlock) {
    applyValueBlock(captured.payload, predicted.valueBlock, ctx, "", probe);
    return probe.length === 0;
  }
  return true;
}

export function diffResponse(
  actual: CapturedResponse | undefined,
  predicted: { status: number | string; schemaName: string; valueBlock?: ValueBlock; golden?: string },
  ctx: MatchContext,
  anchor: string,
  out: string[],
) {
  if (!actual) {
    out.push(`${anchor} › response: no response captured`);
    return;
  }
  if (!deepEqual(actual.status, predicted.status))
    out.push(`${anchor} › response: expected status ${JSON.stringify(predicted.status)}, got ${JSON.stringify(actual.status)}`);
  validateSchema(predicted.schemaName, actual.body, ctx, `${anchor} › response`, out);
  if (predicted.golden !== undefined) {
    const golden = ctx.inline.goldens[predicted.golden];
    if (golden === undefined) out.push(`${anchor} › response: golden fixture '${predicted.golden}' was not inlined`);
    else if (!deepEqual(actual.body, golden)) out.push(`${anchor} › response: body does not equal golden fixture '${predicted.golden}'`);
  } else if (predicted.valueBlock && actual.body) {
    applyValueBlock(actual.body, predicted.valueBlock, ctx, `${anchor} › response`, out);
  }
}

export function diffRecords(
  captured: CapturedRecord[],
  predicted: PredictedRecord[],
  ordering: "ordered" | "unordered",
  ctx: MatchContext,
  anchor: string,
  out: string[],
) {
  if (ordering === "ordered") {
    const max = Math.max(captured.length, predicted.length);
    for (let i = 0; i < max; i++) {
      const c = captured[i];
      const p = predicted[i];
      if (c && p && !recordMatches(c, p, ctx))
        out.push(`${anchor}[${i}]: captured ${c.type} does not match predicted ${p.type} (${p.schemaName})`);
      else if (c && !p) out.push(`${anchor}[${i}]: UNPREDICTED record ${c.type}`);
      else if (!c && p) out.push(`${anchor}[${i}]: MISSING predicted record ${p.type} (${p.schemaName})`);
    }
    return;
  }
  // unordered: multiset matching, greedy pairing for diagnostics
  const remaining = [...captured];
  for (const p of predicted) {
    const idx = remaining.findIndex((c) => recordMatches(c, p, ctx));
    if (idx === -1) out.push(`${anchor}: MISSING predicted record ${p.type} (${p.schemaName})`);
    else remaining.splice(idx, 1);
  }
  for (const c of remaining) out.push(`${anchor}: UNPREDICTED record ${c.type}`);
}
