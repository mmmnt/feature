// The generate pipeline (CLI orchestrates, delegates — Pass 1 dependency rule):
// discover specs → parse (feat-core) → derive (feat-derive) → resolve schemas/goldens
// upfront (GAP-S10, CLI-mediated) → emit (feat-emit-ts). Used by `feat generate` (write)
// and `feat verify` (compare, byte-equality per ADR-0006).

import { readConfig } from "./config.js";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { BuiltSpec, FeatConfig, FeatSchemaAdapter } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { derive, type TestTopology } from "@mmmnt/feat-derive";
import { emit, timingEnvelope, EMITTER_VERSION } from "@mmmnt/feat-emit-ts";
import { importAdapter } from "@mmmnt/feat-runtime";
import { checkSeeds, formatSeedViolations, type SeedViolation } from "./seed-fixtures.js";

// "fixtures" is excluded by convention: fixture .feat files are test vectors
// (e.g. the parser's bad-input corpus), not project specs.
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "coverage", "reports", "fixtures"]);

export interface GeneratedFile {
  specPath: string;
  /** Every fault any scenario arms, as `Operation.Fault` — the runner sweeps these for exclusive ones (SPEC-RT-005). */
  faults: string[];
  outputPath: string;
  content: string;
}

/** A glob (`**`, `*`, `?`) over posix-style relative paths, as a RegExp. `**` crosses directories, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Spec files under `specsDir`, minus those a `specs.exclude` glob (relative to specsDir) removes (ADR-0024). */
export function discoverSpecs(root: string, specsDir: string, exclude: readonly string[] = []): string[] {
  const out: string[] = [];
  const base = path.resolve(root, specsDir);
  const excluded = exclude.map(globToRegExp);
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const p = path.join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.endsWith(".feat")) {
        const rel = path.relative(base, p).split(path.sep).join("/");
        if (!excluded.some((r) => r.test(rel))) out.push(p);
      }
    }
  };
  if (existsSync(base)) walk(base);
  return out.sort();
}

// The schema adapter is configuration, not a constant (INV-10): `schemas.adapter` names
// it and a project may supply its own — a draft-2020-12 resolver, a registry-backed one.
// Unset means the built-in JSON Schema adapter, so a config that predates the key still
// generates. It is loaded the same way every other adapter is (@mmmnt/feat-runtime).
const DEFAULT_SCHEMA_ADAPTER = "@mmmnt/feat-schema-json";

async function loadSchemaAdapter(config: FeatConfig, projectRoot: string): Promise<FeatSchemaAdapter> {
  const specifier = config.schemas?.adapter ?? DEFAULT_SCHEMA_ADAPTER;
  let mod;
  try {
    mod = await importAdapter(specifier, projectRoot);
  } catch (cause) {
    // Loudly, and never by falling back to reading the referenced file verbatim: that
    // read is the defect this path closes, and a silent fallback would reintroduce it
    // invisibly — generated tests carrying `$ref`s that resolve against nothing.
    throw new Error(
      `Schema adapter '${specifier}' (feat.config.json › schemas.adapter) could not be loaded: ` +
        `${(cause as Error).message}`,
      { cause },
    );
  }
  return mod.createAdapter({ ...config.schemas, projectRoot }) as FeatSchemaAdapter;
}

/** Walk a JSON pointer ("/a/b") inside a schema; false when it names nothing there. */
function pointerResolves(root: unknown, fragment: string): boolean {
  let cur: unknown = root;
  for (const token of fragment.split("/").slice(1)) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    cur = Array.isArray(cur) ? cur[Number(key)] : typeof cur === "object" && cur !== null ? (cur as Record<string, unknown>)[key] : undefined;
    if (cur === undefined) return false;
  }
  return true;
}

/**
 * True when an inline schema holds a `$ref` that will not resolve once the schema stands alone in
 * a generated test: one naming another file, or a local pointer that is not inside the schema
 * itself (so it names the contract document, e.g. `#/schemas/Sibling`). Absolute URIs are left alone.
 */
