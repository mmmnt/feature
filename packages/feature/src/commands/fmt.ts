// `feat fmt` — conservative canonical formatting: trailing-whitespace strip,
// collapse >1 blank line, ensure trailing newline, tabs-in-indentation error
// (the parser rejects them anyway; fmt reports instead of rewriting).
// Content-preserving and idempotent; full canonical reprint arrives with the
// LSP surface. --check reports without writing.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { FeatConfig } from "@mmmnt/feat-types";
import { discoverSpecs } from "../pipeline.js";

function format(source: string): string {
  const lines = source.split(/\r?\n/).map((l) => l.replace(/[ \t]+$/, ""));
  const out: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks++;
      if (blanks > 1) continue;
    } else blanks = 0;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

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
      if (/^\t/m.test(source)) {
        this.logToStderr(`✗ ${rel}: tab in leading whitespace (parse error) — fix manually`);
        tabbed++;
        continue;
      }
      const formatted = format(source);
      if (formatted !== source) {
        changed++;
        if (flags.check) this.log(`would format ${rel}`);
        else {
          writeFileSync(specAbs, formatted);
          this.log(`formatted ${rel}`);
        }
      }
    }
    this.log(`fmt: ${specs.length} spec(s), ${changed} ${flags.check ? "would change" : "formatted"}, ${tabbed} with tabs.`);
    if (tabbed > 0 || (flags.check && changed > 0)) this.exit(1);
  }
}
