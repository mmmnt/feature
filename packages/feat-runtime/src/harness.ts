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
import { HarnessConfigurationError, type HarnessConfigurationCode } from "./errors.js";
import { loadConfig, variablesSidecarPath } from "./load-config.js";
import { assertNamespaceNotConfigured, deriveNamespace } from "./namespace.js";
import { diffContains, diffRecords, diffResponse, pathGet, type InlineData, type MatchContext } from "./matcher.js";
import { EXCLUSIVE_FAULTS, type Fault, type FaultCatalog, type FaultCount, type ReadQuery } from "@mmmnt/feat-types";

// ── Spec variables (ADR-0017) ────────────────────────────────────────────────
// Sources resolve ONCE PER CASE at execution start; every ${name} reference in
// the case's string literals (inputs, seeds, predictions) shares the value by
// construction. now() honors a frozen scenario clock (ADR-0012) — one time
// concept in the language.
export interface CaseVariable {
  name: string;
  type: "string" | "number";
  definition:
    | { kind: "call"; fn: "now" | "iso" | "unique"; offsetMs?: number }
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
      if (v.definition.fn === "unique") {
        value = `${Date.now().toString(36)}${(uniqueCounter++).toString(36)}${randomBytes(3).toString("hex")}`;
      } else {
        // One time concept: the scenario clock when frozen (ADR-0012), wall clock otherwise.
        // The offset is applied to that base, so a frozen clock stays fully deterministic.
        const base = frozenClock !== undefined ? Date.parse(frozenClock) : Date.now();
        const at = base + (v.definition.offsetMs ?? 0);
        // `iso` renders the instant; `now` reports it as epoch millis.
        value = v.definition.fn === "iso" ? new Date(at).toISOString() : at;
      }
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

// ── @given.response references ───────────────────────────────────────────────
// A scenario that establishes state with `execute` needs to name what that
// execution produced — an id the system minted, which the spec cannot know in
// advance. Without this, the only alternatives are hard-coding an id (forcing a
// command to accept a caller-supplied one purely for testability) or leaving the
// setup unreferencable. `@given.response.<path>` reads the MOST RECENT preceding
// execute's response body, which is what a reader assumes on sight.
const GIVEN_REF = /^@given\.response\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)$/;

/**
 * Replace `@given.response.<path>` strings through a value tree.
 *
 * Fails loudly on an unresolvable reference. Passing the literal through — which is
 * what happened before this existed — sends the string "@given.response.id" to the
 * system under test, which then fails somewhere far away for a reason that looks
 * nothing like the cause.
 */
export function resolveGivenRefs<T>(value: T, last: CapturedResponse | undefined, anchor: string): T {
  if (typeof value === "string") {
    const m = GIVEN_REF.exec(value);
    if (!m) return value;
    if (!last)
      throw new Error(`${anchor}: '${value}' references a given response, but no execute precedes it.`);
    const path = m[1]!.split(".");
    let cur: unknown = last.body;
    for (const key of path) {
      if (cur === null || typeof cur !== "object" || !(key in (cur as Record<string, unknown>)))
        throw new Error(`${anchor}: '${value}' — the preceding response has no '${m[1]}'.`);
      cur = (cur as Record<string, unknown>)[key];
    }
    return cur as T;
  }
  if (Array.isArray(value)) return value.map((v) => resolveGivenRefs(v, last, anchor)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveGivenRefs(v, last, anchor);
    return out as T;
  }
  return value;
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
  /** The spec's type — handed to each service adapter's startCapture (see TestCase.specType). */
  specType?: string;
  /** ADR-0017: the spec's variable table, resolved once per case. */
  variables?: CaseVariable[];
  given?: {
    clock?: string;
    faults?: Fault[];
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
    services: Record<string, { ordering?: "ordered" | "unordered"; records?: unknown[]; contains?: unknown[] }>;
  };
}

export { HarnessConfigurationError } from "./errors.js";

const COUNT_WORDS: Record<FaultCount, string> = { once: "once", times: "times n", reset: "until reset" };

