# @mmmnt/feat-cdk

**Point Feature at the CDK app you already have.** No conventions, no
declaration files, no restructuring — the contract is CDK's own cloud
assembly (`cdk.out/`), so Feature derives the deployment from `cdk synth`
output: resources, the SSM publish/consume graph, and the dependency closure.

Adding infrastructure means adding a construct to *your* app. Feature reads
the assembly.

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

## A first-class adapter — zero consumer code

Feature's execution layer lives in published adapters, and this package IS
one. The consumer's total authored surface is their CDK app, their `.feat`
specs, and the config they already have — no handler files, no wiring code:

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-cdk",
  "invoke": {
    "appCommand": "node bin/app.ts",
    "stage": { "fromEnv": "ENVIRONMENT", "default": "local" }
  },
  "commands": {
    "SynthDeployed": { "env": { "FEAT_POSTURE": "deployed" } },
    "SynthHarness":  { "env": { "FEAT_POSTURE": "harness" } }
  }
}
```

Each command synthesizes the app with its configured environment (posture
flags, anything else your app reads) and answers with the canonical surface.
The resolved stage is exported to the synth subprocess as `ENVIRONMENT`.
(`createSynthStackHandler` remains exported for custom setups.)

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

## API

- `analyzeAssembly(cdkOutDir)` → `{ stacks, byArtifact, byStackName }`
- `resolveStackClosure(assembly, roots, externalPublications?)` → dependency-first artifact ids
- `stackSurface(assembly, stack, closure, { stage, select })` → the canonical `StackSurface`
- `createSynthStackHandler(config)` → the Feature response command
- `normalizedResources` / `selectResources` / `deepMatch` / `normalizeStage` /
  `consumedSsmNames` / `publishedSsm` / `listStacks` / `readTemplate` — the
  primitives, for consumer unit tests and tooling.

The [LocalStack adapter](https://www.npmjs.com/package/@mmmnt/feat-adapter-localstack)
consumes the same analysis to deploy exactly the closure a run needs and
resolve materialized values afterward.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. MIT
