// The probes behind `PlanRun` and `PreflightSerial` (SPEC-RT-005) and `RunVitest` (SPEC-RT-010).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { faultsOf, plan, runPlan } from "../src/plan.ts";
import { runTestsAsync } from "../src/index.ts";
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

// The configuration error the harness throws, as a generated suite surfaces it (HarnessConfigurationError's message).
const CONFIG_ERROR = "Configuration error (exit 2): [FAULT_UNSUPPORTED] fault store Append Nonsense is not offered by the adapter";

/** The one test file a `probe` run writes, by suite; each records the version of the vitest that loaded it. */
function probeSuite(suite, ranFile, version) {
  const ran = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ranFile)}, ${JSON.stringify(version)});\n`;
  const error = JSON.stringify(CONFIG_ERROR);
  const bodies = {
    "config-error-in-test": `import { it } from "vitest";\nit("refuses", () => { throw new Error(${error}); });\n`,
    // As when createHarness refuses: the suite's beforeAll throws, so its tests are skipped.
    "config-error-in-setup": `import { beforeAll, describe, it } from "vitest";\ndescribe("suite", () => {\n  beforeAll(() => { throw new Error(${error}); });\n  it("never runs", () => {});\n});\n`,
    failing: `import { expect, it } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n`,
    passing: `import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n`,
  };
  const body = bodies[suite];
  if (body === undefined) throw new Error(`probe: unknown suite ${suite}`);
  return ran + body;
}

/** The real vitest a `probe` run links: FEAT_PROBE_VITEST, or the workspace's own. */
function probeVitestDir() {
  if (process.env.FEAT_PROBE_VITEST) return path.resolve(process.env.FEAT_PROBE_VITEST);
  return path.dirname(createRequire(import.meta.url).resolve("vitest/package.json"));
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
  if (input.vitest === "probe") {
    const real = probeVitestDir();
    const version = JSON.parse(readFileSync(path.join(real, "package.json"), "utf8")).version;
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(real, path.join(root, "node_modules", "vitest"), "junction");
    writeFileSync(path.join(root, "gen.test.ts"), probeSuite(input.suite, ranFile, version));
  } else {
    writeFileSync(path.join(root, "gen.test.ts"), "");
  }
  if (input.vitest === "installed") stubVitest(root, ranFile);
  if (input.vitest === "hoisted") stubVitest(path.join(tmp, "workspace"), ranFile);
  const bin = path.join(tmp, "bin");
  stubFetchers(bin, fetchedFile);
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved ?? ""}`;
  let r;
  try {
    // Awaited: this runs inside a vitest worker, which must keep its event loop turning while the nested vitest
    // runs (a synchronous run blocked the worker for 137 s under load and it missed vitest's RPC timeout).
    r = await runTestsAsync({ files: ["gen.test.ts"], root, quiet: true });
  } finally {
    process.env.PATH = saved;
  }
  const ran = existsSync(ranFile) ? readFileSync(ranFile, "utf8") : "";
  const fetched = existsSync(fetchedFile);
  rmSync(tmp, { recursive: true, force: true });
  if (r.refusal) return { status: "ERR", body: { code: r.refusal.code, detail: r.refusal.message, exit: r.exitCode, ran, fetched } };
  // `exit` is the exit `feat run` takes from this result (packages/feature/src/commands/run.ts): 2 on a configuration
  // error, else 1 on any failure, else 0. The runner itself returns vitest's own code beside the flag.
  const configurationError = r.configurationError === true;
  const exit = configurationError ? 2 : r.exitCode !== 0 ? 1 : 0;
  return { status: "OK", body: { exit, ran, fetched, configurationError } };
}
