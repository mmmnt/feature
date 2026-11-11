# @mmmnt/feat-runner

**The runner of Feature: it runs generated test files under vitest, in the right passes, and tells a
configuration error from a failed test.**
`runTests(options)` takes a list of generated test files and runs them in a vitest subprocess. Files
that arm an exclusive fault (`BrokerLoss`) run last, alone, in a serial pass. The runner merges the
two JUnit reports, collects coverage when asked, and says whether the run failed because a harness
refused its configuration. It never lets a run that selected no tests pass.

It is deliberately thin. Generated tests own their lifecycle, so the runner starts vitest, passes
the exit code through and points the reporters at the configured outputs.

## Where it sits

```
feat run  ->  generate / read config  ->  pick files (--spec, --shard)
                                              |
                          feat-runner: plan() splits parallel and serial
                                              |
                       vitest run (parallel pass), then vitest run (serial pass)
                                              |
                      generated tests -> feat-runtime harness -> adapters
```

Most users get this package through [`@mmmnt/feature`](https://www.npmjs.com/package/@mmmnt/feature):
`feat run` calls it. Depend on it directly when you drive generated suites from your own tooling and
want the same passes, the same JUnit merge and the same configuration-error detection without the
CLI.

## Install

```sh
npm install @mmmnt/feat-runner
```

- Node 20 or later. The package is ESM only.
- `vitest` must be installed in the project you run from. The runner calls `npx vitest run` with the
  project root as the working directory. This repository tests against vitest 3.2.
- `--coverage` needs a vitest coverage provider installed in the project.
- The only runtime dependency is `@mmmnt/feat-types`, which supplies the `EXCLUSIVE_FAULTS` list.
- The generated files you pass must be Feature's (`@mmmnt/feat-emit-ts` output). They import
  `@mmmnt/feat-runtime`.

## Use

```ts
import { plan, runTests } from "@mmmnt/feat-runner";

const specs = [
  { path: "gen/a.test.ts", faults: [] },
  { path: "gen/b.test.ts", faults: ["Connection.BrokerLoss"] },
];

const p = plan(specs);
console.log(p);
// { parallel: [ 'gen/a.test.ts' ], serial: [ 'gen/b.test.ts' ],
//   order: 'parallel then serial', serialWorkers: 1 }

const result = runTests({
  files: specs.map((s) => s.path),
  root: process.cwd(),
  serialFiles: p.serial,
  junitOutput: "reports/feat-junit.xml",
  testTimeoutMs: 60_000,
  hookTimeoutMs: 120_000,
  quiet: true,
});
console.log(result);
process.exit(result.configurationError ? 2 : result.exitCode === 0 ? 0 : 1);
```

`faults` is every fault any scenario of the file arms, written `Operation.Fault`. `feat run` fills it
from the parsed IR. `runTests` is synchronous: it returns when the last pass has ended.

## What one run does

For each pass the runner:

1. Writes a vitest config to `<root>/node_modules/.cache/feat/feat-run.vitest.config.mjs`. It extends
   your own `vitest.config.ts`, `.mts`, `.js` or `.mjs` from the root when there is one, so your
   coverage settings and aliases survive. It then forces `test.include` to exactly the files of the
   pass and sets `passWithNoTests: false`. A vitest config scoped to your unit tests cannot hide
   generated suites, and a pass that collects none fails.
2. Applies `testTimeoutMs` and `hookTimeoutMs` as `test.testTimeout` and `test.hookTimeout` when you
   pass them.
3. Spawns `npx vitest run --config <that file>` from `root`, with a reporter that records
   configuration errors (see below). Unless `quiet` is set it adds vitest's default reporter and
   inherits stdio. With `quiet`, vitest's output is discarded.
4. Adds `--coverage` when `coverage` is set.

The environment of the subprocess is yours plus:

| Variable | Set when | Meaning |
| --- | --- | --- |
| `FEAT_CONFIG` | `configPath` is given | Absolute path of the active config. The generated files resolve their config from it, which is how one generated file serves every tier (ADR-0024). |
| `FEAT_SERIAL` | the serial pass | `1`. The harness refuses an exclusive fault when it is not `1`. |
| `FEAT_CONFIG_ERROR_MARKER` | always | Internal. The path where the reporter leaves its marker. |

On Windows the runner calls `npx.cmd` through a shell and quotes the arguments.

## Passes: parallel, then serial (SPEC-RT-005)

A fault named in `EXCLUSIVE_FAULTS` from `@mmmnt/feat-types` (today `["BrokerLoss"]`) pauses or stops
a container that every spec file shares. A file that arms it while another file runs against the same
product breaks that other file for a reason it cannot see. Namespaces isolate data, not availability.

So the runner splits the run:

- **Parallel pass.** Every file that arms no exclusive fault, with vitest's normal file parallelism.
- **Serial pass.** Every file in `serialFiles`, after the parallel pass, in a second vitest run with
  `--no-file-parallelism --maxWorkers=1` and `FEAT_SERIAL=1`.

A failing parallel pass does not skip the serial pass. The run's exit code is the larger of the two
passes' codes. If only one pass has files, only that pass runs.

`plan(specs)` computes the split. It sweeps the faults each file arms and matches the part after the
dot against `EXCLUSIVE_FAULTS`. One scenario in a file is enough to move the whole file. A file's name
decides nothing. There is no list to keep and no tag to remember, so a new spec that arms
`BrokerLoss` cannot be forgotten. The harness backs this up: it refuses an exclusive fault in a
process that is not the serial one (`FAULT_REQUIRES_SERIAL`), so a hand-run vitest cannot arm it by
accident.

`runTests` takes `serialFiles` as given. It does not call `plan` itself.

## Shards

`feat run --shard i/n` runs a deterministic, disjoint slice of the generated files, for n jobs that
each have their own instruments. The slicing happens in the CLI, before the runner is called: the
files are sorted and dealt round-robin, and the CLI gives the JUnit file a per-shard name
(`feat-junit.shard-2-of-4.xml`) so parallel shards never share evidence. The runner sees only the
slice it is given. Each shard still does its own parallel-then-serial split over its files.

Shards that share one store are not isolated. Give each shard its own instruments.

## Reports

- **JUnit.** Set `junitOutput` (root-relative) and the report is written there. When a serial pass
  follows a parallel one, the serial pass writes `<junitOutput>.serial`, and the runner merges it into
  the main file (`tests`, `failures`, `errors` and `time` add up, every suite is kept) and deletes
  it. Both passes are in one report. `mergeJunit(a, b)` is exported if you need the merge alone.
- **JSON.** Set `jsonOutput` to get vitest's JSON results from the parallel pass. A serial pass does
  not write it, so a run whose files are all serial leaves no JSON file, although `jsonPath` is still
  returned.
- **Coverage.** `coverage: true` passes `--coverage` to each pass. Your own thresholds apply.

## Configuration errors and exit codes

A harness configuration error is something the harness refuses before any effect: an adapter that
cannot honour `clock at`, a fault it does not offer, a namespace conflict. It is raised in
`beforeAll` of a suite, so vitest reports skipped tests rather than a failed one, and its message
would be easy to lose. The runner attaches a small reporter that reads vitest's task tree, including
failed hooks. It marks the run as a configuration error when any error message contains
`Configuration error (exit 2):`.

| Level | Exit | Meaning |
| --- | --- | --- |
| `runTests` result | `exitCode` | vitest's exit code, or the larger of the two passes'. `1` if a process gave none. |
| `runTests` result | `configurationError: true` | A harness refused its configuration in some pass. `exitCode` is still vitest's, usually `1`. Your code decides what to exit with. |
| `feat run` | `0` | Every pass passed. |
| `feat run` | `1` | A test failed, or a pass selected no test. |
| `feat run` | `2` | `configurationError` was set, or two spec files derived one namespace before any ran. |

The code in the message is one of the harness codes. They are listed in
[`@mmmnt/feat-runtime`](https://www.npmjs.com/package/@mmmnt/feat-runtime), for example
`Configuration error (exit 2): [FAULT_UNSUPPORTED] ...`.

Only messages that carry that exact prefix are recognised. An adapter module that cannot be resolved
or loaded fails with its own message, which says "configuration error" in lower case and does not
carry the prefix. That run ends with `configurationError` unset.

## API

```ts
function runTests(opts: RunOptions): RunResult;
function plan(specs: readonly PlannedSpec[], exclusive?: readonly string[]): Plan;
function runPlan(p: Plan, runPass: (files: string[], opts: { serial: boolean }) => number): { exitCode: number };
function runConfigSource(root: string, absFiles: string[], timeouts?: { testTimeoutMs?: number; hookTimeoutMs?: number }): string;
function mergeJunit(a: string, b: string): string;
const CONFIG_ERROR_REPORTER_SOURCE: string;
```

`RunOptions`:

| Field | Meaning |
| --- | --- |
| `files` | Generated test files to run, root-relative. Required. |
| `root` | Project root: the working directory of vitest and the base of every relative path. Required. |
| `junitOutput` | Write a JUnit XML report here (root-relative). |
| `jsonOutput` | Write vitest's JSON results here (root-relative). Parallel pass only. |
| `coverage` | Pass `--coverage`. |
| `quiet` | Discard vitest's console output, for machine use. |
| `serialFiles` | The subset of `files` that run in the serial pass. |
| `testTimeoutMs`, `hookTimeoutMs` | Per-test and per-hook timeouts. `feat run` computes them from the active config with `timingEnvelope` from `@mmmnt/feat-emit-ts`. |
| `configPath` | Absolute path of the active config, handed to the suites as `FEAT_CONFIG`. |

`RunResult`: `exitCode`, `configurationError?`, `junitPath?`, `jsonPath?` (absolute paths, present
when the matching option was set).

`Plan`: `parallel`, `serial`, `order` (`"parallel"`, `"serial"` or `"parallel then serial"`) and
`serialWorkers` (1 when there is a serial pass, else 0). `PlannedSpec`: `{ path, faults }`. `plan`'s
second argument replaces `EXCLUSIVE_FAULTS`, for tests. `runPlan` runs the parallel set, then the
serial set, and returns the larger exit code. `runConfigSource` returns the text of the run config
and `CONFIG_ERROR_REPORTER_SOURCE` the text of the reporter. Both are exported for testing.

## Errors

The runner has no error codes of its own.

| Condition | Result |
| --- | --- |
| `files` is empty | Prints `feat-runner: zero generated test files to execute — refusing a silently empty run.` to stderr and returns `exitCode: 1`. |
| vitest collects no file in a pass | The pass fails (`passWithNoTests: false`). |
| A pass fails | Its exit code counts. The other pass still runs. |
| A harness refused its configuration | `configurationError: true`. |

## What changed in 0.2.0

- **Serial pass for exclusive faults (SPEC-RT-005, ADR-0023).** New `plan` and `runPlan`, the
  `serialFiles` option, and a second vitest run with one worker and `FEAT_SERIAL=1`. The two JUnit
  reports are merged and either pass failing fails the run.
- **Configuration errors are told from failures.** `RunResult.configurationError`, so `feat run`
  exits `2` when a harness refused its configuration.
- **Tier-aware runs (ADR-0024).** New `testTimeoutMs`, `hookTimeoutMs` and `configPath` options. The
  runner hands the active config to the suites as `FEAT_CONFIG` and no longer relies on a timing
  envelope baked into the generated file.

## Specs and decisions

- [SPEC-RT-005](https://github.com/mmmnt/feature/blob/main/packages/feat-runner/serial-faults.feat): the runner's serial pass for exclusive faults.
- [SPEC-RT-003](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/harness-faults.feat): fault arming, consumption and refusal in the harness.
- [SPEC-RT-006](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/harness-namespace.feat): one namespace per spec file.
- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md): fault injection and the observation modes.
- [ADR-0024](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0024-tier-bindings.md): tier bindings, `FEAT_CONFIG`, the timing envelope.
- [Root README](https://github.com/mmmnt/feature#the-cli): the CLI and its exit codes.

## License

MIT

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki
