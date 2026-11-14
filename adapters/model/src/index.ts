// @mmmnt/feat-adapter-model — a recorded judge for a judgment port (SPEC-ADPMODEL-001, ADR-0028).
//
// The port's records live in one JSON Lines file per namespace, <dir>/<namespace>.jsonl. The spec seeds the answers
// the judge gives (the adapter appends them); the system under test reads them from the file and appends its asks.
// The capture window is the complete lines appended after startCapture. Nothing goes over a network and no model is
// ever called: this module imports node:fs, node:path and @mmmnt/feat-types only.

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CapturedRecord, FeatServiceAdapter, ReadQuery, SeedRecord } from "@mmmnt/feat-types";

export type ModelAdapterErrorCode = "OPTIONS_INVALID" | "NAMESPACE_INVALID" | "RECORD_MALFORMED";

export class ModelAdapterError extends Error {
  constructor(
    readonly code: ModelAdapterErrorCode,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "ModelAdapterError";
  }
}

export interface ModelAdapterOptions {
  /** The directory holding the record files, absolute or relative to the project root. */
  dir: string;
}

interface ModelAdapterConfig {
  namespace?: unknown;
  projectRoot?: string;
  options?: unknown;
}

const NAMESPACE_PATTERN = /^s[0-9a-f]{12}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkOptions(options: unknown): ModelAdapterOptions {
  if (!isObject(options)) throw new ModelAdapterError("OPTIONS_INVALID", "options must be an object { dir }");
  const extra = Object.keys(options).filter((key) => key !== "dir");
  if (extra.length > 0) throw new ModelAdapterError("OPTIONS_INVALID", `unknown option(s) ${extra.join(", ")}: the only option is dir`);
  if (typeof options.dir !== "string" || options.dir.length === 0)
    throw new ModelAdapterError("OPTIONS_INVALID", "options.dir must be a non-empty string, the directory holding the record files");
  return { dir: options.dir };
}

class ModelAdapter implements FeatServiceAdapter {
  readonly observes = { diff: "native", state: true } as const;

  private readonly namespace: string;
  /** The record file, <dir>/<namespace>.jsonl. */
  readonly file: string;
  /** Complete lines the file held when the window opened; null with no window open. */
  private windowFrom: number | null = null;

  constructor(config: ModelAdapterConfig) {
    const options = checkOptions(config.options);
    const ns = config.namespace;
    if (typeof ns !== "string" || !NAMESPACE_PATTERN.test(ns))
      throw new ModelAdapterError(
        "NAMESPACE_INVALID",
        `${ns === undefined ? "no namespace" : `'${String(ns)}'`} does not match ${NAMESPACE_PATTERN.source}, the pattern the runner derives`,
      );
    this.namespace = ns;
    const dir = path.resolve(config.projectRoot ?? process.cwd(), options.dir);
    this.file = path.join(dir, `${ns}.jsonl`);
  }

  reportedNamespace(): string {
    return this.namespace;
  }

  async setup(): Promise<void> {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, "");
  }

  async teardown(): Promise<void> {
    this.windowFrom = null;
    rmSync(this.file, { force: true });
  }

  async reset(): Promise<void> {
    this.windowFrom = null;
    writeFileSync(this.file, "");
  }

  async seed(records: SeedRecord[]): Promise<void> {
    const lines = records.map((r) => `${JSON.stringify({ type: r.type, payload: r.values })}\n`).join("");
    if (lines.length > 0) appendFileSync(this.file, lines);
  }

  /** The complete lines of the file: a last line without its LF is a write in progress. */
  private lines(): string[] {
    let text: string;
    try {
      text = readFileSync(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const end = text.lastIndexOf("\n");
    return end < 0 ? [] : text.slice(0, end).split("\n");
  }

  private record(line: string, number: number): CapturedRecord {
    const where = `${path.basename(this.file)} line ${number}`;
    let value: unknown;
    try {
      value = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
    } catch {
      throw new ModelAdapterError("RECORD_MALFORMED", `${where} (${this.file}) is not JSON`);
    }
    if (!isObject(value) || typeof value.type !== "string" || value.type.length === 0 || !isObject(value.payload))
      throw new ModelAdapterError("RECORD_MALFORMED", `${where} (${this.file}) is not a record { type, payload }`);
    if (value.key !== undefined && typeof value.key !== "string")
      throw new ModelAdapterError("RECORD_MALFORMED", `${where} (${this.file}): key must be a string`);
    if (value.timestamp !== undefined && typeof value.timestamp !== "number")
      throw new ModelAdapterError("RECORD_MALFORMED", `${where} (${this.file}): timestamp must be a number`);
    if (value.metadata !== undefined && !isObject(value.metadata))
      throw new ModelAdapterError("RECORD_MALFORMED", `${where} (${this.file}): metadata must be an object`);
    return {
      type: value.type,
      key: value.key ?? String(number),
      payload: value.payload,
      timestamp: value.timestamp ?? number,
      ...(value.metadata !== undefined ? { metadata: value.metadata } : {}),
    };
  }

  private records(from: number): CapturedRecord[] {
    return this.lines()
      .map((line, i) => ({ line, number: i + 1 }))
      .slice(from)
      .map(({ line, number }) => this.record(line, number));
  }

  async startCapture(_context?: { specType?: string }): Promise<void> {
    this.windowFrom = this.lines().length;
  }

  async stopCapture(): Promise<CapturedRecord[]> {
    const from = this.windowFrom;
    this.windowFrom = null;
    return from === null ? [] : this.records(from);
  }

  async peekCapture(): Promise<CapturedRecord[]> {
    return this.windowFrom === null ? [] : this.records(this.windowFrom);
  }

  /**
   * Every capture reads the file when it is called, so whatever the system has already written (its line complete)
   * is visible to stopCapture: true with a window open, false without one (nothing to vouch for).
   */
  async settle(): Promise<boolean> {
    return this.windowFrom !== null;
  }

  async read(_query?: ReadQuery): Promise<CapturedRecord[]> {
    return this.records(0);
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new ModelAdapter(config as ModelAdapterConfig);
}
