# @mmmnt/feature

**The `feat` CLI.** The toolchain for the `.feat` execution specification
language. A `.feat` file instructs how a feature is built, predicts every
observable effect it will produce, and compiles deterministically into complete
test suites. Anything unpredicted is a failure.

```sh
npm install --save-dev @mmmnt/feature
npx feat init                       # scaffolds config + a first spec, installs everything else

npx feat generate                   # compile specs into test files
ENVIRONMENT=local npx feat run      # execute them with the adapter lifecycle
```

## Where it sits

`feat` is the orchestrator. It owns the commands, the config, the evidence and
the exit codes, and delegates the work:

| Step | Package | What it does |
| --- | --- | --- |
| parse | [`@mmmnt/feat-core`](https://www.npmjs.com/package/@mmmnt/feat-core) | `.feat` source to the BuiltSpec IR, with the closed reference spaces checked |
| derive | `@mmmnt/feat-derive` | IR to a test topology: one case per scenario, one per outline row |
| emit | `@mmmnt/feat-emit-ts` | topology to a Vitest test file, byte-for-byte deterministic |
| run | `@mmmnt/feat-runner` | spawns `vitest run` on exactly the generated files |
| harness | `@mmmnt/feat-runtime` | loads the config, loads adapters, opens the capture window, diffs the prediction |
| analyze | [`@mmmnt/feat-analyze`](https://www.npmjs.com/package/@mmmnt/feat-analyze) | lint, audit, format |
| contracts | [`@mmmnt/feat-types`](https://www.npmjs.com/package/@mmmnt/feat-types) | the IR, the config and the adapter interfaces |

The package exposes one binary, `feat`. It is not a library: its `main` exports
only the oclif `Parse` command class, which is an implementation detail. To parse
in code, use `@mmmnt/feat-core`.

## Install

```sh
npm install --save-dev @mmmnt/feature
```

Requirements:

- **Node 20 or later** (the repository's `engines` field).
- **Vitest** in the project. Generated suites are ordinary Vitest files and
  `feat run` spawns `npx vitest run`. `feat init` installs it.
- **`@mmmnt/feat-runtime`** in the project. Every generated test imports it.
- **The adapters your config names**, installed in the project that owns
  `feat.config.json`. An npm adapter resolves from the project's own
  `package.json`, never from the toolchain's `node_modules`.
- **git**, only for `feat diff` and for the commit in an evidence bundle.

`feat init` installs the starter set: `@mmmnt/feat-runtime`,
`@mmmnt/feat-adapter-handler`, `@mmmnt/feat-adapter-fs`,
`@mmmnt/feat-schema-json` and `vitest`. It detects your package manager from a
lockfile (`pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`), then from
`npm_config_user_agent`, and falls back to npm. It installs only what
`package.json` does not already declare.

## Quick start

```sh
npx feat init --no-install     # print the install command instead of running it
```

`feat init` writes three files, plus `package.json` when there is none, and stops
with exit `2` if `feat.config.json` already exists. It checks only that file, so it will overwrite an existing
`specs/greet.feat`.

```
created feat.config.json
created specs/greet.feat
created specs/greet.contract.json
created package.json              # only when there was none
```

The scaffold is a one-command project: a `Greet` handler at `src/greet.ts`, a
filesystem service, and a spec in `draft`. Write the handler, flip the spec to
`agreed` when it says what you mean, and run the chain:

```ts
// src/greet.ts
export async function greet(input: { name: string }) {
  if (input.name === "") return { status: "ERR", body: { code: "EMPTY_NAME", message: "blank" } };
  return { status: "OK", body: { message: `Hello, ${input.name}` } };
}
```

```sh
npx feat parse specs/greet.feat      # validate; prints the IR
npx feat generate                    # writes specs/greet.test.ts
ENVIRONMENT=local npx feat run       # 2 tests pass
```

`feat run` needs an environment name, and the scaffolded config does not set
one. Set `ENVIRONMENT` or `FEAT_ENVIRONMENT`, or put `"environment"` in the
config (see [Environment](#environment)).

## Project layout

| What | Where |
| --- | --- |
| Config | `feat.config.json` (any path via `--config`) |
| Specs | `**/*.feat` under `specs.dir` |
| Contracts | `<name>.contract.json`, beside the spec it pairs with |
| Generated tests | `specs.outputPattern` with `{name}` replaced, beside the spec: `specs/greet.feat` gives `specs/greet.test.ts`. Commit them. |
| Run artifacts | `.feature/` (evidence bundles, the variables sidecar), and the JUnit file wherever `report.junitOutput` points. Generated; gitignore them. |
| Runner scratch | `node_modules/.cache/feat/` (the runner's Vitest config and reporter) |

Discovery skips these directories wherever they appear: `node_modules`, `dist`,
`.turbo`, `.git`, `coverage`, `reports`, and `fixtures` (fixture `.feat` files
are test vectors, not project specs).

## Configuration: `feat.config.json`

Every command reads the config through one loader, so a refused config is the
same refusal everywhere. The paths in the table below resolve like this:
`specs.dir` against **the directory you run `feat` from**, and adapter
`module` paths and relative adapter specifiers against **the directory holding
the config**.

A config that uses every field:

```json
{
  "featVersion": "1.0",
  "environment": "spec",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "@mmmnt/feat-adapter-handler",
    "invoke": { "timeout": 10000 },
    "commands": {
      "CreateUser": { "module": "src/create-user.mjs", "export": "createUser", "namespace": true }
    },
    "actors": {
      "default": "operator",
      "operator": { "role": "operator" },
      "auditor": { "role": "auditor" }
    }
  },
  "services": {
    "database": { "adapter": "@mmmnt/feat-adapter-memory", "consistency": "strong" },
    "events": {
      "adapter": "@mmmnt/feat-adapter-memory",
      "consistency": "eventual",
      "convergenceTimeout": 2000,
      "absenceTimeout": 500,
      "options": {}
    }
  },
  "specs": {
    "dir": "specs",
    "pattern": "**/*.feat",
    "contractPattern": "**/*.contract.json",
    "outputPattern": "{name}.test.ts",
    "exclude": ["drafts/**"]
  },
  "report": { "format": ["console", "junit"], "junitOutput": ".feature/reports/feat-junit.xml" }
}
```

Unknown keys are refused: every object in the schema is closed except
`response.invoke`, `response.commands.<Name>`, `response.actors.<name>` and
`services.<key>.options`, which belong to the adapters.

### Top level

| Field | Required | Meaning |
| --- | --- | --- |
| `featVersion` | no | Language version the project targets, `"<major>.<minor>"`. |
| `extends` | no | Makes this file a tier overlay of the named base. See [Tiers](#tiers-one-set-of-specs-an-overlay-per-environment). |
| `environment` | no | The environment this config verifies, `^[a-z][a-z0-9-]*$`. See [Environment](#environment). |
| `schemas` | yes | `{ adapter }`: the schema adapter, used when generating. |
| `response` | when specs use `when:` or `execute` | How a stimulus reaches the system. Deliver-only projects omit it. |
| `services` | yes | One entry per observable service. At least one. |
| `specs` | yes | Where specs are and where tests go. |
| `report` | no | Reporting. |

### `schemas`

| Field | Meaning |
| --- | --- |
| `adapter` | An npm package name or a local path. The module must export `createAdapter`. The standard one is `@mmmnt/feat-schema-json`. It resolves contract `$ref`s, bundles cross-file and sibling references so the generated test is self-contained, and validates seed values. A project may supply its own. |

If the adapter cannot be loaded, `feat generate`, `verify` and `run` stop with
`Schema adapter '<name>' (feat.config.json › schemas.adapter) could not be loaded`.
They never fall back to reading the referenced file verbatim.

### `response`

| Field | Required | Meaning |
| --- | --- | --- |
| `adapter` | yes | The response adapter, for example `@mmmnt/feat-adapter-handler` or `@mmmnt/feat-adapter-http`. |
| `commands` | yes, at least one | `CommandName` to the adapter's invocation shape (handler: `{ module, export }`, HTTP: `{ method, path }`). **A closed space:** a `when:` or `execute` that names a command not in this map is `UNKNOWN_COMMAND` at parse time. |
| `commands.<Name>.namespace` | no | `true` declares that a handler route reads `ctx.namespace`. The harness then refuses the route with `NAMESPACE_NOT_HONOURED` if it never does. Absent means never checked (SPEC-ADPHND-002). |
| `actors` | no | `name` to the adapter's auth material. **A closed space:** an `as <actor>` for a name not here is `UNKNOWN_ACTOR`. `default` is a string naming the actor used when a trigger has no `as`. `anonymous` is reserved, always allowed, and never declared. |
| `invoke` | no | Adapter-wide invocation config (base URL and headers, host and proto path, ...). A numeric `invoke.timeout` is also the per-invoke allowance in milliseconds that sizes the test timeout (default 30 000). |

### `services`

Each key is a service name, and the **only valid prediction target** (a closed
space: a prediction, seed, delivery or fault that names another key is
`UNKNOWN_SERVICE_KEY`).

| Field | Required | Meaning |
| --- | --- | --- |
| `adapter` | yes | The service adapter module. |
| `consistency` | yes | `acid`, `strong` or `eventual`. `eventual` services are read after a wait, and their `has` lists compare unordered unless a spec writes `has ordered [...]`. The other two compare ordered. |
| `convergenceTimeout` | when `eventual` | Milliseconds. The ceiling of the wait before capture. Missing on an `eventual` service is `MISSING_CONVERGENCE_TIMEOUT`. |
| `absenceTimeout` | no | A shorter wait for absence proofs on `eventual` services. This release accepts and records it in the evidence bindings, but the harness does not read it. |
| `options` | no | Adapter-specific options. A `namespace` key here is refused (`NAMESPACE_CONFIGURED`). |

### `specs`

| Field | Required | Meaning |
| --- | --- | --- |
| `dir` | yes | Directory searched recursively for `.feat` files, relative to the working directory. |
| `pattern` | yes | Required by the schema. The CLI in this release does not read it: it finds every `*.feat` under `dir`. |
| `contractPattern` | yes | Required by the schema. Not read either: a spec's contract is always `<name>.contract.json` beside it. |
| `outputPattern` | yes | Name of the generated file. `{name}` is the spec's file name without `.feat`. |
| `exclude` | no | Globs, relative to `dir`, that remove spec files from this config's run. `**` crosses directories, `*` and `?` do not. |

### `report`

| Field | Meaning |
| --- | --- |
| `format` | A non-empty list of `console` and `junit`. |
| `junitOutput` | Where `feat run` writes JUnit XML. It is written only when `format` includes `junit` and this is set. `feat report` reads this path. |

### Refusals

A config that cannot be used exits `2` with `ERROR [CODE] message`.

| Code | Meaning |
| --- | --- |
| `CONFIG_NOT_FOUND` | no file at the path |
| `INVALID_CONFIG` | not valid JSON, or violates the schema (the message names the first problem, for example `config root must have required property 'services'`); also an overlay that redeclares `featVersion` or `schemas`, or a base that is unreadable or invalid |
| `MISSING_CONVERGENCE_TIMEOUT` | an `eventual` service with no `convergenceTimeout` |
| `EXTENDS_NOT_FOUND` | the base named by `extends` does not exist |
| `EXTENDS_CHAIN` | the base itself has `extends` |
| `TIER_SPACE_MISMATCH` | the overlay adds a service, or adds or removes a command or an actor |

The schema is
[`schemas/feat.config.schema.json`](https://github.com/mmmnt/feature/blob/main/schemas/feat.config.schema.json).

## Commands

Every command takes `-c, --config <path>` (default `feat.config.json`) except
`init`. Run `feat <command> --help` for the flags.

### `feat init [--no-install]`

Scaffolds the project (see [Quick start](#quick-start)). `--no-install` skips
the install and prints it. Exit `2` with `ALREADY_INITIALIZED` when
`feat.config.json` exists. If the install fails, `init` warns, prints the command
to run yourself, and still exits `0`.

### `feat parse <file> [-c <config>]`

Validates one spec against the config and prints its IR as JSON on success.
Catches syntax errors and every closed-reference violation.

```
$ feat parse specs/bad.feat
ERROR [MISSING_PRAGMA] specs/bad.feat:1
  The first non-comment line must be a version pragma, e.g. 'feat 1.0'.
  Hint: Add 'feat 1.0' as the first line.
```

Exit `0`, `1` for a parse error (the codes are in
[`@mmmnt/feat-core`](https://www.npmjs.com/package/@mmmnt/feat-core)), `2` for a
refused config.

### `feat generate [-c <config>]`

Compiles every spec under `specs.dir` into its test file: parse, derive,
resolve schemas and goldens, check seeds, emit. It writes nothing unless every
spec succeeded. A seed violation, a parse failure or an unloadable schema
adapter stops the run with exit `1`. A refused config is exit `2`.

```
generated specs/greet.test.ts  (from specs/greet.feat)
1 test file(s) generated.
```

The same spec, contract and closed spaces always give the same bytes, in every
tier. The file header carries an `Inputs-hash`.

### `feat verify [-c <config>]`

The CI integrity gate. Regenerates in memory and byte-compares with the
committed files. A missing or different file fails the build.

```
ERROR [VERIFY_FAILED] Committed tests do not match current specs:
  specs/greet.test.ts (differs)
  Run "feat generate" and commit the updated files.
```

Exit `1` on drift, `2` on a refused config. (A failing run also prints a stray
`ERROR EEXIT: 1` line after the message. The exit code is unaffected.)

### `feat run [-c <config>] [--spec <id>] [--coverage] [--shard <i/n>]`

Executes the generated tests with the full adapter lifecycle, through
`vitest run`.

| Flag | Meaning |
| --- | --- |
| `--spec <id>` | Run only the spec with this id (`SPEC-EX-001`). No match is exit `1`. |
| `--coverage` | Pass `--coverage` through to Vitest. Your coverage provider and thresholds apply. |
| `--shard <i/n>` | Run slice `i` of `n`. See [Shards](#shards). |

What it does, in order:

1. Loads the config (exit `2` if refused) and resolves the
   [environment](#environment) (a missing one is an error before any work).
2. Deletes the previous variables sidecar, so a stale one cannot exist.
3. Generates in memory to learn each spec's file and faults. **It does not
   rewrite or compare the files on disk.** It runs what is committed, so run
   `feat verify` first.
4. Filters by `--spec` and `--shard`.
5. Derives every file's [namespace](#namespaces) and stops on a collision.
6. Stops with `NOT_GENERATED` (exit `1`) if a generated file is missing.
7. Computes timeouts from the active config and spawns Vitest. Files that arm an
   exclusive fault run last, alone (see [Faults](#faults-and-the-serial-pass)).
8. Prints `junit: <path>` when a JUnit file was written.

The run exits `0` when every test passes and `1` when any fails. It exits `2`
when the harness refused its configuration: a clock, fault or observation mode
an adapter cannot serve, a namespace problem, a bad adapter. The output carries
the refusal's code, for example
`Configuration error (exit 2): [FAULT_UNSUPPORTED] ...`.

A failed prediction names the spec, the scenario, the path, what was expected
and what was captured:

```
Prediction violated:
  SPEC-EX-001 › "greets by name" › response › message: expected string matching /Ada/, got "Hello, stranger"
```

### `feat report [-c <config>] [--junit] [--evidence] [--out <path>] [--force]`

Summarises the last run from its JUnit file: one line per suite with test,
failure and error counts, then a total. Exit `1` if anything failed.

| Flag | Meaning |
| --- | --- |
| `--junit` | Print the absolute path of the JUnit XML, for CI or Xray import. |
| `--evidence` | Write a `feat-evidence/2` bundle and exit. See [Evidence](#evidence-bundle). |
| `--out <path>` | With `--evidence`: the output path, replacing the convention. |
| `--force` | With `--evidence`: write even for the `local` environment. |

With no JUnit file (`report.junitOutput` unset, or `feat run` has not run) it
exits `2` with `NO_REPORT`.

### `feat audit [-c <config>]`

The buildability gate (ADR-0008) over every spec. Per spec it runs
[`auditSpec`](https://www.npmjs.com/package/@mmmnt/feat-analyze): **B1** a
handler for code-producing types, **B3** a `touches` change boundary, **B2**
two-way traceability between `rejects X` lines and predicted `rejection X`
scenarios. It adds two warnings that need the filesystem: no paired
`.contract.json`, and no generated test file. A parse failure counts as an
error. Exit `1` if any spec has an error. Warnings never fail the run.

```
✗ specs/greet.feat (SPEC-EX-001, status built)
    ERROR B2: predicted rejection 'EMPTY_NAME' has no `rejects EMPTY_NAME when …` line

audit: 1 spec(s), 1 with errors, 0 warning(s).
```

### `feat lint [-c <config>]`

Language-quality warnings: unused schema declarations, unused variables,
duplicate contract declarations, and a note for `draft` specs. Exit `1` only
when a spec does not parse. Warnings never fail the run.

### `feat fmt [-c <config>] [--check]`

Conservative formatting: strips trailing whitespace, collapses blank-line runs,
ends the file with one newline. Content-preserving and idempotent. Without
`--check` it rewrites files. With `--check` it prints `would format <file>` and
changes nothing. Exit `1` with `--check` when any file would change, and exit
`1` when a file has a tab as its first character (it reports and does not touch
that file).

### `feat watch [-c <config>] [--run] [--json] [--src <dir>...]`

Regenerates on change. It watches `specs.dir` for `.feat` and
`.contract.json` files. The first cycle writes every test file, and later cycles
rewrite only the files whose generated bytes changed. A config edit is not
watched; restart the command.

| Flag | Meaning |
| --- | --- |
| `--run` | Run the affected suites after each regeneration. The first cycle runs everything. |
| `--json` | Emit one NDJSON event per line on stdout. Implies `--run`. |
| `--src <dir>` | Also watch this directory. A change reruns **all** suites without regenerating. Repeatable. Changes to `*.test.ts` there are ignored. A missing directory is skipped. |

The `--json` events are the IDE surface. Each carries `ts` (an ISO timestamp):

| `event` | Fields |
| --- | --- |
| `generate` | `reason`, `files` (`[{ spec, output }]`), `changed` (output paths rewritten) |
| `source-change` | `reason`, for a `--src` change |
| `run` | `exitCode`, `suites` (`[{ spec, output }]`), `cases` (`[{ suite, name, state, message? }]`, `state` is `passed`, `failed` or `skipped`) |
| `error` | `reason`, `message`, when a cycle failed (parse failure, seed violation, ...) |

It writes a temporary report under `.feat-watch/`. Stop it with Ctrl-C.

### `feat diff <file> [-c <config>] [--ref <ref>]`

A spec-level change summary against a git ref (default `HEAD`), for PR review.
It compares IRs, so a comment or a reformat changes nothing. `<file>` is a path
from the directory you run in, which must be the repository root.

```
status: agreed → built
+ scenario "greets another"
- scenario "rejects a blank name"
~ scenario "greets by name" changed
- contract error GreetError
```

The lines are `status: a → b`, `+ scenario`, `- scenario`, `~ scenario ... changed`,
`+ contract <kind> <Schema>`, `- contract ...`, or `no IR-level changes`. If the
file does not exist at the ref it prints
`new spec (<id>) — not present at <ref>`. If the old version does not parse under
the current config it lists every scenario as new. Exit `1` when the current
spec does not parse.

## Environment

`feat run` and `feat report --evidence` need to know what they are verifying.
The name resolves in this order, and none of them is an error before any work:

1. `environment` in the config (an explicit override);
2. the `FEAT_ENVIRONMENT` environment variable;
3. the `ENVIRONMENT` environment variable.

A name is lowercase letters, digits and hyphens. The environment is stamped into
the evidence bundle. The `local` environment records no evidence unless you pass
`--force`: compliance windows begin above local.

## Tiers: one set of specs, an overlay per environment

The same specs run at two tiers: the **spec tier** (in-process, in-memory,
`strong`) and the **integration tier** (real products through product adapters,
real consistency, real timeouts). A tier is an overlay config that `extends` a
base (ADR-0024).

The base, `feat.config.json`, is the spec tier:

```json
{
  "featVersion": "1.0",
  "environment": "spec",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "@mmmnt/feat-adapter-handler",
    "commands": { "Ping": { "module": "src/ping.mjs", "export": "ping" } }
  },
  "services": {
    "events": { "adapter": "@mmmnt/feat-adapter-memory", "consistency": "strong" }
  },
  "specs": {
    "dir": "specs",
    "pattern": "**/*.feat",
    "contractPattern": "**/*.contract.json",
    "outputPattern": "{name}.test.ts"
  }
}
```

The overlay, `feat.integration.config.json`:

```json
{
  "extends": "./feat.config.json",
  "environment": "integration",
  "services": {
    "events": {
      "adapter": "@mmmnt/feat-adapter-kurrent",
      "consistency": "eventual",
      "convergenceTimeout": 5000,
      "options": { "connectionStringEnv": "FEAT_KURRENT_URL" }
    }
  },
  "specs": {
    "dir": "specs",
    "pattern": "**/*.feat",
    "contractPattern": "**/*.contract.json",
    "outputPattern": "{name}.test.ts",
    "exclude": ["transport/**"]
  }
}
```

```sh
npx feat run                                          # the spec tier
npx feat run --config feat.integration.config.json    # the integration tier
```

The rules:

- **One level.** `extends` is a path relative to the overlay. A base that itself
  extends is `EXTENDS_CHAIN`. A missing base is `EXTENDS_NOT_FOUND`.
- **Replace whole, per key.** The overlay replaces `environment`, `response`,
  `specs` and `report` as a whole, and `services` key by key. There is no deep
  merge: an overlay's adapter `options` never inherit the base's. A service key
  the overlay does not name is inherited from the base, so an overlay cannot
  remove a service.
- **Inherited.** `featVersion` and `schemas` come from the base and may not be
  redeclared (`INVALID_CONFIG`). `environment` is **not** inherited: an overlay
  without one resolves it from `FEAT_ENVIRONMENT` or `ENVIRONMENT`, so a bundle
  is never stamped with the base's name by accident.
- **Validated after merging.** The overlay file alone need not carry `schemas`,
  `services` or `specs`. The merged document is checked, including
  `MISSING_CONVERGENCE_TIMEOUT`.
- **Parity.** An overlay may not add a service, and may not add or remove a
  command or an actor. `TIER_SPACE_MISMATCH` at load, exit `2`, with the space
  (`service`, `command`, `actor`), the change (`added`, `removed`) and the name:
  `Overlay 'feat.integration.config.json' adds command 'Extra', which the base does not declare.`
  Specs are parsed against the base, so a spec means the same thing in both tiers
  by construction.
- **`specs.exclude`** removes spec files from a tier, for example transport-fault
  specs from the spec tier. Because `specs` is replaced whole, an overlay that
  sets `exclude` states the other four `specs` fields too.
- **Generated files are tier-independent.** The `Inputs-hash` covers the spec
  text, the contract text, `featVersion`, and the **names** of the services,
  commands and actors, nothing else. Adapters, consistency, timeouts and options
  never enter it, so `feat generate` and `feat verify` give the same bytes
  whichever tier's config you pass, and changing a timeout regenerates nothing.
  The file embeds the base's path, and `feat run` hands the active config to the
  suites as `FEAT_CONFIG`.
- **Ordering and timing follow the active tier.** The default `has` ordering is
  resolved by the harness from the active config's `consistency`, and `feat run`
  computes Vitest's `testTimeout` (the per-invoke allowance times the steps of
  the worst case, plus the longest `convergenceTimeout`, plus 30 s) and
  `hookTimeout` (120 s) from the active config.
- **Two unrelated config files are not an overlay.** Nothing then keeps their
  spaces equal, and the generated files differ per tier.

This repository runs itself this way:
[`feat.config.json`](https://github.com/mmmnt/feature/blob/main/feat.config.json)
is the spec tier and
[`feat.integration.config.json`](https://github.com/mmmnt/feature/blob/main/feat.integration.config.json)
is the integration tier.

## Seeds

A `seed` puts state into a service before the capture window opens, through the
adapter's `seed()`. Seed data is literal: no matchers, no `@when`.

**Inline**, a list of records, each optionally validated against a contract
schema with `with`:

```feat
scenario "add an item":
  given:
    The store already holds seeded state.
    seed store [ ItemAdded with ItemEvent { itemId: "11111111-0000-4000-8000-000000000001", name: "Item-1" } ]
  when: AddItem { itemId: "22222222-0000-4000-8000-000000000009" }
  predict rejection ITEM_EXISTS:
    response 409 ItemError
    store has []
```

**Fixture**, bulk state from a JSON file, resolved against **the directory of
the spec that names it** (not the config directory or the working directory):

```feat
scenario "add an item":
  given:
    The store already holds seeded state.
    seed store from "data/items.json"
  when: AddItem { itemId: "22222222-0000-4000-8000-000000000009" }
  predict rejection ITEM_EXISTS:
    response 409 ItemError
    store has []
```

A fixture is a JSON array of `{ type, schemaName?, values }` records, the shape
of an inline record. A record with a `schemaName` must name a schema in the
spec's contract and its `values` must validate against it. A record without one
is shape-checked only.

```json
[
  { "type": "ItemAdded", "schemaName": "ItemEvent", "values": { "itemId": "11111111-0000-4000-8000-000000000001", "name": "Item-1" } },
  { "type": "ItemRenamed", "schemaName": "ItemEvent", "values": { "itemId": "11111111-0000-4000-8000-000000000002", "name": "Item-2" } }
]
```

**Checked at generate time (SPEC-GEN-001).** `feat generate`, and so `verify`,
`run` and `watch`, read every fixture, check its shape, check each `schemaName`
against the contract's closed space, validate values through the configured
schema adapter, and inline the checked records into the generated test. The test
reads no fixture at run time. Inline records get the same values check. Every
violation across every spec is collected and reported together, in spec,
scenario, row, seed, record order, and **nothing is written**.

```
ERROR 1 seed violation(s); nothing was generated:
SEED_FIXTURE_SCHEMA_UNDECLARED: data/items.json record 1: schema 'NoSuchSchema' is not declared in the contract (declared: AddItemInput, ItemEvent, ItemRow, ItemError)
```

| Code | When |
| --- | --- |
| `SEED_FIXTURE_NOT_FOUND` | the resolved path names no readable file |
| `SEED_FIXTURE_NOT_JSON` | the file is not valid JSON |
| `SEED_FIXTURE_NOT_RECORDS` | the JSON is not an array of `{ type, schemaName?, values }` records (the message names the record index and what is missing) |
| `SEED_FIXTURE_SCHEMA_UNDECLARED` | a record's `schemaName` is not in the contract |
| `SEED_FIXTURE_VALUES_INVALID` | a fixture record's `values` fail its schema |
| `SEED_VALUES_INVALID` | an inline record's values fail its schema, in a scenario that is not an outline |
| `SEED_ROW_VALUES_INVALID` | an inline record's values fail its schema in one row of a scenario outline |

An undeclared schema name on an **inline** record never reaches this step: the
parser refuses it as `UNDECLARED_SCHEMA`.

**Outlines and `SEED_ROW_VALUES_INVALID`.** In a `scenario outline`, each example
row gets its own copy of every inline seed record, with the row's values
substituted first (SPEC-DRV-001): a whole-value `<placeholder>` takes the row's
value, and a placeholder inside a string stays literal (`"Item-<n>"` is not
rewritten). Each row is then checked on its own, so one bad row is one violation
and the others raise nothing. The anchor ends in `› row[n]`, with `n` counting
from 1:

```feat
scenario outline "seed per row":
  given:
    The store already holds seeded state.
    seed store [ ItemAdded with ItemEvent { itemId: <id>, name: "Item-<n>" } ]
  when: AddItem { itemId: "22222222-0000-4000-8000-000000000009" }
  predict rejection ITEM_EXISTS:
    response 409 ItemError
    store has []
  examples:
    | id | n |
    | "11111111-0000-4000-8000-000000000001" | 1 |
    | 7 | 2 |
```

Row 2 supplies `7` for `itemId`, which the contract says is a string, so
generation stops:

```
ERROR 1 seed violation(s); nothing was generated:
SEED_ROW_VALUES_INVALID: scenario "seed per row" given › seed[0] record 0 › row[2]: values fail schema 'ItemEvent': /itemId must be string
```

An inline seed with no placeholder is still checked in every row, so one bad
record is one violation per row. A **fixture** seed in an outline is never
substituted (a path written as a placeholder is looked up as written, and is
`SEED_FIXTURE_NOT_FOUND`). It is read, checked and counted once, and every row
carries its checked records.

## Namespaces

Spec files run in parallel, often against one product. So that two files never
see each other's data, the runner gives **each spec file its own namespace**
(SPEC-RT-006), derived from the file's path alone: `s` plus the first 12 hex
characters of the SHA-256 of the spec's path relative to the base config's
directory, with `/` separators and no leading `./`. `specs/greet.feat` is
`sb0e796f7f361`. The pattern is `^s[0-9a-f]{12}$`.

The namespace reaches every adapter as `config.namespace` and as the
`FEAT_NAMESPACE` environment variable, and is delivered to a spec host (a
product adapter's out-of-process helper) too. Adapters isolate their data under
it. Namespaces isolate **data**, not availability: an exclusive fault still
affects a shared product.

Refusals, all exit `2` before any case has an effect:

| Code | When |
| --- | --- |
| `NAMESPACE_COLLISION` | two files in one run derive the same namespace; one must move (checked by `feat run` before it starts) |
| `NAMESPACE_CONFIGURED` | a `namespace` key is written in the config, in `response`, `response.invoke` or a service's `options`. A configured value would be shared by every file. |
| `NAMESPACE_NOT_HONOURED` | an adapter or host reports a namespace other than the one it was given, or a handler route with `namespace: true` never read it |

## Faults and the serial pass

A `given:` block may arm logical faults (ADR-0023), as preconditions:

```feat
given:
  fault database Put TIMEOUT { "ms": 5 } times 2
  fault broker Connection Partition until reset
```

The form is `fault <service> <Operation> <Fault> [{ json }] [once | times <n> | until reset]`.
The harness arms them after the seeds and executes and before the capture
window, in written order. A fault is never an assertion: the scenario predicts
the system's reaction with the usual forms. Three refusals matter to a run:

| Code | Exit | When |
| --- | --- | --- |
| `FAULT_UNSUPPORTED` | `2` | the adapter has no `fault()`, offers no such operation or fault, does not declare that count, or cannot carry a detail. Before any effect. |
| `FAULT_REQUIRES_SERIAL` | `2` | an exclusive fault (`BrokerLoss`) armed outside the serial pass |
| `FAULT_NOT_CONSUMED` | `1` | an armed fault the system never consumed (a prediction violation). Skipped for an adapter that cannot observe consumption. |

**The serial pass (SPEC-RT-005).** A spec file that arms an exclusive fault
(`BrokerLoss`, which pauses a container every namespace shares) cannot run
beside other files. `feat run` finds those files from the IR, never by name, runs
every other file in the parallel pass, then runs the exclusive ones in a second
Vitest pass with one worker and `FEAT_SERIAL=1`. The two JUnit reports are
merged into one.

## Shards

`--shard i/n` runs one disjoint slice of the generated files, so a suite whose
services share one store can run as `n` parallel jobs. The files are sorted by
path and dealt round-robin, so every job computes the same partition with no
coordination.

```sh
npx feat run --shard 1/4    # in job 1
npx feat run --shard 2/4    # in job 2, with its OWN instruments
```

- **Each shard needs its own instruments.** Shards that share a store are not
  isolated.
- Each shard writes its own JUnit file: `feat-junit.xml` becomes
  `feat-junit.shard-2-of-4.xml`. Collect them yourself. `feat report` reads the
  unsuffixed path.
- More shards than files leaves some slices empty. An empty slice prints
  `shard i/n: 0 file(s)`, writes no JUnit file, and exits `0`.
- `i/n` must satisfy `1 <= i <= n`, otherwise exit `1`.
- `--shard` combines with `--spec`.

## JUnit and `feat report`

With `report.format` containing `junit` and `report.junitOutput` set, `feat run`
writes JUnit XML there. Each test case is a scenario, named
`SPEC-ID: Spec name > scenario name`, so a failure points at spec coordinates,
not a generated line. `feat report --junit` prints the absolute path for CI or
Xray import.

```json
{ "report": { "format": ["console", "junit"], "junitOutput": ".feature/reports/feat-junit.xml" } }
```

## Evidence bundle

`feat report --evidence` writes a self-contained, digest-anchored
`feat-evidence/2` record of the project's spec state and results. It is a record,
not a gate: it never fails the build by itself, and it needs no account.

```sh
feat run                       # optional, populates the run block
feat report --evidence         # writes .feature/evidence/<environment>/<commit>[-<config>][-dirty].json
```

```
evidence: .feature/evidence/ci/ae34f95486becc5b97d2acc3aaf176245cb71f94.json
evidence: specs 1, verify pass, run pass, environment ci
```

The bundle holds:

| Block | Contents |
| --- | --- |
| `contract` | `feat-evidence/2` |
| `producer` | the tool, its version, and the exact `@mmmnt` toolchain versions |
| `project` | `feat_version`, `config_digest`, `environment`, the producing `commit`, `config` (see below) and `bindings` |
| `specs` | every spec: path, content digest, id, status, name, context, aggregate, type, handler, a zone-tagged `excerpt`, per-scenario digests, the contract `interface`, and the generated file's digest. A spec that does not parse is listed with `parse_error`. |
| `verify` | `pass`, or `fail` with the mismatched files (`feat verify` semantics) |
| `run` | the last run's test, failure and error counts and a digest of the JUnit file, when one exists |
| `runs` | one entry per scenario: spec id, pass or fail, duration, and parsed violation rows `{ path, expected, got }` |
| `variables` | each case's resolved spec variables, when a spec declares any |
| `signature` | `null` when produced locally |

Conventions:

- **Path.** `.feature/evidence/<environment>/<commit-sha>[-<config-slug>][-dirty].json`.
  The default config keeps the bare `<sha>`. Any other config appends its slug
  (`feat.integration.config.json` gives `-integration`), so a repo that reports
  once per config never overwrites one file. A dirty tree appends `-dirty`, so it
  cannot pass as a clean commit. `--out` replaces the whole path. The file name
  uses `git rev-parse HEAD` (`nosha` outside a git repository). The `commit` field
  inside prefers `GITHUB_SHA` when it is set.
- **Tier provenance (ADR-0024).** `project.config.resolved` is a digest of the
  merged config. For an overlay, `project.config.overlay` and `.base` hold each
  file's path and digest. `project.bindings` records the response adapter and,
  per service, the adapter, consistency and timeouts the run was bound to, so an
  integration-tier bundle is distinguishable from a spec-tier one.
- **Local records nothing.** With environment `local`, `--evidence` prints
  `evidence: skipped` and writes nothing, unless `--force`.

The schema ships in this package as `schemas/evidence.schema.json`. The full
description is
[docs/evidence-bundle.md](https://github.com/mmmnt/feature/blob/main/docs/evidence-bundle.md).

## Environment variables

| Variable | Used by | Meaning |
| --- | --- | --- |
| `ENVIRONMENT`, `FEAT_ENVIRONMENT` | `run`, `report --evidence` | The environment name (see [Environment](#environment)). |
| `FEAT_CONFIG` | generated tests | Set by `feat run` to the active config's absolute path. Set it yourself to run a generated file under another tier with plain Vitest. |
| `FEAT_NAMESPACE` | adapters | The spec file's namespace, set while its adapters are alive. |
| `FEAT_SERIAL` | the harness | `1` in the serial pass. Required to arm an exclusive fault. |
| `FEAT_FENCE_AUDIT` | the harness | Set to wait out the convergence ceiling anyway and fail if a capture grew after a fence vouched. |
| `GITHUB_SHA` | `report --evidence` | The commit recorded in the bundle. |
| `npm_config_user_agent` | `init` | Package manager detection, after lockfiles. |

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | validation failure: a parse error, a seed violation, drift (`verify`), a failed prediction, a failed audit, a failed `fmt --check` |
| `2` | configuration error: a refused config (`CONFIG_NOT_FOUND`, `INVALID_CONFIG`, the `EXTENDS_*` codes, `TIER_SPACE_MISMATCH`, ...), a harness refusal during `run` (`CLOCK_UNSUPPORTED`, `MODE_UNSUPPORTED`, `FAULT_*`, `NAMESPACE_*`), `NO_REPORT`, `ALREADY_INITIALIZED` |

Three paths do not follow the table in this release, and exit `1` where a
configuration error would suggest `2`:

- `feat run` and `feat report --evidence` with no environment resolvable.
  The message says "configuration error".
- `feat diff` with a config that cannot be loaded.
- `feat run` when generation fails (a parse failure or a seed violation).

## In CI

A typical pipeline is three lines:

```sh
feat verify                    # committed tests match the specs
feat run                       # predictions hold against the real system
feat report --junit            # print the JUnit path to import
```

with the environment set (`ENVIRONMENT=ci`). Add `feat audit` to gate on
buildability, and `feat report --evidence` to archive the bundle as a build
artifact. For the integration tier add
`feat run --config feat.integration.config.json`.

## What changed in 0.4.0

Release v0.1.48.

- **Tier overlays (ADR-0024).** `extends`, `specs.exclude`, `TIER_SPACE_MISMATCH`,
  `EXTENDS_NOT_FOUND`, `EXTENDS_CHAIN`. Every command reads the config through
  one loader. Generation is environment-agnostic: the `Inputs-hash` covers only
  the closed spaces, ordering resolves in the harness, and the timing envelope and
  `FEAT_CONFIG` come from `feat run`. This is a one-time change to every committed
  generated file: run `feat generate` once and commit.
- **Seed checks (SPEC-GEN-001, SPEC-DRV-001).** Fixtures are validated and
  inlined at generate time with all violations reported together. An outline
  row's inline seeds are substituted and checked on their own, refused as
  `SEED_ROW_VALUES_INVALID`.
- **Evidence.** The bundle records the overlay, its base and the tier's bindings
  (ADR-0024).
- **Namespaces, faults and the serial pass (SPEC-RT-005, SPEC-RT-006, ADR-0023).**
  One namespace per spec file, `feat run` stops on a collision, and exclusive
  faults run in a serial pass after the parallel one.
- **Exit codes.** `generate` and `verify` exit `2` on a refused config. `run`
  exits `2` when the run failed on a harness configuration error, and the
  generated suite tears down only a harness that was created.

Re-run `feat generate` after upgrading.

## Specs and decisions

The toolchain is specified in `.feat` and built with itself.

- [SPEC-GEN-001](https://github.com/mmmnt/feature/blob/main/packages/feature/generate-seed-fixtures.feat):
  check and inline seed fixtures at generate time
- [SPEC-DRV-001](https://github.com/mmmnt/feature/blob/main/packages/feat-derive/derive-seeds.feat):
  derive substitutes each outline row into its own seeds
- [SPEC-RT-001](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/load-config.feat):
  load and validate `feat.config.json`
- [SPEC-RT-004](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/load-config-extends.feat):
  load a tier overlay
- [SPEC-RT-005](https://github.com/mmmnt/feature/blob/main/packages/feat-runner/serial-faults.feat):
  exclusive faults run in a serial pass
- [SPEC-RT-006](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/harness-namespace.feat):
  one namespace per spec file
- [ADR-0022](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0022-uppercamel-rejection-ids.md):
  rejection ids, `UPPER_SNAKE` or `UpperCamel`
- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md):
  observation modes, the scenario clock, fault injection
- [ADR-0024](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0024-tier-bindings.md):
  tier bindings
- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [Evidence bundle](https://github.com/mmmnt/feature/blob/main/docs/evidence-bundle.md)

## Documentation

- Repository: https://github.com/mmmnt/feature
- Getting started, language guide, CLI reference: https://github.com/mmmnt/feature/wiki

## License

MIT
