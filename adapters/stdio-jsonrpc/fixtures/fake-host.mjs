#!/usr/bin/env node
// The fake spec host the SPEC-RPC-001/002 scenarios drive. `--mode <m>` picks what it does; it keeps
// serving lines until stdin closes. Not shipped; part of the build.
//   FAKE_HOST_LOG=<file>: appends `pid`, `env <FEAT_NAMESPACE>`, `setup <ns> <services>` and `clock <v>` lines
//   so a test can see what reached the host.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[process.argv.indexOf("--mode") + 1] ?? "canned";
const logFile = process.env.FAKE_HOST_LOG;
const log = (s) => logFile && appendFileSync(logFile, `${s}\n`);
log(`pid ${process.pid}`);
log(`env ${process.env.FEAT_NAMESPACE ?? ""}`);

const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));

const record = { type: "log.entry", payload: { n: 1 }, timestamp: 1000 };
const state = { ns: undefined, services: new Set(), captured: new Map(), tasks: 0, failed: false };
const captured = (svc) => state.captured.get(svc) ?? [];
const withDefault = (list) => (list.length > 0 ? list : [record]);

const send = (obj) => process.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
const waitForTasks = () => new Promise((resolve) => {
  const t = setInterval(() => { if (state.tasks === 0) { clearInterval(t); resolve(); } }, 10);
});

async function canned(req) {
  const p = req.params;
  switch (req.method) {
    case "setup": {
      if (state.ns !== undefined && p.namespace !== state.ns) return { error: { code: -32602, message: `namespace ${p.namespace} is not this host's ${state.ns}` } };
      state.ns ??= p.namespace;
      for (const s of p.services) state.services.add(s);
      log(`setup ${p.namespace} ${JSON.stringify(p.services)}`);
      if (mode === "other-ns") return { result: { protocol: 2, namespace: "s3b04e21257fd" } };
      if (mode === "other-protocol") return { result: { protocol: 1, namespace: p.namespace } };
      if (mode === "bad-setup-none") return { result: { protocol: 2 } };
      if (mode === "bad-setup-no-protocol") return { result: { namespace: p.namespace } };
      if (mode === "bad-setup-pattern") return { result: { protocol: 2, namespace: "sABCDEF012345" } };
      return { result: { protocol: 2, namespace: p.namespace } };
    }
    case "fault":
      log(`fault ${p.kind} ${p.times ?? ""}`);
      return { result: {} };
    case "setClock":
      log(`clock ${JSON.stringify(p.clock)}`);
      return { result: {} };
    case "startCapture":
      state.captured.set(p.service, []);
      return { result: {} };
    case "invoke": {
      if (mode === "crash-on-invoke") process.exit(1);
      if (mode === "spawn-task" || mode === "spawn-task-failed") {
        state.tasks++;
        setTimeout(() => {
          if (mode === "spawn-task") for (const s of state.services) state.captured.set(s, [...captured(s), record]);
          else state.failed = true;
          state.tasks--;
        }, 200);
      } else {
        for (const s of state.services) state.captured.set(s, [...captured(s), record, record]);
      }
      return { result: { status: 200, body: { command: p.command } } };
    }
    case "settle":
      if (mode === "unvouched") return { result: { settled: false } };
      await waitForTasks();
      return { result: { settled: !state.failed } };
    case "peekCapture":
      return { result: withDefault(captured(p.service)) };
    case "stopCapture": {
      const out = withDefault(captured(p.service));
      state.captured.set(p.service, []);
      return { result: out };
    }
    case "read":
      return { result: [{ n: 1 }] };
    default:
      return { result: {} };
  }
}

rl.on("line", async (line) => {
  const req = JSON.parse(line);
  const reply = (r) => send({ jsonrpc: "2.0", id: req.id, ...r });
  switch (mode) {
    case "rpc-error": return reply({ error: { code: -32000, message: "boom" } });
    case "garbage": return send("this is not json");
    case "wrong-id": return send({ jsonrpc: "2.0", id: req.id + 1000, result: {} });
    case "exit": return process.exit(1);
    case "silent": return void setInterval(() => {}, 60_000);
    case "bad-invoke": return reply({ result: { body: {} } });
    case "bad-record": return reply({ result: [{ ...record, extra: 1 }] });
    case "bad-settle": return reply({ result: true });
    case "both": return send({ jsonrpc: "2.0", id: req.id, result: {}, error: { code: -32000, message: "x" } });
    case "parse-error": return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    case "null-id-other": return send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "x" } });
    default: return reply(await canned(req));
  }
});
