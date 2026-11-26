// ADR-0041 — the clock RunFiles injects (not exported from the package). Time moves only by advance(ms), which
// fires every timer due by then in due order (ties in the order they were set), timers set while firing included.

import type { Clock } from "./clock.js";

interface Timer {
  at: number;
  seq: number;
  fn: () => void;
}

export class ManualClock implements Clock {
  private now = 0;
  private seq = 0;
  private readonly timers = new Map<number, Timer>();

  setTimeout(fn: () => void, ms: number): unknown {
    const seq = ++this.seq;
    this.timers.set(seq, { at: this.now + Math.max(0, ms), seq, fn });
    return seq;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers.values()) if (t.at <= end && (!next || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
      if (!next) break;
      this.timers.delete(next.seq);
      this.now = next.at;
      next.fn();
    }
    this.now = end;
  }
}
