// The probe behind `LintNested` (SPEC-ANL-001): run the NESTED_SCHEMA_OPEN rule (ADR-0039) over one scenario built
// from the input — a response prediction and/or service records — against the given schema registry, and answer what
// it found as data: how many findings, and the first one's level and message.
import { lintNestedOpen } from "../src/index.ts";

export async function lintNested(input) {
  const services = {};
  for (const r of input.records ?? []) {
    const p = (services[r.service] ??= { records: [] });
    const rec = { type: r.type, schemaName: r.schemaName, valueBlock: r.valueBlock };
    if (r.partial === true) rec.partial = true;
    if (r.contains === true) (p.contains ??= []).push(rec);
    else p.records.push(rec);
  }
  const prediction = { type: "success", services };
  if (input.response !== undefined) prediction.response = { status: "OK", ...input.response };
  const spec = { scenarios: [{ name: input.scenario ?? "s", prediction }] };
  const findings = lintNestedOpen(spec, input.registry ?? {});
  const body = { count: findings.length };
  if (findings.length > 0) {
    body.level = findings[0].level;
    body.finding = findings[0].message;
  }
  return { status: "OK", body };
}
