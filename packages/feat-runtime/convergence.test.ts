// ADR-0021 — the fence: an absence proof is a FACT, not a timeout.
//
// ADR-0020 let a scenario leave the convergence window early only when every eventual service
// PREDICTED records; an absence proof (`records []`) kept the full ceiling, because nothing in the
// harness could tell "nothing arrived" from "nothing arrived YET". Measured on howie (2026-10-06):
// 1,103 of 1,122 cases sat the whole 2000ms window with ~60ms of real work — 95% of `feat run`.
//
// An adapter that can PROVE its capture has caught up with everything written so far implements
// settle(). When every eventual service in the prediction can, the harness awaits those proofs
// instead of the clock. Anything less — an adapter without settle, a settle that cannot vouch
// (false), a settle that never answers — keeps ADR-0020's behaviour exactly: the ceiling holds.
import { describe, expect, it } from "vitest";
import type { CapturedRecord, FeatServiceAdapter } from "@mmmnt/feat-types";
import { awaitConvergence } from "./src/harness.js";

const CEILING = 400;
const eventual = { consistency: "eventual" as const, convergenceTimeout: CEILING };
const strong = { consistency: "strong" as const };

type Fake = Partial<FeatServiceAdapter>;
const adapters = (entries: Record<string, Fake>) =>
  new Map(Object.entries(entries) as Array<[string, FeatServiceAdapter]>);

const settling = (ms: number, vouches = true): Fake => ({
  settle: () => new Promise((r) => setTimeout(() => r(vouches), ms))
});
const timed = async (f: () => Promise<{ mode: string }>) => {
  const t = Date.now();
  const out = await f();
  return { ...out, ms: Date.now() - t };
};

describe("ADR-0021: awaitConvergence — the fence", () => {
  it("an absence proof ends when every eventual service has settled, not at the ceiling", async () => {
    const r = await timed(() =>
      awaitConvergence(
        { projections: { records: [] }, outbound: { records: [] } },
        { projections: eventual, outbound: eventual },
        adapters({ projections: settling(20), outbound: settling(5) })
      )
    );
    expect(r.mode).toBe("fence");
    expect(r.ms).toBeLessThan(CEILING / 2);
  });

  it("waits for the slowest settle — a fence is only as good as its last proof", async () => {
    const r = await timed(() =>
      awaitConvergence(
        { projections: { records: [] }, outbound: { records: [] } },
        { projections: eventual, outbound: eventual },
        adapters({ projections: settling(150), outbound: settling(5) })
      )
    );
    expect(r.mode).toBe("fence");
    expect(r.ms).toBeGreaterThanOrEqual(140);
  });

  it("one eventual service without settle keeps the full ceiling for an absence proof", async () => {
    const r = await timed(() =>
      awaitConvergence(
        { projections: { records: [] }, outbound: { records: [] } },
        { projections: eventual, outbound: eventual },
        adapters({ projections: settling(5), outbound: {} })
      )
    );
    expect(r.mode).toBe("ceiling");
    expect(r.ms).toBeGreaterThanOrEqual(CEILING - 10);
  });

  it("a settle that cannot vouch (false) keeps the ceiling", async () => {
    const r = await timed(() =>
      awaitConvergence(
        { projections: { records: [] } },
        { projections: eventual },
        adapters({ projections: settling(5, false) })
      )
    );
    expect(r.mode).toBe("ceiling");
    expect(r.ms).toBeGreaterThanOrEqual(CEILING - 10);
  });

  it("a settle that never answers is bounded by the ceiling, never longer", async () => {
    const r = await timed(() =>
      awaitConvergence(
        { projections: { records: [] } },
        { projections: eventual },
        adapters({ projections: { settle: () => new Promise<boolean>(() => {}) } })
      )
    );
    expect(r.mode).toBe("ceiling");
    expect(r.ms).toBeGreaterThanOrEqual(CEILING - 10);
    expect(r.ms).toBeLessThan(CEILING + 150);
  });

  it("strong services need no fence: a prediction with no eventual service does not wait", async () => {
    const r = await timed(() =>
      awaitConvergence({ eventstore: { records: [] } }, { eventstore: strong }, adapters({ eventstore: {} }))
    );
    expect(r.mode).toBe("none");
    expect(r.ms).toBeLessThan(50);
  });

  it("without settle, ADR-0020's early exit is unchanged: predicted records + one quiet poll", async () => {
    const seen: CapturedRecord[] = [{ type: "Row", payload: {} }];
    const r = await timed(() =>
      awaitConvergence(
        { projections: { records: [{}] } },
        { projections: eventual },
        adapters({ projections: { peekCapture: async () => seen } })
      )
    );
    expect(r.mode).toBe("peek");
    expect(r.ms).toBeLessThan(CEILING);
  });
});
