// @mmmnt/feat-adapter-redis (SPEC-ADPRDS-001) — Redis as a Feat service.
//
// Redis has no change feed a client can read back for a window (keyspace notifications are fire-and-forget pub/sub and
// carry no values), so the capture window is a SNAPSHOT of the namespace's keys taken at start and compared at
// peek/stop, as the Neo4j adapter does. The namespace is a key prefix, `<namespace>:`, that every key the system writes
// carries; the adapter reports keys with the prefix removed.
//
// The instrument's connection takes its credential and its CA from files the options name by path (the rule
// SPEC-ADPKUR-005 and SPEC-ADPNEO-003 set): a credential is never required to sit in an environment variable.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createClient } from "redis";
import type {
  CapturedRecord,
  FaultArm,
  FaultCatalog,
  FeatServiceAdapter,
  ReadQuery,
  SeedRecord,
} from "@mmmnt/feat-types";

export type RedisAdapterErrorCode =
  | "NAMESPACE_INVALID"
  | "REDIS_UNREACHABLE"
  | "KIND_UNSUPPORTED"
  | "SEED_INVALID"
  | "FAULT_UNSUPPORTED"
  | "OPTIONS_INVALID"
  | "CREDENTIAL_FILE_UNREADABLE";

export class RedisAdapterError extends Error {
  constructor(
    readonly code: RedisAdapterErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "RedisAdapterError";
  }
}

/** The instrument's credentials as environment-variable names. */
export interface RedisAuthFromEnv {
  /** Name of the environment variable holding the ACL user name; omit for the `default` user. */
  username?: string;
  /** Name of the environment variable holding the password. */
  password: string;
}

/** The instrument's credentials with the password in a file. */
export interface RedisAuthFromFile {
  /** The ACL user name itself (not a secret); `default` for a `requirepass` server. */
  user: string;
  /** Path of a file whose content is the password; a relative path is resolved against the working directory. */
  passwordFile: string;
}

export interface RedisOptions {
  /** redis:// or rediss:// (TLS). No credentials in it: give them in `auth`. */
  url?: string;
  /** Name of the environment variable holding the URL. */
  urlEnv?: string;
  /** Path of a file whose content is the URL; relative to the working directory. */
  urlFile?: string;
  /** The instrument's credentials: environment-variable names, or a password file. Never both forms. Omit for a server without auth. */
  auth?: RedisAuthFromEnv | RedisAuthFromFile;
  /** Path of a PEM file of the CA the server's certificate is verified against; only with a rediss:// URL. */
  tlsCAFile?: string;
}

interface RedisConfig {
  key?: string;
  namespace?: string;
  options?: RedisOptions;
}

/** What one key holds, as JSON: the Redis type and its value in a canonical order. */
export type KeyState =
  | { kind: "string"; value: string }
  | { kind: "set"; value: string[] }
  | { kind: "hash"; value: Record<string, string> }
  | { kind: "list"; value: string[] }
  | { kind: "zset"; value: { member: string; score: number }[] };

type Client = ReturnType<typeof createClient>;

const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;
const SCAN_COUNT = "1000";
const KINDS = ["string", "set", "hash", "list", "zset"] as const;

const byKey = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function stable(v: unknown): string {
  return JSON.stringify(v, (_k, x) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => byKey(a, b)))
      : x,
  );
}

/**
 * A file the options name by path. Relative to the working directory; exactly one trailing LF or CRLF is removed and
 * nothing else. The refusal's detail names the option, the path and the cause, never the content.
 */
