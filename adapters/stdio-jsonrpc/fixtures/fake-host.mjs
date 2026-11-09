#!/usr/bin/env node
// The fake spec host the SPEC-RPC-001/002 scenarios drive. `--mode <m>` picks what it does with the
// request line it reads on stdin (one line, one answer). Not shipped; part of the build.
import { createInterface } from "node:readline";

const mode = process.argv[process.argv.indexOf("--mode") + 1] ?? "canned";
const rl = createInterface({ input: process.stdin });

const record = { type: "log.entry", payload: { n: 1 }, timestamp: 1000 };
const canned = {
  setup: (p) => ({ protocol: 2, namespace: p.namespace }),
  teardown: () => ({}), reset: () => ({}), setClock: () => ({}), seed: () => ({}),
  startCapture: () => ({}), deliver: () => ({}), fault: () => ({}),
  invoke: (p) => ({ status: 200, body: { command: p.command } }),
  peekCapture: () => [record], stopCapture: () => [record],
  settle: () => ({ settled: true }), read: () => [{ n: 1 }],
};

const send = (obj) => process.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);

rl.once("line", (line) => {
  const req = JSON.parse(line);
  const ok = (result, id = req.id) => send({ jsonrpc: "2.0", id, result });
  switch (mode) {
    case "canned":
    case "echo":
      return ok(canned[req.method](req.params));
    case "rpc-error":
      return send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "boom" } });
    case "garbage":
      return send("this is not json");
    case "wrong-id":
      return ok({}, req.id + 1000);
    case "exit":
      return process.exit(1);
    case "silent":
      return void setInterval(() => {}, 60_000);
    case "bad-invoke":
      return ok({ body: {} });
    case "bad-record":
      return ok([{ ...record, extra: 1 }]);
    case "bad-settle":
      return ok(true);
    case "both":
      return send({ jsonrpc: "2.0", id: req.id, result: {}, error: { code: -32000, message: "x" } });
    case "parse-error":
      return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    case "null-id-other":
      return send({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "x" } });
    case "other-ns":
      return ok({ protocol: 2, namespace: "s3b04e21257fd" });
    case "other-protocol":
      return ok({ protocol: 1, namespace: req.params.namespace });
    case "bad-setup-none":
      return ok({ protocol: 2 });
    case "bad-setup-no-protocol":
      return ok({ namespace: req.params.namespace });
    case "bad-setup-pattern":
      return ok({ protocol: 2, namespace: "sABCDEF012345" });
    default:
      process.exit(2);
  }
});
