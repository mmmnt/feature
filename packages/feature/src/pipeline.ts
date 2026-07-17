// The generate pipeline (CLI orchestrates, delegates — Pass 1 dependency rule):
// discover specs → parse (feat-core) → derive (feat-derive) → resolve schemas/goldens
// upfront (GAP-S10, CLI-mediated) → emit (feat-emit-ts). Used by `feat generate` (write)
// and `feat verify` (compare, byte-equality per ADR-0006).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { derive, type TestTopology } from "@mmmnt/feat-derive";
import { emit, EMITTER_VERSION } from "@mmmnt/feat-emit-ts";

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

function resolveContract(contractPath: string): { registry: Record<string, object>; text: string } {
  if (!existsSync(contractPath)) return { registry: {}, text: "" };
  const text = readFileSync(contractPath, "utf8");
  const doc = JSON.parse(text) as { schemas: Record<string, object> };
  const registry: Record<string, object> = {};
  for (const [name, schema] of Object.entries(doc.schemas)) {
    const ref = (schema as { $ref?: string }).$ref;
    if (ref && Object.keys(schema).length === 1) {
      const refPath = path.resolve(path.dirname(contractPath), ref);
      registry[name] = JSON.parse(readFileSync(refPath, "utf8")) as object;
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
    const { registry, text: contractText } = resolveContract(contractPath);
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
            ? { adapter: config.response.adapter, commands: config.response.commands, actors: config.response.actors }
            : undefined,
          services: config.services,
        } as object,
      },
      specPath: specRel,
      configPath: path.relative(specDir, configAbs),
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
