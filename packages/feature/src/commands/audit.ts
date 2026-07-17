// `feat audit` — spec completeness + the ADR-0008 buildability lint:
// B1 handler for code-producing types, B2 two-way rejects↔rejection traceability,
// B3 touches present; paired contract + generated test existence; lifecycle status.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { parse } from "@mmmnt/feat-core";
import { discoverSpecs } from "../pipeline.js";

const CODE_TYPES = new Set(["command", "query", "policy", "projection", "saga"]);

export default class Audit extends Command {
  static override description = "Audit all specs: completeness, buildability (B1–B3), lifecycle";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Audit);
    const root = process.cwd();
    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;
    const specs = discoverSpecs(root, config.specs.dir);
    let errors = 0;
    let warnings = 0;

    for (const specAbs of specs) {
      const rel = path.relative(root, specAbs);
      const findings: string[] = [];
      const warn: string[] = [];

      const parsed = await parse({ spec: rel, config: flags.config });
      if (parsed.status === "ERR") {
        const body = parsed.body as { code: string; message: string };
        this.log(`✗ ${rel}`);
        this.log(`    ERROR [${body.code}] ${body.message}`);
        errors++;
        continue;
      }
      const spec = parsed.body as unknown as BuiltSpec;

      // B1: handler present for code-producing types
      if (CODE_TYPES.has(spec.identity.type) && !spec.construct.some((c) => c.kind === "handler"))
        findings.push("B1: no `handler at` for a code-producing spec type");
      // B3: touches always required
      if (!spec.construct.some((c) => c.kind === "touches"))
        findings.push("B3: no `touches` change boundary declared");
      // B2: two-way rejects ↔ predicted rejection IDs
      const rejectsIds = new Set(
        spec.enforce.filter((e) => e.kind === "rejects").map((e) => e.rejectionId as string),
      );
      const predictedIds = new Set<string>();
      for (const sc of spec.scenarios) {
        const rid = sc.prediction.rejectionId;
        if (!rid) continue;
        const ph = /^<(.+)>$/.exec(rid);
        if (ph) {
          for (const row of sc.examples ?? []) {
            const v = row[ph[1]!];
            if (typeof v === "string") predictedIds.add(v);
          }
        } else predictedIds.add(rid);
      }
      for (const id of predictedIds)
        if (!rejectsIds.has(id)) findings.push(`B2: predicted rejection '${id}' has no \`rejects ${id} when …\` line`);
      for (const id of rejectsIds)
        if (!predictedIds.has(id)) findings.push(`B2: \`rejects ${id}\` is never predicted by any scenario`);

      // Paired files
      const base = specAbs.slice(0, -".feat".length);
      if (!existsSync(`${base}.contract.json`)) warn.push("no paired .contract.json");
      const outPath = path.join(path.dirname(specAbs), config.specs.outputPattern.replace("{name}", path.basename(base)));
      if (!existsSync(outPath)) warn.push("no generated test file — run `feat generate`");

      // Lifecycle
      if (spec.identity.status === "draft") warn.push("status draft — not buildable until agreed");

      if (findings.length > 0) {
        this.log(`✗ ${rel} (${spec.identity.id}, status ${spec.identity.status})`);
        for (const f of findings) this.log(`    ERROR ${f}`);
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
}