function readCredentialFile(option: string, file: string, keepContent = false): string {
  const at = path.resolve(process.cwd(), file);
  const refuse = (cause: string) =>
    new RedisAdapterError("CREDENTIAL_FILE_UNREADABLE", `options.${option} names ${at}, which ${cause}`);
  let content: string;
  try {
    if (statSync(at).isDirectory()) throw refuse("is a directory");
    content = readFileSync(at, "utf8");
  } catch (e) {
    if (e instanceof RedisAdapterError) throw e;
    const code = typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";
    if (code === "ENOENT") throw refuse("is missing");
    if (code === "EISDIR") throw refuse("is a directory");
    throw refuse(`cannot be read (${code || "unknown error"})`);
  }
  if (keepContent) {
    if (content.trim() === "") throw refuse("is empty");
    return content;
  }
  const value = content.endsWith("\r\n") ? content.slice(0, -2) : content.endsWith("\n") ? content.slice(0, -1) : content;
  if (value === "") throw refuse("is empty");
  return value;
}

/** A URL without any credentials in it, for a message. */
function redact(url: string): string {
  return url.replace(/\/\/[^@/]*@/, "//");
}

/** A hash reply as an object with its fields sorted: RESP2 answers [field, value, ...], RESP3 a map (an object or a Map). */
function pairs(reply: unknown): Record<string, string> {
  let out: [string, string][];
  if (Array.isArray(reply)) {
    out = [];
    for (let i = 0; i + 1 < reply.length; i += 2) out.push([String(reply[i]), String(reply[i + 1])]);
  } else if (reply instanceof Map) {
    out = [...reply].map(([k, v]) => [String(k), String(v)]);
  } else if (reply !== null && typeof reply === "object") {
    out = Object.entries(reply as Record<string, unknown>).map(([k, v]) => [k, String(v)]);
  } else out = [];
  return Object.fromEntries(out.sort(([a], [b]) => byKey(a, b)));
}

/** A ZRANGE WITHSCORES reply in score order: RESP2 answers [member, score, ...], RESP3 [[member, score], ...]. */
function scored(reply: unknown): { member: string; score: number }[] {
  const items = Array.isArray(reply) ? reply : [];
  if (items.every((x) => Array.isArray(x))) return items.map((x) => ({ member: String((x as unknown[])[0]), score: Number((x as unknown[])[1]) }));
  const out: { member: string; score: number }[] = [];
  for (let i = 0; i + 1 < items.length; i += 2) out.push({ member: String(items[i]), score: Number(items[i + 1]) });
  return out;
}

class RedisAdapter implements FeatServiceAdapter {
  readonly observes = { diff: "snapshot", state: true } as const;
  /** No fault Redis can arm for one namespace alone: a fault is FAULT_UNSUPPORTED (the catalog is empty). */
  readonly faults: FaultCatalog = {};

  private readonly namespace: string;
  private readonly options: RedisOptions;
  private client: Client | undefined;
  private baseline: Map<string, KeyState> | undefined;
  /** How the last read() found its records: "KeyedLookup" or "NamespaceScan". */
  lastReadVia: "KeyedLookup" | "NamespaceScan" | null = null;

  constructor(config: RedisConfig) {
    const ns = config.namespace;
    if (typeof ns !== "string" || !NAMESPACE_PATTERN.test(ns)) {
      throw new RedisAdapterError(
        "NAMESPACE_INVALID",
        `'${String(ns)}' does not match ${NAMESPACE_PATTERN.source}, the pattern the runner derives`,
      );
    }
    this.namespace = ns;
    this.options = config.options ?? {};
  }

  reportedNamespace(): string {
    return this.namespace;
  }

  private get prefix(): string {
    return `${this.namespace}:`;
  }

  // ── the instrument connection ─────────────────────────────────────────────

  private resolved: { url: string; username: string | undefined; password: string | undefined; ca: string | undefined } | undefined;

