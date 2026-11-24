// SPEC-RPC-002 — one spec host per spec file, shared by the file's response role and every service
// role. A HostConnection is a long-lived child process speaking the Feat Host Protocol (one request
// line, one answer line, correlated by id); a HostRegistry hands the same connection to every role
// of a file and ends it when the last role leaves. A request with no answer within the limit fails
// HOST_TIMEOUT and ends the connection: nothing more is written to the host, it is ended in the
// background (stdin closed, killed after the grace period), the registry drops it, and every pending
// and later call fails HOST_ENDED (founder rulings cd46cd64, agreed 78a98840).

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
  /** Set when a request timed out: the HOST_ENDED every pending and later call fails with. */
  broken: ExchangeError | undefined;
  /** Told once, when the connection breaks, so the registry can drop it. */
  onBroken: (() => void) | undefined;

  private constructor(child: ChildProcess, private readonly timeoutMs: number) {
    this.child = child;
    this.exited = new Promise((resolve) => {
      child.once("close", () => {
        this.ended = true;
        if (!this.asked) this.crashed = true;
        for (const [, p] of this.pending) {
          clearTimeout(p.timer);
          p.reject(this.broken ?? new ExchangeError("HOST_CRASHED", "the host process exited", true));
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
      // After a timeout nothing the host writes answers anything.
      if (this.broken) continue;
      // One request is outstanding at a time (calls are queued and a timeout ends the host), so a line
      // answers it; checkAnswer still holds its id to the request's.
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
      if (this.broken) throw this.broken;
      if (this.ended) throw new ExchangeError("HOST_CRASHED", "the host process has exited", true);
      const id = this.nextId++;
      const request = checkRequest(id, method, params); // INVALID_REQUEST never reaches the host
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new ExchangeError("HOST_TIMEOUT", `no answer to ${method} within ${this.timeoutMs} ms`, true));
          this.breakAfterTimeout(method);
        }, this.timeoutMs);
        this.pending.set(id, { method, resolve, reject, timer });
        this.child.stdin!.write(`${JSON.stringify(request)}\n`);
      });
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** A request timed out: write nothing more, fail every other call HOST_ENDED, end the host in the background. */
  private breakAfterTimeout(method: string): void {
    if (this.broken) return;
    this.broken = new ExchangeError("HOST_ENDED", `the host was ended after ${method} had no answer within ${this.timeoutMs} ms`, true);
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(this.broken);
    }
    this.pending.clear();
    this.onBroken?.();
    this.asked = true;
    if (!this.ended) {
      this.child.stdin!.end();
      const kill = setTimeout(() => this.child.kill("SIGKILL"), GRACE_MS);
      void this.exited.then(() => clearTimeout(kill));
    }
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

  /** RunFiles alone names a shorter request limit; the adapters' registry keeps the 30 s default. */
  constructor(private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS) {}

  async join(config: HostConfig, namespace: string): Promise<{ host: HostConnection; spawnedNow: boolean }> {
    const key = canonical(config);
    if (this.entry && !this.entry.host.ended) {
      if (this.entry.key !== key)
        throw new ExchangeError("HOST_CONFIG_MISMATCH", `host configuration differs from the host already open for this file (${this.entry.host.pid})`, true);
      this.entry.roles++;
      return { host: this.entry.host, spawnedNow: false };
    }
    const host = await HostConnection.spawn(config, namespace, this.requestTimeoutMs);
    this.spawned++;
    const entry: Entry = { key, host, roles: 1 };
    this.entry = entry;
    // A timeout ends the host: drop its entry, so a role that sets up next gets a fresh host.
    host.onBroken = () => {
      if (this.entry === entry) this.entry = undefined;
    };
    return { host, spawnedNow: true };
  }

  /** A role leaves; the last one out ends the host. Returns whether it did. */
  async leave(host: HostConnection): Promise<boolean> {
    // A host ended after a timeout has left the registry; each of its roles waits for it to be gone.
    if (host.broken) {
      await host.close();
      return false;
    }
    if (!this.entry || this.entry.host !== host) return false;
    if (--this.entry.roles > 0) return false;
    this.entry = undefined;
    await host.close();
    return true;
  }
}

export const defaultRegistry = new HostRegistry();
