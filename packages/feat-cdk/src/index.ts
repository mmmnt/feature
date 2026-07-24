// @mmmnt/feat-cdk — point Feature at the CDK app you already have.
//
// The contract is CDK's own cloud assembly (cdk.out/): Feature derives the
// deployment — resources, the SSM publish/consume graph, the dependency
// closure — from `cdk synth` output, with no convention files and no
// declaration registry. `createSynthStackHandler` turns "synthesize this
// stack and describe it" into a Feature response command, so an infra spec
// predicts the canonical stack surface (or a golden template) and prediction
// inversion verifies it against the real synthesized template.
//
// The LocalStack adapter consumes the same analysis to deploy exactly the
// closure a run needs and resolve materialized values afterward.
export {
  analyzeAssembly,
  resolveStackClosure,
  consumedSsmNames,
  publishedSsm,
  listStacks,
  readTemplate,
  type Assembly,
  type StackAnalysis,
  type SsmPublish,
  type CfnResource,
} from "./assembly.js";
export { stackSurface, countOfType, firstOfType, type StackSurface, type SurfaceOptions } from "./surface.js";
export { createSynthStackHandler, resolveCdkEntry, type SynthStackConfig } from "./synth-stack.js";
export {
  createAdapter,
  resolveStage,
  type CdkInvokeConfig,
  type CdkCommandConfig,
  type StageConfig,
} from "./adapter.js";
export {
  constructPath,
  normalizeTokens,
  normalizeStage,
  normalizedResources,
  deepMatch,
  selectResources,
  runSelects,
  type NormalizedResource,
  type SelectQuery,
  type Selection,
} from "./resources.js";
