// `feat generate` — parse → derive → emit committed test files for every spec.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import { generateAll } from "../pipeline.js";

export default class Generate extends Command {
  static override description = "Generate test files from every .feat spec (parse → derive → emit)";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Generate);
    const root = process.cwd();
    try {
      const files = await generateAll(root, flags.config);
      for (const f of files) {
        writeFileSync(f.outputPath, f.content);
        this.log(`generated ${path.relative(root, f.outputPath)}  (from ${f.specPath})`);
      }
      this.log(`${files.length} test file(s) generated.`);
    } catch (e) {
      this.logToStderr(`ERROR ${String((e as Error).message)}`);
      this.exit(1);
    }
  }
}
