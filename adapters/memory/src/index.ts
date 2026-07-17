// @mmmnt/feat-adapter-memory — in-memory event service (ADR-0011 runtime).
// Deliver-triggered specs (projection/policy/saga) run against this adapter with
// zero infrastructure: deliver() routes an event to configured consumer modules;
// anything a consumer publishes lands in the event log and is captured if the
// window is open. Delivered stimuli are EXCLUDED from capture (flow-view rule);
// read() returns the full log for `contains` assertions.

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CapturedRecord, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";

interface ConsumerRoute {
  module: string;
  export: string;
}

interface MemoryAdapterConfig {
  options?: {
    /** event type → consumer route(s) invoked on deliver(). */
    consumers?: Record<string, ConsumerRoute | ConsumerRoute[]>;
  };
  projectRoot?: string;
}

export interface PublishContext {
  /** Publish a new event onto this bus (captured when the window is open). */
  publish(event: string, payload: Record<string, unknown>): void;
}

type Consumer = (payload: Record<string, unknown>, ctx: PublishContext) => void | Promise<void>;

interface LogEntry {
  type: string;
  payload: Record<string, unknown>;
  /** Delivered stimuli are logged (visible to read()) but never captured. */
  stimulus: boolean;
  seq: number;
}

class MemoryAdapter implements FeatServiceAdapter {
  private log: LogEntry[] = [];
  private seq = 0;
  private captureFrom: number | null = null;
  private consumers = new Map<string, Consumer[]>();
  private readonly root: string;

  constructor(private config: MemoryAdapterConfig) {
    this.root = config.projectRoot ?? process.cwd();
  }

  private async consumersFor(event: string): Promise<Consumer[]> {
    if (this.consumers.has(event)) return this.consumers.get(event)!;
    const route = this.config.options?.consumers?.[event];
    const routes = route === undefined ? [] : Array.isArray(route) ? route : [route];
    const loaded: Consumer[] = [];
    for (const r of routes) {
      const mod = (await import(pathToFileURL(path.resolve(this.root, r.module)).href)) as Record<string, unknown>;
      const fn = mod[r.export];
      if (typeof fn !== "function")
        throw new Error(`Module '${r.module}' lacks export '${r.export}' (INV-10) — configuration error.`);
      loaded.push(fn as Consumer);
    }
    this.consumers.set(event, loaded);
    return loaded;
  }

  private publishContext(): PublishContext {
    return {
      publish: (event, payload) => {
        this.log.push({ type: event, payload, stimulus: false, seq: this.seq++ });
      },
    };
  }

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}

  async reset(): Promise<void> {
    this.log = [];
    this.seq = 0;
    this.captureFrom = null;
  }

  async startCapture(): Promise<void> {
    this.captureFrom = this.seq;
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    const from = this.captureFrom ?? this.seq;
    this.captureFrom = null;
    return this.log
      .filter((e) => e.seq >= from && !e.stimulus)
      .map((e) => ({ type: e.type, key: String(e.seq), payload: e.payload, timestamp: e.seq }));
  }

  async deliver(event: string, payload: Record<string, unknown>): Promise<void> {
    this.log.push({ type: event, payload, stimulus: true, seq: this.seq++ });
    for (const consumer of await this.consumersFor(event)) {
      await consumer(payload, this.publishContext());
    }
  }

  async read(): Promise<unknown | null> {
    return this.log.map((e) => ({ type: e.type, key: String(e.seq), payload: e.payload, timestamp: e.seq }));
  }

  async seed(records: SeedRecord[]): Promise<void> {
    for (const r of records) {
      this.log.push({ type: r.type, payload: r.values, stimulus: false, seq: this.seq++ });
    }
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new MemoryAdapter(config as MemoryAdapterConfig);
}
