// @mmmnt/feat-fault-proxy (SPEC-FPX-001) — transport faults for the product adapters, through
// Toxiproxy. One proxy per namespace and product; the adapter's own instrument connection never
// goes through it, so a fault applies to the system's path only.
//
// Reused, not reinvented: toxiproxy-node-client for the Toxiproxy API, and the container
// runtime's own CLI (docker or podman, run without a shell) for broker loss.

import { execFile } from "node:child_process";
import { Toxiproxy } from "toxiproxy-node-client";
import type { Proxy } from "toxiproxy-node-client";

export type FaultName = "Timeout" | "ConnectionReset" | "Partition" | "BrokerLoss";
export type FaultStream = "upstream" | "downstream";
export type BrokerLossMode = "pause" | "stop";

export interface ArmDetail {
  /** Timeout and ConnectionReset: the direction the toxic applies to. Default: "downstream" for Timeout, "upstream" for ConnectionReset. */
  stream?: FaultStream;
  /** BrokerLoss: "pause" (default) or "stop". */
  mode?: BrokerLossMode;
}

export interface FaultProxyOptions {
  /** Toxiproxy API base URL, e.g. http://127.0.0.1:8474. */
  api: string;
  product: string;
  /** host:port of the product, as Toxiproxy reaches it. */
  upstream: string;
  namespace: string;
  /** The product's container, for BrokerLoss. Without it BrokerLoss is not in the catalog. */
  container?: string;
  /** The Toxiproxy /metrics URL (the server runs with -proxy-metrics), for traffic(). */
  metrics?: string;
  /** The container runtime's CLI. Default "docker". */
  runtime?: string;
}

export interface OpenProxy {
  name: string;
  /** The address Toxiproxy reports for the proxy, e.g. "[::]:30011". */
  listen: string;
  upstream: string;
}

export type Traffic = "unobserved" | { received: number; sent: number };

export interface FaultProxy {
  readonly catalog: readonly FaultName[];
  open(): Promise<OpenProxy>;
  arm(fault: string, detail?: ArmDetail): Promise<void>;
  disarm(): Promise<void>;
  armed(): readonly FaultName[];
  traffic(): Promise<Traffic>;
  close(): Promise<void>;
}

export type FaultProxyErrorCode =
  | "PROXY_UNREACHABLE"
  | "PROXY_NOT_OPEN"
  | "FAULT_UNSUPPORTED"
  | "CONTAINER_NOT_FOUND"
  | "CONTAINER_RUNTIME_UNAVAILABLE";

export class FaultProxyError extends Error {
  constructor(
    readonly code: FaultProxyErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "FaultProxyError";
  }
}

const TOXIC_PREFIX = "feat-";
const STATUS_PREFIX = "Request failed with status code";

function isApiAnswer(e: unknown): boolean {
  return e instanceof Error && e.message.startsWith(STATUS_PREFIX);
}

interface ToxicRow {
  name: string;
}

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  spawnError?: NodeJS.ErrnoException;
}

function run(runtime: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(runtime, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) return resolve({ code: 0, stdout, stderr });
      const e = error as NodeJS.ErrnoException & { code?: number | string };
      if (typeof e.code === "string") return resolve({ code: null, stdout, stderr, spawnError: e });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout, stderr });
    });
  });
}

