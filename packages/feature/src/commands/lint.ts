// `feat lint` — language-quality rules beyond audit's buildability gate:
// declared-but-unused schemas (ADR-0007 WARN), empty scenario sets per rejection,
// draft-status surfacing. Exit 1 only on ERROR-level findings (currently none
// beyond parse failures — the B-rules live in `feat audit`).

import { readFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { discoverSpecs } from "../pipeline.js";

export default class Lint extends Command {
  static override description = "Lint all specs: unused declarations, style, lifecycle surfacing";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Lint);
    const root = process.cwd();
    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;
    const specs = discoverSpecs(root, config.specs.dir);
    let errors = 0;
    let warnings = 0;

    for (const specAbs of specs) {
      const rel = path.relative(root, specAbs);
      const parsed = await parse({ spec: rel, config: flags.config });
      if (parsed.status === "ERR") {
        const body = parsed.body as { code: string; message: string };
        this.log(`✗ ${rel}: [${body.code}] ${body.message}`);
        errors++;
        continue;
      }
      const spec = parsed.body as unknown as BuiltSpec;
      const findings: string[] = [];

      // ADR-0007: declared-but-unused schema = lint warning
      const used = new Set<string>();
      for (const sc of spec.scenarios) {
        if (sc.prediction.response) used.add(sc.prediction.response.schemaName);
        for (const svc of Object.values(sc.prediction.services ?? {})) {
          for (const r of svc.records ?? []) used.add(r.schemaName);
          for (const r of svc.contains ?? []) used.add(r.schemaName);
        }
        for (const seed of sc.given?.seeds ?? [])
          if ("records" in seed) for (const r of seed.records) if (r.schemaName) used.add(r.schemaName);
      }
      for (const entry of spec.contract) {
        if (entry.kind === "stream") continue;
        // `input` is used by definition: it is the when-payload's contract.
        if (entry.kind === "input") continue;
        if (!used.has(entry.schemaName))
          findings.push(`warn: schema '${entry.schemaName}' is declared but never referenced by a scenario`);
      }

      // Style: duplicate contract declarations
      const seen = new Set<string>();
      for (const entry of spec.contract) {
        if (entry.kind === "stream") continue;
        const key = `${entry.kind}:${entry.schemaName}`;
        if (seen.has(key)) findings.push(`warn: duplicate contract declaration '${entry.kind} ${entry.schemaName}'`);
        seen.add(key);
      }

      if (spec.identity.status === "draft") findings.push("info: status draft — not buildable until agreed");

      if (findings.length === 0) this.log(`✓ ${rel}`);
      else {
        this.log(`• ${rel}`);
        for (const f of findings) {
          this.log(`    ${f}`);
          if (f.startsWith("warn")) warnings++;
        }
      }
    }
    this.log(`\nlint: ${specs.length} spec(s), ${errors} error(s), ${warnings} warning(s).`);
    if (errors > 0) this.exit(1);
  }
}
