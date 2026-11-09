// SPEC-RPC-001 — one request, one answer over the Feat Host Protocol (JSON-RPC 2.0 on a spec host's
// stdio; contract schemas/feat-host-protocol.schema.json). Validate the request BEFORE spawning,
// spawn, write one line, read one line, check the answer against the CLOSED shape of its method,
// fail precisely, and leave nothing running.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(path.resolve(PKG_DIR, "../schemas/feat-host-protocol.schema.json"), "utf8")) as {
  definitions: { requests: Record<string, unknown>; results: Record<string, unknown> };
};

// The schema is draft-07, compiled strict.
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(SCHEMA, "protocol");
const ref = (p: string) => {
  const v = ajv.getSchema(`protocol#/definitions/${p}`);
  if (!v) throw new Error(`feat-host-protocol: no definition '${p}'`);
  return v;
};

export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExchangeInput {
  host: { command: string[] };
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

export type ExchangeFailure =
  | "INVALID_REQUEST" | "HOST_SPAWN_FAILED" | "HOST_EXITED" | "HOST_TIMEOUT" | "PROTOCOL_VIOLATION" | "HOST_ERROR";

/** What an exchange raises, as data: code, detail, and where the host stood. */
export class ExchangeError extends Error {
  constructor(
    public code: ExchangeFailure,
    public detail: string,
    public hostSpawned: boolean,
    public extra: { rpcCode?: number; message?: string } = {},
  ) {
    super(`${code}: ${detail}`);
  }
}

function describe(errors: ErrorObject[] | null | undefined, scope: string): string {
  return (errors ?? [])
    .map((e) => {
      const key = e.params && "missingProperty" in e.params ? ` '${String(e.params.missingProperty)}'` : e.params && "additionalProperty" in e.params ? ` '${String(e.params.additionalProperty)}'` : "";
      return `${scope}${e.instancePath} ${e.message ?? "is invalid"}${key}`;
    })
    .join("; ");
}

let nextId = 1;

/** Run one exchange; resolves with the host's result or rejects with an ExchangeError. */
export async function exchangeOnce(input: ExchangeInput): Promise<{ method: string; sent: { method: string; params: Record<string, unknown> }; hostSpawned: true; hostAlive: false; result: unknown }> {
  const { method, params } = input;
  // 1. The request is checked against the protocol BEFORE any host is spawned.
  if (!(method in SCHEMA.definitions.requests))
    throw new ExchangeError("INVALID_REQUEST", `method '${method}' is not in the protocol (methods: ${Object.keys(SCHEMA.definitions.requests).join(", ")})`, false);
  const id = nextId++;
  const request = { jsonrpc: "2.0", id, method, params };
  const check = ref(`requests/${method}`);
  if (!check(request)) throw new ExchangeError("INVALID_REQUEST", describe(check.errors, "request"), false);

  // 2. Spawn, write one line, read one line.
  const [cmd, ...args] = input.host.command;
  const child = spawn(cmd!, args, { stdio: ["pipe", "pipe", "ignore"] });
  const spawned = await new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.once("error", () => resolve(false));
  });
  if (!spawned) throw new ExchangeError("HOST_SPAWN_FAILED", `could not start '${input.host.command.join(" ")}'`, false);

  let exited = false;
  const closed = new Promise<void>((resolve) => child.once("close", () => { exited = true; resolve(); }));
  const stop = async () => {
    child.stdin.destroy();
    if (!exited) child.kill("SIGKILL");
    await closed;
  };

  try {
    const line = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new ExchangeError("HOST_TIMEOUT", `no answer within ${input.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`, true)), input.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      child.stdout.on("data", (d: Buffer) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl !== -1) { clearTimeout(timer); resolve(buf.slice(0, nl)); }
      });
      child.once("close", () => { clearTimeout(timer); reject(new ExchangeError("HOST_EXITED", "the host exited before it answered", true)); });
      child.stdin.on("error", () => {});
      child.stdin.write(`${JSON.stringify(request)}\n`);
    });

    // 3. The answer.
    let answer: Record<string, unknown>;
    try {
      answer = JSON.parse(line) as Record<string, unknown>;
    } catch {
      throw new ExchangeError("PROTOCOL_VIOLATION", `the host's line is not JSON: ${line.slice(0, 80)}`, true);
    }
    const whole = ajv.getSchema("protocol")!;
    if (!whole(answer)) throw new ExchangeError("PROTOCOL_VIOLATION", `the answer violates the protocol schema: ${describe(whole.errors, "answer")}`, true);
    const rpcError = answer.error as { code: number; message: string } | undefined;
    if (answer.id === null) {
      if (!rpcError || (rpcError.code !== -32700 && rpcError.code !== -32600))
        throw new ExchangeError("PROTOCOL_VIOLATION", "a null id is accepted only on an error of code -32700 or -32600", true);
    } else if (answer.id !== id) {
      throw new ExchangeError("PROTOCOL_VIOLATION", `the answer carries id ${String(answer.id)}, the request carried ${id}`, true);
    }
    if (rpcError) throw new ExchangeError("HOST_ERROR", rpcError.message, true, { rpcCode: rpcError.code, message: rpcError.message });
    const shape = ref(`results/${method}`);
    if (!shape(answer.result)) throw new ExchangeError("PROTOCOL_VIOLATION", `the ${method} result violates its closed shape: ${describe(shape.errors, "result")}`, true);
    return { method, sent: { method, params }, hostSpawned: true, hostAlive: false, result: answer.result };
  } finally {
    await stop();
  }
}

/** The handler contract of the `Exchange` command: { status, body }. */
export async function exchange(input: ExchangeInput): Promise<{ status: "OK" | "ERR"; body: Record<string, unknown> }> {
  try {
    return { status: "OK", body: (await exchangeOnce(input)) as unknown as Record<string, unknown> };
  } catch (e) {
    if (!(e instanceof ExchangeError)) throw e;
    return {
      status: "ERR",
      body: { code: e.code, detail: e.detail, hostSpawned: e.hostSpawned, hostAlive: false, ...e.extra },
    };
  }
}
