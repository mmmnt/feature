// `feat diff` — spec change summary for PR review: compares the working-tree spec
// against a git ref (default HEAD) at the IR level — scenario adds/removes,
// status transitions, contract interface changes.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Args, Command, Flags } from "@oclif/core";
import type { BuiltSpec } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";

export default class Diff extends Command {
  static override description = "Summarize spec changes vs a git ref (IR-level, for PR review)";

  static override args = {
    file: Args.string({ description: "Path to the .feat file", required: true }),
  };

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
    ref: Flags.string({ description: "Git ref to compare against", default: "HEAD" }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Diff);
    const root = process.cwd();

    const current = await parse({ spec: args.file, config: flags.config });
    if (current.status === "ERR") {
      this.logToStderr(`ERROR current spec does not parse: ${JSON.stringify(current.body)}`);
      this.exit(1);
    }
    const now = current.body as unknown as BuiltSpec;

    let baseText: string;
    try {
      baseText = execFileSync("git", ["show", `${flags.ref}:${args.file}`], { cwd: root, encoding: "utf8" });
    } catch {
      this.log(`new spec (${now.identity.id}) — not present at ${flags.ref}`);
      return;
    }
    const tmp = mkdtempSync(path.join(tmpdir(), "feat-diff-"));
    try {
      const basePath = path.join(tmp, "base.feat");
      writeFileSync(basePath, baseText);
      const baseParsed = await parse({ spec: path.relative(root, basePath), config: flags.config });
      if (baseParsed.status === "ERR") {
        this.log(`base version at ${flags.ref} does not parse under the current config — treating all scenarios as new`);
        for (const sc of now.scenarios) this.log(`  + scenario "${sc.name}"`);
        return;
      }
      const base = baseParsed.body as unknown as BuiltSpec;

      if (base.identity.status !== now.identity.status)
        this.log(`status: ${base.identity.status} → ${now.identity.status}`);

      const baseNames = new Set(base.scenarios.map((s) => s.name));
      const nowNames = new Set(now.scenarios.map((s) => s.name));
      for (const n of nowNames) if (!baseNames.has(n)) this.log(`+ scenario "${n}"`);
      for (const n of baseNames) if (!nowNames.has(n)) this.log(`- scenario "${n}"`);
      for (const sc of now.scenarios) {
        if (!baseNames.has(sc.name)) continue;
        const b = base.scenarios.find((s) => s.name === sc.name)!;
        if (JSON.stringify(b) !== JSON.stringify(sc)) this.log(`~ scenario "${sc.name}" changed`);
      }

      const iface = (s: BuiltSpec) =>
        s.contract.map((c) => ("schemaName" in c ? `${c.kind} ${c.schemaName}` : `stream ${c.pattern}`)).sort();
      const bi = iface(base);
      const ni = iface(now);
      for (const e of ni) if (!bi.includes(e)) this.log(`+ contract ${e}`);
      for (const e of bi) if (!ni.includes(e)) this.log(`- contract ${e}`);

      if (JSON.stringify(base) === JSON.stringify(now)) this.log("no IR-level changes");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}
