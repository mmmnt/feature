// `feat verify` — the CI integrity gate (ADR-0006): regenerate and byte-compare
// against the committed test files. Any drift fails the build.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import { generateAll } from "../pipeline.js";

export default class Verify extends Command {
  static override description = "Verify committed test files match what feat generate would produce";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Verify);
    const root = process.cwd();
    try {
      const files = await generateAll(root, flags.config);
      const stale: string[] = [];
      for (const f of files) {
        const rel = path.relative(root, f.outputPath);
        if (!existsSync(f.outputPath)) stale.push(`${rel} (missing)`);
        else if (readFileSync(f.outputPath, "utf8") !== f.content) stale.push(`${rel} (differs)`);
      }
      if (stale.length > 0) {
        this.logToStderr("ERROR [VERIFY_FAILED] Committed tests do not match current specs:");
        for (const s of stale) this.logToStderr(`  ${s}`);
        this.logToStderr('  Run "feat generate" and commit the updated files.');
        this.exit(1);
      }
      this.log(`verify: ${files.length} generated file(s) match their specs.`);
    } catch (e) {
      this.logToStderr(`ERROR ${String((e as Error).message)}`);
      this.exit(1);
    }
  }
}
