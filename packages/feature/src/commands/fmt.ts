// `feat fmt` — thin caller over @mmmnt/feat-analyze formatSource (conservative,
// content-preserving, idempotent). --check reports without writing.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { FeatConfig } from "@mmmnt/feat-types";
import { formatSource } from "@mmmnt/feat-analyze";
import { discoverSpecs } from "../pipeline.js";

export default class Fmt extends Command {
  static override description = "Format .feat files (conservative, content-preserving, idempotent)";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
    check: Flags.boolean({ description: "Report files that would change; exit 1 if any" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Fmt);
    const root = process.cwd();
    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;
    const specs = discoverSpecs(root, config.specs.dir);
    let changed = 0;
    let tabbed = 0;

    for (const specAbs of specs) {
      const rel = path.relative(root, specAbs);
      const source = readFileSync(specAbs, "utf8");
      const result = formatSource(source);
      if (result.hasLeadingTab) {
        this.logToStderr(`✗ ${rel}: tab in leading whitespace (parse error) — fix manually`);
        tabbed++;
        continue;
      }
      if (result.changed) {
        changed++;
        if (flags.check) this.log(`would format ${rel}`);
        else {
          writeFileSync(specAbs, result.formatted);
          this.log(`formatted ${rel}`);
        }
      }
    }
    this.log(`fmt: ${specs.length} spec(s), ${changed} ${flags.check ? "would change" : "formatted"}, ${tabbed} with tabs.`);
    if (tabbed > 0 || (flags.check && changed > 0)) this.exit(1);
  }
}
