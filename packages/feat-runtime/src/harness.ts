// The generated-test harness (ADR-0001/0014): config-driven adapter loading via
// createAdapter, per-file adapter instances, single shared capture window per test,
// precondition execution before the window opens (INV-9), prediction diff via the matcher.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type {
  CapturedRecord, CapturedResponse, FeatConfig, FeatResponseAdapter, FeatServiceAdapter,
} from "@mmmnt/feat-types";
import { loadConfig } from "./load-config.js";
import { diffContains, diffRecords, diffResponse, type InlineData, type MatchContext } from "./matcher.js";

export interface HarnessCase {
  anchor: string;
  name: string;
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

async function importAdapter(specifier: string, projectRoot: string): Promise<{ createAdapter: (cfg: Record<string, unknown>) => unknown }> {
  let resolved: string;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    resolved = path.resolve(projectRoot, specifier);
  } else {
    // Resolve npm specifiers from the USER project root, per ADR-0001.
    const req = createRequire(path.join(projectRoot, "package.json"));
    resolved = req.resolve(specifier);
  }
  const mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  const createAdapter = mod.createAdapter ?? (mod.default as Record<string, unknown> | undefined)?.createAdapter;
  if (typeof createAdapter !== "function")
    throw new Error(`Adapter module '${specifier}' lacks a createAdapter export (INV-10) — configuration error.`);
  return { createAdapter: createAdapter as (cfg: Record<string, unknown>) => unknown };
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

  async function runCase(c: HarnessCase, inline: InlineData): Promise<void> {
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

    // ADR-0014: single shared wait for the scenario's eventual services.
    let wait = 0;
    for (const key of Object.keys(c.prediction.services)) {
      const svc = config.services[key];
      if (svc?.consistency === "eventual")
        wait = Math.max(wait, svc.convergenceTimeout ?? 0);
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

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
