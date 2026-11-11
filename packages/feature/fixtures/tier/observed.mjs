// A service adapter that declares what ADR-0024 says the evidence bundle records per binding: it observes by
// snapshot and cannot answer state, and it reports how often an armed fault was consumed.
export function createAdapter() {
  return {
    observes: { diff: "snapshot", state: false },
    firedFaults: async () => [],
    setup: async () => {},
    teardown: async () => {},
    reset: async () => {},
    startCapture: async () => {},
    stopCapture: async () => [],
    read: async () => null,
  };
}
