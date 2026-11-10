// SPEC-RPC-002 — one spec host per spec file, shared by the file's response role and every service
// role. A HostConnection is a long-lived child process speaking the Feat Host Protocol (one request
// line, one answer line, correlated by id); a HostRegistry hands the same connection to every role
// of a file and ends it when the last role leaves.

import { spawn, type ChildProcess } from "node:child_process";
import { checkAnswer, checkRequest, ExchangeError } from "./protocol.js";

export interface HostConfig {
  command: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const GRACE_MS = 2_000;

export class HostConnection {
  private child: ChildProcess;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<number, { method: string; resolve: (v: unknown) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<unknown> = Promise.resolve();
  /** True once the process is gone, however it went. */
  ended = false;
  /** True when it went without being asked to. */
  crashed = false;
  private asked = false;
  private readonly exited: Promise<void>;

  private constructor(child: ChildProcess, private readonly timeoutMs: number) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        this.ended = true;
        if (!this.asked) this.crashed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(new ExchangeError("HOST_CRASHED", "the host process exited", true));
        }
        this.pending.clear();
        resolve();
      });
    });
    child.stdout!.on("data", (d: Buffer) => this.onData(d.toString("utf8")));
    child.stdin!.on("error", () => {});
  }

  static async spawn(config: HostConfig, namespace: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<HostConnection> {
    const [cmd, ...args] = config.command;
    const child = spawn(cmd!, args, {
      stdio: ["pipe", "pipe", "ignore"],
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      env: { ...process.env, ...config.env, FEAT_NAMESPACE: namespace },
    });
    const ok = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    if (!ok) throw new ExchangeError("HOST_SPAWN_FAILED", `could not start '${config.command.join(" ")}'`, false);
    return new HostConnection(child, timeoutMs);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (let nl = this.buffer.indexOf("\n"); nl !== -1; nl = this.buffer.indexOf("\n")) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      // One request is outstanding at a time (calls are queued), so any line answers it.
      const [id, p] = [...this.pending.entries()][0] ?? [];
      if (id === undefined || p === undefined) continue;
      this.pending.delete(id);
      clearTimeout(p.timer);
      try {
        p.resolve(checkAnswer(line, id, p.method));
      } catch (e) {
        p.reject(e);
      }
    }
  }

  /** One request, one answer; calls are serialised. After the host is gone every call fails HOST_CRASHED. */
  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      if (this.ended) throw new ExchangeError("HOST_CRASHED", "the host process has exited", true);
      const id = this.nextId++;
      const request = checkRequest(id, method, params); // INVALID_REQUEST never reaches the host
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new ExchangeError("HOST_TIMEOUT", `no answer to ${method} within ${this.timeoutMs} ms`, true));
        }, this.timeoutMs);
        this.pending.set(id, { method, resolve, reject, timer });
        this.child.stdin!.write(`${JSON.stringify(request)}\n`);
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  /** End the host: close stdin, kill after a grace period, wait for the process to be gone. */
  async close(): Promise<void> {
    this.asked = true;
    if (!this.ended) {
      this.child.stdin!.end();
      const timer = setTimeout(() => this.child.kill("SIGKILL"), GRACE_MS);
      await this.exited;
      clearTimeout(timer);
    }
  }
}

interface Entry {
  key: string;
  host: HostConnection;
  roles: number;
}

const canonical = (c: HostConfig): string =>
  JSON.stringify({ command: c.command, cwd: c.cwd ?? null, env: Object.fromEntries(Object.entries(c.env ?? {}).sort()) });

/**
 * The open host(s) of one spec file. Module-scoped by default (a vitest worker runs one file, so a
 * module is a file); a caller may hand each simulated file its own. One host per file: a role whose
 * host configuration differs from the open host's is refused.
 */
export class HostRegistry {
  private entry: Entry | undefined;
  spawned = 0;

  async join(config: HostConfig, namespace: string): Promise<{ host: HostConnection; spawnedNow: boolean }> {
    const key = canonical(config);
    if (this.entry && !this.entry.host.ended) {
      if (this.entry.key !== key)
        throw new ExchangeError("HOST_CONFIG_MISMATCH", `host configuration differs from the host already open for this file (${this.entry.host.pid})`, true);
      this.entry.roles++;
      return { host: this.entry.host, spawnedNow: false };
    }
    const host = await HostConnection.spawn(config, namespace);
    this.spawned++;
    this.entry = { key, host, roles: 1 };
    return { host, spawnedNow: true };
  }

  /** A role leaves; the last one out ends the host. Returns whether it did. */
  async leave(host: HostConnection): Promise<boolean> {
    if (!this.entry || this.entry.host !== host) return false;
    if (--this.entry.roles > 0) return false;
    this.entry = undefined;
    await host.close();
    return true;
  }
}

export const defaultRegistry = new HostRegistry();
