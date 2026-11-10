// The system under test, as a process inside the Toxiproxy container's network namespace
// (adapters/kafka/fixtures/probe.mjs starts it; part of the build, not shipped). A client of a proxied
// path must run in that namespace on Docker Desktop (adapters/fault-proxy/fixtures/probe.mjs says why).
// Line protocol on the control port: a JSON request per line, a JSON answer per line.
//   { bootstrap, topic, partition?, key, value, messageTimeoutMs }  ->  { ok: true } | { err, code }
const net = require("net");
const kafka = require("/deps/node_modules/@confluentinc/kafka-javascript");
const { makeClient } = require("/system-client.cjs");

const client = makeClient(kafka);

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
        client.produce(JSON.parse(line)).then((r) => c.write(JSON.stringify(r) + "\n"));
      }
    });
  })
  .listen(19002, "0.0.0.0");
