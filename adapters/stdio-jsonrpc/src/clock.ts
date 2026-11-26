// ADR-0041 — the clock the host's three timers run on: the request limit, and the kill after the grace period on a
// timeout and on close. systemClock is the real one; only the test driver (RunFiles) injects another.

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
