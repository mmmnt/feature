// ADR-0035 — the seed transform the store adapters share (SPEC-ADPNEO-005, SPEC-ADPRDS-002, SPEC-ADPKUR-006,
// SPEC-ADPDDB-003; founder rulings 944b1d17, c141a704, 12081c37, agreed 094b5dcc). A store adapter configured with
// options.seedTransform { host } joins the spec file's shared host (SPEC-RPC-002) as a role of no service, and before
// every seed call asks it `transformSeed` TWICE: the two answers must agree (canonical JSON) and each must keep the
// records' count, order, type and identity. The adapter then checks storability by its own store's rules and writes.

import type { SeedRecord } from "@mmmnt/feat-types";
import { defaultRegistry, type HostConfig, type HostConnection, type HostRegistry } from "./host.js";
import { ExchangeError } from "./protocol.js";
import { PROTOCOL_VERSION } from "./adapters.js";

export type SeedTransformCode = "OPTIONS_INVALID" | "SEED_TRANSFORM_UNAVAILABLE" | "SEED_TRANSFORM_FAILED" | "SEED_TRANSFORM_NONDETERMINISTIC";

/** A refusal of the shared transform; each store adapter re-raises it as its own error class with the same code. */
export class SeedTransformError extends Error {
  constructor(
    readonly code: SeedTransformCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface SeedTransformOptions {
  host: HostConfig;
}

/** options.seedTransform, checked: undefined when absent; OPTIONS_INVALID unless { host } with a non-empty command of strings. */
export function parseSeedTransform(raw: unknown): SeedTransformOptions | undefined {
  if (raw === undefined) return undefined;
  const bad = (why: string) => new SeedTransformError("OPTIONS_INVALID", `options.seedTransform ${why}`);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw bad("must be { host: { command: [...] } }");
  const { host, ...rest } = raw as Record<string, unknown>;
  const extra = Object.keys(rest);
  if (extra.length > 0) throw bad(`names ${extra.join(", ")}; only host is allowed`);
  if (host === null || typeof host !== "object" || Array.isArray(host)) throw bad("must be { host: { command: [...] } }");
  const h = host as Record<string, unknown>;
  const command = h.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((c) => typeof c === "string" && c !== ""))
    throw new SeedTransformError("OPTIONS_INVALID", "options.seedTransform.host.command must be a non-empty list of strings");
  if (h.cwd !== undefined && typeof h.cwd !== "string") throw bad("host.cwd must be a string");
  if (h.env !== undefined && (h.env === null || typeof h.env !== "object" || Object.values(h.env).some((v) => typeof v !== "string")))
    throw bad("host.env must be an object of strings");
  return { host: { command: command as string[], ...(h.cwd !== undefined ? { cwd: h.cwd as string } : {}), ...(h.env !== undefined ? { env: h.env as Record<string, string> } : {}) } };
}

/** JSON with every object's keys sorted, so two answers that hold the same values compare equal (12081c37). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** How a store names one record (for details) and what must not change (its identity). */
export interface SeedIdentity {
  describe(record: SeedRecord): string;
  identity(record: SeedRecord): unknown;
}

export class SeedTransform {
  private host: HostConnection | undefined;
  private readonly registry: HostRegistry;

  constructor(
    private readonly options: SeedTransformOptions,
    private readonly service: string,
    private readonly namespace: string,
    registry?: HostRegistry,
  ) {
    this.registry = registry ?? defaultRegistry;
  }

  /** Join the shared host and set it up as a role of no service; any failure is SEED_TRANSFORM_UNAVAILABLE. */
  async setup(): Promise<void> {
    if (this.host !== undefined) return;
    let host: HostConnection;
    try {
      ({ host } = await this.registry.join(this.options.host, this.namespace));
    } catch (e) {
      throw new SeedTransformError("SEED_TRANSFORM_UNAVAILABLE", `options.seedTransform: the host '${this.options.host.command.join(" ")}' could not be started (${e instanceof Error ? e.message : String(e)})`);
    }
    try {
      const r = (await host.request("setup", { protocol: PROTOCOL_VERSION, services: [], namespace: this.namespace })) as { protocol: number; namespace: string };
      if (r.protocol !== PROTOCOL_VERSION) throw new Error(`the host speaks protocol ${r.protocol}, not ${PROTOCOL_VERSION}`);
      if (r.namespace !== this.namespace) throw new Error(`the host reports namespace ${r.namespace}, not ${this.namespace}`);
    } catch (e) {
      await this.registry.leave(host).catch(() => {});
      throw new SeedTransformError("SEED_TRANSFORM_UNAVAILABLE", `options.seedTransform: the host '${this.options.host.command.join(" ")}' did not set up (${e instanceof Error ? e.message : String(e)})`);
    }
    this.host = host;
  }

