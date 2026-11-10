// SPEC-RPC-002 — the adapters of @mmmnt/feat-adapter-stdio-jsonrpc: a response role and service roles
// that share ONE spec host per spec file (Feat Host Protocol). The first role to set up spawns the
// host; later roles join it; each role's teardown leaves; the last one out ends the host.

import type {
  CapturedRecord, CapturedResponse, FeatResponseAdapter, FeatServiceAdapter, ObservationSupport, ReadQuery, SeedRecord,
} from "@mmmnt/feat-types";
import { ExchangeError } from "./protocol.js";
import { defaultRegistry, type HostConfig, type HostConnection, type HostRegistry } from "./host.js";

export const PROTOCOL_VERSION = 2;

interface RoleConfig {
  namespace?: string;
  /** Tests give each simulated spec file its own registry; a real worker's module is its file. */
  registry?: HostRegistry;
  projectRoot?: string;
}

// An ISO-8601 instant WITH a zone designator, or the host's wall clock is not frozen.
const CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

abstract class Role {
  protected host: HostConnection | undefined;
  protected readonly registry: HostRegistry;
  protected readonly namespace: string;
  private echoed: string | undefined;

  constructor(protected readonly config: RoleConfig, private readonly hostConfig: HostConfig) {
    this.registry = config.registry ?? defaultRegistry;
    this.namespace = config.namespace ?? "";
  }

  /** The services this role opens on the host: none for the response role. */
  protected abstract services(): string[];

  protected async join(): Promise<void> {
    const { host } = await this.registry.join(this.hostConfig, this.namespace);
    this.host = host;
    try {
      const r = (await host.request("setup", { protocol: PROTOCOL_VERSION, services: this.services(), namespace: this.namespace })) as { protocol: number; namespace: string };
      if (r.protocol !== PROTOCOL_VERSION)
        throw new ExchangeError("PROTOCOL_MISMATCH", `the host speaks protocol ${r.protocol}, this client speaks ${PROTOCOL_VERSION}`, true);
      this.echoed = r.namespace;
      if (r.namespace !== this.namespace)
        throw new ExchangeError("NAMESPACE_NOT_HONOURED", `the host reports namespace ${r.namespace}, the namespace sent was ${this.namespace}`, true);
    } catch (e) {
      await this.registry.leave(host);
      this.host = undefined;
      throw e;
    }
  }

  protected call(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.host) throw new Error(`${method}: the adapter has not been set up`);
    return this.host.request(method, params);
  }

  async teardown(): Promise<void> {
    const host = this.host;
    if (!host) return;
    this.host = undefined;
    try {
      if (!host.ended) await host.request("teardown", { services: this.services() });
    } finally {
      await this.registry.leave(host);
    }
  }

  async setClock(clock: string | null): Promise<void> {
    if (clock !== null && (!CLOCK.test(clock) || !Number.isFinite(Date.parse(clock))))
      throw new ExchangeError("INVALID_CLOCK", `'${clock}' is not an ISO-8601 instant with a zone designator`, true);
    await this.call("setClock", { clock });
  }

  reportedNamespace(): string | undefined {
    return this.echoed;
  }
}

export class StdioResponseAdapter extends Role implements FeatResponseAdapter {
  protected services(): string[] {
    return [];
  }
  async setup(): Promise<void> {
    await this.join();
  }
  async invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse> {
    return (await this.call("invoke", { command, input, ...(actor !== undefined ? { actor } : {}) })) as CapturedResponse;
  }
}

export class StdioServiceAdapter extends Role implements FeatServiceAdapter {
  readonly observes: ObservationSupport = { diff: "native", state: true };

  constructor(config: RoleConfig, hostConfig: HostConfig, private readonly key: string) {
    super(config, hostConfig);
  }
  protected services(): string[] {
    return [this.key];
  }
  async setup(): Promise<void> {
    await this.join();
  }
  async reset(): Promise<void> {
    await this.call("reset", {});
  }
  async startCapture(context?: { specType?: string }): Promise<void> {
    await this.call("startCapture", { service: this.key, ...(context?.specType !== undefined ? { specType: context.specType } : {}) });
  }
  async peekCapture(): Promise<CapturedRecord[]> {
    return (await this.call("peekCapture", { service: this.key })) as CapturedRecord[];
  }
  async stopCapture(): Promise<CapturedRecord[]> {
    return (await this.call("stopCapture", { service: this.key })) as CapturedRecord[];
  }
  /** The host's answer, unchanged: true only when the host proves everything the scenario spawned is written. */
  async settle(): Promise<boolean> {
    return ((await this.call("settle", { service: this.key })) as { settled: boolean }).settled;
  }
  async read(query: ReadQuery): Promise<unknown> {
    return this.call("read", { service: this.key, query: query as Record<string, unknown> });
  }
  async seed(records: SeedRecord[]): Promise<void> {
    await this.call("seed", { service: this.key, records });
  }
  async deliver(event: string, payload: Record<string, unknown>): Promise<void> {
    await this.call("deliver", { service: this.key, event, payload });
  }
}

/** createAdapter(config): a response role when the config has no `key`, else the service role `key`. */
export function createAdapter(config: Record<string, unknown>): FeatResponseAdapter | FeatServiceAdapter {
  const key = config.key as string | undefined;
  const where = key === undefined ? (config.invoke as { host?: HostConfig } | undefined) : (config.options as { host?: HostConfig } | undefined);
  const host = where?.host;
  if (!host || !Array.isArray(host.command) || host.command.length === 0)
    throw new Error(`@mmmnt/feat-adapter-stdio-jsonrpc: ${key === undefined ? "response.invoke.host" : `services.${key}.options.host`} must name { command: [...] } — configuration error.`);
  return key === undefined
    ? new StdioResponseAdapter(config as RoleConfig, host)
    : new StdioServiceAdapter(config as RoleConfig, host, key);
}
