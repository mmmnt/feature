// The probe behind `InitProject` (SPEC-INIT-001): run the CLI's `feat init --no-install` in a throwaway directory
// whose package.json is absent, CommonJS (as `npm init -y` writes it on npm 11), typeless or an ES module package,
// and answer what init left: package.json's "type", the module the config routes Greet to, the spec's `handler at`,
// and whether the README's starter handler, written at that route, imports with Node from that directory as the
// handler adapter imports a route (a native dynamic import). No network: --no-install. Test fixture, not shipped.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/run.js");

// The README's starter handler (packages/feature/README.md, Quick start), byte for byte.
const STARTER_HANDLER = `export async function greet(input: { name: string }) {
  if (input.name === "") return { status: "ERR", body: { code: "EMPTY_NAME", message: "blank" } };
  return { status: "OK", body: { message: \`Hello, \${input.name}\` } };
}
`;

const PACKAGE_JSON = {
  commonjs: { name: "app", version: "1.0.0", main: "index.js", type: "commonjs" },
  typeless: { name: "app", version: "1.0.0", main: "index.js" },
  module: { name: "app", version: "1.0.0", type: "module" },
};

const EXISTING = {
  "feat.config.json": "{}\n",
  "specs/greet.feat": "feat 1.0\n",
  "specs/greet.contract.json": "{}\n",
};

function run(file, args, cwd, env) {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, encoding: "utf8" }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

export async function initProject(input) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "feat-init-probe-"));
  try {
    const pkg = PACKAGE_JSON[input.packageJson];
    if (input.packageJson !== "none" && pkg === undefined) throw new Error(`init-probe: unknown packageJson ${input.packageJson}`);
    if (pkg !== undefined) writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    if (input.existing !== undefined) {
      mkdirSync(path.dirname(path.join(dir, input.existing)), { recursive: true });
      writeFileSync(path.join(dir, input.existing), EXISTING[input.existing]);
    }

    // The package manager's user agent is the harness's, not the target project's (init detects from it).
    const env = { ...process.env };
    delete env.npm_config_user_agent;
    const init = await run(process.execPath, [BIN, "init", "--no-install"], dir, env);
    const pkgPath = path.join(dir, "package.json");
    const typeAfter = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, "utf8")).type ?? "") : "";

    if (init.code !== 0) {
      const line = /\[([A-Z_]+)\][^\n]*/.exec(init.stderr);
      return { status: "ERR", body: { code: line?.[1] ?? "UNKNOWN", detail: line?.[0] ?? init.stderr.trim(), exit: init.code, type: typeAfter } };
    }

    const config = JSON.parse(readFileSync(path.join(dir, "feat.config.json"), "utf8"));
    const route = config.response?.commands?.Greet?.module ?? "";
    const specHandler = /^\s*handler at (\S+)\s*$/m.exec(readFileSync(path.join(dir, "specs/greet.feat"), "utf8"))?.[1] ?? "";

    let loads = false;
    if (route !== "") {
      const abs = path.resolve(dir, route);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, STARTER_HANDLER);
      const check = [
        'import { pathToFileURL } from "node:url";',
        `const m = await import(pathToFileURL(${JSON.stringify(abs)}).href);`,
        'if (typeof m.greet !== "function") process.exit(3);',
        'const r = await m.greet({ name: "Ada" });',
        'if (r?.status !== "OK") process.exit(4);',
      ].join("\n");
      loads = (await run(process.execPath, ["--input-type=module", "-e", check], dir, env)).code === 0;
    }
    return { status: "OK", body: { exit: init.code, type: typeAfter, route, specHandler, loads } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
