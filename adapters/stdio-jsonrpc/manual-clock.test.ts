// ADR-0041 — the manual clock RunFiles injects: time moves only by advance(ms), due timers fire in due order.
import { describe, expect, it } from "vitest";
import { ManualClock } from "./src/manual-clock.js";

describe("ManualClock", () => {
  it("fires nothing until advanced, then every due timer in due order, ties in the order they were set", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    clock.setTimeout(() => fired.push("b"), 200);
    clock.setTimeout(() => fired.push("a"), 100);
    clock.setTimeout(() => fired.push("c"), 200);
    clock.setTimeout(() => fired.push("late"), 201);
    expect(fired).toEqual([]);
    clock.advance(200);
    expect(fired).toEqual(["a", "b", "c"]);
    clock.advance(1);
    expect(fired).toEqual(["a", "b", "c", "late"]);
  });

  it("never fires a cleared timer, and fires a timer set while firing once it is due", () => {
    const clock = new ManualClock();
    const fired: string[] = [];
    const h = clock.setTimeout(() => fired.push("cleared"), 10);
    clock.clearTimeout(h);
    clock.setTimeout(() => {
      fired.push("first");
      clock.setTimeout(() => fired.push("chained"), 50);
      clock.setTimeout(() => fired.push("beyond"), 500);
    }, 100);
    clock.advance(150);
    expect(fired).toEqual(["first", "chained"]);
    clock.advance(449);
    expect(fired).toEqual(["first", "chained"]);
    clock.advance(1);
    expect(fired).toEqual(["first", "chained", "beyond"]);
  });
});
