// `feat watch` — dev mode: regenerate on .feat/.contract.json/config changes,
// optionally run affected suites (--run), optionally emit NDJSON events for
// machine consumption (--json, implies --run) — the IDE-integration surface.

import { watch as fsWatch, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Command, Flags } from "@oclif/core";
import type { FeatConfig } from "@mmmnt/feat-types";
import { runTests } from "@mmmnt/feat-runner";
import { generateAll } from "../pipeline.js";

interface CaseResult {
  suite: string;
  name: string;
  state: "passed" | "failed" | "skipped";
  message?: string;
}

export default class Watch extends Command {
  static override description = "Watch specs, regenerate test files, and (optionally) run affected suites on change";

  static override flags = {
    config: Flags.string({ char: "c", description: "Path to feat.config.json", default: "feat.config.json" }),
    run: Flags.boolean({ description: "Run affected generated suites after each regeneration", default: false }),
    json: Flags.boolean({ description: "Emit NDJSON events to stdout (implies --run)", default: false }),
    src: Flags.string({
      multiple: true,
      description: "Additional directory to watch; changes rerun all suites without regeneration (repeatable)",
      default: [],
    }),
  };

  public async run(): Promise<void> {
    const { flags } = await this.parse(Watch);
    const doRun = flags.run || flags.json;
    const root = process.cwd();
    const config = JSON.parse(readFileSync(path.resolve(root, flags.config), "utf8")) as FeatConfig;
    const lastHash = new Map<string, string>();

    const emit = (event: Record<string, unknown>) => {
      if (flags.json) this.log(JSON.stringify({ ts: new Date().toISOString(), ...event }));
    };
    const say = (msg: string) => {
      if (!flags.json) this.log(`[watch] ${msg}`);
    };

    const runSuites = (targets: { specPath: string; outputPath: string }[]) => {
      if (targets.length === 0) return;
      const jsonOutput = flags.json ? path.join(".feat-watch", `run-${randomUUID()}.json`) : undefined;
      const opts: Parameters<typeof runTests>[0] = {
        files: targets.map((t) => path.relative(root, t.outputPath)),
        root,
        quiet: flags.json,
      };
      if (jsonOutput) opts.jsonOutput = jsonOutput;
      const result = runTests(opts);
      if (!flags.json) {
        say(result.exitCode === 0 ? "suites green" : "PREDICTION VIOLATIONS (see above)");
        return;
      }
      let cases: CaseResult[] = [];
      if (result.jsonPath && existsSync(result.jsonPath)) {
        try {
          const report = JSON.parse(readFileSync(result.jsonPath, "utf8")) as {
            testResults?: { name?: string; assertionResults?: { ancestorTitles?: string[]; title?: string; status?: string; failureMessages?: string[] }[] }[];
          };
          cases = (report.testResults ?? []).flatMap((f) =>
            (f.assertionResults ?? []).map((a) => {
              const c: CaseResult = {
                suite: (a.ancestorTitles ?? []).join(" › "),
                name: a.title ?? "",
                state: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped",
              };
              const msg = (a.failureMessages ?? [])[0];
              if (msg !== undefined) c.message = msg;
              return c;
            }),
          );
        } catch {
          // Malformed report: fall through with empty cases; exitCode still signals.
        }
        rmSync(result.jsonPath, { force: true });
      }
      emit({
        event: "run",
        exitCode: result.exitCode,
        suites: targets.map((t) => ({ spec: path.relative(root, t.specPath), output: path.relative(root, t.outputPath) })),
        cases,
      });
    };

    let running = false;
    let queued: string | null = null;
    const cycle = async (reason: string, regen: boolean) => {
      if (running) {
        queued = reason;
        return;
      }
      running = true;
      try {
        let targets: { specPath: string; outputPath: string }[] = [];
        if (regen) {
          const files = await generateAll(root, flags.config);
          const changed: typeof targets = [];
          for (const f of files) {
            const hash = createHash("sha256").update(f.content).digest("hex");
            if (lastHash.get(f.outputPath) !== hash) {
              writeFileSync(f.outputPath, f.content);
              lastHash.set(f.outputPath, hash);
              changed.push({ specPath: f.specPath, outputPath: f.outputPath });
            }
          }
          say(`${reason} — ${files.length} spec(s), ${changed.length} regenerated`);
          emit({
            event: "generate",
            reason,
            files: files.map((f) => ({ spec: path.relative(root, f.specPath), output: path.relative(root, f.outputPath) })),
            changed: changed.map((f) => path.relative(root, f.outputPath)),
          });
          // Startup runs everything; later cycles run only suites whose bytes changed.
          targets = reason === "startup" ? files.map((f) => ({ specPath: f.specPath, outputPath: f.outputPath })) : changed;
        } else {
          // Source change: implementation moved under the specs — rerun everything.
          const files = await generateAll(root, flags.config);
          targets = files.map((f) => ({ specPath: f.specPath, outputPath: f.outputPath }));
          say(`${reason} — source change, rerunning ${targets.length} suite(s)`);
          emit({ event: "source-change", reason });
        }
        if (doRun) runSuites(targets);
      } catch (e) {
        say(`${reason} — ERROR ${(e as Error).message}`);
        emit({ event: "error", reason, message: (e as Error).message });
      } finally {
        running = false;
        if (queued !== null) {
          const next = queued;
          queued = null;
          void cycle(next, true);
        }
      }
    };

    await cycle("startup", true);
    const specsRoot = path.resolve(root, config.specs.dir);
    say(`watching ${path.relative(root, specsRoot) || "."}/ (Ctrl-C to stop)`);
    fsWatch(specsRoot, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (filename.endsWith(".feat") || filename.endsWith(".contract.json")) void cycle(filename, true);
    });
    for (const dir of flags.src) {
      const abs = path.resolve(root, dir);
      if (!existsSync(abs)) {
        say(`--src ${dir}: directory not found, skipping`);
        continue;
      }
      say(`watching ${dir}/ (source)`);
      fsWatch(abs, { recursive: true }, (_event, filename) => {
        if (!filename || filename.endsWith(".test.ts")) return;
        void cycle(`${dir}/${filename}`, false);
      });
    }
    // Keep the process alive.
    await new Promise(() => {});
  }
}
