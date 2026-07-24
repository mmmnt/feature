// Cloud-assembly analysis — the whole contract between Feature and a CDK app
// is `cdk synth` output (cdk.out/). No conventions, no declaration files: we
// read the assembly CDK already produces.
//
//   - resources     — each stack's *.template.json Resources
//   - ssm publishes — AWS::SSM::Parameter resources (names literal at synth;
//                     literal values known now, token values Fn::GetAtt/Ref/
//                     Fn::Join resolved from the deployed stack afterward)
//   - dependencies  — manifest.json per-stack `dependencies` (addDependency +
//                     auto cross-stack Export/ImportValue), stack→stack edges
//   - ssm consumes  — cross-stack out-of-band reads CloudFormation can't see:
//                     CFN Parameters of Type AWS::SSM::Parameter::Value<String>
//                     and {{resolve:ssm:/path}} dynamic references in props
//
// Publishes matched to consumes across stacks gives the complete two-edge
// closure — derived, never declared.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export interface SsmPublish {
  name: string;
  /** Literal value (known at synth) or null when the value is a deploy-time token. */
  literalValue: string | null;
  /** The CFN intrinsic producing a token value (e.g. "Fn::GetAtt"), or null. */
  tokenKind: string | null;
}

export interface StackAnalysis {
  /** Deployable stack name (CloudFormation StackName). */
  stackName: string;
  /** Assembly artifact id (manifest key; what `cdk deploy <id>` takes). */
  artifactId: string;
  /** Injected stack→stack dependencies (artifact ids), from the manifest. */
  dependsOn: string[];
  /** Resource logical id → { Type, Properties }. */
  resources: Record<string, CfnResource>;
  /** SSM parameters this stack writes. */
  publishes: SsmPublish[];
  /** SSM parameter names this stack reads cross-stack (the invisible edges). */
  consumes: string[];
}

export interface CfnResource {
  Type: string;
  Properties?: Record<string, any>;
  DeletionPolicy?: string;
}

export interface Assembly {
  stacks: StackAnalysis[];
  byArtifact: Record<string, StackAnalysis>;
  byStackName: Record<string, StackAnalysis>;
}

