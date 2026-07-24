// @mmmnt/feat-analyze — pure analysis over parsed specs and spec source.
// No filesystem, no process, no CLI: everything here is (spec | source) → findings.
// The `feat lint/audit/fmt` commands are thin callers; embedders (services,
// editors) call these directly. Finding messages are the exact strings the CLI
// prints — extraction changed nothing observable.

import type { BuiltSpec } from "@mmmnt/feat-types";

export interface Finding {
  level: "error" | "warn" | "info";
  message: string;
}

/**
 * Language-quality lint rules beyond audit's buildability gate (ADR-0007):
 * declared-but-unused schemas, duplicate contract declarations, draft surfacing.
 */
export function lintSpec(spec: BuiltSpec): Finding[] {
  const findings: Finding[] = [];

  // ADR-0007: declared-but-unused schema = lint warning
  const used = new Set<string>();
  for (const sc of spec.scenarios) {
    if (sc.prediction.response) used.add(sc.prediction.response.schemaName);
    for (const svc of Object.values(sc.prediction.services ?? {})) {
      for (const r of svc.records ?? []) used.add(r.schemaName);
      for (const r of svc.contains ?? []) used.add(r.schemaName);
    }
    for (const seed of sc.given?.seeds ?? [])
      if ("records" in seed) for (const r of seed.records) if (r.schemaName) used.add(r.schemaName);
  }
  for (const entry of spec.contract) {
    if (entry.kind === "stream") continue;
    // `input` is used by definition: it is the when-payload's contract.
    if (entry.kind === "input") continue;
    if (!used.has(entry.schemaName))
      findings.push({ level: "warn", message: `warn: schema '${entry.schemaName}' is declared but never referenced by a scenario` });
  }

  // ADR-0017: declared-but-unused variable = lint warning (same discipline
  // as schema declarations; the parser already errors on undeclared refs).
  if (spec.variables && spec.variables.length > 0) {
    const referenced = new Set<string>();
    const collect = (v: unknown): void => {
      if (typeof v === "string") {
        for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) referenced.add(m[1]!);
      } else if (Array.isArray(v)) v.forEach(collect);
      else if (v !== null && typeof v === "object") Object.values(v).forEach(collect);
    };
    collect(spec.scenarios);
    for (const variable of spec.variables) {
      if (variable.definition.kind === "template")
        for (const p of variable.definition.parts) if (typeof p === "object") referenced.add(p.ref);
    }
    for (const variable of spec.variables)
      if (!referenced.has(variable.name))
        findings.push({ level: "warn", message: `warn: variable '${variable.name}' is declared but never referenced` });
  }

  // Style: duplicate contract declarations
  const seen = new Set<string>();
  for (const entry of spec.contract) {
    if (entry.kind === "stream") continue;
    const key = `${entry.kind}:${entry.schemaName}`;
    if (seen.has(key)) findings.push({ level: "warn", message: `warn: duplicate contract declaration '${entry.kind} ${entry.schemaName}'` });
    seen.add(key);
  }

  if (spec.identity.status === "draft")
    findings.push({ level: "info", message: "info: status draft — not buildable until agreed" });

  return findings;
}

const CODE_TYPES = new Set(["command", "query", "policy", "projection", "saga"]);

export interface AuditResult {
  /** ADR-0008 buildability failures (B1–B3) — block the agreed gate. */
  errors: string[];
  /** Lifecycle surfacing — advisory. */
  warnings: string[];
}

/**
 * Spec-level audit: B1 handler-for-code-types, B2 two-way rejects↔rejection
 * traceability (outline placeholder IDs resolved through example rows), B3
 * touches present, lifecycle status. File-pairing checks (contract/test
 * existence) are filesystem concerns and live with the caller.
 */
export function auditSpec(spec: BuiltSpec): AuditResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // B1: handler present for code-producing types
  if (CODE_TYPES.has(spec.identity.type) && !spec.construct.some((c) => c.kind === "handler"))
    errors.push("B1: no `handler at` for a code-producing spec type");
  // B3: touches always required
  if (!spec.construct.some((c) => c.kind === "touches"))
    errors.push("B3: no `touches` change boundary declared");
  // B2: two-way rejects ↔ predicted rejection IDs
  const rejectsIds = new Set(
    spec.enforce.filter((e) => e.kind === "rejects").map((e) => e.rejectionId as string),
  );
  const predictedIds = new Set<string>();
  for (const sc of spec.scenarios) {
    const rid = sc.prediction.rejectionId;
    if (!rid) continue;
    const ph = /^<(.+)>$/.exec(rid);
    if (ph) {
      for (const row of sc.examples ?? []) {
        const v = row[ph[1]!];
        if (typeof v === "string") predictedIds.add(v);
      }
    } else predictedIds.add(rid);
  }
  for (const id of predictedIds)
    if (!rejectsIds.has(id)) errors.push(`B2: predicted rejection '${id}' has no \`rejects ${id} when …\` line`);
  for (const id of rejectsIds)
    if (!predictedIds.has(id)) errors.push(`B2: \`rejects ${id}\` is never predicted by any scenario`);

  // Lifecycle
  if (spec.identity.status === "draft") warnings.push("status draft — not buildable until agreed");

  return { errors, warnings };
}

export interface FormatResult {
  formatted: string;
  changed: boolean;
  /** Tabs in leading whitespace are a parse error; fmt reports, never rewrites. */
  hasLeadingTab: boolean;
}

/**
 * Conservative canonical formatting: trailing-whitespace strip, collapse >1
 * blank line, ensure single trailing newline. Content-preserving, idempotent.
 */
export function formatSource(source: string): FormatResult {
  const hasLeadingTab = /^\t/m.test(source);
  const lines = source.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ""));
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks++;
      if (blanks > 1) continue;
    } else blanks = 0;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  const formatted = out.join("\n") + "\n";
  return { formatted, changed: formatted !== source, hasLeadingTab };
}
