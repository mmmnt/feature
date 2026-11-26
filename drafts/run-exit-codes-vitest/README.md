# `feat run` exits 1, not 2, on a configuration error under Vitest 4 and 5 (DRAFT)

Status: draft, revised to the owner's rulings of 2026-11-25 (1 "onTestRunEnd only", 2 "Keep >=3.2.0 open", 3 "CI matrix per major"); awaiting the flip. Nothing is built; the amended spec beside this file is a copy of
SPEC-RT-010 at `status draft`.

| File | |
| --- | --- |
| `packages/feat-runner/local-vitest.feat` | SPEC-RT-010 amended: changes 4 to 6, three enforce lines, two outlines (four cases, run once per CI matrix entry) |
| `packages/feat-runner/local-vitest.contract.json` | `RunVitestInput` gains `vitest: "probe"` and `suite`; `RunVitestResult` gains `configurationError` |
| `ci.change.md` | the ci.yml job `runner-vitest` (matrix 3.2.7, 4.1.12, 5.1.2, latest), the planner fix it needs, and what runs locally |

## Which spec owns it

No spec states the "exit 2 on a harness configuration error" rule: it is the README's exit-code table
(`packages/feature/README.md:893`), built by the fix ad2a65d (2026-11-10) without a spec. SPEC-RT-010
(`packages/feat-runner/local-vitest.feat`) is the nearest owner: its handler is
`packages/feat-runner/src/index.ts`, where the reporter lives; it touches
`packages/feature/run-exit-codes.test.ts`, the test of this exit code; it already owns exit 2 for
`VITEST_NOT_INSTALLED` and the vitest peer range. The draft amends it rather than adding a spec.

## Root cause

`packages/feat-runner/src/index.ts:266-275`, `CONFIG_ERROR_REPORTER_SOURCE`: the reporter implements only
`onFinished(files)`. `afterPass` (`:208-210`) reads the marker it writes; without the marker the run's exit is
vitest's own, 1.

Vitest 4 and 5 do not call a reporter's `onFinished`. In the installed packages:

```sh
grep -rn "reporter.onFinished\|\.onFinished?.(" node_modules/vitest/dist/chunks/*.js
```

- 3.2.7: reporters' `onFinished` is called (and `onTestRunEnd` too);
- 4.1.12: the one call left is `client.onFinished?.(files, errors, void 0, executionTime)` in
  `cli-api.B0Pz1_R7.js:9196`, the browser websocket client, not a reporter;
- 5.1.2: the same.

All three call `onTestRunEnd(testModules, unhandledErrors, reason)`.

## Reproduction

Scratch projects, one per vitest, each a copy of `packages/feature/fixtures/fault` (its spec arms
`fault store Append Nonsense`, which the memory adapter does not offer: `FAULT_UNSUPPORTED`), with
`node_modules/@mmmnt/*` linked to the worktree's packages and vitest installed with
`npm install --no-save vitest@<v>`. Then, in each, with the worktree's CLI (main 72f71de, built):

```sh
ENVIRONMENT=spec node <worktree>/packages/feature/bin/run.js generate
ENVIRONMENT=spec node <worktree>/packages/feature/bin/run.js run; echo "exit=$?"
```

| vitest | exit | marker `node_modules/.cache/feat/feat-run.config-error` | `Configuration error (exit 2): [FAULT_UNSUPPORTED]` printed |
| --- | --- | --- | --- |
| 3.2.0 | 2 | written | yes |
| 3.2.7 | 2 | written | yes |
| 4.1.12 | **1** | not written | yes |
| 5.0.0 | **1** | not written | yes |
| 5.1.2 (what `feat init` installs today, `latest`) | **1** | not written | yes |

The same with `run --config feat.namespaced.config.json` (createHarness refuses in `beforeAll`,
`NAMESPACE_CONFIGURED`): exit 2 on 3.2.7, exit 1 on 4.1.12 and 5.1.2.

4.0.0 did not start at all in its scratch project: vitest's "Startup Error: Failed to load custom Reporter"
with `Cannot read properties of undefined (reading 'startsWith')` in vite's module runner, for the
config-error reporter and for any custom reporter. It is not in the table; it looks like 4.0.0 against the
vite npm resolved for it, and the draft pins 4.1.12.

The proposed hook, checked: a scratch reporter with only
`onTestRunEnd(testModules, unhandledErrors)`, walking `errors()` of modules and suites and
`result().errors` of tests through `children`, run directly with each scratch project's generated config
(`node node_modules/vitest/vitest.mjs run --config node_modules/.cache/feat/feat-run.vitest.config.mjs
--reporter=<scratch reporter>`), found the configuration error on 3.2.0, 3.2.7, 4.1.12, 5.0.0 and 5.1.2,
for the in-test refusal; and on 3.2.7, 4.1.12 and 5.1.2 for the `beforeAll` refusal. This was a check of the
API, not product code; nothing was changed in `packages/`.

## Rulings (2026-11-25) and what remains open

1. Reporter hook: `onTestRunEnd` only (ruled).
2. Peer range: stays `>=3.2.0`, open (ruled). A new major is caught by CI: the matrix's `latest` entry runs the
   scenarios, whose `ran` names the proved majors, so the first CI run after vitest 6 ships is red until
   SPEC-RT-010 is amended.
3. Proof: a CI matrix job per major (ruled); `ci.change.md` has the job. Open points for the owner:
   - `latest` floats, so a red build can appear on a commit that changed nothing, and the local gate goes red too
     (it runs the Node 24 instances by default). Dropping `latest` keeps CI reproducible and loses the catch.
   - The planner names a job instance's files by job key only; four instances of one job overwrite each
     other's steps today (checked). The change includes that fix to `scripts/ci-local-plan.mjs`, so the spec
     touches it.
   - The job fetches vitest from the registry at CI time, outside the lockfile: exact versions and
     `--ignore-scripts`, `latest` excepted.
4. `feat init`'s vitest: with the open range, init keeps installing `latest`; nothing to change.
5. ADR: not needed.