function needsBundling(schema: unknown): boolean {
  const walk = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(walk);
    if (typeof node !== "object" || node === null) return false;
    for (const [k, v] of Object.entries(node)) {
      if (k === "$ref" && typeof v === "string") {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(v)) continue;
        if (!v.startsWith("#")) return true;
        if (v !== "#" && !pointerResolves(schema, v.slice(1))) return true;
      } else if (walk(v)) return true;
    }
    return false;
  };
  return walk(schema);
}

// A contract entry that is nothing but a `$ref` names a schema living in another file.
// Resolution belongs to the adapter: what it returns as `normalized` is what gets inlined,
// so it must already be self-contained (the generated test lands in a different directory
// and nothing resolves at run time). Entries authored inline are already where they belong.
async function resolveContract(
  contractPath: string,
  adapter: FeatSchemaAdapter,
): Promise<{ registry: Record<string, object>; text: string }> {
  if (!existsSync(contractPath)) return { registry: {}, text: "" };
  const text = readFileSync(contractPath, "utf8");
  const doc = JSON.parse(text) as { schemas: Record<string, object> };
  const registry: Record<string, object> = {};
  for (const [name, schema] of Object.entries(doc.schemas)) {
    const ref = (schema as { $ref?: string }).$ref;
    if (ref && Object.keys(schema).length === 1) {
      registry[name] = (await adapter.resolve(ref, contractPath)).normalized;
    } else if (needsBundling(schema)) {
      // An inline schema whose nested properties `$ref` another file, or a sibling entry of this
      // contract: the base URI is lost in the move exactly as for a bare ref, so it is bundled too. Schemas with no file
      // reference are kept verbatim — generated output for them is unchanged.
      registry[name] = (
        adapter.resolveInline
          ? await adapter.resolveInline(schema as Record<string, unknown>, contractPath)
          : await adapter.resolve(`#/schemas/${name}`, contractPath)
      ).normalized;
    } else {
      registry[name] = schema;
    }
  }
  return { registry, text };
}

function collectGoldens(topology: TestTopology, specDir: string): Record<string, unknown> {
  const goldens: Record<string, unknown> = {};
  const add = (p?: string) => {
    if (p && goldens[p] === undefined)
      goldens[p] = JSON.parse(readFileSync(path.resolve(specDir, p), "utf8"));
  };
  for (const c of topology.cases) {
    add(c.prediction.response?.golden);
    for (const svc of Object.values(c.prediction.services)) {
      for (const r of svc.records ?? []) add(r.golden);
      for (const r of svc.contains ?? []) add(r.golden);
    }
  }
  return goldens;
}

export interface PreparedSpec {
  specAbs: string;
  specRel: string;
  spec: BuiltSpec;
  topology: TestTopology;
  specDir: string;
  registry: Record<string, object>;
  contractText: string;
}

export interface Prepared {
  config: FeatConfig;
  configAbs: string;
  specs: PreparedSpec[];
  /** SPEC-GEN-001: every seed violation across every spec, in spec → scenario → seed → record order. */
  violations: SeedViolation[];
  fixtures: number;
  records: number;
  recordTypes: string[];
}

