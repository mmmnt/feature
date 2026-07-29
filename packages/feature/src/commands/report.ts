// `feat report` — summarize the last run from the JUnit output (per-scenario,
// anchors included in test names). --junit prints the raw XML path.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolveEnvironment } from "@mmmnt/feat-runtime";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { FeatConfig } from "@mmmnt/feat-types";
import { produceEvidence } from "../evidence.js";

export default class Report extends Command {
  static override description = "Summarize the last feat run from its JUnit output";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
    junit: Flags.boolean({ description: "Print the JUnit XML path for CI/Xray import" }),
    evidence: Flags.boolean({
      description: "Write a feat-evidence/2 bundle to .feature/evidence/<environment>/<commit-sha>[-<config-slug>].json and exit (the slug disambiguates non-default configs)",
    }),
    out: Flags.string({ description: "Explicit evidence output path (overrides the .feature/ convention)" }),
    force: Flags.boolean({ description: "Write evidence even for the local environment (debugging)" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Report);
    const root = process.cwd();

    if (flags.evidence) {
      const cfg = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;
      const environment = resolveEnvironment(cfg);
      if (environment === "local" && !flags.force) {
        this.log("evidence: skipped — the local environment records no compliance evidence (--force to override).");
        return;
      }
      const bundle = await produceEvidence(root, flags.config);
      let sha = "nosha"; let dirty = false;
      try {
        sha = execSync("git rev-parse HEAD", { cwd: root }).toString().trim();
        dirty = execSync("git status --porcelain", { cwd: root }).toString().trim().length > 0;
      } catch {}
      // Multi-config repos report once PER CONFIG (dogfood-found 2026-07-28:
      // five planes overwrote one file and only the last survived). The
      // default config keeps the bare <sha>.json path; every other config
      // appends its slug so bundles never collide.
      const configFlag = String(flags.config ?? "feat.config.json");
      const configSlug =
        configFlag === "feat.config.json"
          ? ""
          : "-" + path.basename(configFlag).replace(/^feat\./, "").replace(/\.?config\.json$/, "").replace(/[^A-Za-z0-9_-]/g, "-").replace(/^$/, "config");
      const outPath = path.resolve(root, flags.out ?? path.join(".feature", "evidence", environment, sha + configSlug + (dirty ? "-dirty" : "") + ".json"));
      mkdirSync(path.dirname(outPath), { recursive: true });
      writeFileSync(outPath, JSON.stringify(bundle, null, 2) + "\n");
      this.log("evidence: " + path.relative(root, outPath));
      const v = (bundle.verify as { status: string }).status;
      const r = bundle.run ? (bundle.run as { status: string }).status : "absent";
      this.log(`evidence: specs ${(bundle.specs as unknown[]).length}, verify ${v}, run ${r}, environment ${environment}`);
      return;
    }

    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;
    const junitPath = config.report?.junitOutput;
    if (!junitPath || !existsSync(path.resolve(root, junitPath))) {
      this.logToStderr('ERROR [NO_REPORT] No JUnit output found — run "feat run" first (report.format must include "junit").');
      this.exit(2);
    }
    const abs = path.resolve(root, junitPath!);
    if (flags.junit) {
      this.log(abs);
      return;
    }
    const xml = readFileSync(abs, "utf8");
    const suites = [...xml.matchAll(/<testsuite\b[^>]*name="([^"]*)"[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"/g)];
    let total = 0, failures = 0, errors = 0;
    for (const s of suites) {
      total += Number(s[2]);
      failures += Number(s[3]);
      errors += Number(s[4]);
      this.log(`${Number(s[3]) + Number(s[4]) > 0 ? "✗" : "✓"} ${s[1]} — ${s[2]} test(s), ${s[3]} failure(s), ${s[4]} error(s)`);
    }
    this.log(`\n${total} test(s): ${total - failures - errors} passed, ${failures} failed, ${errors} errored.`);
    if (failures + errors > 0) this.exit(1);
  }
}
