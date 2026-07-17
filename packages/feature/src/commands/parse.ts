// `feat parse <file>` — validate a .feat file's syntax and closed reference spaces
// against the project config. Exit codes: 0 success · 1 validation failure · 2 config error.
// Thin orchestration only (CLI delegates; the logic lives in @mmmnt/feat-core).

import { Args, Command, Flags } from "@oclif/core";
import { parse } from "@mmmnt/feat-core";
import { loadConfig } from "@mmmnt/feat-runtime";

export default class Parse extends Command {
  static override description =
    "Parse and validate a .feat file against the project's feat.config.json";

  static override examples = [
    "feat parse corpus/create-flow/create-flow.feat --config corpus/create-flow/feat.config.json",
  ];

  static override args = {
    file: Args.string({ description: "Path to the .feat file", required: true }),
  };

  static override flags = {
    config: Flags.string({
      char: "c",
      description: "Path to feat.config.json",
      default: "feat.config.json",
    }),
  };

  public async run(): Promise<void> {
    const { args, flags } = await this.parse(Parse);

    const config = await loadConfig({ path: flags.config });
    if (config.status === "ERR") {
      const { code, message, detail } = config.body as {
        code: string;
        message: string;
        detail?: string;
      };
      this.logToStderr(`ERROR [${code}] ${message}`);
      if (detail) this.logToStderr(`  ${detail}`);
      this.exit(2);
    }

    const result = await parse({ spec: args.file, config: flags.config });
    if (result.status === "OK") {
      this.log(JSON.stringify(result.body, null, 2));
      return;
    }

    const { code, message, line, hint } = result.body as {
      code: string;
      message: string;
      line?: number;
      hint?: string;
    };
    this.logToStderr(`ERROR [${code}] ${args.file}${line !== undefined ? `:${line}` : ""}`);
    this.logToStderr(`  ${message}`);
    if (hint) this.logToStderr(`  Hint: ${hint}`);
    this.exit(1);
  }
}
