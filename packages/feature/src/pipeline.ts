// The generate pipeline (CLI orchestrates, delegates — Pass 1 dependency rule):
// discover specs → parse (feat-core) → derive (feat-derive) → resolve schemas/goldens
// upfront (GAP-S10, CLI-mediated) → emit (feat-emit-ts). Used by `feat generate` (write)
// and `feat verify` (compare, byte-equality per ADR-0006).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { BuiltSpec, FeatConfig, FeatSchemaAdapter } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { derive, type TestTopology } from "@mmmnt/feat-derive";
import { emit, EMITTER_VERSION } from "@mmmnt/feat-emit-ts";
import { importAdapter } from "@mmmnt/feat-runtime";

// "fixtures" is excluded by convention: fixture .feat files are test vectors
// (e.g. the parser's bad-input corpus), not project specs.
const EXCLUDED_DIRS = new Set(["node_modules", "dist", ".turbo", ".git", "coverage", "reports", "fixtures"]);

export interface GeneratedFile {
  specPath: string;
  outputPath: string;
  content: string;
}

export function discoverSpecs(root: string, specsDir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const p = path.join(d, entry);
      const s = statSync(p);
      if (s.isDirectory()) walk(p);
      else if (entry.endsWith(".feat")) out.push(p);
    }
  };
  const base = path.resolve(root, specsDir);
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

export async function generateAll(root: string, configPath: string): Promise<GeneratedFile[]> {
  const configAbs = path.resolve(root, configPath);
  const config = JSON.parse(readFileSync(configAbs, "utf8")) as FeatConfig;
  const specs = discoverSpecs(root, config.specs.dir);
  // The project root is where the config lives — adapter resolution anchors there, so
  // generate behaves identically regardless of the invoking cwd (as the harness does).
  const schemaAdapter = await loadSchemaAdapter(config, path.dirname(configAbs));
  const results: GeneratedFile[] = [];

  for (const specAbs of specs) {
    const specRel = path.relative(root, specAbs);
    const parsed = await parse({ spec: specRel, config: configPath });
    if (parsed.status === "ERR")
      throw new Error(`Parse failed for ${specRel}: ${JSON.stringify(parsed.body)}`);
    const spec = parsed.body as unknown as BuiltSpec;

    const topology = derive(spec, config);
    const specDir = path.dirname(specAbs);

    // Seed fixtures inline at generate time (ADR-0003 fixture form; keeps derive pure
    // and generated tests self-contained per ADR-0001).
    for (const c of topology.cases) {
      if (!c.given?.seeds) continue;
      c.given.seeds = c.given.seeds.map((seed) => {
        if ("fixture" in seed) {
          const records = JSON.parse(
            readFileSync(path.resolve(specDir, seed.fixture), "utf8"),
          ) as { type: string; schemaName?: string; values: Record<string, unknown> }[];
          return { service: seed.service, records };
        }
        return seed;
      });
    }
    const baseName = path.basename(specAbs, ".feat");
    const contractPath = path.join(specDir, `${baseName}.contract.json`);
    const { registry, text: contractText } = await resolveContract(contractPath, schemaAdapter);
    const goldens = collectGoldens(topology, specDir);

    const content = emit({
      topology,
      schemas: registry,
      goldens,
      hashInputs: {
        specText: readFileSync(specAbs, "utf8"),
        contractText,
        configSlice: {
          featVersion: config.featVersion,
          response: config.response
            ? {
                adapter: config.response.adapter,
                commands: config.response.commands,
                actors: config.response.actors,
                // invoke feeds the emitted timing envelope, so it is derivation-relevant.
                invoke: config.response.invoke,
              }
            : undefined,
          services: config.services,
        } as object,
      },
      specPath: specRel,
      configPath: path.relative(specDir, configAbs),
      invokeTimeoutMs:
        typeof config.response?.invoke?.timeout === "number" ? config.response.invoke.timeout : undefined,
      emitterVersion: EMITTER_VERSION,
      featVersion: spec.featVersion,
    });

    const outputPath = path.join(
      specDir,
      config.specs.outputPattern.replace("{name}", baseName),
    );
    results.push({ specPath: specRel, outputPath, content });
  }
  return results;
}
