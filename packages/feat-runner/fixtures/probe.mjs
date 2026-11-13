// The probes behind `PlanRun` and `PreflightSerial` (SPEC-RT-005) and `RunVitest` (SPEC-RT-010).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { faultsOf, plan, runPlan } from "../src/plan.ts";
import { runTests } from "../src/index.ts";
import { createHarness, HarnessConfigurationError } from "../../feat-runtime/src/index.ts";

export async function planRun(input) {
  const specs = input.specs ?? [];
  // A spec gives its faults, or its IR cases for the sweep feat run applies (faultsOf).
  const faultsFor = (s) => s.faults ?? (s.cases === undefined ? [] : faultsOf(s.cases, input.exclusive));
  const p = plan(specs.map((s) => ({ path: s.path, faults: faultsFor(s) })), input.exclusive);
  const body = {
    parallel: p.parallel.join(","),
    serial: p.serial.join(","),
    order: p.order,
    serialWorkers: p.serialWorkers,
  };
  if (specs.some((s) => s.outcome !== undefined)) {
    const outcome = new Map(specs.map((s) => [s.path, s.outcome ?? "passed"]));
    const reported = [];
    const r = runPlan(p, (files) => {
      for (const f of files) reported.push(`${f}=${outcome.get(f)}`);
      return files.some((f) => outcome.get(f) === "failed") ? 1 : 0;
    });
    body.exit = r.exitCode;
    body.reported = reported.join(",");
  }
  return { status: "OK", body };
}

export async function preflightSerial(input) {
  const [operation, fault] = input.fault.split(".");
  const saved = process.env.FEAT_SERIAL;
  if (input.worker === "serial") process.env.FEAT_SERIAL = "1";
  else delete process.env.FEAT_SERIAL;
  const harness = await createHarness({ configPath: path.resolve(process.cwd(), "packages/feat-runner/fixtures/serial.config.json") });
  try {
    await harness.runCase(
      {
        anchor: "c1",
        name: "c1",
        given: { faults: [{ service: "store", operation, fault, times: "reset" }] },
        when: { command: "Ping", payload: {} },
        prediction: { type: "success", services: { store: { records: [] } } },
      },
      { schemas: {}, goldens: {} },
    );
  } catch (e) {
    if (e instanceof HarnessConfigurationError) return { status: "ERR", body: { code: e.code, detail: e.message } };
    throw e;
  } finally {
    await harness.teardown();
    if (saved === undefined) delete process.env.FEAT_SERIAL;
    else process.env.FEAT_SERIAL = saved;
  }
  return { status: "OK", body: { order: "armed" } };
}

// A stub vitest package: its bin records the version that ran and exits 0. The `exports` map lists
// ./package.json, as the real package does, so resolution goes through the same door.
function stubVitest(dir, ranFile) {
  const pkg = path.join(dir, "node_modules", "vitest");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    path.join(pkg, "package.json"),
    JSON.stringify({ name: "vitest", version: "3.2.99", type: "module", bin: { vitest: "./vitest.mjs" }, exports: { "./package.json": "./package.json" } }),
  );
  writeFileSync(path.join(pkg, "vitest.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ranFile)}, "3.2.99");\n`);
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

export async function runVitest(input) {
  const tmp = mkdtempSync(path.join(tmpdir(), "feat-local-vitest-"));
  const ranFile = path.join(tmp, "ran");
  const fetchedFile = path.join(tmp, "fetched");
  const root = input.vitest === "hoisted" ? path.join(tmp, "workspace", "app") : path.join(tmp, "app");
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app", private: true, type: "module" }));
  writeFileSync(path.join(root, "gen.test.ts"), "");
  if (input.vitest === "installed") stubVitest(root, ranFile);
  if (input.vitest === "hoisted") stubVitest(path.join(tmp, "workspace"), ranFile);
  const bin = path.join(tmp, "bin");
  stubFetchers(bin, fetchedFile);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  let r;
  try {
    r = runTests({ files: ["gen.test.ts"], root, quiet: true });
  } finally {
    process.env.PATH = saved;
  }
  const ran = existsSync(ranFile) ? readFileSync(ranFile, "utf8") : "";
  const fetched = existsSync(fetchedFile);
  rmSync(tmp, { recursive: true, force: true });
  if (r.refusal) return { status: "ERR", body: { code: r.refusal.code, detail: r.refusal.message, exit: r.exitCode, ran, fetched } };
  return { status: "OK", body: { exit: r.exitCode, ran, fetched } };
}