// Parse, derive and resolve every spec, checking and inlining its seeds (SPEC-GEN-001).
// Writes nothing; a seed violation is collected, never thrown, so all are reported together.
export async function prepareAll(root: string, configPath: string): Promise<Prepared> {
  const configAbs = path.resolve(root, configPath);
  const config = await readConfig(root, configPath);
  const specs = discoverSpecs(root, config.specs.dir, config.specs.exclude);
  // The project root is where the config lives — adapter resolution anchors there, so
  // generate behaves identically regardless of the invoking cwd (as the harness does).
  const schemaAdapter = await loadSchemaAdapter(config, path.dirname(configAbs));
  const out: Prepared = { config, configAbs, specs: [], violations: [], fixtures: 0, records: 0, recordTypes: [] };

  for (const specAbs of specs) {
    const specRel = path.relative(root, specAbs);
    const parsed = await parse({ spec: specAbs, config: configAbs });
    if (parsed.status === "ERR")
      throw new Error(`Parse failed for ${specRel}: ${JSON.stringify(parsed.body)}`);
    const spec = parsed.body as unknown as BuiltSpec;

    const topology = derive(spec, config);
    const specDir = path.dirname(specAbs);
    const baseName = path.basename(specAbs, ".feat");
    const contractPath = path.join(specDir, `${baseName}.contract.json`);
    const { registry, text: contractText } = await resolveContract(contractPath, schemaAdapter);

    // Seeds are checked, and fixture seeds inlined, at generate time (ADR-0003 fixture form;
    // SPEC-GEN-001): derive stays pure and generated tests stay self-contained per ADR-0001.
    const seedCheck = checkSeeds(topology, specDir, registry, schemaAdapter);
    out.violations.push(...seedCheck.violations);
    out.fixtures += seedCheck.fixtures;
    out.records += seedCheck.records;
    out.recordTypes.push(...seedCheck.recordTypes);
    out.specs.push({ specAbs, specRel, spec, topology, specDir, registry, contractText });
  }
  return out;
}

/** The runner's timeouts for this run: the worst derived case under the ACTIVE config (ADR-0024). */
export function runTimeouts(prepared: Prepared): { testTimeoutMs: number; hookTimeoutMs: number } {
  return timingEnvelope(prepared.specs.flatMap((sp) => sp.topology.cases), prepared.config);
}

export async function generateAll(
  root: string,
  configPath: string,
  opts: { onPrepared?: (prepared: Prepared) => void } = {},
): Promise<GeneratedFile[]> {
  const prepared = await prepareAll(root, configPath);
  opts.onPrepared?.(prepared);
  if (prepared.violations.length > 0)
    throw new Error(
      `${prepared.violations.length} seed violation(s); nothing was generated:\n${formatSeedViolations(prepared.violations)}`,
    );
  const { config, configAbs } = prepared;
  // A tier overlay embeds its base's path, so the file is the same whichever tier generated it (ADR-0024).
  const baseConfigAbs = config.extends ? path.resolve(path.dirname(configAbs), config.extends) : configAbs;
  const results: GeneratedFile[] = [];

  for (const { specAbs, specRel, spec, topology, specDir, registry, contractText } of prepared.specs) {
    const goldens = collectGoldens(topology, specDir);

    const content = emit({
      topology,
      schemas: registry,
      goldens,
      hashInputs: {
        specText: readFileSync(specAbs, "utf8"),
        contractText,
        // ADR-0024: only what could change the parse or the derived structure — the three closed
        // reference spaces and the language version. Adapters, consistency, timeouts and options
        // never enter the hash, so a generated file is byte-identical in every tier.
        configSlice: {
          featVersion: config.featVersion,
          commands: Object.keys(config.response?.commands ?? {}).sort(),
          actors: Object.keys(config.response?.actors ?? {}).filter((k) => k !== "default").sort(),
          services: Object.keys(config.services).sort(),
        } as object,
      },
      specPath: specRel,
      namespacePath: path.relative(path.dirname(baseConfigAbs), specAbs).split(path.sep).join("/"),
      // The path embedded is the BASE's (the tier-independent one); FEAT_CONFIG names the active tier at run time.
      configPath: path.relative(specDir, baseConfigAbs),
      emitterVersion: EMITTER_VERSION,
      featVersion: spec.featVersion,
    });

    const outputPath = path.join(
      specDir,
      config.specs.outputPattern.replace("{name}", path.basename(specAbs, ".feat")),
    );
    const faults = [...new Set(topology.cases.flatMap((c) => (c.given?.faults ?? []).map((f) => `${f.operation}.${f.fault}`)))].sort();
    results.push({ specPath: specRel, faults, outputPath, content });
  }
  return results;
}
