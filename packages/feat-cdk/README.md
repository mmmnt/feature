# @mmmnt/feat-cdk

A Feature response adapter for the CDK app you already have. No conventions, no
declaration files, no restructuring: the contract is CDK's own cloud
assembly (`cdk.out/`), so Feature derives the deployment from `cdk synth`
output: resources, the SSM publish/consume graph, and the dependency closure.

Adding infrastructure means adding a construct to *your* app. Feature reads
the assembly.

## Installation

Requires Node.js 22 or newer, [`@mmmnt/feature`](../feature/README.md), and a CDK app.

```bash
npm install -D @mmmnt/feat-cdk aws-cdk
```

To synthesize, the adapter runs the
`aws-cdk` CLI your project installed: the first `node_modules/aws-cdk` from the app directory upward
(so a workspace-hoisted install is found), its `cdk` bin run with the current Node, no shell. It never
fetches one with `npx`: without `aws-cdk` the command is refused with `AWS_CDK_NOT_INSTALLED`, a
configuration error (`feat run` exits `2`); add `aws-cdk` as a dev dependency (SPEC-CDK-001). Set
`invoke.cdkBin` to run a binary of your own instead. To skip synthesis, point `invoke.assemblyDir` at a
`cdk.out` you already built.

## What it derives

From a synthesized assembly (`cdk synth --output cdk.out`):

- **Resources** — every stack's template, addressed by **construct path**
  (the names you authored, via `aws:cdk:path`), with `Ref`/`Fn::GetAtt`
  wiring rewritten to path references. CloudFormation is the universal
  schema: specs assert any service's properties directly — there is no
  per-service code here or anywhere.
- **SSM publishes** — `AWS::SSM::Parameter` resources. Names are literal at
  synth; values are literal (known now) or deploy-time tokens (resolved from
  the deployed stack afterward).
- **Dependency closure** — both edge classes CloudFormation splits:
  injected stack→stack deps from `manifest.json`, plus the cross-stack SSM
  reads it *can't* see (`AWS::SSM::Parameter::Value<String>` parameters and
  `{{resolve:ssm:/path}}` references) matched to their publishers.

The CDK bootstrap parameter is never mistaken for a dependency.

## Usage

