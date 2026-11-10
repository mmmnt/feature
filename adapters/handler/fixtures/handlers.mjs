// Handlers behind the ProbeHandlerClock probe (SPEC-ADPHND-001). Test fixtures, not shipped.

/** Three-argument handler: answers what its context says about the clock. */
export async function now(_input, _actor, ctx) {
  return { status: "OK", body: { now: ctx.clock.now(), iso: ctx.clock.iso(), frozen: ctx.clock.frozen } };
}

/** Two-argument handler: knows nothing of the clock; answers its actor's role. */
export async function legacy(_input, actor) {
  return { status: "OK", body: { role: actor?.role } };
}

// SPEC-ADPHND-002 ------------------------------------------------------------------------------

/** Three-argument handler that reads the runner's namespace. */
export async function namespace(_input, _actor, ctx) {
  return { status: "OK", body: { ns: ctx.namespace } };
}

/** Three-argument handler that never touches ctx.namespace. */
export async function quiet(_input, _actor, _ctx) {
  return { status: "OK", body: {} };
}

/** The harness-mode `Ping`: behaves as the handler the probe selected (globalThis.__adphnd2Mode). */
export async function ping(input, actor, ctx) {
  const mode = globalThis.__adphnd2Mode === "Plain" ? "Quiet" : globalThis.__adphnd2Mode;
  if (mode === "Namespace") return namespace(input, actor, ctx);
  if (mode === "Quiet") return quiet(input, actor, ctx);
  return legacy(input, actor);
}
