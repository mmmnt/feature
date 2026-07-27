// Evidence bundle production (feat-evidence/2, schemas/evidence.schema.json).
// A digest-anchored record of spec state + verification results at a point in
// time. Free, local, account-less — the account lane signs bundles on
// ingestion; locally `signature` is null.
//
// feat-evidence/2 (ADR-0020) is a strict superset of /1: it adds `runs` —
// per-scenario results with parsed prediction violations, derived from the
// JUnit artifact (stage 1). Stage 2 replaces the JUnit parse with a
// structured run sidecar written by the harness itself.

import { resolveEnvironment, variablesSidecarPath } from "@mmmnt/feat-runtime";
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

const XML_ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&#39;": "'", "&amp;": "&" };
function decodeXml(text: string): string {
  return text.replace(/&(?:lt|gt|quot|apos|amp|#39);/g, (m) => XML_ENTITIES[m] ?? m);
}

/**
 * feat-evidence/2 stage 1: fold the JUnit artifact into per-scenario runs.
 * Each testcase is one scenario; the harness's "Prediction violated" lines
 * inside a failure parse into {path, expected, got} rows. Lenient by
 * construction — an unparseable failure still records the failed scenario,
 * it never drops it. Exported for unit testing.
 */
export function parseJunitRuns(xml: string): Array<Record<string, unknown>> {
  const runs: Array<Record<string, unknown>> = [];
  for (const tc of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = tc[1] ?? "";
    const inner = tc[2] ?? "";
    const attr = (name: string) => {
      const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
      return m ? decodeXml(m[1] ?? "") : null;
    };
    const name = attr("name") ?? "";
    const specId = /SPEC-[A-Z0-9]+-[A-Z0-9]+/.exec(name)?.[0] ?? null;
    const time = attr("time");
    const failed = /<failure\b/.test(inner);
    const violations: Array<Record<string, string>> = [];
    if (failed) {
      const text = decodeXml(inner);
      for (const line of text.matchAll(/^\s*\S+ › "(?:.*?)" › (.+?): expected (.+?), got (.+?)\s*$/gm)) {
        violations.push({ path: line[1] ?? "", expected: line[2] ?? "", got: line[3] ?? "" });
      }
    }
    runs.push({
      name,
      spec_id: specId,
      status: failed ? "fail" : "pass",
      ...(time !== null ? { time: Number(time) } : {}),
      violations,
    });
  }
  return runs;
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
    contract: "feat-evidence/2",
    produced_at: new Date().toISOString(),
    producer: {
      tool: "@mmmnt/feature",
      version: (require("../package.json") as { version: string }).version,
      toolchain: toolchainVersions(),
    },
    project: {
      feat_version: config.featVersion,
      config_digest: sha256(configText),
      // Environment: config override > FEAT_ENVIRONMENT > ENVIRONMENT (fail-fast).
      environment: resolveEnvironment(config),
    },
    specs,
    verify,
    signature: null,
  };

  // ADR-0017: per-case resolved variable values from the run sidecar — the
  // bundle replays the substitution (spec text keeps ${expressions}).
  const sidecar = variablesSidecarPath(root, configPath);
  if (existsSync(sidecar)) {
    const vars: Record<string, unknown> = {};
    for (const line of readFileSync(sidecar, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { const rec = JSON.parse(line) as { anchor: string; variables: unknown }; vars[rec.anchor] = rec.variables; } catch {}
    }
    if (Object.keys(vars).length > 0) bundle.variables = vars;
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
    // feat-evidence/2: the per-scenario detail the dashboard's violation
    // view demands (its envelope: feature-dashboard SPEC-FD-037).
    bundle.runs = parseJunitRuns(xml);
  }

  return bundle;
}
