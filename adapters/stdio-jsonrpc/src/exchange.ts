// SPEC-RPC-001 — one request, one answer over the Feat Host Protocol (JSON-RPC 2.0 on a spec host's
// stdio; contract schemas/feat-host-protocol.schema.json). Validate the request BEFORE spawning,
// spawn, write one line, read one line, check the answer against the CLOSED shape of its method,
// fail precisely, and leave nothing running.

import { spawn } from "node:child_process";
import { checkAnswer, checkRequest, ExchangeError } from "./protocol.js";

export { ExchangeError } from "./protocol.js";
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface ExchangeInput {
  host: { command: string[] };
  method: string;
  params: Record<string, unknown>;
  timeoutMs?: number;
}

let nextId = 1;

/** Run one exchange; resolves with the host's result or rejects with an ExchangeError. */
export async function exchangeOnce(input: ExchangeInput): Promise<{ method: string; sent: { method: string; params: Record<string, unknown> }; hostSpawned: true; hostAlive: false; result: unknown }> {
  const { method, params } = input;
  const id = nextId++;
  const request = checkRequest(id, method, params);

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
    const result = checkAnswer(line, id, method);
    return { method, sent: { method, params }, hostSpawned: true, hostAlive: false, result };
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
