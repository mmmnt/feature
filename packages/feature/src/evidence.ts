// Evidence bundle production (feat-evidence/1, schemas/evidence.schema.json).
// A digest-anchored record of spec state + verification results at a point in
// time. Free, local, account-less — the account lane signs bundles on
// ingestion; locally `signature` is null.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parse } from "@mmmnt/feat-core";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";
import { discoverSpecs, generateAll } from "./pipeline.js";

const require = createRequire(import.meta.url);

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function toolchainVersions(): Record<string, string> {
  const versions: Record<string, string> = {};
  const own = require("../package.json") as { version: string; dependencies?: Record<string, string> };
  for (const dep of Object.keys(own.dependencies ?? {})) {
    if (!dep.startsWith("@mmmnt/")) continue;
    versions[dep] = (require(`${dep}/package.json`) as { version: string }).version;
  }
  return versions;
}

export async function produceEvidence(root: string, configPath: string): Promise<Record<string, unknown>> {
  const configText = readFileSync(path.resolve(root, configPath), "utf8");
  const config = JSON.parse(configText) as FeatConfig;

  // Spec inventory
  const specs: Record<string, unknown>[] = [];
  for (const specAbs of discoverSpecs(root, config.specs.dir)) {
    const rel = path.relative(root, specAbs);
    const source = readFileSync(specAbs, "utf8");
    const entry: Record<string, unknown> = { path: rel, content_digest: sha256(source) };
    const parsed = await parse({ spec: rel, config: configPath });
    if (parsed.status === "OK") {
      const spec = parsed.body as unknown as BuiltSpec;
      entry.spec_id = spec.identity.id;
      entry.status = spec.identity.status;
    } else {
      entry.spec_id = "UNPARSEABLE";
      entry.status = "draft";
      entry.parse_error = parsed.body;
    }
    const base = specAbs.slice(0, -".feat".length);
    const outPath = path.join(path.dirname(specAbs), config.specs.outputPattern.replace("{name}", path.basename(base)));
    if (existsSync(outPath)) entry.generated_digest = sha256(readFileSync(outPath, "utf8"));
    specs.push(entry);
  }

  // Verify (byte-lock semantics; a generation failure is a verify fail, not a crash)
  let verify: Record<string, unknown>;
  try {
    const files = await generateAll(root, configPath);
    const mismatched = files
      .filter((f) => !existsSync(f.outputPath) || readFileSync(f.outputPath, "utf8") !== f.content)
      .map((f) => path.relative(root, f.outputPath));
    verify = mismatched.length > 0 ? { status: "fail", mismatched } : { status: "pass" };
  } catch {
    verify = { status: "fail", mismatched: [] };
  }

  const bundle: Record<string, unknown> = {
    contract: "feat-evidence/1",
    produced_at: new Date().toISOString(),
    producer: {
      tool: "@mmmnt/feature",
      version: (require("../package.json") as { version: string }).version,
      toolchain: toolchainVersions(),
    },
    project: { feat_version: config.featVersion, config_digest: sha256(configText) },
    specs,
    verify,
    signature: null,
  };

  // Run block, when a JUnit artifact exists
  const junitRel = config.report?.junitOutput;
  if (junitRel && existsSync(path.resolve(root, junitRel))) {
    const xml = readFileSync(path.resolve(root, junitRel), "utf8");
    let tests = 0;
    let failures = 0;
    let errors = 0;
    for (const s of xml.matchAll(/<testsuite\b[^>]*tests="(\d+)"[^>]*failures="(\d+)"[^>]*errors="(\d+)"/g)) {
      tests += Number(s[1]);
      failures += Number(s[2]);
      errors += Number(s[3]);
    }
    bundle.run = {
      status: failures + errors > 0 ? "fail" : "pass",
      tests,
      failures,
      errors,
      junit_digest: sha256(xml),
    };
  }

  return bundle;
}
