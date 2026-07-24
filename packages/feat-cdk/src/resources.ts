// The GLOBAL resource surface — no per-service code, ever. CloudFormation is
// the universal schema: every synthesized resource is a uniform
// {Type, Properties} object, so specs predict directly against it. This
// module supplies the three global normalizations that make raw templates
// assertable:
//
//   - ADDRESSING: resources are keyed by their CDK construct path (the
//     aws:cdk:path metadata — the names the consumer authored), with the
//     stack-root segment stripped. Logical-id hashes never appear in specs.
//   - WIRING: Ref / Fn::GetAtt intrinsics are rewritten to construct-path
//     references ({ref} / {ref, att}), so cross-resource edges are stable,
//     readable, and environment-invariant.
//   - STAGE: every occurrence of the active stage in a string (segment-
//     bounded) becomes the literal token "<env>", so ONE spec text holds in
//     every environment while each run's evidence carries its real
//     environment.
//
// Plus the one generic query primitive: select resources by path / type /
// partial property match / serialized-content regex. Relational and ABSENCE
// claims (reachability, "no default route") become count predictions.
import type { CfnResource, StackAnalysis } from "./assembly.js";

export interface NormalizedResource {
  /** Construct path relative to the stack root (falls back to the logical id). */
  path: string;
  type: string;
  /** Raw CloudFormation properties with Ref/GetAtt rewritten to path references. */
  properties: Record<string, any>;
  deletionPolicy?: string;
}

export interface SelectQuery {
  /** Exact construct path. */
  path?: string;
  /** Exact CloudFormation type (e.g. "AWS::DynamoDB::Table"). */
  type?: string;
  /** Partial deep match over normalized properties (arrays: containment). */
  where?: Record<string, any>;
  /** Regex tested against the JSON-serialized normalized properties. */
  matching?: string;
}

export interface Selection {
  count: number;
  paths: string[];
  /** The first match (path order), when any. */
  first?: NormalizedResource;
}

/** Construct path of one resource, stack-root segment stripped. */
export function constructPath(logicalId: string, res: CfnResource): string {
  const meta = (res as { Metadata?: Record<string, unknown> }).Metadata?.["aws:cdk:path"];
  if (typeof meta !== "string") return logicalId;
  const segments = meta.split("/");
  return segments.length > 1 ? segments.slice(1).join("/") : meta;
}

/** Rewrite Ref / Fn::GetAtt intrinsics to construct-path references, recursively. */
export function normalizeTokens(value: any, pathOf: (logicalId: string) => string | null): any {
  if (Array.isArray(value)) return value.map((v) => normalizeTokens(v, pathOf));
  if (value === null || typeof value !== "object") return value;
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "Ref" && typeof value.Ref === "string") {
    const target = pathOf(value.Ref);
    if (target !== null) return { ref: target };
  }
  if (keys.length === 1 && keys[0] === "Fn::GetAtt" && Array.isArray(value["Fn::GetAtt"])) {
    const [id, att] = value["Fn::GetAtt"];
    const target = typeof id === "string" ? pathOf(id) : null;
    if (target !== null) return { ref: target, att };
  }
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) out[k] = normalizeTokens(v, pathOf);
  return out;
}

/** Replace segment-bounded occurrences of the stage with the "<env>" token, recursively. */
export function normalizeStage<T>(value: T, stage: string | undefined): T {
  if (stage === undefined || stage === "") return value;
  const pattern = new RegExp(`(^|[^A-Za-z0-9])${stage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^A-Za-z0-9])`, "g");
  const walk = (v: any): any => {
    if (typeof v === "string") return v.replace(pattern, "$1<env>");
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, any> = {};
      for (const [k, val] of Object.entries(v)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(value);
}

/** All of a stack's resources, path-addressed and token-normalized, path-sorted. */
export function normalizedResources(stack: StackAnalysis): NormalizedResource[] {
  const pathByLogicalId = new Map<string, string>();
  for (const [id, res] of Object.entries(stack.resources)) pathByLogicalId.set(id, constructPath(id, res));
  const pathOf = (id: string) => pathByLogicalId.get(id) ?? null;
  return Object.entries(stack.resources)
    .map(([id, res]) => {
      const out: NormalizedResource = {
        path: pathByLogicalId.get(id)!,
        type: res.Type,
        properties: normalizeTokens(res.Properties ?? {}, pathOf),
      };
      if (res.DeletionPolicy !== undefined) out.deletionPolicy = res.DeletionPolicy;
      return out;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Partial deep match: objects require every expected key to match
 * recursively; arrays require every expected element to match SOME actual
 * element (containment — the useful semantics for Tags and statements);
 * primitives require equality.
 */
export function deepMatch(actual: any, expected: any): boolean {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected.every((e) => actual.some((a) => deepMatch(a, e)));
  }
  if (expected !== null && typeof expected === "object") {
    if (actual === null || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => deepMatch(actual[k], v));
  }
  return actual === expected;
}

/** Apply one select query to a normalized resource set. */
export function selectResources(resources: NormalizedResource[], q: SelectQuery): NormalizedResource[] {
  const pattern = q.matching !== undefined ? new RegExp(q.matching) : null;
  return resources.filter(
    (r) =>
      (q.path === undefined || r.path === q.path) &&
      (q.type === undefined || r.type === q.type) &&
      (q.where === undefined || deepMatch(r.properties, q.where)) &&
      (pattern === null || pattern.test(JSON.stringify(r.properties))),
  );
}

/** Run a named set of select queries into the response's `selected` map. */
export function runSelects(
  resources: NormalizedResource[],
  selects: Record<string, SelectQuery>,
): Record<string, Selection> {
  const out: Record<string, Selection> = {};
  for (const [name, q] of Object.entries(selects)) {
    const matches = selectResources(resources, q);
    const sel: Selection = { count: matches.length, paths: matches.map((m) => m.path) };
    if (matches.length > 0) sel.first = matches[0]!;
    out[name] = sel;
  }
  return out;
}
