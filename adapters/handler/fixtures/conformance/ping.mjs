export async function ping(payload) { return { status: "OK", body: { echo: payload.n } }; }
