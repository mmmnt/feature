// SPEC-GEN-001 — seed records are checked when `feat generate` inlines them.
// Fixture form (`seed <svc> from "<path>"`, ADR-0003): resolved against the spec's directory, read,
// shape-checked, every schemaName checked against the contract's closed space (ADR-0007), values
// validated through the configured schema adapter, then inlined in file order. Inline records
// (`seed <svc> [ T with S {..} ]`) get the same values check. Every violation is collected.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { CapturedResponse } from "@mmmnt/feat-core";
import { resolveVariables, substituteVariables, type CaseVariable } from "@mmmnt/feat-runtime";
import type { TestTopology } from "@mmmnt/feat-derive";
import type { FeatSchemaAdapter, Seed, SeedRecord } from "@mmmnt/feat-types";

export type SeedViolationCode =
  | "SEED_FIXTURE_NOT_FOUND"
  | "SEED_FIXTURE_NOT_JSON"
  | "SEED_FIXTURE_NOT_RECORDS"
  | "SEED_FIXTURE_SCHEMA_UNDECLARED"
  | "SEED_FIXTURE_VALUES_INVALID"
  | "SEED_VALUES_INVALID"
  | "SEED_ROW_VALUES_INVALID";

export interface SeedViolation {
  code: SeedViolationCode;
  detail: string;
}

