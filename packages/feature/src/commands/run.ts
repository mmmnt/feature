// `feat run` — execute the generated test suites (runner subprocess, GAP-D09).
// --spec filters to a single spec ID. JUnit output per the config report block.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { FeatConfig } from "@mmmnt/feat-types";
import { runTests } from "@mmmnt/feat-runner";
import { generateAll } from "../pipeline.js";

export default class Run extends Command {
  static override description = "Execute the generated tests with the adapter lifecycle";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
    spec: Flags.string({ description: "Run only the spec with this ID (e.g. SPEC-RT-001)" }),
    coverage: Flags.boolean({ description: "Collect coverage via the runner's coverage provider" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const root = process.cwd();
    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;

    let files = (await generateAll(root, flags.config)).map((f) => ({
      specId: f.specPath,
      out: f.outputPath,
      content: f.content,
    }));
    if (flags.spec) {
      files = files.filter((f) => f.content.includes(`(${flags.spec})`));
      if (files.length === 0) {
        this.logToStderr(`ERROR no generated test found for spec '${flags.spec}'`);
        this.exit(1);
      }
    }

    const missing = files.filter((f) => !existsSync(f.out));
    if (missing.length > 0) {
      this.logToStderr("ERROR [NOT_GENERATED] Missing generated test files:");
      for (const m of missing) this.logToStderr(`  ${path.relative(root, m.out)}`);
      this.logToStderr('  Run "feat generate" first.');
      this.exit(1);
    }

    const junit = config.report?.format?.includes("junit") ? config.report.junitOutput : undefined;
    const runOpts: Parameters<typeof runTests>[0] = {
      files: files.map((f) => path.relative(root, f.out)),
      root,
    };
    if (junit !== undefined) runOpts.junitOutput = junit;
    if (flags.coverage) runOpts.coverage = true;
    const result = runTests(runOpts);
    if (result.junitPath) this.log(`junit: ${path.relative(root, result.junitPath)}`);
    if (result.exitCode !== 0) this.exit(1);
  }
}
