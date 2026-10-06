// `feat run` — execute the generated test suites (runner subprocess, GAP-D09).
// --spec filters to a single spec ID; --shard i/n runs one disjoint slice (for N isolated jobs).
// JUnit output per the config report block, suffixed per shard.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { FeatConfig } from "@mmmnt/feat-types";
import { runTests } from "@mmmnt/feat-runner";
import { resolveEnvironment, variablesSidecarPath } from "@mmmnt/feat-runtime";
import { rmSync } from "node:fs";
import { generateAll } from "../pipeline.js";
import { parseShard, selectShard, shardJunitPath } from "../shard.js";

export default class Run extends Command {
  static override description = "Execute the generated tests with the adapter lifecycle";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
    spec: Flags.string({ description: "Run only the spec with this ID (e.g. SPEC-RT-001)" }),
    coverage: Flags.boolean({ description: "Collect coverage via the runner's coverage provider" }),
    shard: Flags.string({
      description:
        "Run slice i of n (e.g. 2/4). Each shard needs its OWN instruments — shards that share a store are not isolated."
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Run);
    const root = process.cwd();
    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;
    // Environment must be resolvable BEFORE any work (fail fast + notify).
    resolveEnvironment(config);
    // ADR-0017: fresh sidecar per run — staleness structurally impossible.
    rmSync(variablesSidecarPath(root, flags.config), { force: true });

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

    let shard: ReturnType<typeof parseShard> | undefined;
    if (flags.shard) {
      try {
        shard = parseShard(flags.shard);
      } catch (e) {
        this.logToStderr(`ERROR ${(e as Error).message}`);
        this.exit(1);
      }
      const keep = new Set(selectShard(files.map((f) => f.out), shard!));
      files = files.filter((f) => keep.has(f.out));
      this.log(`shard ${shard!.index}/${shard!.total}: ${files.length} file(s)`);
      if (files.length === 0) return; // more shards than files — this slice is honestly empty
    }

    const missing = files.filter((f) => !existsSync(f.out));
    if (missing.length > 0) {
      this.logToStderr("ERROR [NOT_GENERATED] Missing generated test files:");
      for (const m of missing) this.logToStderr(`  ${path.relative(root, m.out)}`);
      this.logToStderr('  Run "feat generate" first.');
      this.exit(1);
    }

    const junitBase = config.report?.format?.includes("junit") ? config.report.junitOutput : undefined;
    const junit = junitBase !== undefined ? shardJunitPath(junitBase, shard) : undefined;
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
