// The probe behind `SynthLocalCdk` (SPEC-CDK-001): SynthStack runs the app's own aws-cdk, never a fetched one.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSynthStackHandler } from "../src/synth-stack.ts";

const ASSEMBLY = path.join(path.dirname(fileURLToPath(import.meta.url)), "single-stack");

// A stub aws-cdk package: its bin records the version that ran and copies the fixture assembly to --output.
function stubCdk(dir, ranFile) {
  const pkg = path.join(dir, "node_modules", "aws-cdk");
  mkdirSync(path.join(pkg, "bin"), { recursive: true });
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "aws-cdk", version: "2.999.0-stub", bin: { cdk: "bin/cdk" } }));
  writeFileSync(
    path.join(pkg, "bin", "cdk"),
    [
      'const { cpSync, writeFileSync } = require("node:fs");',
      'const out = process.argv[process.argv.indexOf("--output") + 1];',
      `cpSync(${JSON.stringify(ASSEMBLY)}, out, { recursive: true });`,
      `writeFileSync(${JSON.stringify(ranFile)}, "2.999.0-stub");`,
      "",
    ].join("\n"),
  );
}

/** Stubs for every command that could fetch a package at run time; each records that it was called. */
function stubFetchers(dir, fetchedFile) {
  mkdirSync(dir, { recursive: true });
  for (const name of ["npx", "npm", "pnpm", "pnpx", "yarn", "bunx"]) {
    const sh = path.join(dir, name);
    writeFileSync(sh, `#!/bin/sh\necho "${name} $*" >> ${JSON.stringify(fetchedFile)}\nexit 0\n`);
    chmodSync(sh, 0o755);
    writeFileSync(`${sh}.cmd`, `@echo ${name} %* >> "${fetchedFile}"\r\n@exit /b 0\r\n`);
  }
}

export async function synthLocalCdk(input) {
  const tmp = mkdtempSync(path.join(tmpdir(), "feat-local-cdk-"));
  const ranFile = path.join(tmp, "ran");
  const fetchedFile = path.join(tmp, "fetched");
  const app = input.cdk === "hoisted" ? path.join(tmp, "workspace", "infra") : path.join(tmp, "infra");
  mkdirSync(app, { recursive: true });
  writeFileSync(path.join(app, "package.json"), JSON.stringify({ name: "infra", private: true }));
  if (input.cdk === "installed") stubCdk(app, ranFile);
  if (input.cdk === "hoisted") stubCdk(path.join(tmp, "workspace"), ranFile);
  const bin = path.join(tmp, "bin");
  stubFetchers(bin, fetchedFile);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  const observed = () => ({ ran: existsSync(ranFile) ? readFileSync(ranFile, "utf8") : "", fetched: existsSync(fetchedFile) });
  try {
    const r = await createSynthStackHandler({ cwd: app })({ stack: "FeatureDashboardLocalData" });
    return { status: "OK", body: { stackName: r.body.stackName, ...observed() } };
  } catch (e) {
    if (e?.code === "AWS_CDK_NOT_INSTALLED") return { status: "ERR", body: { code: e.code, detail: e.message, ...observed() } };
    return { status: "ERR", body: { code: "THREW", detail: String(e?.message ?? e), ...observed() } };
  } finally {
    process.env.PATH = saved;
    rmSync(tmp, { recursive: true, force: true });
  }
}
