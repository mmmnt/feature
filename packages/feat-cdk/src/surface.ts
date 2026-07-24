// The canonical stack surface — a normalized, assertable projection of any
// synthesized stack, free for every consumer with zero authored code. Infra
// specs predict against this (prediction inversion verifies it matches the
// real synthesized template); goldens pin whole templates when needed.
import type { Assembly, StackAnalysis, CfnResource } from "./assembly.js";

export interface StackSurface {
  stackName: string;
  artifactId: string;
  /** Deploy-order closure (dependency-first) rooted at this stack. */
  closure: string[];
  /** Resource type → count — the deployment footprint at a glance. */
  resourceCounts: Record<string, number>;
  /** SSM parameter names this stack writes, sorted. */
  publishes: string[];
  /** SSM parameter names this stack reads cross-stack, sorted. */
  consumes: string[];
  /** Injected stack dependencies (artifact ids). */
  dependsOn: string[];
}

function resourceCounts(resources: Record<string, CfnResource>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of Object.values(resources)) counts[r.Type] = (counts[r.Type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export function stackSurface(assembly: Assembly, stack: StackAnalysis, closure: string[]): StackSurface {
  return {
    stackName: stack.stackName,
    artifactId: stack.artifactId,
    closure,
    resourceCounts: resourceCounts(stack.resources),
    publishes: stack.publishes.map((p) => p.name).sort(),
    consumes: [...stack.consumes].sort(),
    dependsOn: [...stack.dependsOn].sort(),
  };
}

/** Count resources of a type across a stack — a stock helper for semantic specs. */
export function countOfType(stack: StackAnalysis, type: string): number {
  return Object.values(stack.resources).filter((r) => r.Type === type).length;
}

/** First resource of a type in a stack (for property-level assertions). */
export function firstOfType(stack: StackAnalysis, type: string): CfnResource | undefined {
  return Object.values(stack.resources).find((r) => r.Type === type);
}
