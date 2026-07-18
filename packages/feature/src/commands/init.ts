// `feat init` — scaffold a project: feat.config.json, a first spec + contract,
// AND the dependency setup — after scaffolding it installs what a working
// project needs (runtime, starter adapters, vitest) with the detected package
// manager, so `npm i -D @mmmnt/feature && npx feat init` is a complete start.
// Refuses to overwrite existing files. --no-install prints the command instead.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command, Flags } from "@oclif/core";

const CONFIG = `{
  "featVersion": "1.0",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "@mmmnt/feat-adapter-handler",
    "commands": {
      "Greet": { "module": "src/greet.ts", "export": "greet" }
    }
  },
  "services": {
    "filesystem": {
      "adapter": "@mmmnt/feat-adapter-fs",
      "consistency": "acid",
      "options": { "scope": "src" }
    }
  },
  "specs": {
    "dir": "specs",
    "pattern": "**/*.feat",
    "contractPattern": "**/*.contract.json",
    "outputPattern": "{name}.test.ts"
  },
  "report": { "format": ["console", "junit"], "junitOutput": "reports/feat-junit.xml" }
}
`;

const SPEC = `feat 1.0

spec SPEC-EX-001 "Greet"
context Example
aggregate Greeting
type command
status draft

construct:
  handler at src/greet.ts
  touches src/**

enforce:
  return a greeting containing the given name
  rejects EMPTY_NAME when the name is blank

contract:
  input GreetInput
  response GreetResponse
  error GreetError

scenario "greets by name":
  when: Greet { name: "Ada" }
  predict success:
    response OK GreetResponse { message: matching "Ada" }
    filesystem has []

scenario "rejects a blank name":
  when: Greet { name: "" }
  predict rejection EMPTY_NAME:
    response ERR GreetError { code: "EMPTY_NAME" }
    filesystem has []
`;

const CONTRACT = `{
  "$schema": "https://feat.dev/schemas/contract.json",
  "specId": "SPEC-EX-001",
  "schemas": {
    "GreetInput": {
      "type": "object",
      "required": ["name"],
      "additionalProperties": false,
      "properties": { "name": { "type": "string" } }
    },
    "GreetResponse": {
      "type": "object",
      "required": ["message"],
      "properties": { "message": { "type": "string" } }
    },
    "GreetError": {
      "type": "object",
      "required": ["code", "message"],
      "properties": { "code": { "type": "string" }, "message": { "type": "string" } }
    }
  }
}
`;

/** What a working project needs beyond the CLI itself. Installed at latest —
 *  the registry resolves compatible versions; the manifest gets caret ranges. */
const STARTER_DEPS = [
  "@mmmnt/feat-runtime",
  "@mmmnt/feat-adapter-handler",
  "@mmmnt/feat-adapter-fs",
  "@mmmnt/feat-schema-json",
  "vitest",
];

type Pm = "pnpm" | "yarn" | "npm";

function detectPm(root: string): Pm {
  if (existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(root, "package-lock.json"))) return "npm";
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("pnpm")) return "pnpm";
  if (ua.startsWith("yarn")) return "yarn";
  return "npm";
}

function installCommand(pm: Pm, deps: string[]): string[] {
  if (pm === "npm") return ["npm", "install", "-D", ...deps];
  return [pm, "add", "-D", ...deps];
}

export default class Init extends Command {
  static override description = "Scaffold feat.config.json, a first spec, and install the starter dependencies";

  static override flags = {
    "no-install": Flags.boolean({
      description: "Skip dependency installation; print the install command instead",
      default: false,
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Init);
    const root = process.cwd();
    const configPath = path.join(root, "feat.config.json");
    if (existsSync(configPath)) {
      this.logToStderr("ERROR [ALREADY_INITIALIZED] feat.config.json already exists.");
      this.exit(2);
    }
    writeFileSync(configPath, CONFIG);
    mkdirSync(path.join(root, "specs"), { recursive: true });
    writeFileSync(path.join(root, "specs/greet.feat"), SPEC);
    writeFileSync(path.join(root, "specs/greet.contract.json"), CONTRACT);

    this.log("created feat.config.json");
    this.log("created specs/greet.feat");
    this.log("created specs/greet.contract.json");

    // ── Dependency completion ──
    const pkgPath = path.join(root, "package.json");
    if (!existsSync(pkgPath)) {
      writeFileSync(
        pkgPath,
        JSON.stringify({ name: path.basename(root), version: "0.0.0", private: true }, null, 2) + "\n",
      );
      this.log("created package.json");
    }
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
    const missing = STARTER_DEPS.filter((d) => !declared.has(d));

    if (missing.length === 0) {
      this.log("dependencies: all present");
    } else {
      const pm = detectPm(root);
      const cmd = installCommand(pm, missing);
      if (flags["no-install"]) {
        this.log("");
        this.log("Install the remaining dependencies:");
        this.log(`  ${cmd.join(" ")}`);
      } else {
        this.log("");
        this.log(`installing with ${pm}: ${missing.join(", ")}`);
        const result = spawnSync(cmd[0]!, cmd.slice(1), { cwd: root, stdio: "inherit", env: process.env });
        if (result.status !== 0) {
          this.logToStderr("");
          this.logToStderr(`WARN install did not complete — run it yourself:`);
          this.logToStderr(`  ${cmd.join(" ")}`);
        }
      }
    }

    this.log("");
    this.log("Next steps:");
    this.log("  1. feat parse specs/greet.feat      # validate the spec");
    this.log("  2. Change `status draft` to `status agreed` once the spec says what you mean");
    this.log("  3. feat generate                    # compile specs into test files");
    this.log("  4. Implement src/greet.ts, then: feat run");
    this.log("");
    this.log("The handler contract: export an async function that returns { status, body }.");
  }
}
