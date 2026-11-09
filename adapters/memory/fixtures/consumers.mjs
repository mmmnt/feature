// The consumer the probe wires up (SPEC-ADPMEM-001): Ping publishes Pong, as in the conformance suite.
export function onPing(payload, ctx) { ctx.publish("Pong", { echo: payload.n }); }