The adapter needs no handler files or wiring code: your CDK app, your `.feat` specs and the config
are the whole authored surface.

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-cdk",
  "invoke": {
    "appCommand": "node bin/app.ts",
    "stage": { "fromEnv": "ENVIRONMENT", "default": "local" }
  },
  "commands": {
    "SynthStack":    {},
    "SynthDeployed": { "env": { "FEAT_POSTURE": "deployed" } },
    "SynthHarness":  { "env": { "FEAT_POSTURE": "harness" } }
  }
}
```

Each command synthesizes the app with its configured environment (posture
flags, anything else your app reads) and answers with the canonical surface.
Every command takes the same payload (`stack`, and optionally `select`), and
the command name only chooses which environment and assembly the synth uses.
The resolved stage is exported to the synth subprocess as `ENVIRONMENT`.
(`createSynthStackHandler` remains exported for custom setups.)

### Every option

| Key | Type | Meaning |
| --- | --- | --- |
| `invoke.appCommand` | string | The `cdk synth --app` command, such as `node bin/app.ts`. Use it when there is no `cdk.json`. With neither, `cdk` runs the app its own config names. |
| `invoke.cwd` | string | The CDK app directory. Default: the project root, where `feat.config.json` lives. |
| `invoke.assemblyDir` | string | A pre-synthesized `cdk.out`. When set, nothing is synthesized: the deterministic path for CI. |
| `invoke.cdkBin` | string | A binary of your own that runs `cdk`, with `cdk` as its first argument, used instead of the resolved `aws-cdk` (through a shell on Windows, for a `.cmd` shim). There is no default: without it, the project's `aws-cdk` runs, or the command is refused with `AWS_CDK_NOT_INSTALLED`. |
| `invoke.env` | object | Environment added to every synth subprocess. |
| `invoke.stage` | string or `{ fromEnv, default }` | The active stage. A literal, or the name of an environment variable and a default. See "One spec text, every environment". |
| `invoke.externalPublications` | string[] | SSM names published by another plane. See below. |
| `commands.<Name>.env` | object | Environment for that command, merged over `invoke.env`. The stage is added last as `ENVIRONMENT`. |
| `commands.<Name>.assemblyDir` | string | A pre-synthesized assembly for that command, overriding `invoke.assemblyDir`. |

Synthesis runs `cdk synth --all --output <temp dir> --quiet` for the **whole app**. The assembly is the
contract, and the analysis rules on stack membership. A failed synth fails the case with the
subprocess error.

## Plane-split apps: declared cross-plane consumption

A consumed SSM name with no publisher in the assembly is a loud analysis
failure — it would fail at deploy. When your composition is deliberately
split into planes (e.g. a stable environment-level app deployed by humans
and an ephemeral app owned by CI), declare the names the other plane
publishes:

```jsonc
"invoke": {
  "appCommand": "node bin/app.ts",
  "externalPublications": ["/feature/dashboard/<env>/ddb-endpoint-id"]
}
```

Entries are exact names (`<env>` resolves to the stage) and read like
imports between planes: a listed name is accepted as a cross-plane edge —
surfaced in `consumes`, never a closure member, its publisher a deploy
prerequisite. Undeclared dangling consumes still throw, so a typo'd SSM
read remains caught at analysis, not at deploy.

## One spec text, every environment

With a `stage` configured, `<env>` is a two-way token: it resolves to the
stage in the requested stack id, and the stage normalizes back to `<env>` in
every response string. The same spec runs against local, staging, and prod
synthesis unchanged; each run's evidence bundle carries its real environment.

## Predictions: properties directly, relations by query

Property claims assert raw CloudFormation through named `select` queries
(by `path`, `type`, partial `where` match, or serialized-content `regex` —
named to stay clear of `.feat`'s reserved `matching` keyword). Relational and
**absence** claims are counts:

```
scenario "the table is production-grade and pinned to the endpoint":
  when: SynthStack {
    stack: "my-app-<env>-data",
    select: {
      table: { path: "WorkspaceTable/Table/Resource" },
      pinned: { type: "AWS::DynamoDB::Table", regex: "aws:sourceVpce" }
    }
  }
  predict success:
    response 200 StackSurface {
      closure: ["my-app-<env>-network", "my-app-<env>-data"]
      selected: {
        table: { count: 1, first: { properties: { BillingMode: "PAY_PER_REQUEST" } } }
        pinned: { count: 1 }
      }
    }
```

`count: 0` is how "public must never reach intra" and "intra has no internet
route" become verified predictions — no projection code, any AWS service,
including ones that don't exist yet.

## Responses and refusals

The command answers `{ status, body }`:

| Status | Body | When |
| --- | --- | --- |
| `200` | The `StackSurface` below | The stack is in the assembly. |
| `400` | `{ code: "MISSING_STACK", message }` | The payload has no `stack` string. |
| `404` | `{ code: "UNKNOWN_STACK", message }` | The stack is not in the assembly. The message lists the available stacks, stage-normalized. |

Specs predict them with `predict error MISSING_STACK` and `predict error UNKNOWN_STACK`. Three other
failures are thrown, not answered: a consumed SSM name with no publisher and no `externalPublications`
entry (it would fail at deploy), a cyclic stack dependency, and a failed `cdk synth`. A command that must
synthesize while the app has no `aws-cdk` (and no `invoke.cdkBin`) throws
`Configuration error (exit 2): [AWS_CDK_NOT_INSTALLED] ...` before anything is written or spawned, so
`feat run` exits `2`.

`stack` is a stack name or an artifact id, and `<env>` in it resolves to the stage.

The `StackSurface` body:

| Field | Meaning |
| --- | --- |
| `stackName` | The deployable stack name, with the stage written as `<env>`. |
| `artifactId` | The stack's artifact id in the manifest. |
| `closure` | Stack names to deploy, dependency-first, ending with the requested stack. |
| `resourceCounts` | CloudFormation type to count, sorted by type. |
| `publishes` | SSM names this stack writes, sorted. |
| `consumes` | SSM names this stack reads from another stack, sorted. |
| `dependsOn` | Stack names this stack depends on directly, sorted. |
| `selected` | Present only when `select` was sent: query name to `{ count, paths, first? }`. |

A select query is `{ path?, type?, where?, regex? }`. All given fields must hold. `path` is the exact
construct path, `type` the exact CloudFormation type, `where` a partial deep match over the normalized
properties (arrays match by containment), and `regex` is tested against the JSON-serialized properties.
`first` is `{ path, type, properties, deletionPolicy? }` for the first match.

## A runnable example, with no synthesis

With a pre-built assembly the spec runs without CDK installed and without a cloud:

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-cdk",
  "invoke": { "assemblyDir": "cdk.out", "stage": { "fromEnv": "ENVIRONMENT", "default": "local" } },
  "commands": { "SynthStack": {} }
}
```

