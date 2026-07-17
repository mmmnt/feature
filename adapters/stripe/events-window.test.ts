// Capture-window semantics against a local stub of the Stripe Events API:
// newest-first pages, id cursors, has_more pagination.
import { createServer, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createAdapter } from "./src/index.js";

interface StubEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

let events: StubEvent[] = []; // oldest-first internally
let server: Server;
let baseUrl: string;

function push(type: string, object: Record<string, unknown>) {
  events.push({ id: `evt_${events.length + 1}`, type, created: 1700000000 + events.length, data: { object } });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (!req.headers.authorization?.startsWith("Bearer sk_test_")) {
      res.writeHead(401).end(JSON.stringify({ error: "no key" }));
      return;
    }
    // Stripe semantics: newest-first; ending_before returns items NEWER than the id.
    let list = [...events].reverse();
    const endingBefore = url.searchParams.get("ending_before");
    if (endingBefore) {
      const idx = list.findIndex((e) => e.id === endingBefore);
      if (idx !== -1) list = list.slice(0, idx);
    }
    const startingAfter = url.searchParams.get("starting_after");
    if (startingAfter) {
      const idx = list.findIndex((e) => e.id === startingAfter);
      if (idx !== -1) list = list.slice(idx + 1);
    }
    const typeFilters = [...url.searchParams.entries()].filter(([k]) => k.startsWith("types[")).map(([, v]) => v);
    if (typeFilters.length) list = list.filter((e) => typeFilters.includes(e.type));
    const limit = Number(url.searchParams.get("limit") ?? "100");
    const pageData = list.slice(0, limit);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ data: pageData, has_more: list.length > pageData.length }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://localhost:${(server.address() as { port: number }).port}`;
  process.env.STRIPE_TEST_KEY = "sk_test_fixture";
});

afterAll(() => server.close());
afterEach(() => {
  events = [];
});

function adapter(options: Record<string, unknown> = {}) {
  return createAdapter({ options: { apiKeyEnv: "STRIPE_TEST_KEY", baseUrl, ...options } });
}

describe("stripe events capture window", () => {
  it("captures only events after the window opened, oldest-first", async () => {
    push("charge.succeeded", { id: "ch_before" });
    const a = adapter();
    await a.startCapture();
    push("charge.succeeded", { id: "ch_1", amount: 4900 });
    push("customer.created", { id: "cus_1" });
    const records = await a.stopCapture();
    expect(records.map((r) => r.type)).toEqual(["charge.succeeded", "customer.created"]);
    expect(records[0]!.payload).toEqual({ id: "ch_1", amount: 4900 });
  });

  it("empty window captures nothing", async () => {
    push("charge.succeeded", { id: "ch_old" });
    const a = adapter();
    await a.startCapture();
    expect(await a.stopCapture()).toEqual([]);
  });

  it("works on a virgin account (no prior events)", async () => {
    const a = adapter();
    await a.startCapture();
    push("payout.paid", { id: "po_1" });
    const records = await a.stopCapture();
    expect(records).toHaveLength(1);
  });

  it("paginates past 100 events", async () => {
    const a = adapter();
    await a.startCapture();
    for (let i = 0; i < 130; i++) push("charge.succeeded", { id: `ch_${i}` });
    expect(await a.stopCapture()).toHaveLength(130);
  });

  it("type filter restricts the observable universe", async () => {
    const a = adapter({ types: ["charge.succeeded"] });
    await a.startCapture();
    push("charge.succeeded", { id: "ch_1" });
    push("customer.created", { id: "cus_1" });
    const records = await a.stopCapture();
    expect(records.map((r) => r.type)).toEqual(["charge.succeeded"]);
  });

  it("read() returns the full log for contains assertions", async () => {
    push("charge.succeeded", { id: "ch_old" });
    push("refund.created", { id: "re_1" });
    const a = adapter();
    const state = (await a.read({})) as { type: string }[];
    expect(state.map((r) => r.type)).toEqual(["charge.succeeded", "refund.created"]);
  });

  it("refuses to construct without the key env var", () => {
    expect(() => createAdapter({ options: { apiKeyEnv: "NOPE_MISSING" } })).toThrowError(/NOPE_MISSING is not set/);
  });
});
