// `feat lint` — thin caller over @mmmnt/feat-analyze lintSpec (ADR-0007 rules).
// Exit 1 only on ERROR-level findings (currently none beyond parse failures —
// the B-rules live in `feat audit`).

import { readFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { lintSpec } from "@mmmnt/feat-analyze";
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
      const findings = lintSpec(parsed.body as unknown as BuiltSpec);

      if (findings.length === 0) this.log(`✓ ${rel}`);
      else {
        this.log(`• ${rel}`);
        for (const f of findings) {
          this.log(`    ${f.message}`);
          if (f.level === "warn") warnings++;
        }
      }
    }
    this.log(`\nlint: ${specs.length} spec(s), ${errors} error(s), ${warnings} warning(s).`);
    if (errors > 0) this.exit(1);
  }
}