```
scenario "the data stack has one table and publishes its name":
  when: SynthStack {
    stack: "data",
    select: { tables: { type: "AWS::DynamoDB::Table" } }
  }
  predict success:
    response 200 StackSurface {
      stackName: "data"
      closure: ["net", "data"]
      publishes: ["/app/table-name"]
      selected: { tables: { count: 1 } }
    }
    # plus `<service> has []` for every other configured service
```

## API

- `createAdapter(config)` → the Feature response adapter that `feat.config.json` loads by name.
- `analyzeAssembly(cdkOutDir)` → `{ stacks, byArtifact, byStackName }`
- `resolveStackClosure(assembly, roots, externalPublications?)` → dependency-first artifact ids, where
  `roots` is a list of artifact ids and `externalPublications` a read-only `Set` of names
- `stackSurface(assembly, stack, closure, { stage, select })` → the canonical `StackSurface`, where
  `stack` is a `StackAnalysis` from `assembly.byArtifact`, not a name
- `createSynthStackHandler(config)` → the Feature response command. Its config adds a `project`
  function, an escape hatch that merges extra fields over the surface.
- `resolveStage(stage)` → the stage a config resolves to; `resolveCdkEntry(cwd)` → the project's
  `aws-cdk` entry (its `cdk` bin, from `cwd` upward), or `null`. `CdkNotInstalledError`
  (`code: "AWS_CDK_NOT_INSTALLED"`) is what the handler throws without one.
- `normalizedResources` / `selectResources` / `runSelects` / `deepMatch` / `constructPath` /
  `normalizeTokens` / `normalizeStage` / `consumedSsmNames` / `publishedSsm` / `listStacks` /
  `readTemplate` / `countOfType` / `firstOfType` — the primitives, for consumer unit tests and
  tooling.
- Types: `Assembly`, `StackAnalysis`, `SsmPublish`, `CfnResource`, `StackSurface`, `SurfaceOptions`,
  `SynthStackConfig`, `CdkInvokeConfig`, `CdkCommandConfig`, `StageConfig`, `NormalizedResource`,
  `SelectQuery`, `Selection`.

## Limitations

- The package reads CloudFormation. It does not deploy anything.
- It synthesizes the whole app on each invocation unless `assemblyDir` is set. Use `assemblyDir` in CI
  to synthesize once.
- A resource without `aws:cdk:path` metadata is addressed by its logical id.
- The adapter takes no actors and offers no `setClock`, so `clock at` against it is a
  `CLOCK_UNSUPPORTED` configuration error.

## References

- [SPEC-CDK-001](local-cdk.feat): `aws-cdk` resolves from the project, never fetched.
- [ADR-0026](../../docs/adr/ADR-0026-local-vitest.md): the same rule for the runner's vitest.

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
