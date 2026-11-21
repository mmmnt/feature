#!/usr/bin/env node
// The fake seed-transform host the store adapters' seed-transform specs drive (SPEC-ADPNEO-005, SPEC-ADPRDS-002,
// SPEC-ADPKUR-006, SPEC-ADPDDB-003; ADR-0035). `--mode <m>` picks how it answers transformSeed; every other method of
// the protocol answers as a host with no services would. Imported (not run), it exports the probes' helpers
// seedTransformOption and transformCalls. Not shipped; part of the build.
//   SEED_HOST_LOG=<file>: appends one `transformSeed` line per request it received, so a probe can count them.
// Modes:
//   encode     every { encode: t } value, at any depth of values, becomes [len(t), first char code of t, 1.0]
//   encodestr  every { encode: t } value becomes the string "enc:<t>"
//   slow       as encode, answering after 200 ms
//   random     as encode, with a third item that differs on every request
//   fail       transformSeed answers a JSON-RPC error { code: -32000, message: "encoder not loaded" }
//   map        every { encode: t } is left as it is
//   mixed      every { encode: t } becomes [1, "a"]
//   scalar     every record's values becomes the string "x"
//   short      one record fewer than it was sent
//   retype     every record's type becomes "Other"
//   rekey      every record's identity changes: each identity field the probe names in SEED_HOST_IDENTITY (comma-separated
//              keys of values) gets "-moved" appended, or 1 added when it is a number
//   crash      exits on the first transformSeed
//   nomethod   transformSeed answers method not found
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── for the probes: the options.seedTransform of one run, and how many requests it served ──────────────────────
const HOST = fileURLToPath(import.meta.url);

/**
 * mode: a seed-host.mjs mode, or "absent" (a command that does not exist), "nocommand" ({ host: {} }), "none" (no option).
 * identity: the values keys the "rekey" mode moves.
 */
export function seedTransformOption(mode, identity) {
  if (mode === undefined || mode === "none") return { option: undefined, log: undefined, cleanup() {} };
  if (mode === "nocommand") return { option: { host: {} }, log: undefined, cleanup() {} };
  const dir = mkdtempSync(path.join(os.tmpdir(), "feat-seed-host-"));
  const log = path.join(dir, "requests.log");
  const command = mode === "absent" ? [path.join(dir, "no-such-host")] : [process.execPath, HOST, "--mode", mode];
  return {
    option: { host: { command, env: { SEED_HOST_LOG: log, SEED_HOST_IDENTITY: identity.join(",") } } },
    log,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** How many transformSeed requests the fake host received in this run. */
export function transformCalls(t) {
  if (t?.log === undefined) return 0;
  try {
    return readFileSync(t.log, "utf8").split("\n").filter((l) => l === "transformSeed").length;
  } catch {
    return 0;
  }
}

// ── the host ──────────────────────────────────────────────────────────────────────────────────────────────────────
const main = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const mode = process.argv[process.argv.indexOf("--mode") + 1] ?? "encode";
const logFile = process.env.SEED_HOST_LOG;
const identity = (process.env.SEED_HOST_IDENTITY ?? "").split(",").filter((s) => s !== "");
let requests = 0;

const isEncode = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.encode === "string";

function replace(v, fn) {
  if (isEncode(v)) return fn(v.encode);
  if (Array.isArray(v)) return v.map((x) => replace(x, fn));
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replace(x, fn)]));
  return v;
}

const vector = (t) => [t.length, t.length > 0 ? t.charCodeAt(0) : 0, 1.0];

function transform(records) {
  const each = (fn) => records.map((r) => ({ type: r.type, values: replace(r.values, fn) }));
  switch (mode) {
    case "encode":
    case "slow":
      return each(vector);
    case "encodestr":
      return each((t) => `enc:${t}`);
    case "random":
      return each((t) => [t.length, t.length > 0 ? t.charCodeAt(0) : 0, requests + Math.random()]);
    case "map":
      return records.map((r) => ({ type: r.type, values: r.values }));
    case "mixed":
      return each(() => [1, "a"]);
    case "scalar":
      return records.map((r) => ({ type: r.type, values: "x" }));
    case "short":
      return each(vector).slice(0, -1);
    case "retype":
      return each(vector).map((r) => ({ ...r, type: "Other" }));
    case "rekey":
      return each(vector).map((r) => {
        const values = { ...r.values };
        for (const k of identity) if (k in values) values[k] = typeof values[k] === "number" ? values[k] + 1 : `${values[k]}-moved`;
        return { ...r, values };
      });
    default:
      return each(vector);
  }
}

const send = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
if (main) serve();
function serve() {
const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));
rl.on("line", async (line) => {
  const req = JSON.parse(line);
  const p = req.params ?? {};
  switch (req.method) {
    case "setup":
      return send({ jsonrpc: "2.0", id: req.id, result: { protocol: 2, namespace: p.namespace } });
    case "transformSeed": {
      requests++;
      if (logFile) appendFileSync(logFile, "transformSeed\n");
      if (mode === "crash") process.exit(1);
      if (mode === "nomethod") return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "Method not found: transformSeed" } });
      if (mode === "fail") return send({ jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "encoder not loaded" } });
      if (mode === "slow") await new Promise((r) => setTimeout(r, 200));
      return send({ jsonrpc: "2.0", id: req.id, result: { records: transform(p.records) } });
    }
    case "teardown":
    case "reset":
    case "setClock":
    case "setSeed":
      return send({ jsonrpc: "2.0", id: req.id, result: {} });
    default:
      return send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
});
}
