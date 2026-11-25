<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo/feature-logo-light.png" />
    <img src="docs/assets/logo/feature-logo-dark.png" alt="feature" height="46" />
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mmmnt/feature"><img src="https://img.shields.io/npm/v/@mmmnt/feature.svg?label=npm" alt="npm" /></a>
  <a href="https://discord.gg/YcRqsQUQuu"><img src="https://img.shields.io/discord/1489758529219723486?color=5865F2&logo=discord&logoColor=white&label=Discord" alt="Discord" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-BSD--3--Clause-blue.svg" alt="License: BSD-3-Clause" /></a>
</p>

# Feature

**Specify a feature once. Get the test suite that holds the code to it.**

Feature is the `.feat` execution specification language and its toolchain. A `.feat` file is the
spec for one command, query, policy, projection or saga. It does three things:

1. **Instructs.** Build directives that the builder, a person or an AI agent, follows: where the
   handler lives, which files it may touch, what it must enforce and what it must refuse.
2. **Predicts.** Every observable effect of each scenario: the response, the events, the records
   written, the messages sent.
3. **Compiles.** Deterministically, into a complete Vitest suite. There are no step definitions and
   no glue code, and no model reads the spec at test time. An effect the system produces that the
   spec did not predict is a failure.

The same spec compiles to the same test file, byte for byte, every time. That is what lets CI check
that the committed tests are the ones the specs say (`feat verify`).