  /** One URL source when a file is named, one form of `auth`, a CA only with TLS; no file is read here. */
  private optionsRule(): RedisAdapterError | undefined {
    const o = this.options;
    const sources = (["url", "urlEnv", "urlFile"] as const).filter((k) => o[k] !== undefined);
    if (o.urlFile !== undefined && sources.length > 1) {
      return new RedisAdapterError("OPTIONS_INVALID", `the options name more than one url source: ${sources.join(", ")}; give exactly one with urlFile`);
    }
    const a = o.auth as Partial<RedisAuthFromEnv & RedisAuthFromFile> | undefined;
    if (a !== undefined) {
      const env = a.username !== undefined || a.password !== undefined;
      const file = a.user !== undefined || a.passwordFile !== undefined;
      if (env && file) {
        return new RedisAdapterError("OPTIONS_INVALID", "options.auth mixes the variable names (username, password) with user and passwordFile; use one form");
      }
      if (!env && !file) return new RedisAdapterError("OPTIONS_INVALID", "options.auth names neither a password variable nor a passwordFile");
      if (env && a.password === undefined) return new RedisAdapterError("OPTIONS_INVALID", "options.auth with a username variable needs a password variable");
      // founder ruling 2026-11-15 ("Require a user"): the file form always names its user, as SPEC-ADPNEO-003's does
      if (file && (a.user === undefined || a.passwordFile === undefined)) {
        return new RedisAdapterError("OPTIONS_INVALID", "options.auth with a passwordFile needs both user and passwordFile (a requirepass server's user is `default`)");
      }
    }
    return undefined;
  }