  private async ask(records: SeedRecord[]): Promise<SeedRecord[]> {
    if (this.host === undefined) throw new SeedTransformError("SEED_TRANSFORM_FAILED", "the seed-transform host is not set up");
    try {
      const r = (await this.host.request("transformSeed", { service: this.service, records: records.map(({ type, values }) => ({ type, values })) })) as { records: SeedRecord[] };
      return r.records;
    } catch (e) {
      if (e instanceof ExchangeError) {
        const why =
          e.code === "HOST_ERROR" && e.extra.rpcCode === -32601
            ? "the host does not implement transformSeed (method not found)"
            : e.code === "HOST_CRASHED"
              ? "the host ended"
              : e.code === "HOST_ERROR"
                ? `the host refused transformSeed: ${e.extra.message ?? e.detail}`
                : `${e.code}: ${e.detail}`;
        throw new SeedTransformError("SEED_TRANSFORM_FAILED", why);
      }
      throw new SeedTransformError("SEED_TRANSFORM_FAILED", e instanceof Error ? e.message : String(e));
    }
  }

  private check(sent: SeedRecord[], got: SeedRecord[], id: SeedIdentity): void {
    if (got.length !== sent.length)
      throw new SeedTransformError("SEED_TRANSFORM_FAILED", `the host answered ${got.length} records for ${sent.length} records sent`);
    sent.forEach((s, i) => {
      const g = got[i]!;
      if (g.type !== s.type) throw new SeedTransformError("SEED_TRANSFORM_FAILED", `record ${i} (${id.describe(s)}) came back as type '${g.type}'`);
      // Founder ruling 57cc575c (T2): identity is compared for every answer, whatever its values are.
      if (canonicalJson(id.identity(g)) !== canonicalJson(id.identity(s)))
        throw new SeedTransformError("SEED_TRANSFORM_FAILED", `record ${i} (${id.describe(s)}) came back with another identity: ${canonicalJson(id.identity(g))}`);
    });
  }

  /** Transform one seed call's records: asked twice, checked, the first answer returned. Nothing is written here. */
  async transform(records: SeedRecord[], id: SeedIdentity): Promise<SeedRecord[]> {
    if (records.length === 0) return records;
    const first = await this.ask(records);
    this.check(records, first, id);
    const second = await this.ask(records);
    this.check(records, second, id);
    for (let i = 0; i < first.length; i++) {
      const a = first[i]!;
      const b = second[i]!;
      if (canonicalJson(a.values) !== canonicalJson(b.values)) {
        const keys = new Set([...Object.keys((a.values ?? {}) as object), ...Object.keys((b.values ?? {}) as object)]);
        const where = typeof a.values === "object" && a.values !== null && typeof b.values === "object" && b.values !== null
          ? [...keys].sort().find((k) => canonicalJson((a.values as Record<string, unknown>)[k]) !== canonicalJson((b.values as Record<string, unknown>)[k]))
          : undefined;
        throw new SeedTransformError(
          "SEED_TRANSFORM_NONDETERMINISTIC",
          `two transforms of ${id.describe(records[i]!)}${where !== undefined ? ` › ${where}` : ""} differ: ${canonicalJson(where !== undefined ? (a.values as Record<string, unknown>)[where] : a.values)} and ${canonicalJson(where !== undefined ? (b.values as Record<string, unknown>)[where] : b.values)}`,
        );
      }
    }
    return first.map((r, i) => ({ ...records[i]!, type: r.type, values: r.values as Record<string, unknown> }));
  }

  async teardown(): Promise<void> {
    const host = this.host;
    if (host === undefined) return;
    this.host = undefined;
    try {
      if (!host.ended) await host.request("teardown", { services: [] });
    } catch {
      // the host may already be gone; leaving is what matters
    } finally {
      await this.registry.leave(host).catch(() => {});
    }
  }
}
