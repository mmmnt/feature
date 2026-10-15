// A response adapter and a service adapter in one module, for when-refs.test.ts.
// Offer answers with a start the system "minted"; Book answers with what it was SENT,
// so a prediction can check the sent value against @when.<path>.
export function createAdapter(cfg) {
  if (cfg.key) {
    // The memory service records what is DELIVERED to it, so @deliver.<path> has something to meet.
    let delivered = [];
    return {
      async setup() {},
      async teardown() {},
      async reset() { delivered = []; },
      async startCapture() { delivered = []; },
      async deliver(event, payload) { delivered.push({ type: event, payload: { seen: payload.expect } }); },
      async stopCapture() { return delivered; },
      async read() { return []; }
    };
  }
  return {
    async setup() {},
    async teardown() {},
    async invoke(command, payload) {
      if (command === "Offer") return { status: "OK", body: { start: "2030-08-13T18:00:00Z" } };
      return { status: "OK", body: { booked: payload.expect } };
    }
  };
}