/** Why an adapter cannot arm this fault (ADR-0023), or undefined when it can. */
export function faultProblem(adapter: FeatServiceAdapter | undefined, f: Fault): string | undefined {
  if (!adapter) return `service '${f.service}' is not configured`;
  if (typeof adapter.fault !== "function") return `the adapter for '${f.service}' has no fault() method`;
  if (f.detail !== undefined && adapter.acceptsFaultDetail === false)
    return `the adapter for '${f.service}' cannot carry a fault detail to the product`;
  const catalog: FaultCatalog = adapter.faults ?? {};
  const entry = catalog[f.operation];
  if (entry === undefined)
    return `the adapter for '${f.service}' offers no operation '${f.operation}' (offers: ${Object.keys(catalog).join(", ") || "none"})`;
  const names = Array.isArray(entry) ? (entry as readonly string[]) : Object.keys(entry);
  if (!names.includes(f.fault))
    return `the adapter for '${f.service}' offers no fault '${f.fault}' under '${f.operation}' (offers: ${names.join(", ")})`;
  const counts: readonly FaultCount[] = Array.isArray(entry) ? ["once", "times", "reset"] : (entry as Record<string, readonly FaultCount[]>)[f.fault]!;
  const wanted: FaultCount = f.times === "reset" ? "reset" : f.times === 1 && counts.includes("once") ? "once" : "times";
  if (!counts.includes(wanted))
    return `the fault '${f.operation}/${f.fault}' of '${f.service}' declares only ${counts.map((c) => COUNT_WORDS[c]).join(" | ")}, not ${f.times === "reset" ? "until reset" : f.times === 1 ? "once" : `times ${f.times}`}`;
  return undefined;
}

/** The query hint of a `contains` assertion: type + the literal top-level fields (and @when values) of each record. */
function readHint(contains: unknown[], when: Record<string, unknown> | undefined): ReadQuery {
  const expect = (contains as { type: string; valueBlock?: Record<string, { matcher: string; value?: unknown; path?: string }> }[]).map((r) => {
    const key: Record<string, string | number | boolean | null> = {};
    for (const [field, m] of Object.entries(r.valueBlock ?? {})) {
      const v = m.matcher === "literal" ? m.value : m.matcher === "whenRef" ? pathGet(when ?? {}, m.path ?? "") : undefined;
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) key[field] = v as string | number | boolean | null;
    }
    return Object.keys(key).length > 0 ? { type: r.type, key } : { type: r.type };
  });
  return { expect };
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

