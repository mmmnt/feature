// @mmmnt/feat-adapter-fs — filesystem capture (acid). Records files created,
// modified, or deleted inside the configured scope during the capture window as
// FILE_WRITTEN / FILE_DELETED CapturedRecords. Options: { scope?: string } —
// directory relative to the project root (default "."). node_modules, dist,
// .turbo, .git and reports are always excluded. SPEC-ADPFS-002 adds
// { archives?: string[] } (a written archive matching a glob is reported with its
// members) and { clearOnReset?: boolean } (reset empties the scope).

import { readFile, readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { CapturedRecord, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";
import { readArchive } from "./archive.js";

const EXCLUDED = new Set(["node_modules", "dist", ".turbo", ".git", "coverage", "reports"]);

interface FsAdapterConfig {
  options?: { scope?: string; archives?: unknown; clearOnReset?: unknown };
  projectRoot?: string;
}

/** A refusal of SPEC-ADPFS-002: an Error carrying its code. */
export class FsAdapterError extends Error {
  constructor(
    readonly code: "OPTIONS_INVALID" | "CLEAR_SCOPE_UNSAFE" | "CLEAR_FAILED",
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "FsAdapterError";
  }
}

class FsAdapter implements FeatServiceAdapter {
  /** Two snapshots compared; read() reports no state (SPEC-ADPFS-001). */
  readonly observes = { diff: "snapshot", state: false } as const;
  private root: string;
  private projectRoot: string;
  private options: FsAdapterConfig["options"];
  private archives: string[] = [];
  private clearOnReset = false;
  private before: Map<string, number> | null = null;

  constructor(config: FsAdapterConfig) {
    this.projectRoot = path.resolve(config.projectRoot ?? process.cwd());
    this.root = path.resolve(this.projectRoot, config.options?.scope ?? ".");
    this.options = config.options;
  }

  /**
   * Every file under the scope with its mtime. The walk is asynchronous: the harness awaits a capture window case
   * after case, and a synchronous walk never let a suite's event loop turn between them; on a slow filesystem (a
   * container's bind mount) a vitest worker went 70 s without a turn and missed vitest's RPC timeout. An entry gone
   * between the listing and its stat is not in this snapshot, as if it had been listed after it went.
   */
  private async snapshot(): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const walk = async (d: string): Promise<void> => {
      let entries: string[];
      try {
        entries = await readdir(d);
      } catch {
        return;
      }
      await Promise.all(
        entries
          .filter((entry) => !EXCLUDED.has(entry))
          .map(async (entry) => {
            const p = path.join(d, entry);
            let s: Awaited<ReturnType<typeof stat>>;
            try {
              s = await stat(p);
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
              throw e;
            }
            if (s.isDirectory()) await walk(p);
            else out.set(p, s.mtimeMs);
          }),
      );
    };
    await walk(this.root);
    return out;
  }

  /** SPEC-ADPFS-002: the options are checked before any case; clearOnReset only on a scope strictly inside the root. */
  async setup(): Promise<void> {
    const { archives, clearOnReset } = this.options ?? {};
    if (archives !== undefined) {
      if (!Array.isArray(archives) || archives.some((g) => typeof g !== "string" || g === ""))
        throw new FsAdapterError("OPTIONS_INVALID", `options.archives must be an array of non-empty glob strings, got ${JSON.stringify(archives)}.`);
      this.archives = archives as string[];
    }
    if (clearOnReset !== undefined) {
      if (typeof clearOnReset !== "boolean")
        throw new FsAdapterError("OPTIONS_INVALID", `options.clearOnReset must be a boolean, got ${JSON.stringify(clearOnReset)}.`);
      this.clearOnReset = clearOnReset;
    }
    if (this.clearOnReset) {
      const rel = path.relative(this.projectRoot, this.root);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel))
        throw new FsAdapterError(
          "CLEAR_SCOPE_UNSAFE",
          `clearOnReset empties the scope, and scope '${this.options?.scope ?? "."}' resolves to ${this.root}, which is not strictly inside the project root ${this.projectRoot}.`,
        );
    }
  }
  async teardown(): Promise<void> {}
  async reset(): Promise<void> {
    this.before = null;
    if (this.clearOnReset) await this.clear();
  }

  /** Remove everything under the scope but the scope itself and the names the snapshot never descends into. */
  private async clear(): Promise<void> {
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(this.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new FsAdapterError("CLEAR_FAILED", `cannot read the scope ${this.root}: ${(e as Error).message}`);
    }
    if (!s.isDirectory()) throw new FsAdapterError("CLEAR_FAILED", `the scope ${this.root} is not a directory.`);
    const walk = async (d: string): Promise<void> => {
      for (const entry of await readdir(d, { withFileTypes: true })) {
        if (EXCLUDED.has(entry.name)) continue;
        const p = path.join(d, entry.name);
        try {
          if (entry.isDirectory()) {
            await walk(p);
            // A directory that still holds an excluded name is kept.
            if ((await readdir(p)).length === 0) await rmdir(p);
          } else await rm(p, { force: true });
        } catch (e) {
          if (e instanceof FsAdapterError) throw e;
          throw new FsAdapterError("CLEAR_FAILED", `cannot remove ${p}: ${(e as Error).message}`);
        }
      }
    };
    await walk(this.root);
  }

  // The spec type (ADR-0011) is accepted: a snapshot diff is the same for every spec type.
  async startCapture(_context?: { specType?: string }): Promise<void> {
    this.before = await this.snapshot();
  }

  /** The FILE_WRITTEN / FILE_DELETED records between `before` and a snapshot taken now. */
  private async diff(before: Map<string, number>): Promise<CapturedRecord[]> {
    const after = await this.snapshot();
    const records: CapturedRecord[] = [];
    // Path order (SPEC-ADPFS-002): the walk is concurrent, so the snapshot's insertion order is the order its stats
    // happened to finish in; an acid service's records are compared in order, so the order is made the paths'.
    for (const [p, mtime] of [...after].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!before.has(p) || before.get(p) !== mtime) {
        records.push(await this.written(p, path.relative(this.root, p), mtime));
      }
    }
    for (const p of [...before.keys()].sort()) {
      if (!after.has(p)) {
        records.push({
          type: "FILE_DELETED",
          key: path.relative(this.root, p),
          payload: { path: path.relative(this.root, p) },
          timestamp: 0,
        });
      }
    }
    return records;
  }

  /** A written file: with its members when it matches an `archives` glob (SPEC-ADPFS-002), else `{ path }`. */
  private async written(abs: string, rel: string, mtime: number): Promise<CapturedRecord> {
    const posix = rel.split(path.sep).join("/");
    if (!this.archives.some((g) => path.posix.matchesGlob(posix, g)))
      return { type: "FILE_WRITTEN", key: rel, payload: { path: rel }, timestamp: mtime };
    let bytes: Buffer;
    try {
      bytes = await readFile(abs);
    } catch {
      return { type: "ARCHIVE_UNREADABLE", key: rel, payload: { path: rel, reason: "zstd" }, timestamp: mtime };
    }
    const reading = readArchive(bytes);
    if (reading.ok) return { type: "FILE_WRITTEN", key: rel, payload: { path: rel, members: reading.members }, timestamp: mtime };
    const payload: Record<string, unknown> = { path: rel, reason: reading.reason };
    if (reading.member !== undefined) payload.member = reading.member;
    return { type: "ARCHIVE_UNREADABLE", key: rel, payload, timestamp: mtime };
  }

  /** With no window open there is nothing to report (SPEC-ADPFS-001), never a diff against an empty baseline. */
  async stopCapture(): Promise<CapturedRecord[]> {
    if (this.before === null) return [];
    const records = await this.diff(this.before);
    this.before = null;
    return records;
  }

  /** ADR-0020: what stopCapture would return now; the baseline stays. [] with no window open. */
  async peekCapture(): Promise<CapturedRecord[]> {
    return this.before === null ? [] : await this.diff(this.before);
  }

  /**
   * ADR-0021: always false. A rewrite inside the filesystem's timestamp granularity leaves the mtime
   * unchanged, so the snapshot diff cannot prove every write is visible; the harness keeps its ceiling.
   */
  async settle(): Promise<boolean> {
    return false;
  }

  async read(): Promise<unknown | null> {
    return null;
  }

  async seed(_records: SeedRecord[]): Promise<void> {
    throw new Error("@mmmnt/feat-adapter-fs does not support seeding — configuration error.");
  }
}

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  return new FsAdapter(config as FsAdapterConfig);
}