export function createFaultProxy(options: FaultProxyOptions): FaultProxy {
  const { api, product, upstream, namespace, container, metrics } = options;
  const runtime = options.runtime ?? "docker";
  const name = `feat-${namespace}-${product}`;
  const catalog: readonly FaultName[] =
    container === undefined ? ["Timeout", "ConnectionReset", "Partition"] : ["Timeout", "ConnectionReset", "Partition", "BrokerLoss"];
  const toxiproxy = new Toxiproxy(api);

  let proxy: Proxy | undefined;
  let armedFaults: FaultName[] = [];
  let brokerMode: BrokerLossMode | undefined;
  let baseline: { received: number; sent: number } | undefined;

  const unreachable = (e: unknown): FaultProxyError =>
    new FaultProxyError("PROXY_UNREACHABLE", `the Toxiproxy api at ${api} did not answer: ${e instanceof Error ? e.message : String(e)}`);

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (isApiAnswer(e) || e instanceof FaultProxyError) throw e;
      throw unreachable(e);
    }
  }

  function opened(): Proxy {
    if (proxy === undefined) {
      throw new FaultProxyError("PROXY_NOT_OPEN", `namespace '${namespace}' has no open proxy '${name}': call open() before arm()`);
    }
    return proxy;
  }

  async function runtimeCall(args: string[]): Promise<Run> {
    const r = await run(runtime, args);
    if (r.spawnError !== undefined) {
      throw new FaultProxyError("CONTAINER_RUNTIME_UNAVAILABLE", `the container runtime '${runtime}' cannot be run: ${r.spawnError.message}`);
    }
    return r;
  }

  async function requireContainer(): Promise<string> {
    const c = container as string;
    const r = await runtimeCall(["inspect", "--format", "{{.State.Status}}", c]);
    if (r.code !== 0) {
      if (/no such (object|container)|not found|does not exist/i.test(r.stderr)) {
        throw new FaultProxyError("CONTAINER_NOT_FOUND", `the container runtime does not know the container '${c}'`);
      }
      throw new FaultProxyError("CONTAINER_RUNTIME_UNAVAILABLE", `the container runtime '${runtime}' failed: ${r.stderr.trim()}`);
    }
    return c;
  }

  async function containerVerb(verb: string, c: string): Promise<void> {
    const r = await runtimeCall([verb, c]);
    if (r.code !== 0) {
      throw new FaultProxyError("CONTAINER_RUNTIME_UNAVAILABLE", `the container runtime '${runtime}' failed to ${verb} '${c}': ${r.stderr.trim()}`);
    }
  }

  async function readCounters(): Promise<{ received: number; sent: number } | undefined> {
    if (metrics === undefined) return undefined;
    const res = await call(async () => {
      const r = await fetch(metrics);
      if (!r.ok) throw new Error(`${STATUS_PREFIX} ${r.status}`);
      return r.text();
    });
    let received = 0;
    let sent = 0;
    for (const line of res.split("\n")) {
      if (line.startsWith("#") || !line.includes(`proxy="${name}"`)) continue;
      const value = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (!Number.isFinite(value)) continue;
      if (line.startsWith("toxiproxy_proxy_received_bytes_total")) received += value;
      else if (line.startsWith("toxiproxy_proxy_sent_bytes_total")) sent += value;
    }
    return { received, sent };
  }

  return {
    catalog,

    async open(): Promise<OpenProxy> {
      if (proxy === undefined) {
        proxy = await call(async () => {
          try {
            return await toxiproxy.get(name);
          } catch (e) {
            if (!isApiAnswer(e)) throw e;
            return toxiproxy.createProxy({ name, listen: ":0", upstream });
          }
        });
      }
      const fresh = await call(() => toxiproxy.get(name));
      proxy = fresh;
      return { name, listen: fresh.listen, upstream: fresh.upstream };
    },

    async arm(fault: string, detail: ArmDetail = {}): Promise<void> {
      if (!(catalog as readonly string[]).includes(fault)) {
        throw new FaultProxyError("FAULT_UNSUPPORTED", `the fault '${fault}' is not in the catalog (${catalog.join(", ")})`);
      }
      const f = fault as FaultName;
      const p = opened();
      baseline = await readCounters();
      if (f === "Timeout" || f === "ConnectionReset") {
        const stream = detail.stream ?? (f === "ConnectionReset" ? "upstream" : "downstream");
        const toxicName = `${TOXIC_PREFIX}${f}`;
        await call(async () => {
          // Re-arming the same fault replaces it: a toxic name is unique on a proxy.
          try {
            await (await p.getToxic(toxicName)).remove();
          } catch (e) {
            if (!isApiAnswer(e)) throw e;
          }
          await p.addToxic({
            name: toxicName,
            type: f === "Timeout" ? "timeout" : "reset_peer",
            stream,
            toxicity: 1,
            attributes: { timeout: 0 },
          });
        });
      } else if (f === "Partition") {
        await call(async () => {
          const cur = await toxiproxy.get(name);
          await cur.update({ enabled: false, listen: cur.listen, upstream: cur.upstream });
        });
      } else {
        const c = await requireContainer();
        const mode = detail.mode ?? "pause";
        await containerVerb(mode === "stop" ? "stop" : "pause", c);
        brokerMode = mode;
      }
      armedFaults = [...armedFaults.filter((x) => x !== f), f];
    },

    async disarm(): Promise<void> {
      // Proxy-scoped on purpose: Toxiproxy's global reset would clear other hosts' faults.
      const p = opened();
      await call(async () => {
        const rows = (await toxiproxy.getApi().get<ToxicRow[]>(`${api}/proxies/${name}/toxics`)).data;
        for (const row of rows) await (await p.getToxic(row.name)).remove();
        const cur = await toxiproxy.get(name);
        if (!cur.enabled) await cur.update({ enabled: true, listen: cur.listen, upstream: cur.upstream });
      });
      if (brokerMode !== undefined && container !== undefined) {
        const mode = brokerMode;
        await containerVerb(mode === "stop" ? "start" : "unpause", container);
        brokerMode = undefined;
      }
      armedFaults = [];
    },

    armed(): readonly FaultName[] {
      return [...armedFaults];
    },

    async traffic(): Promise<Traffic> {
      if (metrics === undefined) return "unobserved";
      const now = await readCounters();
      if (now === undefined) return "unobserved";
      const base = baseline ?? { received: 0, sent: 0 };
      return { received: now.received - base.received, sent: now.sent - base.sent };
    },

    async close(): Promise<void> {
      if (proxy === undefined) return;
      try {
        await this.disarm();
      } finally {
        await call(async () => {
          try {
            await (await toxiproxy.get(name)).remove();
          } catch (e) {
            if (!isApiAnswer(e)) throw e;
          }
        });
        proxy = undefined;
      }
    },
  };
}