  private resolve(): { url: string; username: string | undefined; password: string | undefined; ca: string | undefined } {
    if (this.resolved !== undefined) return this.resolved;
    const refusal = this.optionsRule();
    if (refusal !== undefined) throw refusal;
    const o = this.options;
    const url =
      o.urlFile !== undefined ? readCredentialFile("urlFile", o.urlFile) : (o.url ?? (o.urlEnv !== undefined ? process.env[o.urlEnv] : undefined));
    if (url === undefined || url === "") {
      throw new RedisAdapterError("OPTIONS_INVALID", "the redis service has no url (or urlEnv naming a set variable, or urlFile)");
    }
    if (!/^rediss?:\/\//.test(url)) throw new RedisAdapterError("OPTIONS_INVALID", `the url ${redact(url)} is not redis:// or rediss://`);
    if (/\/\/[^@/]*@/.test(url)) throw new RedisAdapterError("OPTIONS_INVALID", "the url carries credentials; give them in options.auth");
    const tls = url.startsWith("rediss://");
    if (o.tlsCAFile !== undefined && !tls) throw new RedisAdapterError("OPTIONS_INVALID", "options.tlsCAFile needs a rediss:// url");
    const ca = o.tlsCAFile !== undefined ? readCredentialFile("tlsCAFile", o.tlsCAFile, true) : undefined;
    let username: string | undefined;
    let password: string | undefined;
    const auth = o.auth;
    if (auth !== undefined && "passwordFile" in auth) {
      username = auth.user;
      password = readCredentialFile("auth.passwordFile", auth.passwordFile);
    } else if (auth !== undefined) {
      const env = auth as RedisAuthFromEnv;
      password = process.env[env.password];
      username = env.username !== undefined ? process.env[env.username] : undefined;
      if (password === undefined || (env.username !== undefined && username === undefined)) {
        throw new RedisAdapterError("OPTIONS_INVALID", `options.auth names variables that are not set (${[env.username, env.password].filter(Boolean).join(", ")})`);
      }
    }
    this.resolved = { url, username, password, ca };
    return this.resolved;
  }

  private db(): Client {
    if (this.client === undefined) {
      const { url, username, password, ca } = this.resolve();
      const socket = url.startsWith("rediss://") ? { tls: true as const, ...(ca !== undefined ? { ca } : {}), connectTimeout: 10_000, reconnectStrategy: false as const } : { connectTimeout: 10_000, reconnectStrategy: false as const };
      this.client = createClient({
        url,
        ...(username !== undefined ? { username } : {}),
        ...(password !== undefined ? { password } : {}),
        socket,
      });
      this.client.on("error", () => {});
    }
    return this.client;
  }

  private async cmd(args: string[]): Promise<unknown> {
    return this.db().sendCommand(args);
  }

  async setup(): Promise<void> {
    const { url } = this.resolve();
    try {
      await this.db().connect();
      await this.cmd(["PING"]);
    } catch (e) {
      await this.closeClient();
      const message = e instanceof Error ? e.message : String(e);
      throw new RedisAdapterError("REDIS_UNREACHABLE", `the server at ${redact(url)} did not answer: ${message}`);
    }
  }

  private async closeClient(): Promise<void> {
    const c = this.client;
    this.client = undefined;
    if (c !== undefined && c.isOpen) await c.quit().catch(() => {});
  }

  async teardown(): Promise<void> {
    this.baseline = undefined;
    await this.closeClient();
  }

  // ── the snapshot ──────────────────────────────────────────────────────────

  private async keys(): Promise<string[]> {
    const out: string[] = [];
    let cursor = "0";
    do {
      const [next, batch] = (await this.cmd(["SCAN", cursor, "MATCH", `${this.prefix}*`, "COUNT", SCAN_COUNT])) as [string, string[]];
      cursor = next;
      out.push(...batch);
    } while (cursor !== "0");
    return [...new Set(out)].sort(byKey);
  }

  /** The state of one key, or undefined when it no longer exists. */
  private async state(full: string): Promise<KeyState | undefined> {
    const kind = String(await this.cmd(["TYPE", full]));
    switch (kind) {
      case "none":
        return undefined;
      case "string":
        return { kind, value: String(await this.cmd(["GET", full])) };
      case "set":
        return { kind, value: ((await this.cmd(["SMEMBERS", full])) as string[]).sort(byKey) };
      case "hash":
        return { kind, value: pairs(await this.cmd(["HGETALL", full])) };
      case "list":
        return { kind, value: (await this.cmd(["LRANGE", full, "0", "-1"])) as string[] };
      case "zset":
        return { kind, value: scored(await this.cmd(["ZRANGE", full, "0", "-1", "WITHSCORES"])) };
      default:
        throw new RedisAdapterError("KIND_UNSUPPORTED", `the key ${full.slice(this.prefix.length)} of the namespace holds a ${kind}; the adapter reads ${KINDS.join(", ")}`);
    }
  }

  private async snapshot(): Promise<Map<string, KeyState>> {
    const out = new Map<string, KeyState>();
    for (const full of await this.keys()) {
      const s = await this.state(full);
      if (s !== undefined) out.set(full.slice(this.prefix.length), s);
    }
    return out;
  }

  private record(type: string, key: string, s: KeyState, timestamp: number): CapturedRecord {
    return { type, key, payload: { kind: s.kind, value: s.value }, timestamp };
  }

  private diff(before: Map<string, KeyState>, after: Map<string, KeyState>): CapturedRecord[] {
    const timestamp = Date.now();
    const out: CapturedRecord[] = [];
    for (const key of [...new Set([...before.keys(), ...after.keys()])].sort(byKey)) {
      const was = before.get(key);
      const is = after.get(key);
      if (was === undefined && is !== undefined) out.push(this.record("INSERT", key, is, timestamp));
      else if (was !== undefined && is === undefined) out.push(this.record("REMOVE", key, was, timestamp));
      else if (was !== undefined && is !== undefined && stable(was) !== stable(is)) out.push(this.record("MODIFY", key, is, timestamp));
    }
    return out;
  }

  // ── the window ────────────────────────────────────────────────────────────

  async startCapture(): Promise<void> {
    this.baseline = await this.snapshot();
  }

  async peekCapture(): Promise<CapturedRecord[]> {
    if (this.baseline === undefined) return [];
    return this.diff(this.baseline, await this.snapshot());
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    if (this.baseline === undefined) return [];
    const records = this.diff(this.baseline, await this.snapshot());
    this.baseline = undefined;
    return records;
  }

  /**
   * True with a window open: Redis runs one command at a time and a command the system has had answered is applied
   * before any later command, the instrument's included. False with no window open.
   */
  async settle(): Promise<boolean> {
    return this.baseline !== undefined;
  }

  // ── state ─────────────────────────────────────────────────────────────────

  async read(query: ReadQuery): Promise<unknown | null> {
    const timestamp = Date.now();
    const named = query.expect?.map((e) => (typeof e.key?.key === "string" ? e.key.key : undefined));
    if (named !== undefined && named.length > 0 && named.every((k) => k !== undefined)) {
      this.lastReadVia = "KeyedLookup";
      const out: CapturedRecord[] = [];
      for (const key of named as string[]) {
        const s = await this.state(`${this.prefix}${key}`);
        if (s !== undefined) out.push(this.record(s.kind, key, s, timestamp));
      }
      return out;
    }
    this.lastReadVia = "NamespaceScan";
    return [...(await this.snapshot())].map(([k, s]) => this.record(s.kind, k, s, timestamp));
  }

  /** SeedRecord { type: one of the kinds, values: { key, value } }, written under the namespace before the window. */
  async seed(records: SeedRecord[]): Promise<void> {
    const commands: string[][] = [];
    for (const r of records) {
      const key = r.values.key;
      const value = r.values.value;
      if (typeof key !== "string" || key === "") throw new RedisAdapterError("SEED_INVALID", `a ${r.type} seed needs values.key, a non-empty string`);
      const full = `${this.prefix}${key}`;
      const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string");
      switch (r.type) {
        case "string":
          if (typeof value !== "string") throw new RedisAdapterError("SEED_INVALID", `the string seed ${key} needs values.value, a string`);
          commands.push(["SET", full, value]);
          break;
        case "set":
          if (!strings(value)) throw new RedisAdapterError("SEED_INVALID", `the set seed ${key} needs values.value, a non-empty array of strings`);
          commands.push(["SADD", full, ...value]);
          break;
        case "list":
          if (!strings(value)) throw new RedisAdapterError("SEED_INVALID", `the list seed ${key} needs values.value, a non-empty array of strings`);
          commands.push(["RPUSH", full, ...value]);
          break;
        case "hash": {
          const entries = value !== null && typeof value === "object" && !Array.isArray(value) ? Object.entries(value as Record<string, unknown>) : [];
          if (entries.length === 0 || entries.some(([, v]) => typeof v !== "string")) {
            throw new RedisAdapterError("SEED_INVALID", `the hash seed ${key} needs values.value, an object of string fields`);
          }
          commands.push(["HSET", full, ...entries.flatMap(([f, v]) => [f, v as string])]);
          break;
        }
        case "zset": {
          const members = Array.isArray(value) ? value : [];
          const ok = members.length > 0 && members.every((m) => m !== null && typeof m === "object" && typeof (m as { member?: unknown }).member === "string" && typeof (m as { score?: unknown }).score === "number");
          if (!ok) throw new RedisAdapterError("SEED_INVALID", `the zset seed ${key} needs values.value, a non-empty array of { member, score }`);
          commands.push(["ZADD", full, ...members.flatMap((m) => [String((m as { score: number }).score), (m as { member: string }).member])]);
          break;
        }
        default:
          throw new RedisAdapterError("SEED_INVALID", `the seed type '${r.type}' is not one of ${KINDS.join(", ")}`);
      }
    }
    if (commands.length === 0) return;
    const multi = this.db().multi();
    for (const c of commands) multi.addCommand(c);
    await multi.exec();
  }

  // ── faults ────────────────────────────────────────────────────────────────

  async fault(arm: FaultArm): Promise<void> {
    throw new RedisAdapterError("FAULT_UNSUPPORTED", `the fault '${arm.operation}.${arm.fault}' is not in the catalog (it is empty)`);
  }

  async reset(): Promise<void> {
    const keys = await this.keys();
    for (let i = 0; i < keys.length; i += 500) await this.cmd(["UNLINK", ...keys.slice(i, i + 500)]);
    this.baseline = undefined;
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new RedisAdapter(config as RedisConfig);
}
