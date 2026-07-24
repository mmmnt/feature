// The canonical stack surface — a normalized, assertable projection of any
// synthesized stack, free for every consumer with zero authored code. Infra
// specs predict against this (prediction inversion verifies it matches the
// real synthesized template). With a stage configured, every stack name and
// SSM path reads "<env>" in place of the active stage, so one spec text
// holds in every environment; with `select` queries, relational and absence
// claims come back as counts — no per-service projection code anywhere.
import type { Assembly, StackAnalysis, CfnResource } from "./assembly.js";
import {
  normalizedResources,
  normalizeStage,
  runSelects,
  type Selection,
  type SelectQuery,
} from "./resources.js";

export interface StackSurface {
  /** Deployable stack name (stage-normalized to "<env>" when a stage is set). */
  stackName: string;
  artifactId: string;
  /** Deploy-order closure (dependency-first), as stage-normalized stack names. */
  closure: string[];
  /** Resource type → count — the deployment footprint at a glance. */
  resourceCounts: Record<string, number>;
  /** SSM parameter names this stack writes, sorted, stage-normalized. */
  publishes: string[];
  /** SSM parameter names this stack reads cross-stack, sorted, stage-normalized. */
  consumes: string[];
  /** Injected stack dependencies, as stage-normalized stack names. */
  dependsOn: string[];
  /** Results of the request's select queries (present when queries were sent). */
  selected?: Record<string, Selection>;
}

export interface SurfaceOptions {
  /** Active stage; occurrences in strings normalize to the "<env>" token. */
  stage?: string;
  /** Named select queries to run over the stack's normalized resources. */
  select?: Record<string, SelectQuery>;
}

function resourceCounts(resources: Record<string, CfnResource>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of Object.values(resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function stackSurface(
  assembly: Assembly,
  stack: StackAnalysis,
  closure: string[],
  options: SurfaceOptions = {},
): StackSurface {
  const stackNameOf = (artifactId: string) => assembly.byArtifact[artifactId]?.stackName ?? artifactId;
  const surface: StackSurface = {
    stackName: normalizeStage(stack.stackName, options.stage),
    artifactId: stack.artifactId,
    closure: normalizeStage(closure.map(stackNameOf), options.stage),
    resourceCounts: resourceCounts(stack.resources),
    publishes: normalizeStage(stack.publishes.map((p) => p.name).sort(), options.stage),
    consumes: normalizeStage([...stack.consumes].sort(), options.stage),
    dependsOn: normalizeStage(stack.dependsOn.map(stackNameOf).sort(), options.stage),
  };
  if (options.select !== undefined) {
    surface.selected = normalizeStage(runSelects(normalizedResources(stack), options.select), options.stage);
  }
  return surface;
}

/** Count resources of a type across a stack — a stock helper for consumer tests. */
export function countOfType(stack: StackAnalysis, type: string): number {
  return Object.values(stack.resources).filter((r) => r.Type === type).length;
}

/** First resource of a type in a stack (for property-level assertions). */
export function firstOfType(stack: StackAnalysis, type: string): CfnResource | undefined {
  return Object.values(stack.resources).find((r) => r.Type === type);
}
