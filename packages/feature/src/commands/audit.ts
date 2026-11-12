// `feat audit` — thin caller over @mmmnt/feat-analyze auditSpec (B1–B3,
// lifecycle) plus the filesystem-bound checks that belong to the CLI:
// paired contract + generated test existence.
// `feat audit --changed <base>` — the touches gate (SPEC-CHG-001): changedPaths (the git read), then
// checkChanged (the decision) over every -c workspace, anchored at git's top level.

import { readConfigOrExit } from "../config.js";
import { existsSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { auditSpec } from "@mmmnt/feat-analyze";
import { discoverSpecs } from "../pipeline.js";
import { changedPaths, checkChanged, isGlob } from "../audit-changed.js";

// The codes of a failed boundary or an unreadable spec: exit 1. Every other refusal of the gate is exit 2.
const VALIDATION = new Set(["OUTSIDE_TOUCHES", "HANDLER_OUTSIDE_FEATURE", "SPEC_UNPARSEABLE"]);

export default class Audit extends Command {
  static override description =
    "Audit all specs: completeness, buildability (B1–B3), lifecycle; with --changed <base>, check the change against every spec's touches";

  static override flags = {
    config: Flags.string({
      char: "c",
      description: "Path to feat.config.json (default feat.config.json); with --changed, repeatable and may be a glob",
      multiple: true,
    }),
    changed: Flags.string({
      description: "The touches gate: check the changes since the merge base of <base> and HEAD, plus the working tree",
      helpValue: "<base>",
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Audit);
    const configs = flags.config && flags.config.length > 0 ? flags.config : ["feat.config.json"];
    if (flags.changed !== undefined) return this.changed(flags.changed, configs);
    if (configs.length > 1 || isGlob(configs[0]!)) {
      this.logToStderr(
        "ERROR [CONFIG_MULTIPLE] feat audit takes one config; more than one -c, or a glob, is for feat audit --changed <base>",
      );
      return this.exit(2);
    }
    const root = process.cwd();
    const configPath = configs[0]!;
    const config = await readConfigOrExit(this, root, configPath);
    const specs = discoverSpecs(root, config.specs.dir, config.specs.exclude);
    let errors = 0;
    let warnings = 0;

    for (const specAbs of specs) {
      const rel = path.relative(root, specAbs);

      const parsed = await parse({ spec: rel, config: configPath });
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

  private refused(body: { code: string; count?: number; detail: string }): never {
    const out = (m: string) => (VALIDATION.has(body.code) ? this.log(m) : this.logToStderr(m));
    out(`ERROR [${body.code}] ${body.count ?? 1} finding(s)`);
    for (const line of body.detail.split("\n")) out(`    ${line}`);
    return this.exit(VALIDATION.has(body.code) ? 1 : 2);
  }

  private async changed(base: string, configs: string[]): Promise<void> {
    const cwd = process.cwd(); // getcwd: already free of symlinks, as git's top level is
    const read = await changedPaths({ cwd, base });
    if (read.status === "ERR") return this.refused(read.body as { code: string; detail: string });
    const { root, paths } = read.body as { root: string; paths: string[] };
    const rel = configs.map((c) => path.relative(root, path.resolve(cwd, c)).split(path.sep).join("/"));
    const r = await checkChanged({ root, configs: rel, paths });
    if (r.status === "ERR") return this.refused(r.body as { code: string; count: number; detail: string });
    const b = r.body as { workspaces: number; specs: number; checked: number; specd: number; unspecd: number };
    this.log(
      `audit --changed ${base}: ${b.checked} path(s) checked against ${b.specs} spec(s) in ${b.workspaces} workspace(s): ` +
        `${b.specd} inside a feature directory, ${b.unspecd} outside every one.`,
    );
  }
}
