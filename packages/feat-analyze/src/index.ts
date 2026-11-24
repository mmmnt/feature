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

// ── DRAFT (ADR-0038; founder rulings 7d3026eb and 55fb39c4): an omitted optional property ─────────────────────
// A value block is partial (ADR-0002): a property it leaves out is never checked, so an optional
// property of the block's schema can appear unpredicted and pass. The rule names every optional
// property a top-level response or record block omits, unless the block is marked `partial`. An error (L2).
type JsonSchema = {
  properties?: Record<string, unknown>;
  required?: string[];
  allOf?: JsonSchema[];
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
};

/** Follow a local ref ("#/$defs/x") inside the bundled schema the schema adapter returned. */
function local(root: JsonSchema, node: JsonSchema | undefined): JsonSchema | undefined {
  let cur = node;
  for (let i = 0; cur?.$ref && cur.$ref.startsWith("#/") && i < 10; i++) {
    let target: unknown = root;
    for (const t of cur.$ref.slice(2).split("/")) target = (target as Record<string, unknown> | undefined)?.[t];
    cur = target as JsonSchema | undefined;
  }
  return cur;
}

function optionalProperties(schema: JsonSchema | undefined): string[] {
  if (!schema || typeof schema !== "object") return [];
  const props: Record<string, unknown> = {};
  const required = new Set<string>();
  const add = (node: JsonSchema | undefined) => {
    const n = local(schema, node);
    if (!n) return;
    Object.assign(props, n.properties ?? {});
    for (const r of n.required ?? []) required.add(r);
    for (const part of n.allOf ?? []) add(part);
  };
  add(schema);
  return Object.keys(props).filter((p) => !required.has(p)).sort();
}

export function lintOptionalFields(spec: BuiltSpec, registry: Record<string, object>): Finding[] {
  const findings: Finding[] = [];
  const check = (where: string, schemaName: string, block: Record<string, unknown> | undefined, partial: boolean) => {
    if (!block || partial) return;
    const omitted = optionalProperties(registry[schemaName] as JsonSchema).filter((p) => !(p in block));
    if (omitted.length > 0)
      findings.push({
        level: "error",
        message: `error [OPTIONAL_UNSTATED]: ${where}: ${schemaName} leaves out optional ${omitted.map((p) => `'${p}'`).join(", ")} — state each (absent, any, or a value), or mark the block '${schemaName} partial { … }' (ADR-0038)`,
      });
  };
  for (const sc of spec.scenarios) {
    const r = sc.prediction.response;
    if (r?.valueBlock) check(`scenario "${sc.name}" › response`, r.schemaName, r.valueBlock, r.partial === true);
    for (const [svc, p] of Object.entries(sc.prediction.services ?? {}))
      for (const rec of [...(p.records ?? []), ...(p.contains ?? [])])
        if (rec.valueBlock)
          check(`scenario "${sc.name}" › ${svc} ${rec.type}`, rec.schemaName, rec.valueBlock, rec.partial === true);
  }
  return findings;
}

// ── ADR-0039 (founder rulings 02af6938, item 5 "Breaking, with a lint"): a nested block under an open schema ──────
// From feat-runtime 0.10.0 a nested value block is exact: a key of its object it does not declare is a violation.
// Where the contract leaves that object open (no `additionalProperties: false` / `unevaluatedProperties: false`, or no
// schema for the property at all), nothing but the block states the object's keys, so a spec written against the
// partial matcher may go red. The migration lint names each such block — a warning, never a config switch.
type ObjectSchema = JsonSchema & {
  additionalProperties?: unknown;
  unevaluatedProperties?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
};

/** The schema of property `key` under `node` (following local refs and allOf), or undefined when none describes it. */
function propertySchema(root: JsonSchema, node: JsonSchema | undefined, key: string): JsonSchema | undefined {
  const n = local(root, node);
  if (!n || typeof n !== "object") return undefined;
  const own = (n.properties ?? {})[key] as JsonSchema | undefined;
  if (own !== undefined) return own;
  for (const part of n.allOf ?? []) {
    const found = propertySchema(root, part, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** True when the schema admits no key beyond the ones it declares. */
function closedObject(root: JsonSchema, node: JsonSchema | undefined): boolean {
  const n = local(root, node) as ObjectSchema | undefined;
  if (!n || typeof n !== "object") return false;
  if (n.additionalProperties === false || n.unevaluatedProperties === false) return true;
  if ((n.allOf ?? []).some((part) => closedObject(root, part))) return true;
  const branches = [...(n.anyOf ?? []), ...(n.oneOf ?? [])];
  return branches.length > 0 && branches.every((b) => closedObject(root, b));
}

type BlockMatcher = { matcher?: string; fields?: Record<string, BlockMatcher> };

export function lintNestedOpen(spec: BuiltSpec, registry: Record<string, object>): Finding[] {
  const findings: Finding[] = [];
  const walk = (where: string, schemaName: string, root: JsonSchema, node: JsonSchema | undefined, block: Record<string, unknown>, path: string[]) => {
    for (const [key, m] of Object.entries(block)) {
      const matcher = m as BlockMatcher;
      if (matcher?.matcher !== "nested" || typeof matcher.fields !== "object" || matcher.fields === null) continue;
      const sub = propertySchema(root, node, key);
      const at = [...path, key];
      if (!closedObject(root, sub))
        findings.push({
          level: "warn",
          message: `warn [NESTED_SCHEMA_OPEN]: ${where} › ${at.join(" › ")}: ${schemaName} leaves '${at.join(".")}' open, so from feat-runtime 0.10.0 a key the block does not state fails the scenario (ADR-0039) — close it (additionalProperties: false), or check the block states every key`,
        });
      walk(where, schemaName, root, sub, matcher.fields, at);
    }
  };
  const check = (where: string, schemaName: string, block: Record<string, unknown> | undefined) => {
    if (!block) return;
    const root = registry[schemaName] as JsonSchema | undefined;
    walk(where, schemaName, root ?? {}, root, block, []);
  };
  for (const sc of spec.scenarios) {
    const r = sc.prediction.response;
    if (r?.valueBlock) check(`scenario "${sc.name}" › response`, r.schemaName, r.valueBlock);
    for (const [svc, p] of Object.entries(sc.prediction.services ?? {}))
      for (const rec of [...(p.records ?? []), ...(p.contains ?? [])])
        if (rec.valueBlock) check(`scenario "${sc.name}" › ${svc} ${rec.type}`, rec.schemaName, rec.valueBlock);
  }
  return findings;
}