export interface SeedCheck {
  violations: SeedViolation[];
  fixtures: number;
  records: number;
  recordTypes: string[];
  skipped: string[];
}

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const esc = (k: string) => k.replace(/~/g, "~0").replace(/\//g, "~1");

// The variables of a case whose value is static at generate time (SPEC-GEN-001): a number, a template of static
// variables, now()/iso() under `clock at`. unique(), and now()/iso() with no clock, have no value until run time.
function staticTable(vars: CaseVariable[] | undefined, clock: string | undefined): { table: CaseVariable[]; nonStatic: Set<string> } {
  const byName = new Map((vars ?? []).map((v) => [v.name, v]));
  const memo = new Map<string, boolean>();
  const isStatic = (n: string): boolean => {
    if (memo.has(n)) return memo.get(n)!;
    const v = byName.get(n)!;
    const d = v.definition;
    const r = d.kind === "number" ? true : d.kind === "call" ? d.fn !== "unique" && clock !== undefined
      : d.parts.every((p) => typeof p === "string" || isStatic(p.ref));
    memo.set(n, r);
    return r;
  };
  const table = (vars ?? []).filter((v) => isStatic(v.name));
  return { table, nonStatic: new Set((vars ?? []).filter((v) => !isStatic(v.name)).map((v) => v.name)) };
}

// The JSON pointers of the string leaves that still hold a non-static reference after substitution.
function skippedPointers(v: unknown, nonStatic: Set<string>, at = ""): string[] {
  if (typeof v === "string") {
    return [...v.matchAll(REF)].some((m) => nonStatic.has(m[1]!)) ? [at] : [];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => skippedPointers(x, nonStatic, `${at}/${i}`));
  if (v !== null && typeof v === "object")
    return Object.entries(v).flatMap(([k, x]) => skippedPointers(x, nonStatic, `${at}/${esc(k)}`));
  return [];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Why a record is not a { type, schemaName?, values } record; undefined when it is one.
function recordShapeProblem(r: unknown): string | undefined {
  if (!isObject(r)) return "is not an object";
  if (typeof r.type !== "string" || r.type === "") return "has no string 'type'";
  if (r.schemaName !== undefined && (typeof r.schemaName !== "string" || r.schemaName === ""))
    return "has a 'schemaName' that is not a non-empty string";
  if (!isObject(r.values)) return "has no object 'values'";
  return undefined;
}

function valuesProblem(
  rec: SeedRecord,
  registry: Record<string, object>,
  adapter: FeatSchemaAdapter,
  ctx?: { resolved: Record<string, string | number>; nonStatic: Set<string>; anchor: string; skipped: string[] },
): string | undefined {
  const schema = registry[rec.schemaName as string];
  let values: unknown = rec.values;
  let skip: string[] = [];
  if (ctx) {
    values = substituteVariables(rec.values, ctx.resolved);
    skip = skippedPointers(values, ctx.nonStatic);
    for (const p of skip) ctx.skipped.push(`${ctx.anchor} › ${p}`);
  }
  const res = adapter.validate(values, {
    id: rec.schemaName as string,
    format: "json-schema",
    raw: schema,
    normalized: schema as Record<string, unknown>,
  });
  const errors = (res.errors ?? []).filter((e) => !skip.some((p) => e.startsWith(`${p} `) || e.startsWith(`${p}/`)));
  return res.valid || errors.length === 0 ? undefined : `values fail schema '${rec.schemaName}': ${errors.join("; ")}`;
}

/**
 * Check every seed of a spec's topology and replace each fixture seed by its checked records.
 * An outline row holds its own substituted seeds (SPEC-DRV-001) and is checked on its own; a fixture seed,
 * which derive carries into every row as the same object, is read, checked and counted once.
 */
export function checkSeeds(
  topology: TestTopology,
  specDir: string,
  registry: Record<string, object>,
  adapter: FeatSchemaAdapter,
): SeedCheck {
  const out: SeedCheck = { violations: [], fixtures: 0, records: 0, recordTypes: [], skipped: [] };
  const fixtures = new Map<Seed, Seed>();
  let fxCtx: ((anchor: string) => Parameters<typeof valuesProblem>[3]) | undefined;
  const violate = (code: SeedViolationCode, detail: string) => out.violations.push({ code, detail });

  // Read, check and count one fixture seed; a refused fixture stays as written.
  const checkFixture = (seed: Extract<Seed, { fixture: string }>): Seed => {
    out.fixtures++;
    const where = seed.fixture;
    const file = path.resolve(specDir, seed.fixture);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      violate("SEED_FIXTURE_NOT_FOUND", `${where}: cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
      return seed;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (e) {
      violate("SEED_FIXTURE_NOT_JSON", `${where}: not valid JSON (${(e as Error).message})`);
      return seed;
    }
    if (!Array.isArray(json)) {
      violate("SEED_FIXTURE_NOT_RECORDS", `${where}: not an array of { type, schemaName?, values } records`);
      return seed;
    }
    const records: SeedRecord[] = [];
    let ok = true;
    json.forEach((r: unknown, j) => {
      const shape = recordShapeProblem(r);
      if (shape) {
        ok = false;
        violate("SEED_FIXTURE_NOT_RECORDS", `${where} record ${j}: ${shape} (expected { type, schemaName?, values })`);
        return;
      }
      const rec = r as SeedRecord;
      out.records++;
      out.recordTypes.push(rec.type);
      if (rec.schemaName !== undefined) {
        if (registry[rec.schemaName] === undefined) {
          ok = false;
          violate(
            "SEED_FIXTURE_SCHEMA_UNDECLARED",
            `${where} record ${j}: schema '${rec.schemaName}' is not declared in the contract (declared: ${Object.keys(registry).join(", ")})`,
          );
          return;
        }
        const problem = valuesProblem(rec, registry, adapter, fxCtx?.(`${where} record ${j}`));
        if (problem) {
          ok = false;
          violate("SEED_FIXTURE_VALUES_INVALID", `${where} record ${j}: ${problem}`);
          return;
        }
      }
      records.push(rec);
    });
    return ok ? { service: seed.service, records } : seed;
  };

  for (const c of topology.cases) {
    const seeds = c.given?.seeds;
    if (!seeds) continue;
    const row = / › row\[(\d+)\]$/.exec(c.name)?.[1];
    const scenario = c.name.replace(/ › row\[\d+\]$/, "");
    const st = staticTable(c.variables as CaseVariable[] | undefined, c.given?.clock);
    const resolved = st.table.length > 0 ? resolveVariables(st.table, c.given?.clock) : {};
    const withVars = (anchor: string) => (c.variables && c.variables.length > 0 ? { resolved, nonStatic: st.nonStatic, anchor, skipped: out.skipped } : undefined);
    fxCtx = withVars;
    const checked = seeds.map((seed, i): Seed => {
      if (!("fixture" in seed)) {
        seed.records.forEach((rec, j) => {
          out.records++;
          out.recordTypes.push(rec.type);
          const problem = rec.schemaName === undefined ? undefined : registry[rec.schemaName] === undefined
            ? undefined // undeclared inline names are the parser's UNDECLARED_SCHEMA, never reached here
            : valuesProblem(rec, registry, adapter, withVars(`scenario "${scenario}" given › seed[${i}] record ${j}${row !== undefined ? ` › row[${row}]` : ""}`));
          if (problem && row !== undefined)
            violate("SEED_ROW_VALUES_INVALID", `scenario "${scenario}" given › seed[${i}] record ${j} › row[${row}]: ${problem}`);
          else if (problem) violate("SEED_VALUES_INVALID", `scenario "${scenario}" given › seed[${i}] record ${j}: ${problem}`);
        });
        return seed;
      }
      const prior = fixtures.get(seed);
      if (prior) return prior;
      const result = checkFixture(seed);
      fixtures.set(seed, result);
      return result;
    });
    c.given!.seeds = checked;
  }
  return out;
}

export function formatSeedViolations(v: SeedViolation[]): string {
  return v.map((x) => `${x.code}: ${x.detail}`).join("\n");
}

/** The SPEC-GEN-001 command: check and inline every seed of every spec under the config's specs.dir. */
export async function inlineSeedFixtures(input: { config: string }): Promise<CapturedResponse> {
  // Dynamic: pipeline.ts imports this module, and the module graph must stay acyclic at load time.
  const { prepareAll } = await import("./pipeline.js");
  const configAbs = path.resolve(process.cwd(), input.config);
  const prepared = await prepareAll(path.dirname(configAbs), path.basename(configAbs));
  const unresolved = prepared.specs.reduce(
    (n, s) => n + s.topology.cases.reduce((m, c) => m + (c.given?.seeds ?? []).filter((x) => "fixture" in x).length, 0),
    0,
  );
  if (prepared.violations.length > 0)
    return {
      status: "ERR",
      body: {
        code: prepared.violations[0]!.code,
        count: prepared.violations.length,
        detail: formatSeedViolations(prepared.violations),
      },
    };
  return {
    status: "OK",
    body: {
      specs: prepared.specs.length,
      fixtures: prepared.fixtures,
      records: prepared.records,
      skipped: prepared.skipped,
      unresolved,
      recordTypes: prepared.recordTypes,
    },
  };
}
