# @mmmnt/feat-cdk

**Point Feature at the CDK app you already have.** No conventions, no
declaration files, no restructuring — the contract is CDK's own cloud
assembly (`cdk.out/`), so Feature derives the deployment from `cdk synth`
output: resources, the SSM publish/consume graph, and the dependency closure.

Adding infrastructure means adding a construct to *your* app. Feature reads
the assembly.

## What it derives

From a synthesized assembly (`cdk synth --output cdk.out`):

- **Resources** — each stack's template, counted and inspectable.
- **SSM publishes** — `AWS::SSM::Parameter` resources. Names are literal at
  synth; values are literal (known now) or deploy-time tokens (`Fn::GetAtt`,
  `Ref`, `Fn::Join` — resolved from the deployed stack afterward).
- **Dependency closure** — both edge classes CloudFormation splits:
  - injected stack→stack deps from `manifest.json` (`addDependency` +
    automatic cross-stack `Export`/`ImportValue`);
  - cross-stack SSM reads it *can't* see — CFN parameters of type
    `AWS::SSM::Parameter::Value<String>` and `{{resolve:ssm:/path}}` dynamic
    references — matched to their publishers across stacks.

The CDK bootstrap parameter is never mistaken for a dependency.

## Synthesis as a Feature command

`createSynthStackHandler` turns "synthesize this stack and describe it" into a
response command, shipped in-package — a consumer authors **zero** handler
code:

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-adapter-handler",
  "commands": { "SynthStack": { "module": "feat-cdk-handler.ts", "export": "synthStack" } }
}
```

```ts
// feat-cdk-handler.ts — the consumer's only wiring
import { createSynthStackHandler } from "@mmmnt/feat-cdk";
export const synthStack = createSynthStackHandler({ appCommand: "node bin/app.ts" });
```

```
# an infra spec predicts the canonical surface — prediction inversion
# verifies it against the REAL synthesized template
scenario "the data stack ships the expected footprint":
  when: SynthStack { stack: "MyDataStack" }
  predict success:
    response 200 StackSurface {
      resourceCounts: { "AWS::DynamoDB::Table": 1 }
      publishes: [ "/app/prod/table-name" ]
      closure: [ "MyNetworkStack", "MyDataStack" ]
    }
```

Semantic surfaces — regulatory posture predicates, reachability matrices,
whatever your specs should pin — are a pure `project` function merged over the
canonical surface:

```ts
export const synthStack = createSynthStackHandler({
  appCommand: "node bin/app.ts",
  project: ({ stack }) => ({ tableCount: countOfType(stack, "AWS::DynamoDB::Table") }),
});
```

## API

- `analyzeAssembly(cdkOutDir)` → `{ stacks, byArtifact, byStackName }`
- `resolveStackClosure(assembly, roots)` → dependency-first artifact ids
- `stackSurface(assembly, stack, closure)` → the canonical `StackSurface`
- `createSynthStackHandler(config)` → the Feature response command
- `consumedSsmNames` / `publishedSsm` / `listStacks` / `readTemplate` — the
  primitives, for custom projections and semantic surfaces.

The [LocalStack adapter](https://www.npmjs.com/package/@mmmnt/feat-adapter-localstack)
consumes the same analysis to deploy exactly the closure a run needs and
resolve materialized values afterward.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. MIT
