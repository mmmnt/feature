// A service adapter that offers only the mandatory lifecycle: no seed(), no deliver(). A case that seeds or
// delivers to it asks for what it cannot give (a configuration error, README exit 2).
export function createAdapter() {
  return {
    setup: async () => {},
    teardown: async () => {},
    reset: async () => {},
    startCapture: async () => {},
    stopCapture: async () => [],
    read: async () => [],
  };
}