export async function createHarness(opts: { configPath: string; specPath?: string }): Promise<Harness> {
  const loaded = await loadConfig({ path: opts.configPath });
  if (loaded.status === "ERR") {
    // The loader's own code, as [CODE], like every other refusal (README: exit 2).
    const b = loaded.body as { code: HarnessConfigurationCode; message: string; detail?: string };
    throw new HarnessConfigurationError(b.code, `${b.message}${b.detail ? ` — ${b.detail}` : ""}`);
  }
  const config = loaded.body as unknown as FeatConfig;
  // The project root is where the config lives — all module/scope resolution anchors there,
  // so generated tests behave identically regardless of the invoking cwd.
  const projectRoot = path.dirname(path.resolve(process.cwd(), opts.configPath));

  // SPEC-RT-006: one namespace per spec file, derived from its path alone and handed to every adapter.
  assertNamespaceNotConfigured(config as never, opts.configPath);
  const namespace = opts.specPath !== undefined ? deriveNamespace(opts.specPath, projectRoot) : undefined;
  const priorNamespaceEnv = process.env.FEAT_NAMESPACE;
  if (namespace !== undefined) process.env.FEAT_NAMESPACE = namespace;
  const restoreEnv = () => {
    if (namespace === undefined) return;
    if (priorNamespaceEnv === undefined) delete process.env.FEAT_NAMESPACE;
    else process.env.FEAT_NAMESPACE = priorNamespaceEnv;
  };
  // A host (or in-process adapter) that reports a namespace must report the one it was given: a host that
  // ignores it writes outside the namespace, and an absence proof would pass while the system misbehaves.
  const honoured = async (who: string, adapter: { reportedNamespace?: () => string | undefined | Promise<string | undefined> }) => {
    if (namespace === undefined || typeof adapter.reportedNamespace !== "function") return;
    const reported = await adapter.reportedNamespace();
    if (reported !== namespace)
      throw new HarnessConfigurationError(
        "NAMESPACE_NOT_HONOURED",
        `${who} reports ${reported === undefined ? "no namespace" : `namespace ${reported}`}, but the namespace delivered for ${opts.specPath} is ${namespace}.`,
      );
  };

  let response: FeatResponseAdapter | undefined;
  const services = new Map<string, FeatServiceAdapter>();
  try {
    if (config.response) {
      const mod = await importAdapter(config.response.adapter, projectRoot);
      response = mod.createAdapter({ ...config.response, projectRoot, ...(namespace !== undefined ? { namespace } : {}) }) as FeatResponseAdapter;
      await response.setup(config.response.invoke ?? {});
      // The response adapter is checked after the case's invoke(), not here (namespace timing A): an
      // in-process handler reports the namespace only once its handler has read it.
    }

    for (const [key, svc] of Object.entries(config.services)) {
      const mod = await importAdapter(svc.adapter, projectRoot);
      const adapter = mod.createAdapter({ key, ...svc, projectRoot, ...(namespace !== undefined ? { namespace } : {}) }) as FeatServiceAdapter;
      await adapter.setup();
      await honoured(`the adapter for '${key}'`, adapter);
      services.set(key, adapter);
    }
  } catch (e) {
    restoreEnv();
    throw e;
  }

  // ADR-0024: the default ordering belongs to the ACTIVE tier (its consistency), not to generation:
  // an event feed (eventual) is a multiset, anything else is a sequence.
  const defaultOrdering = (key: string): "ordered" | "unordered" =>
    config.services[key]?.consistency === "eventual" ? "unordered" : "ordered";

  // ADR-0023: what the case needs from its adapters, checked before anything runs.
  function preflight(c: HarnessCase): void {
    if (c.given?.clock !== undefined) {
      const reached = response ? typeof response.setClock === "function" : [...services.values()].some((a) => typeof a.setClock === "function");
      if (!reached)
        throw new HarnessConfigurationError(
          "CLOCK_UNSUPPORTED",
          `${c.anchor}: 'clock at' needs a response adapter with setClock() — the configured response adapter cannot honour it.`,
        );
    }
    for (const f of c.given?.faults ?? []) {
      const problem = faultProblem(services.get(f.service), f);
      if (problem !== undefined)
        throw new HarnessConfigurationError("FAULT_UNSUPPORTED", `${c.anchor}: fault ${f.service} ${f.operation} ${f.fault}: ${problem}.`, f.service);
      // SPEC-RT-005: an exclusive fault pauses something every other file shares; only the serial pass may arm it.
      if (EXCLUSIVE_FAULTS.includes(f.fault) && process.env.FEAT_SERIAL !== "1")
        throw new HarnessConfigurationError(
          "FAULT_REQUIRES_SERIAL",
          `${c.anchor}: fault ${f.service} ${f.operation} ${f.fault} is exclusive and may only run in the serial pass (FEAT_SERIAL=1), not alongside other spec files.`,
          f.service,
        );
    }
    for (const [key, assertion] of Object.entries(c.prediction.services)) {
      if (assertion.contains === undefined) continue;
      const observes = services.get(key)?.observes ?? { diff: "native", state: true };
      if (!observes.state)
        throw new HarnessConfigurationError(
          "MODE_UNSUPPORTED",
          `${c.anchor} › ${key}: 'contains' asserts resulting state, which the adapter for '${key}' does not serve (observes.state is false).`,
          key,
          "state",
        );
    }
  }

  async function runCase(rawCase: HarnessCase, inline: InlineData): Promise<void> {
    preflight(rawCase);
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
    // ADR-0023: the scenario clock, on EVERY case (null when there is none), after the resets.
    const clock = c.given?.clock ?? null;
    if (response?.setClock) await response.setClock(clock);
    for (const adapter of services.values()) if (adapter.setClock) await adapter.setClock(clock);

    // ── Preconditions: before the capture window (INV-9) ──
    for (const seed of c.given?.seeds ?? []) {
      const adapter = services.get(seed.service);
      if (!adapter) throw new Error(`${c.anchor}: seed targets unknown service '${seed.service}'`);
      if (!adapter.seed) throw new HarnessConfigurationError("SEED_UNSUPPORTED", `${c.anchor}: adapter for '${seed.service}' does not support seed().`, seed.service);
      if ("fixture" in seed) throw new Error(`${c.anchor}: fixture seeds require generate-time inlining (not yet wired)`);
      await adapter.seed(seed.records);
    }
    // Each execute may reference the one before it, so the reference target advances
    // as the preconditions run.
    let givenResponse: CapturedResponse | undefined;
    for (const pre of c.given?.executes ?? []) {
      if (!response) throw new Error(`${c.anchor}: execute precondition requires a response adapter`);
      const payload = resolveGivenRefs(pre.payload, givenResponse, c.anchor);
      givenResponse = await response.invoke(pre.command, payload, pre.actor);
    }

    // ADR-0023: faults are armed after the seeds and the given executes (setup never consumes them)
    // and before the capture window (arming is never a captured effect), in written order.
    for (const f of c.given?.faults ?? []) {
      const { service, ...arm } = f;
      await services.get(service)!.fault!(arm);
    }

    // ── Capture window ──
    // The spec's type travels with the window (ADR-0011): an adapter that reports resulting
    // STATE for a command must not report that same seeded state as a WRITE to a query, whose
    // `records: []` is synthesised as a side-effect-freedom guarantee. Optional, so an adapter
    // that does not care simply ignores it.
    for (const adapter of services.values()) await adapter.startCapture(c.specType === undefined ? {} : { specType: c.specType });

    // `@when.<path>` / `@deliver.<path>` equal the values SENT — after `@given.response.*` resolved —
    // so what is invoked and what the matchers read are one value, never the payload as written.
    let captured: CapturedResponse | undefined;
    let sentWhen: Record<string, unknown> | undefined;
    if (c.when) {
      if (!response) throw new Error(`${c.anchor}: when: requires a response adapter`);
      sentWhen = resolveGivenRefs(c.when.payload, givenResponse, c.anchor) as Record<string, unknown>;
      captured = await response.invoke(c.when.command, sentWhen, c.when.actor);
      // SPEC-RT-006 (timing A): after the invoke returns and before any prediction is compared.
      await honoured("the response adapter", response);
    }
    // deliver-triggered stimulus (ADR-0011): events delivered in order, inside the
    // window; the delivered stimuli themselves are excluded from capture by the adapter.
    const sentDelivers: Array<Record<string, unknown>> = [];
    for (const d of c.delivers ?? []) {
      const adapter = services.get(d.service);
      if (!adapter) throw new Error(`${c.anchor}: deliver targets unknown service '${d.service}'`);
      if (!adapter.deliver)
        throw new HarnessConfigurationError("DELIVER_UNSUPPORTED", `${c.anchor}: adapter for '${d.service}' does not support deliver().`, d.service);
      // A delivered stimulus may also name what a precondition produced.
      const sent = resolveGivenRefs(d.payload, givenResponse, c.anchor) as Record<string, unknown>;
      sentDelivers.push(sent);
      await adapter.deliver(d.event, sent);
    }

    await awaitConvergence(c.prediction.services, config.services, services);

    const capturedRecords = new Map<string, CapturedRecord[]>();
    for (const [key, adapter] of services) capturedRecords.set(key, await adapter.stopCapture());

    // ADR-0023: an armed fault the system never consumed means the scenario did not exercise what it
    // claims. An adapter that cannot observe consumption (no firedFaults) is not checked.
    for (const key of new Set((c.given?.faults ?? []).map((f) => f.service))) {
      const adapter = services.get(key)!;
      if (!adapter.firedFaults) continue;
      const fired = await adapter.firedFaults();
      const wanted = new Map<string, { operation: string; fault: string; need: number }>();
      for (const f of (c.given?.faults ?? []).filter((x) => x.service === key)) {
        const id = `${f.operation}/${f.fault}`;
        const w = wanted.get(id) ?? { operation: f.operation, fault: f.fault, need: 0 };
        w.need += f.times === "reset" ? 1 : f.times;
        wanted.set(id, w);
      }
      for (const [id, w] of wanted) {
        const got = fired.filter((x) => x.operation === w.operation && x.fault === w.fault).reduce((n, x) => n + x.count, 0);
        if (got < w.need)
          violations.push(`FAULT_NOT_CONSUMED: ${c.anchor} › ${key}: fault ${id} armed for ${w.need} call(s), consumed ${got}`);
      }
    }

    // ── Diff ──
    const ctx: MatchContext = {
      when: c.when ? sentWhen : undefined,
      delivers: c.delivers ? sentDelivers : undefined,
      // Every surface's capture, before any of them is diffed — so `@<service>[i].<path>`
      // resolves the same whatever order the diffs run in.
      captures: capturedRecords,
      inline,
    };
    if (c.prediction.response)
      diffResponse(captured, c.prediction.response as never, ctx, c.anchor, violations);
    for (const [key, assertion] of Object.entries(c.prediction.services)) {
      if (assertion.records !== undefined)
        diffRecords(capturedRecords.get(key) ?? [], assertion.records as never, assertion.ordering ?? defaultOrdering(key), ctx, `${c.anchor} › ${key}`, violations);
      if (assertion.contains !== undefined) {
        const adapter = services.get(key);
        if (!adapter) {
          violations.push(`${c.anchor} › ${key}: unknown service for contains assertion`);
        } else {
          // contains (ADR-0011): resulting state via adapter read(); the shared
          // convergence wait has already elapsed for eventual services.
          const state = await adapter.read(readHint(assertion.contains, sentWhen));
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
      try {
        for (const adapter of services.values()) await adapter.teardown();
        if (response) await response.teardown();
      } finally {
        restoreEnv();
      }
    },
  };
}

/**
 * The convergence window, as one decision (ADR-0014 → ADR-0020 → ADR-0021).
 *
 *   fence    — every eventual service in the prediction offers settle() and every one vouched
 *              before the ceiling: the window ends on proof. Absence proofs included.
 *   peek     — ADR-0020: every eventual service predicts records and can peek; exit once each
 *              target count has arrived and the capture went quiet for one more poll.
 *   ceiling  — anything else waits the full convergenceTimeout (absence without a fence, a
 *              settle that could not vouch or never answered, contains assertions, no peek).
 *   none     — no eventual service in the prediction: strong services capture at once.
 *
 * The ceiling is never exceeded: a fence that does not answer in time falls through to the
 * ADR-0020 decision with whatever time is left, so the slowest path is exactly today's.
 */
export async function awaitConvergence(
  predicted: Record<string, unknown>,
  configured: Record<string, { consistency?: string; convergenceTimeout?: number } | undefined>,
  adapters: Map<string, FeatServiceAdapter>
): Promise<{ mode: "none" | "fence" | "peek" | "ceiling" }> {
  const eventualKeys = Object.keys(predicted).filter((k) => configured[k]?.consistency === "eventual");
  let wait = 0;
  for (const key of eventualKeys) wait = Math.max(wait, configured[key]?.convergenceTimeout ?? 0);
  if (wait <= 0) return { mode: "none" };
  const deadline = Date.now() + wait;
  const remaining = () => Math.max(0, deadline - Date.now());
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── ADR-0021: the fence ──
  const settles = eventualKeys.map((k) => adapters.get(k)?.settle?.bind(adapters.get(k)));
  if (settles.length > 0 && settles.every((f) => typeof f === "function")) {
    const TIMED_OUT = Symbol("timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const proofs = await Promise.race([
      Promise.all(settles.map((f) => f!().catch(() => false))),
      new Promise<typeof TIMED_OUT>((r) => {
        timer = setTimeout(() => r(TIMED_OUT), remaining());
      })
    ]);
    if (timer) clearTimeout(timer);
    if (proofs !== TIMED_OUT && proofs.every((p) => p === true)) {
      // FEAT_FENCE_AUDIT: check the fence against the clock it replaced. Wait out the ceiling
      // anyway; any capture that grew after the fence is a late write the fence would have hidden.
      if (process.env.FEAT_FENCE_AUDIT) {
        const peekers = eventualKeys
          .map((k) => [k, adapters.get(k)?.peekCapture?.bind(adapters.get(k))] as const)
          .filter((e): e is readonly [string, () => Promise<CapturedRecord[]>] => typeof e[1] === "function");
        const before = await Promise.all(peekers.map(async ([, peek]) => (await peek()).length));
        await sleep(remaining());
        const after = await Promise.all(peekers.map(async ([, peek]) => (await peek()).length));
        const grew = peekers
          .map(([k], i) => ({ k, b: before[i]!, a: after[i]! }))
          .filter((x) => x.a !== x.b)
          .map((x) => `${x.k} ${x.b} → ${x.a}`);
        if (grew.length > 0) {
          throw new Error(
            `fence audit: the fence vouched, then the capture grew before the ceiling (${grew.join(", ")}) — ` +
              `a write landed after settle(); that adapter must not vouch for this system`
          );
        }
      }
      return { mode: "fence" };
    }
  }

  // ── ADR-0020: the early exit for write predictions ──
  const goals: Array<{ peek: () => Promise<CapturedRecord[]>; min: number }> = [];
  let earlyExitLegal = true;
  for (const key of eventualKeys) {
    const assertion = predicted[key] as { records?: unknown[]; contains?: unknown[] };
    const adapter = adapters.get(key);
    const peek = adapter?.peekCapture?.bind(adapter);
    if (assertion?.contains === undefined && Array.isArray(assertion?.records) && assertion.records.length > 0 && peek) {
      goals.push({ peek, min: assertion.records.length });
    } else {
      earlyExitLegal = false;
    }
  }
  if (earlyExitLegal && goals.length > 0) {
    const POLL_MS = 150;
    let lastTotal = -1;
    while (remaining() > 0) {
      let total = 0;
      let reached = true;
      for (const g of goals) {
        const count = (await g.peek()).length;
        total += count;
        if (count < g.min) reached = false;
      }
      // Exit only when every target is met AND nothing new arrived since the previous poll —
      // the quiet grace that keeps inversion honest.
      if (reached && total === lastTotal) return { mode: "peek" };
      lastTotal = total;
      await sleep(Math.min(POLL_MS, Math.max(1, remaining())));
    }
    return { mode: "ceiling" };
  }
  await sleep(remaining());
  return { mode: "ceiling" };
}
