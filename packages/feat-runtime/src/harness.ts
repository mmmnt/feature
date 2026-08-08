// The generated-test harness (ADR-0001/0014): config-driven adapter loading via
// createAdapter, per-file adapter instances, single shared capture window per test,
// precondition execution before the window opens (INV-9), prediction diff via the matcher.

import path from "node:path";
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import type {
  CapturedRecord, CapturedResponse, FeatConfig, FeatResponseAdapter, FeatServiceAdapter,
} from "@mmmnt/feat-types";
import { importAdapter } from "./import-adapter.js";
import { loadConfig, variablesSidecarPath } from "./load-config.js";
import { diffContains, diffRecords, diffResponse, type InlineData, type MatchContext } from "./matcher.js";

// ── Spec variables (ADR-0017) ────────────────────────────────────────────────
// Sources resolve ONCE PER CASE at execution start; every ${name} reference in
// the case's string literals (inputs, seeds, predictions) shares the value by
// construction. now() honors a frozen scenario clock (ADR-0012) — one time
// concept in the language.
export interface CaseVariable {
  name: string;
  type: "string" | "number";
  definition:
    | { kind: "call"; fn: "now" | "unique" }
    | { kind: "number"; value: number }
    | { kind: "template"; parts: (string | { ref: string })[] };
}

let uniqueCounter = 0;

/** Resolve a case's variable table. Exported for unit testing. */
export function resolveVariables(vars: CaseVariable[], frozenClock?: string): Record<string, string | number> {
  const byName = new Map(vars.map((v) => [v.name, v]));
  const out: Record<string, string | number> = {};
  const resolve = (name: string): string | number => {
    if (name in out) return out[name]!;
    const v = byName.get(name);
    if (!v) throw new Error(`Variable '\${${name}}' is not declared — configuration error.`);
    let value: string | number;
    if (v.definition.kind === "call") {
      value =
        v.definition.fn === "now"
          ? frozenClock !== undefined
            ? Date.parse(frozenClock)
            : Date.now()
          : `${Date.now().toString(36)}${(uniqueCounter++).toString(36)}${randomBytes(3).toString("hex")}`;
    } else if (v.definition.kind === "number") {
      value = v.definition.value;
    } else {
      value = v.definition.parts.map((p) => (typeof p === "string" ? p : String(resolve(p.ref)))).join("");
    }
    out[name] = value;
    return value;
  };
  for (const v of vars) resolve(v.name);
  return out;
}

/** Substitute ${name} references (declared names only) through a value tree. */
export function substituteVariables<T>(value: T, resolved: Record<string, string | number>): T {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
      name in resolved ? String(resolved[name]) : whole,
    ) as T;
  }
  if (Array.isArray(value)) return value.map((v) => substituteVariables(v, resolved)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteVariables(v, resolved);
    return out as T;
  }
  return value;
}

export interface HarnessCase {
  anchor: string;
  name: string;
  /** ADR-0017: the spec's variable table, resolved once per case. */
  variables?: CaseVariable[];
  given?: {
    clock?: string;
    context?: string[];
    executes?: { command: string; actor?: string; payload: Record<string, unknown> }[];
    seeds?: ({ service: string; records: { type: string; schemaName?: string; values: Record<string, unknown> }[] } | { service: string; fixture: string })[];
  };
  when?: { command: string; actor?: string; payload: Record<string, unknown> };
  delivers?: { event: string; payload: Record<string, unknown>; service: string }[];
  prediction: {
    type: "success" | "rejection" | "error";
    rejectionId?: string;
    errorCode?: string;
    response?: { status: number | string; schemaName: string; valueBlock?: Record<string, unknown>; golden?: string };
    services: Record<string, { ordering: "ordered" | "unordered"; records?: unknown[]; contains?: unknown[] }>;
  };
}

export class PredictionViolation extends Error {
  constructor(public violations: string[]) {
    super(`Prediction violated:\n  ${violations.join("\n  ")}`);
  }
}

