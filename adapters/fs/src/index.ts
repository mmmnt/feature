// @mmmnt/feat-adapter-fs — filesystem capture (acid). Records files created,
// modified, or deleted inside the configured scope during the capture window as
// FILE_WRITTEN / FILE_DELETED CapturedRecords. Options: { scope?: string } —
// directory relative to the project root (default "."). node_modules, dist,
// .turbo, .git and reports are always excluded.

import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { CapturedRecord, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";

const EXCLUDED = new Set(["node_modules", "dist", ".turbo", ".git", "coverage", "reports"]);

interface FsAdapterConfig {
  options?: { scope?: string };
  projectRoot?: string;
}

class FsAdapter implements FeatServiceAdapter {
  /** Two snapshots compared; read() reports no state (SPEC-ADPFS-001). */
  readonly observes = { diff: "snapshot", state: false } as const;
  private root: string;
  private before: Map<string, number> | null = null;

  constructor(config: FsAdapterConfig) {
    this.root = path.resolve(config.projectRoot ?? process.cwd(), config.options?.scope ?? ".");
  }

  private snapshot(): Map<string, number> {
    const out = new Map<string, number>();
    const walk = (d: string) => {
      let entries: string[];
      try {
        entries = readdirSync(d);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (EXCLUDED.has(entry)) continue;
        const p = path.join(d, entry);
        const s = statSync(p);
        if (s.isDirectory()) walk(p);
        else out.set(p, s.mtimeMs);
      }
    };
    walk(this.root);
    return out;
  }

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}
  async reset(): Promise<void> {
    this.before = null;
  }

  // The spec type (ADR-0011) is accepted: a snapshot diff is the same for every spec type.
  async startCapture(_context?: { specType?: string }): Promise<void> {
    this.before = this.snapshot();
  }

  /** The FILE_WRITTEN / FILE_DELETED records between `before` and a snapshot taken now. */
  private diff(before: Map<string, number>): CapturedRecord[] {
    const after = this.snapshot();
    const records: CapturedRecord[] = [];
    for (const [p, mtime] of after) {
      if (!before.has(p) || before.get(p) !== mtime) {
        records.push({
          type: "FILE_WRITTEN",
          key: path.relative(this.root, p),
          payload: { path: path.relative(this.root, p) },
          timestamp: mtime,
        });
      }
    }
    for (const p of before.keys()) {
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

  /** With no window open there is nothing to report (SPEC-ADPFS-001), never a diff against an empty baseline. */
  async stopCapture(): Promise<CapturedRecord[]> {
    if (this.before === null) return [];
    const records = this.diff(this.before);
    this.before = null;
    return records;
  }

  /** ADR-0020: what stopCapture would return now; the baseline stays. [] with no window open. */
  async peekCapture(): Promise<CapturedRecord[]> {
    return this.before === null ? [] : this.diff(this.before);
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
