// `feat audit` — thin caller over @mmmnt/feat-analyze auditSpec (B1–B3,
// lifecycle) plus the filesystem-bound checks that belong to the CLI:
// paired contract + generated test existence.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { auditSpec } from "@mmmnt/feat-analyze";
import { discoverSpecs } from "../pipeline.js";

export default class Audit extends Command {
  static override description = "Audit all specs: completeness, buildability (B1–B3), lifecycle";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Audit);
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
        this.log(`✗ ${rel}`);
        this.log(`    ERROR [${body.code}] ${body.message}`);
        errors++;
        continue;
      }
      const spec = parsed.body as unknown as BuiltSpec;
      const result = auditSpec(spec);

      // Paired files (filesystem concerns — the CLI's share of the audit),
      // then the spec-level lifecycle warnings, preserving the original order.
      const warn: string[] = [];
      const base = specAbs.slice(0, -".feat".length);
      if (!existsSync(`${base}.contract.json`)) warn.push("no paired .contract.json");
      const outPath = path.join(path.dirname(specAbs), config.specs.outputPattern.replace("{name}", path.basename(base)));
      if (!existsSync(outPath)) warn.push("no generated test file — run `feat generate`");
      warn.push(...result.warnings);

      if (result.errors.length > 0) {
        this.log(`✗ ${rel} (${spec.identity.id}, status ${spec.identity.status})`);
        for (const f of result.errors) this.log(`    ERROR ${f}`);
        errors++;
      } else {
        this.log(`✓ ${rel} (${spec.identity.id}, status ${spec.identity.status})`);
      }
      for (const w of warn) {
        this.log(`    warn: ${w}`);
        warnings++;
      }
    }

    this.log(`\naudit: ${specs.length} spec(s), ${errors} with errors, ${warnings} warning(s).`);
    if (errors > 0) this.exit(1);
  }
}
