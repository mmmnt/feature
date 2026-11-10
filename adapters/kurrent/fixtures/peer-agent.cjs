// The system under test, as a process inside the Toxiproxy container's network namespace
// (adapters/kurrent/fixtures/probe.mjs starts it; part of the build, not shipped). A client of a proxied
// path must run in that namespace on Docker Desktop (adapters/fault-proxy/fixtures/probe.mjs says why).
// Line protocol on the control port: a JSON request per line, a JSON answer per line.
//   { cs, stream, type, state: "any" | "nostream" }  ->  { ok: true } | { err: "<client error type>", code: <gRPC status code>, message }
const net = require("net");
const { KurrentDBClient, jsonEvent, ANY, NO_STREAM } = require("/deps/node_modules/@kurrent/kurrentdb-client");

async function append(req) {
  const client = KurrentDBClient.connectionString(req.cs);
  try {
    await client.appendToStream(req.stream, jsonEvent({ type: req.type, data: {} }), {
      streamState: req.state === "nostream" ? NO_STREAM : ANY,
    });
    return { ok: true };
  } catch (e) {
    return { err: (e && e.type) || "unknown", code: e && e.code, message: String((e && e.message) || "") };
  } finally {
    await client.dispose().catch(() => {});
  }
}

net
  .createServer((c) => {
    let buf = "";
    c.on("error", () => {});
    c.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        append(JSON.parse(line)).then((r) => c.write(JSON.stringify(r) + "\n"));
      }
    });
  })
  .listen(19002, "0.0.0.0");
