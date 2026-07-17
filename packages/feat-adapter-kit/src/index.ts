// @mmmnt/feat-adapter-kit — executable conformance suites for adapter authors.
// Drop `serviceAdapterContract(...)` / `responseAdapterContract(...)` into your
// vitest suite and the harness-facing contract is asserted for you: capture
// window discipline, record shape, reset semantics, optional-method behavior.
// The kit registers describe/it blocks; vitest is a peer dependency.

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import type { CapturedRecord, FeatResponseAdapter, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";

export interface ServiceContractOptions {
  /** Build a fresh adapter instance. Called once; setup() is driven by the suite. */
  factory: () => FeatServiceAdapter | Promise<FeatServiceAdapter>;
  /**
   * Cause at least one observable effect while the capture window is open.
   * Without it, effect-shape assertions are skipped (window discipline is
   * still asserted).
   */
  act?: (adapter: FeatServiceAdapter) => Promise<void>;
  /** Sample records for seed(); provide only if the adapter supports seeding. */
  seedRecords?: SeedRecord[];
  /**
   * Sample event for deliver(); provide only for event-capable adapters.
   * The suite asserts the delivered stimulus is EXCLUDED from capture.
   */
  deliverSample?: { event: string; payload: Record<string, unknown> };
}

export function serviceAdapterContract(name: string, opts: ServiceContractOptions): void {
  describe(`${name}: Feat service adapter contract`, () => {
    let adapter: FeatServiceAdapter;
    let ready = false;

    beforeEach(async () => {
      if (!ready) {
        adapter = await opts.factory();
        await adapter.setup();
        ready = true;
      }
      await adapter.reset();
    });

    afterAll(async () => {
      if (ready) await adapter.teardown();
    });

    it("an empty capture window captures nothing", async () => {
      await adapter.startCapture();
      expect(await adapter.stopCapture()).toEqual([]);
    });

    it("stopCapture without startCapture does not throw and yields no records", async () => {
      expect(await adapter.stopCapture()).toEqual([]);
    });

    it("reset() is repeatable and clears window state", async () => {
      await adapter.reset();
      await adapter.reset();
      await adapter.startCapture();
      await adapter.reset();
      // A reset mid-window must not leak the stale window into a later capture.
      await adapter.startCapture();
      expect(await adapter.stopCapture()).toEqual([]);
    });

    it("read() returns a record array or null", async () => {
      const state = await adapter.read({});
      expect(state === null || Array.isArray(state)).toBe(true);
    });

    if (opts.act) {
      it("effects inside the window are captured with the record shape", async () => {
        await adapter.startCapture();
        await opts.act!(adapter);
        const records = await adapter.stopCapture();
        expect(records.length).toBeGreaterThan(0);
        for (const r of records as CapturedRecord[]) {
          expect(typeof r.type).toBe("string");
          expect(r.type.length).toBeGreaterThan(0);
          expect(typeof r.payload).toBe("object");
        }
      });

      it("effects before the window opens are not captured", async () => {
        await opts.act!(adapter);
        await adapter.startCapture();
        expect(await adapter.stopCapture()).toEqual([]);
      });
    }

    if (opts.seedRecords) {
      it("seed() accepts records as preconditions", async () => {
        expect(adapter.seed).toBeTypeOf("function");
        await adapter.seed!(opts.seedRecords!);
      });

      it("seeded records are not captured by a later window", async () => {
        await adapter.seed!(opts.seedRecords!);
        await adapter.startCapture();
        expect(await adapter.stopCapture()).toEqual([]);
      });
    } else {
      it("seed(), if present, rejects with a clear configuration error", async () => {
        if (!adapter.seed) return; // absent is a valid way to not support seeding
        await expect(adapter.seed([{ type: "X", values: {} }])).rejects.toThrowError(/configuration error|does not support/);
      });
    }

    if (opts.deliverSample) {
      it("deliver() accepts a stimulus and EXCLUDES it from capture", async () => {
        expect(adapter.deliver).toBeTypeOf("function");
        await adapter.startCapture();
        await adapter.deliver!(opts.deliverSample!.event, opts.deliverSample!.payload);
        const records = await adapter.stopCapture();
        const stimulusCaptured = records.some(
          (r) => r.type === opts.deliverSample!.event && JSON.stringify(r.payload) === JSON.stringify(opts.deliverSample!.payload),
        );
        expect(stimulusCaptured).toBe(false);
      });
    }
  });
}

export interface ResponseContractOptions {
  /** Build a fresh adapter instance. */
  factory: () => FeatResponseAdapter | Promise<FeatResponseAdapter>;
  /** A command the adapter is configured to route, with a payload it accepts. */
  command: string;
  payload: Record<string, unknown>;
  /** Expected response status for the sample command (defaults to just shape-checking). */
  expectStatus?: number | string;
}

export function responseAdapterContract(name: string, opts: ResponseContractOptions): void {
  describe(`${name}: Feat response adapter contract`, () => {
    let adapter: FeatResponseAdapter;
    let ready = false;

    beforeEach(async () => {
      if (!ready) {
        adapter = await opts.factory();
        await adapter.setup({});
        ready = true;
      }
    });

    afterAll(async () => {
      if (ready) await adapter.teardown();
    });

    it("invoke() returns the { status, body } response shape", async () => {
      const r = await adapter.invoke(opts.command, opts.payload);
      expect(r).toBeTypeOf("object");
      expect(r).toHaveProperty("status");
      expect(r).toHaveProperty("body");
      if (opts.expectStatus !== undefined) expect(r.status).toEqual(opts.expectStatus);
    });

    it("an unrouted command rejects with a configuration error", async () => {
      await expect(adapter.invoke("__FEAT_KIT_UNROUTED__", {})).rejects.toThrowError(/not routed|configuration error/);
    });
  });
}
