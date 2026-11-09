// A local stub of the Stripe Events API (SPEC-ADPSTR-001): newest-first pages, id cursors,
// has_more, types[] filters. Same semantics as the stub in adapters/stripe/events-window.test.ts.
import { createServer } from "node:http";

export async function startFakeStripe() {
  const events = []; // oldest-first
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (!req.headers.authorization?.startsWith("Bearer sk_test_")) {
      res.writeHead(401).end(JSON.stringify({ error: "no key" }));
      return;
    }
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
  await new Promise((r) => server.listen(0, r));
  return {
    baseUrl: `http://localhost:${server.address().port}`,
    emit(type, object = {}) {
      events.push({ id: `evt_${events.length + 1}`, type, created: 1700000000 + events.length, data: { object } });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}
