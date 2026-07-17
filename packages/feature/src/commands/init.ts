// `feat init` — scaffold a project: feat.config.json, a first spec + contract,
// and next steps. Refuses to overwrite existing files.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Command } from "@oclif/core";

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

export default class Init extends Command {
  static override description = "Scaffold feat.config.json and a first spec";

  public async run(): Promise<void> {
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
