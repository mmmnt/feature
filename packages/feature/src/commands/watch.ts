// `feat watch` — dev mode: regenerate on .feat/.contract.json/config changes.

import { watch as fsWatch, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { FeatConfig } from "@mmmnt/feat-types";
import { generateAll } from "../pipeline.js";

export default class Watch extends Command {
  static override description = "Watch specs and regenerate test files on change";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Watch);
    const root = process.cwd();
    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;

    let running = false;
    let queued = false;
    const regenerate = async (reason: string) => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        const files = await generateAll(root, flags.config);
        for (const f of files) writeFileSync(f.outputPath, f.content);
        this.log(`[watch] ${reason} — regenerated ${files.length} file(s)`);
      } catch (e) {
        this.logToStderr(`[watch] ${reason} — ERROR ${(e as Error).message}`);
      } finally {
        running = false;
        if (queued) {
          queued = false;
          void regenerate("queued change");
        }
      }
    };

    await regenerate("startup");
    const specsRoot = path.resolve(root, config.specs.dir);
    this.log(`[watch] watching ${path.relative(root, specsRoot)}/ (Ctrl-C to stop)`);
    fsWatch(specsRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.endsWith(".feat") || filename.endsWith(".contract.json"))
        void regenerate(filename);
    });
    // Keep the process alive.
    await new Promise(() => {});
  }
}
