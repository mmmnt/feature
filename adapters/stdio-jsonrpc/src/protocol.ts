// The Feat Host Protocol, client side: the closed schema, request checking and answer checking,
// shared by the one-shot exchange (SPEC-RPC-001) and the shared host (SPEC-RPC-002).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import type { ErrorObject } from "ajv";

const require = createRequire(import.meta.url);
const Ajv: typeof import("ajv").default = require("ajv");
const addFormats: typeof import("ajv-formats").default = require("ajv-formats");

const PKG_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SCHEMA = JSON.parse(readFileSync(path.resolve(PKG_DIR, "../schemas/feat-host-protocol.schema.json"), "utf8")) as {
  definitions: { requests: Record<string, unknown>; results: Record<string, unknown> };
};

// The schema is draft-07, compiled strict.
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addSchema(SCHEMA, "protocol");
export const ref = (p: string) => {
  const v = ajv.getSchema(`protocol#/definitions/${p}`);
  if (!v) throw new Error(`feat-host-protocol: no definition '${p}'`);
  return v;
};

export const DEFAULT_TIMEOUT_MS = 30_000;

export type ExchangeFailure =
  | "INVALID_REQUEST" | "HOST_SPAWN_FAILED" | "HOST_EXITED" | "HOST_TIMEOUT" | "PROTOCOL_VIOLATION" | "HOST_ERROR"
  // SPEC-RPC-002: the shared host
  | "HOST_CRASHED" | "PROTOCOL_MISMATCH" | "NAMESPACE_NOT_HONOURED" | "INVALID_CLOCK" | "HOST_CONFIG_MISMATCH";

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

export function describe(errors: ErrorObject[] | null | undefined, scope: string): string {
  return (errors ?? [])
    .map((e) => {
      const key = e.params && "missingProperty" in e.params ? ` '${String(e.params.missingProperty)}'` : e.params && "additionalProperty" in e.params ? ` '${String(e.params.additionalProperty)}'` : "";
      return `${scope}${e.instancePath} ${e.message ?? "is invalid"}${key}`;
    })
    .join("; ");
}


/** Check a request against the protocol BEFORE anything is spawned or written. */
export function checkRequest(id: number, method: string, params: Record<string, unknown>): { jsonrpc: "2.0"; id: number; method: string; params: Record<string, unknown> } {
  if (!(method in SCHEMA.definitions.requests))
    throw new ExchangeError("INVALID_REQUEST", `method '${method}' is not in the protocol (methods: ${Object.keys(SCHEMA.definitions.requests).join(", ")})`, false);
  const request = { jsonrpc: "2.0" as const, id, method, params };
  const check = ref(`requests/${method}`);
  if (!check(request)) throw new ExchangeError("INVALID_REQUEST", describe(check.errors, "request"), false);
  return request;
}

/** Check one answer line against the protocol and the closed shape of the method it answers; returns the result. */
export function checkAnswer(line: string, id: number, method: string): unknown {
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
  return answer.result;
}