// CDK's own bootstrap parameter — not a consumer edge.
const BOOTSTRAP_PARAM = "BootstrapVersion";
const SSM_VALUE_TYPE = "AWS::SSM::Parameter::Value";
const RESOLVE_SSM = /\{\{resolve:ssm(?:-secure)?:([^:}]+)/g;

function valueShape(v: unknown): { literal: string | null; tokenKind: string | null } {
  if (typeof v === "string") return { literal: v, tokenKind: null };
  if (v && typeof v === "object") return { literal: null, tokenKind: Object.keys(v as object)[0] ?? "unknown" };
  return { literal: null, tokenKind: "unknown" };
}

/** Every SSM name a template reads out-of-band (CFN param defaults + resolve refs). */
export function consumedSsmNames(template: any): string[] {
  const names = new Set<string>();
  for (const [id, param] of Object.entries<any>(template.Parameters ?? {})) {
    if (id === BOOTSTRAP_PARAM) continue;
    if (typeof param?.Type === "string" && param.Type.startsWith(SSM_VALUE_TYPE)) {
      if (typeof param.Default === "string") names.add(param.Default);
    }
  }
  const json = JSON.stringify(template);
  for (const m of json.matchAll(RESOLVE_SSM)) names.add(m[1]!);
  return [...names];
}

/** SSM parameters a template writes. */
export function publishedSsm(template: any): SsmPublish[] {
  const out: SsmPublish[] = [];
  for (const res of Object.values<any>(template.Resources ?? {})) {
    if (res?.Type !== "AWS::SSM::Parameter") continue;
    const name = res.Properties?.Name;
    if (typeof name !== "string") continue; // tokenized names are rare; skip from the contract
    const { literal, tokenKind } = valueShape(res.Properties?.Value);
    out.push({ name, literalValue: literal, tokenKind });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse a synthesized cloud assembly directory into the analysis model. */
export function analyzeAssembly(cdkOutDir: string): Assembly {
  const manifest = JSON.parse(readFileSync(path.join(cdkOutDir, "manifest.json"), "utf8"));
  const stacks: StackAnalysis[] = [];
  for (const [artifactId, artifact] of Object.entries<any>(manifest.artifacts ?? {})) {
    if (artifact.type !== "aws:cloudformation:stack") continue;
    const templateFile = artifact.properties?.templateFile ?? `${artifactId}.template.json`;
    const template = JSON.parse(readFileSync(path.join(cdkOutDir, templateFile), "utf8"));
    const stackName = artifact.properties?.stackName ?? artifactId;
    const dependsOn = (artifact.dependencies ?? []).filter(
      (d: string) => manifest.artifacts?.[d]?.type === "aws:cloudformation:stack",
    );
    stacks.push({
      stackName,
      artifactId,
      dependsOn,
      resources: template.Resources ?? {},
      publishes: publishedSsm(template),
      consumes: consumedSsmNames(template),
    });
  }
  const byArtifact: Record<string, StackAnalysis> = {};
  const byStackName: Record<string, StackAnalysis> = {};
  for (const s of stacks) {
    byArtifact[s.artifactId] = s;
    byStackName[s.stackName] = s;
  }
  return { stacks, byArtifact, byStackName };
}

/**
 * Full deployment closure of the requested stacks: injected dependencies
 * (manifest) + cross-stack SSM consumes matched to publishers. Returned
 * dependency-first (safe deploy order). Dangling consumes throw — an SSM read
 * with no publisher in the assembly would fail at deploy.
 */
export function resolveStackClosure(assembly: Assembly, rootArtifactIds: string[]): string[] {
  const publisherOf = new Map<string, string>(); // ssm name → artifactId
  for (const s of assembly.stacks) for (const p of s.publishes) publisherOf.set(p.name, s.artifactId);

  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (artifactId: string, trail: string[]) => {
    if (state.get(artifactId) === "done") return;
    if (state.get(artifactId) === "visiting")
      throw new Error(`Cyclic stack dependency: ${[...trail, artifactId].join(" → ")} — configuration error.`);
    const stack = assembly.byArtifact[artifactId];
    if (!stack) throw new Error(`Unknown stack '${artifactId}' — the assembly has: ${assembly.stacks.map((s) => s.artifactId).join(", ")} — configuration error.`);
    state.set(artifactId, "visiting");
    for (const dep of stack.dependsOn) visit(dep, [...trail, artifactId]);
    for (const name of stack.consumes) {
      const publisher = publisherOf.get(name);
      if (!publisher)
        throw new Error(`Stack '${artifactId}' consumes SSM '${name}' but no stack in the assembly publishes it — configuration error.`);
      if (publisher !== artifactId) visit(publisher, [...trail, artifactId]);
    }
    state.set(artifactId, "done");
    order.push(artifactId);
  };
  for (const root of rootArtifactIds) visit(root, []);
  return order;
}

/** List the assembly's stack artifact ids without a full deep parse. */
export function listStacks(cdkOutDir: string): string[] {
  const manifest = JSON.parse(readFileSync(path.join(cdkOutDir, "manifest.json"), "utf8"));
  return Object.entries<any>(manifest.artifacts ?? {})
    .filter(([, a]) => a.type === "aws:cloudformation:stack")
    .map(([id]) => id);
}

/** Convenience: read a raw template file from an assembly (for goldens). */
export function readTemplate(cdkOutDir: string, artifactId: string): { Resources: Record<string, CfnResource> } {
  const files = readdirSync(cdkOutDir).filter((f) => f.endsWith(".template.json"));
  const match = files.find((f) => f === `${artifactId}.template.json`) ?? files[0]!;
  return JSON.parse(readFileSync(path.join(cdkOutDir, match), "utf8"));
}
