// Handlers behind the ProbeHandlerClock probe (SPEC-ADPHND-001). Test fixtures, not shipped.

/** Three-argument handler: answers what its context says about the clock. */
export async function now(_input, _actor, ctx) {
  return { status: "OK", body: { now: ctx.clock.now(), iso: ctx.clock.iso(), frozen: ctx.clock.frozen } };
}

/** Two-argument handler: knows nothing of the clock; answers its actor's role. */
export async function legacy(_input, actor) {
  return { status: "OK", body: { role: actor?.role } };
}