export interface Harness {
  runCase(c: HarnessCase, inline: InlineData): Promise<void>;
  teardown(): Promise<void>;
}

export async function createHarness(opts: { configPath: string }): Promise<Harness> {
  const loaded = await loadConfig({ path: opts.configPath });
  if (loaded.status === "ERR")
    throw new Error(`Configuration error (exit 2): ${JSON.stringify(loaded.body)}`);
  const config = loaded.body as unknown as FeatConfig;
  // The project root is where the config lives — all module/scope resolution anchors there,
  // so generated tests behave identically regardless of the invoking cwd.
  const projectRoot = path.dirname(path.resolve(process.cwd(), opts.configPath));

  let response: FeatResponseAdapter | undefined;
  if (config.response) {
    const mod = await importAdapter(config.response.adapter, projectRoot);
    response = mod.createAdapter({ ...config.response, projectRoot }) as FeatResponseAdapter;
    await response.setup(config.response.invoke ?? {});
  }

  const services = new Map<string, FeatServiceAdapter>();
  for (const [key, svc] of Object.entries(config.services)) {
    const mod = await importAdapter(svc.adapter, projectRoot);
    const adapter = mod.createAdapter({ key, ...svc, projectRoot }) as FeatServiceAdapter;
    await adapter.setup();
    services.set(key, adapter);
  }

  async function runCase(rawCase: HarnessCase, inline: InlineData): Promise<void> {
    // ADR-0017: resolve the variable table once, substitute throughout — the
    // case's given/when/predictions share every value by construction.
    let c = rawCase;
    if (rawCase.variables && rawCase.variables.length > 0) {
      const resolved = resolveVariables(rawCase.variables, rawCase.given?.clock);
      const { variables: _table, ...rest } = rawCase;
      c = { ...substituteVariables(rest as HarnessCase, resolved) };
      // ADR-0017 evidence channel: the resolved values land in the sidecar
      // (.feature/run/, cleared by feat run pre-spawn) so the bundle can
      // replay the substitution per case — recorded whether the case passes.
      const sidecar = variablesSidecarPath(projectRoot, opts.configPath);
      mkdirSync(path.dirname(sidecar), { recursive: true });
      appendFileSync(sidecar, JSON.stringify({ anchor: rawCase.anchor, variables: resolved }) + "\n");
    }
    const violations: string[] = [];
    for (const adapter of services.values()) await adapter.reset();

    // ── Preconditions: before the capture window (INV-9) ──
    for (const seed of c.given?.seeds ?? []) {
      const adapter = services.get(seed.service);
      if (!adapter) throw new Error(`${c.anchor}: seed targets unknown service '${seed.service}'`);
      if (!adapter.seed) throw new Error(`${c.anchor}: adapter for '${seed.service}' does not support seed() — configuration error.`);
      if ("fixture" in seed) throw new Error(`${c.anchor}: fixture seeds require generate-time inlining (not yet wired)`);
      await adapter.seed(seed.records);
    }
    for (const pre of c.given?.executes ?? []) {
      if (!response) throw new Error(`${c.anchor}: execute precondition requires a response adapter`);
      await response.invoke(pre.command, pre.payload, pre.actor);
    }

    // ── Capture window ──
    for (const adapter of services.values()) await adapter.startCapture();

    let captured: CapturedResponse | undefined;
    if (c.when) {
      if (!response) throw new Error(`${c.anchor}: when: requires a response adapter`);
      captured = await response.invoke(c.when.command, c.when.payload, c.when.actor);
    }
    // deliver-triggered stimulus (ADR-0011): events delivered in order, inside the
    // window; the delivered stimuli themselves are excluded from capture by the adapter.
    for (const d of c.delivers ?? []) {
      const adapter = services.get(d.service);
      if (!adapter) throw new Error(`${c.anchor}: deliver targets unknown service '${d.service}'`);
      if (!adapter.deliver)
        throw new Error(`${c.anchor}: adapter for '${d.service}' does not support deliver() — configuration error.`);
      await adapter.deliver(d.event, d.payload);
    }

    // ADR-0020 (revising ADR-0014): convergence is a CEILING, not a
    // sentence. When every eventual service in the prediction asserts a
    // non-empty record list and its adapter can peek, poll and exit as soon
    // as each target count has arrived AND the capture has gone quiet for
    // one extra poll — prediction inversion demands that extra unpredicted
    // records still get their chance to surface. Absence proofs (records
    // []), contains assertions, and peek-less adapters keep the full window.
    let wait = 0;
    for (const key of Object.keys(c.prediction.services)) {
      const svc = config.services[key];
      if (svc?.consistency === "eventual")
        wait = Math.max(wait, svc.convergenceTimeout ?? 0);
    }
    if (wait > 0) {
      const goals: Array<{ peek: () => Promise<CapturedRecord[]>; min: number }> = [];
      let earlyExitLegal = true;
      for (const [key, assertion] of Object.entries(c.prediction.services)) {
        const svc = config.services[key];
        if (svc?.consistency !== "eventual") continue;
        const records = (assertion as { records?: unknown[] }).records;
        const hasContains = (assertion as { contains?: unknown[] }).contains !== undefined;
        const adapter = services.get(key);
        const peek = adapter?.peekCapture?.bind(adapter);
        if (!hasContains && Array.isArray(records) && records.length > 0 && peek) {
          goals.push({ peek, min: records.length });
        } else {
          earlyExitLegal = false;
        }
      }
      if (earlyExitLegal && goals.length > 0) {
        const deadline = Date.now() + wait;
        const POLL_MS = 150;
        let lastTotal = -1;
        while (Date.now() < deadline) {
          let total = 0;
          let reached = true;
          for (const g of goals) {
            const count = (await g.peek()).length;
            total += count;
            if (count < g.min) reached = false;
          }
          // Exit only when every target is met AND nothing new arrived since
          // the previous poll — the quiet grace that keeps inversion honest.
          if (reached && total === lastTotal) break;
          lastTotal = total;
          await new Promise((r) => setTimeout(r, Math.min(POLL_MS, Math.max(1, deadline - Date.now()))));
        }
      } else {
        await new Promise((r) => setTimeout(r, wait));
      }
    }

    const capturedRecords = new Map<string, CapturedRecord[]>();
    for (const [key, adapter] of services) capturedRecords.set(key, await adapter.stopCapture());

    // ── Diff ──
    const ctx: MatchContext = {
      when: c.when?.payload,
      delivers: c.delivers?.map((d) => d.payload),
      inline,
    };
    if (c.prediction.response)
      diffResponse(captured, c.prediction.response as never, ctx, c.anchor, violations);
    for (const [key, assertion] of Object.entries(c.prediction.services)) {
      if (assertion.records !== undefined)
        diffRecords(capturedRecords.get(key) ?? [], assertion.records as never, assertion.ordering, ctx, `${c.anchor} › ${key}`, violations);
      if (assertion.contains !== undefined) {
        const adapter = services.get(key);
        if (!adapter) {
          violations.push(`${c.anchor} › ${key}: unknown service for contains assertion`);
        } else {
          // contains (ADR-0011): resulting state via adapter read(); the shared
          // convergence wait has already elapsed for eventual services.
          const state = await adapter.read({});
          const records = Array.isArray(state) ? (state as CapturedRecord[]) : [];
          if (!Array.isArray(state))
            violations.push(`${c.anchor} › ${key}: adapter read() did not return a record array — configuration error.`);
          else diffContains(records, assertion.contains as never, ctx, `${c.anchor} › ${key}`, violations);
        }
      }
    }
    if (violations.length > 0) throw new PredictionViolation(violations);
  }

  return {
    runCase,
    async teardown() {
      for (const adapter of services.values()) await adapter.teardown();
      if (response) await response.teardown();
    },
  };
}