**See it first.** [TicketWave](https://github.com/mmmnt/mmmnt/tree/main/examples/ticketwave), the example ticketing platform modelled in [Moment](https://moment.mmmnt.ai) and rehearsed in [Facet](https://facet.mmmnt.dev), takes its `RequestHold` command from the proven model to a `.feat` spec and the suite it compiles into. [Walk through it on the site.](https://feature.mmmnt.ai/#ticketwave)

## Why Feature

Every spec-to-test approach has a translation layer. Gherkin needs step definitions, contract tools
need hand-written provider tests, and a Markdown spec needs a person, or a model, to decide what it
means. That layer is where drift lives: the spec says one thing, the tests check another, and
nobody notices until production does. A model that turns requirements into tests is the same layer,
moved into an LLM: different every run, and impossible to verify.

Feature has no translation layer. The prediction is the assertion, the suite is derived from the
spec deterministically, and `feat verify` fails the build when the two drift apart.

## From design to running code: Moment, Facet and Feature

Feature is the last of three tools that take a domain from a design to verified code. Each answers
one question and hands the next something it can check.

| | The question it answers | What you write | What you get |
| --- | --- | --- | --- |
| **[Moment](https://moment.mmmnt.ai)** | Is the design complete and consistent over time? | A `.moment` model | Validation, every path through every flow, a board, scenarios, types and documents |
| **[Facet](https://facet.mmmnt.dev)** | Does the design behave the way it says it does? | Nothing. Facet reads what Moment derives | Every scenario replayed and asserted, before any code exists |
| **Feature** | Does the code do what the design decided? | A `.feat` spec for each command, taken from the model | Test suites compiled from the spec, the same ones every time, which gate CI |

A `.feat` spec is cheap to write correctly only once the design has stopped moving, and Facet is
where it stops moving.

## Quick start

Requires Node.js 22 or newer.

```sh
npm install --save-dev @mmmnt/feature
npx feat init
```

`feat init` writes `feat.config.json`, a first spec (`specs/greet.feat`, `status draft`) and its
contract (`specs/greet.contract.json`). It refuses with exit 2 (`ALREADY_INITIALIZED`) if any of the
three exists. It creates a `package.json` if there is none, then installs `@mmmnt/feat-runtime`,
`@mmmnt/feat-adapter-handler`, `@mmmnt/feat-adapter-fs`, `@mmmnt/feat-schema-json` and `vitest`
with the package manager it detects (pnpm, yarn or npm). `--no-install` prints the install command
instead.

```sh
npx feat parse specs/greet.feat   # validate the spec and print its IR
# edit the spec, then change `status draft` to `status agreed`
npx feat generate                 # compile specs/greet.feat into specs/greet.test.ts
# implement src/greet.ts: an exported async function that returns { status, body }
npx feat run                      # red until the handler does what the spec predicts
```

A spec:

```feat
feat 1.0

spec SPEC-USR-001 "CreateUser"
context Users
aggregate User
type command
status agreed

construct:
  handler at handlers/create-user.ts
  touches handlers/**

enforce:
  validate input against CreateUserInput
  rejects DUPLICATE_EMAIL when a user with this email already exists

contract:
  input CreateUserInput
  response UserResponse
  record UserRow
  error ErrorResponse

scenario "successful user creation":
  when: CreateUser { email: "alice@example.com", name: "Alice" }
  predict success:
    response 201 UserResponse { id: any uuid, email: @when.email }
    database has [ INSERT with UserRow { email: @when.email, status: "active" } ]

scenario "rejects duplicate email":
  given:
    execute CreateUser { email: "alice@example.com", name: "Alice" }
  when: CreateUser { email: "alice@example.com", name: "Bob" }
  predict rejection DUPLICATE_EMAIL:
    response 409 ErrorResponse { code: "DUPLICATE_EMAIL" }
    database has []
```

`database` is a service key from `feat.config.json`; the schemas are in the paired
`create-user.contract.json`. The full exemplar, with its config and expected IR, is
[`corpus/create-user/`](corpus/create-user/).

| | |
| --- | --- |
| Specs | `specs/**/*.feat`, each beside its `.contract.json` (`specs` in `feat.config.json`) |
| Generated tests | next to each spec by `specs.outputPattern` (`greet.feat` → `greet.test.ts`), committed |
| Test runner | the project's own Vitest; generated files are standard Vitest suites |
| Reports | JUnit XML from `feat run` when `report.format` includes `junit`; `feat report` summarizes it |

## What Feature does

### The `feat` CLI

Every command that reads a config takes `-c, --config <path>` (default `feat.config.json`).

| Command | What it does |
| --- | --- |
| `feat init [--no-install]` | Scaffold `feat.config.json`, a first spec and contract, and install the starter dependencies. |
| `feat parse <file>` | Parse and validate one spec and print its IR (BuiltSpec JSON). Reports syntax errors and closed-reference violations (an unknown service, command, schema or actor) with the line. |
| `feat generate` | Compile every spec into its test file (parse, derive, emit). |
| `feat verify` | Regenerate in memory and compare with the committed test files; a missing or differing file is `VERIFY_FAILED`. |
| `feat run [--spec <ID>] [--coverage] [--shard <i>/<n>]` | Run the generated suites with the adapter lifecycle (a missing generated file is `NOT_GENERATED`). `--spec` runs one spec, `--coverage` uses the runner's coverage provider, `--shard` runs slice *i* of *n* (each shard needs its own instruments). |
| `feat report [--junit] [--evidence [--out <path>] [--force]]` | Summarize the last run from its JUnit XML; `--junit` prints the XML path. `--evidence` writes a `feat-evidence/2` bundle to `.feature/evidence/<environment>/<sha>.json` ([format](docs/evidence-bundle.md)); the `local` environment is skipped unless `--force`. |
| `feat audit` | Buildability gate (B1 to B3): a code-producing spec has its `handler at`, every spec declares `touches`, and every predicted rejection has its `rejects` line and the reverse. Warns on a draft, a missing paired contract or a missing generated test. |
| `feat audit --changed <base> [-c <config>...]` | The touches gate: every path changed since the merge base of `<base>` and `HEAD`, plus the working tree, is checked against the specs' `touches`. `-c` is repeatable and takes globs. |
| `feat lint` | Language-quality findings: unused or duplicate declarations, drafts, an optional property left unstated (`OPTIONAL_UNSTATED`), a nested block over an open schema (`NESTED_SCHEMA_OPEN`). |
| `feat fmt [--check]` | Conservative, content-preserving formatting; `--check` exits 1 if a file would change. |
| `feat watch [--run] [--json] [--src <dir>...]` | Regenerate on a spec or contract change; `--run` runs the affected suites, `--json` emits NDJSON events (implies `--run`), `--src` adds directories whose changes rerun every suite. |
| `feat diff <file> [--ref <ref>]` | Spec-level change summary against a git ref (default `HEAD`): status, scenarios added, removed or changed, contract entries. |

Exit codes: `0` success, `1` a validation failure (a spec that does not parse, a failed prediction,
drift, a lint or audit error), `2` a configuration error (a config that does not load, no resolvable
environment, an adapter the config cannot use, no JUnit report for `feat report`).

A CI pipeline:

```sh
feat verify          # the committed tests are what the specs compile to
feat audit           # every spec is buildable
feat run --coverage  # the predictions hold against the real system
feat report --junit  # the JUnit path for your CI's test report
```

The full reference, configuration included, is in [`packages/feature`](packages/feature/README.md).

### The language

- [`docs/grammar-reference.md`](docs/grammar-reference.md): the `.feat` v1 reference. It is the
  source of truth: where code and reference disagree, the reference wins.
- [`corpus/`](corpus/README.md): the exemplars, each a `.feat`, its `.contract.json`, its expected
  IR (`.ir.json`) and its `feat.config.json`. The parser is tested against them.
- [`schemas/`](schemas): the language-neutral JSON Schemas for the IR (`builtspec.schema.json`),
  contracts and config. `pnpm corpus:validate` checks the corpus against them.
- [`docs/evidence-bundle.md`](docs/evidence-bundle.md): the `feat report --evidence` format.
- [`docs/adr/`](docs/adr/README.md): the architecture decision records.

### Editor support

[`editors/vscode`](editors/vscode) is the VS Code extension (`mmmnt.feat-vscode`): syntax
highlighting from `@mmmnt/feat-grammar`, and live, spec-anchored test feedback from `feat watch`
(commands **Feat: Start watch** and **Feat: Stop watch**). It is published to the VS Code
Marketplace and Open VSX. [`editor/feat.tmLanguage.json`](editor/feat.tmLanguage.json) is a copy of
the grammar for other editors.

## Packages

All packages are published to npm under `@mmmnt`. Adapters are named in `feat.config.json` and
loaded by package name.

**Toolchain**

| Package | Purpose |
| --- | --- |
| [`@mmmnt/feature`](packages/feature) | The `feat` CLI. |
| [`@mmmnt/feat-core`](packages/feat-core) | Recursive-descent parser, AST to BuiltSpec IR, closed-reference validation. |
| [`@mmmnt/feat-types`](packages/feat-types) | TypeScript types for the IR, config and reports, mirroring `schemas/`. No dependencies. |
| [`@mmmnt/feat-derive`](packages/feat-derive) | BuiltSpec IR and config to a test topology: outline expansion, ordering, query implicit-zero. Pure and deterministic. |
| [`@mmmnt/feat-emit-ts`](packages/feat-emit-ts) | Test topology to a complete, deterministic Vitest file. |
| [`@mmmnt/feat-runtime`](packages/feat-runtime) | What generated tests import: config loading, adapter loading, the capture lifecycle, preconditions, `toMatchPrediction`. |
| [`@mmmnt/feat-runner`](packages/feat-runner) | Runs the project's Vitest as a subprocess: spec filtering, exit codes, JUnit. |
| [`@mmmnt/feat-analyze`](packages/feat-analyze) | Pure lint, audit (B1 to B3) and formatting for specs. |
| [`@mmmnt/feat-grammar`](packages/feat-grammar) | The TextMate grammar for `.feat`, for editors, Shiki and other highlighters. |
| [`@mmmnt/feat-adapter-kit`](packages/feat-adapter-kit) | Conformance suites for adapter authors. |
| [`@mmmnt/feat-cdk`](packages/feat-cdk) | Derives a deployment (resources, SSM contract, dependency closure) from a CDK cloud assembly. |

**Adapters**

| Package | Role | Purpose |
| --- | --- | --- |
| [`@mmmnt/feat-adapter-handler`](adapters/handler) | response | Invokes a module's exported function directly. |
| [`@mmmnt/feat-adapter-http`](adapters/http) | response | Invokes HTTP routes; actor headers from the actor registry. |
| [`@mmmnt/feat-adapter-playwright`](adapters/playwright) | response | A command is a real browser journey. |
| [`@mmmnt/feat-adapter-stdio-jsonrpc`](adapters/stdio-jsonrpc) | response, service | The Feat Host Protocol: JSON-RPC 2.0 on a spec host's stdio. |
| [`@mmmnt/feat-schema-json`](adapters/schema-json) | schema | JSON Schema resolution and validation at generate time. |
| [`@mmmnt/feat-adapter-fs`](adapters/fs) | service | Files written during the capture window. |
| [`@mmmnt/feat-adapter-memory`](adapters/memory) | service | In-memory events for deliver-triggered specs, no infrastructure. |
| [`@mmmnt/feat-adapter-model`](adapters/model) | service | A recorded judge: seeded answers and captured asks in a JSON Lines file; never calls a model. |
| [`@mmmnt/feat-adapter-dynamodb`](adapters/dynamodb) | service | DynamoDB writes captured through DynamoDB Streams. |
| [`@mmmnt/feat-adapter-kafka`](adapters/kafka) | service | Namespaced Kafka topics read at the last stable offset. |
| [`@mmmnt/feat-adapter-kms`](adapters/kms) | service | A snapshot diff of KMS key state. |
| [`@mmmnt/feat-adapter-kurrent`](adapters/kurrent) | service | KurrentDB's `$all` log as the capture window, with a fence-marker settle. |
| [`@mmmnt/feat-adapter-neo4j`](adapters/neo4j) | service | A snapshot diff of the namespace's graph, node and relationship seeds. |
| [`@mmmnt/feat-adapter-redis`](adapters/redis) | service | A snapshot diff of the namespace's keys. |
| [`@mmmnt/feat-adapter-stripe`](adapters/stripe) | service | The Stripe Events API as the capture window. |
| [`@mmmnt/feat-fault-proxy`](adapters/fault-proxy) | library | Transport faults (timeout, reset, partition, broker loss) through Toxiproxy, for the product adapters. |

## Documentation

- **[feature.mmmnt.ai](https://feature.mmmnt.ai)**: what Feature is, the language at a glance, and the TicketWave walkthrough
- **[Grammar reference](docs/grammar-reference.md)**: the `.feat` language, construct by construct
- **[Wiki](https://github.com/mmmnt/feature/wiki)**: core concepts, the architecture, testing mechanics and the package reference
- **[Architecture decisions](docs/adr/README.md)**: why the language and the toolchain are the way they are
- Each package's `README.md` covers its API, and its `CHANGELOG.md` covers what changed in each release

## Developing Feature

Feature is built spec-driven on itself: its components are specified in `.feat` files beside their
code, and their suites are generated by `feat generate` and run by `feat run`.

```sh
pnpm install
pnpm build        # turbo
pnpm typecheck
pnpm test         # package tests (vitest)
pnpm corpus:validate
node packages/feature/bin/run.js verify && node packages/feature/bin/run.js run
```

### The local gate

Run [`scripts/ci-local.sh`](scripts/ci-local.sh) before every push. It runs the ubuntu jobs of
`.github/workflows/ci.yml` (Typecheck & corpus, Workspace tests, Spec chain), read from `ci.yml`
itself, in a container from a pinned `node:<major>-bookworm` image (`scripts/ci-local.images.json`)
on a fresh `git archive` of the commit. It needs Docker and an installed workspace. See
[ADR-0031](docs/adr/ADR-0031-local-gate.md).

```sh
scripts/ci-local.sh               # the full gate on HEAD at the .tool-versions Node; leaves a pass record
scripts/ci-local.sh --changed     # while working: what changed since origin/main and its dependents; no record
scripts/ci-local.sh --since <ref> # the same, against another base
scripts/ci-local.sh --rebased     # after a rebase: what differs from ORIG_HEAD, which must have a record
scripts/ci-local.sh --node 26     # another matrix Node; --all runs every one
scripts/ci-local.sh --job spec    # a subset; --ref <commit> checks another commit
scripts/ci-local.sh --list        # what would run
```

[`.githooks/pre-push`](.githooks/pre-push) runs nothing: it refuses a push unless every pushed
commit has a full-gate pass record (`scripts/ci-local.sh --record-path` prints where it is).
Enable it once per clone:

```sh
git config core.hooksPath .githooks
```

One gate runs at a time on a machine (the host-wide `~/.flmnt/gate.lock`, `scripts/gate-lock.sh`).
A run stops after 30 minutes (`CI_LOCAL_MAX_SECONDS`) and refuses to start with under 20 GB free in
the Docker VM (`CI_LOCAL_DISK_MIN_GB`). Other settings: `CI_LOCAL_DIR` (run directory, default
`${TMPDIR:-/tmp}/feat-ci-local`), `CI_LOCAL_MAX_WORKERS` (vitest workers, default 3),
`CI_LOCAL_TURBO_CONCURRENCY`, `FLMNT_GATE_CPU_MAX`. Caches are docker volumes named
`feat-ci-cache-*`; the containers a run's tests start are labelled with their owner and removed
after it (`scripts/docker-sweep.sh`). A job CI runs on another OS (feat-cdk on Windows) is left to
CI.

- Use a conventional-commit title (`feat:`, `fix:`, ...): it decides the release.
- A change to the language closes four layers in one change: the grammar reference, a corpus
  exemplar, the parser and IR, and the whole corpus re-validated.
- A design change comes with an ADR in [`docs/adr/`](docs/adr/README.md).
- Run `scripts/ci-local.sh` before you push.

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Releases

All `@mmmnt/feat*` packages and `@mmmnt/feature` are one fixed version group and are released
together. After CI succeeds on `main`, the release workflow turns the merged pull request's
conventional-commit title into a changeset (`feat` is a minor, `fix`, `perf` and `refactor` a
patch, `!` or `BREAKING CHANGE` a major), and the project's bot opens or updates a
`chore: version packages` pull request. Merging it publishes every package to npm through trusted
publishing with provenance, creates one `vX.Y.Z` tag and GitHub Release, and publishes the VS Code
extension at the same version. Nobody pushes release tags by hand.

## Community

Join the [Discord server](https://discord.gg/YcRqsQUQuu) to discuss Feature, get help, and meet other teams writing specs.

## License

BSD-3-Clause. See [LICENSE](LICENSE). Every published package ships the same license.
