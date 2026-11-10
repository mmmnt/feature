// The system under test, as a process inside the Toxiproxy container's network namespace
// (adapters/neo4j/fixtures/probe.mjs starts it; part of the build, not shipped). A client of a proxied
// path must run in that namespace on Docker Desktop (adapters/fault-proxy/fixtures/probe.mjs says why).
// Line protocol on the control port: a JSON request per line, a JSON answer per line.
//   { uri, user, pass, label, keyprop, key, ns }  ->  { ok: true } | { err: "<driver error code>", message }
const net = require("net");
const neo4j = require("/deps/node_modules/neo4j-driver");

const quote = (name) => "`" + name.replace(/`/g, "``") + "`";

async function create(req) {
  const driver = neo4j.driver(req.uri, neo4j.auth.basic(req.user, req.pass), { connectionTimeout: 2000, connectionAcquisitionTimeout: 4000 });
  const session = driver.session();
  try {
    await session.run(`CREATE (n:${quote(req.label)}:${quote("ns_" + req.ns)} {${quote(req.keyprop)}: $key})`, { key: req.key });
    return { ok: true };
  } catch (e) {
    return { err: (e && e.code) || (e && e.name) || "unknown", message: String((e && e.message) || "") };
  } finally {
    await session.close().catch(() => {});
    await driver.close().catch(() => {});
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
        create(JSON.parse(line)).then((r) => c.write(JSON.stringify(r) + "\n"));
      }
    });
  })
  .listen(19002, "0.0.0.0");
