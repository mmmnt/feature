// `feat run --shard i/n` — a deterministic, disjoint slice of the generated files.
//
// Sharding is how a suite whose services share one store runs in parallel: N jobs, each with its
// OWN instruments, each running one slice. The slice depends only on the file set (sorted, then
// taken round-robin), so every job computes the same partition with no coordination.

export interface Shard {
  index: number; // 1-based
  total: number;
}

export function parseShard(value: string): Shard {
  const m = /^(\d+)\/(\d+)$/.exec(value.trim());
  const index = m ? Number(m[1]) : NaN;
  const total = m ? Number(m[2]) : NaN;
  if (!m || total < 1 || index < 1 || index > total) {
    throw new Error(`--shard must be i/n with 1 ≤ i ≤ n (got '${value}')`);
  }
  return { index, total };
}

export function selectShard(files: readonly string[], shard: Shard): string[] {
  return [...files].sort().filter((_, i) => i % shard.total === shard.index - 1);
}

/** `feat-junit.xml` → `feat-junit.shard-2-of-4.xml`, so parallel shards never share evidence. */
export function shardJunitPath(junit: string, shard: Shard | undefined): string {
  if (!shard) return junit;
  const dot = junit.lastIndexOf(".");
  const base = dot > junit.lastIndexOf("/") ? junit.slice(0, dot) : junit;
  const ext = dot > junit.lastIndexOf("/") ? junit.slice(dot) : "";
  return `${base}.shard-${shard.index}-of-${shard.total}${ext}`;
}
