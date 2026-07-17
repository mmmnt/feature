export function onPing(payload, ctx) { ctx.publish("Pong", { echo: payload.n }); }
