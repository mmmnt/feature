// The assembly analyzer, against two fixtures: a REAL captured cdk.out (the
// feature-dashboard DataStack — every truth here came out of `cdk synth`) and
// a synthetic 3-stack assembly proving both cross-stack SSM edge forms and
// closure resolution. No mocks: the input is genuine assembly JSON.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeAssembly,
  resolveStackClosure,
  consumedSsmNames,
  publishedSsm,
  listStacks,
} from "./src/assembly.js";
import { stackSurface, countOfType } from "./src/surface.js";
import { createSynthStackHandler, resolveCdkEntry } from "./src/synth-stack.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(HERE, "fixtures", "single-stack");
const MULTI = path.join(HERE, "fixtures", "multi-stack");

describe("analyzeAssembly on a real captured cdk.out (feature-dashboard)", () => {
  const a = analyzeAssembly(REAL);
  const s = a.stacks[0]!;

  it("reads the deployable stack name and artifact id from the manifest", () => {
    expect(s.artifactId).toBe("FeatureDashboardLocalData");
    expect(s.stackName).toBe("feature-dashboard-local-data");
  });

  it("derives all 10 SSM publishes with literal-vs-token classification", () => {
    expect(s.publishes).toHaveLength(10);
    const byLeaf = Object.fromEntries(s.publishes.map((p) => [p.name.split("/").pop(), p]));
    expect(byLeaf["workspace-table-stream-arn"]!.tokenKind).toBe("Fn::GetAtt");
    expect(byLeaf["vpc-id"]!.tokenKind).toBe("Ref");
    expect(byLeaf["subnet-ids-public"]!.tokenKind).toBe("Fn::Join");
    // every name is a literal string known at synth
    expect(s.publishes.every((p) => p.name.startsWith("/feature/dashboard/local/"))).toBe(true);
  });

  it("has no cross-stack consumes (single stack) and excludes the bootstrap param", () => {
    expect(s.consumes).toEqual([]);
  });

  it("projects a canonical surface: footprint counts + a single-stack closure", () => {
    const surf = stackSurface(a, s, resolveStackClosure(a, [s.artifactId]));
    expect(surf.closure).toEqual(["FeatureDashboardLocalData"]);
    expect(surf.resourceCounts["AWS::SSM::Parameter"]).toBe(10);
    expect(surf.resourceCounts["AWS::DynamoDB::Table"]).toBe(1);
    expect(surf.resourceCounts["AWS::EC2::VPCEndpoint"]).toBe(1);
    expect(surf.publishes).toContain("/feature/dashboard/local/ddb-endpoint-id");
  });
});

describe("cross-stack edges + closure (synthetic 3-stack assembly)", () => {
  const a = analyzeAssembly(MULTI);

  it("detects consumes via BOTH forms: CFN Parameter default and resolve-ssm ref", () => {
    const api = a.byArtifact["Api"]!;
    expect(api.consumes.sort()).toEqual(["/app/table-name", "/app/vpc-id"]);
  });

  it("never treats the bootstrap version parameter as a consume", () => {
    const api = a.byArtifact["Api"]!;
    expect(api.consumes).not.toContain("/cdk-bootstrap/hnb659fds/version");
  });

  it("closes over injected deps AND ssm publishers, dependency-first", () => {
    // Api consumes Net's vpc-id + Data's table-name; Data injected-depends on Net.
    const closure = resolveStackClosure(a, ["Api"]);
    expect(closure).toContain("Api");
    expect(closure).toContain("Data");
    expect(closure).toContain("Net");
    expect(closure.indexOf("Net")).toBeLessThan(closure.indexOf("Data"));
    expect(closure.indexOf("Data")).toBeLessThan(closure.indexOf("Api"));
    expect(closure.indexOf("Net")).toBeLessThan(closure.indexOf("Api"));
  });

  it("a single root pulls only its own closure", () => {
    expect(resolveStackClosure(a, ["Net"])).toEqual(["Net"]);
    expect(resolveStackClosure(a, ["Data"])).toEqual(["Net", "Data"]);
  });

  it("publishedSsm/consumedSsmNames are pure over raw templates", () => {
    expect(publishedSsm({ Resources: { P: { Type: "AWS::SSM::Parameter", Properties: { Name: "/x", Value: "v" } } } })).toEqual([
      { name: "/x", literalValue: "v", tokenKind: null },
    ]);
    expect(consumedSsmNames({ Parameters: { BootstrapVersion: { Type: "AWS::SSM::Parameter::Value<String>", Default: "/b" } } })).toEqual([]);
  });

  it("listStacks enumerates stack artifacts without deep parsing", () => {
    expect(listStacks(MULTI).sort()).toEqual(["Api", "Data", "Net"]);
  });
});

describe("resolveStackClosure error cases", () => {
  it("an unknown root names the available stacks", () => {
    const a = analyzeAssembly(MULTI);
    expect(() => resolveStackClosure(a, ["Nope"])).toThrowError(/Unknown stack 'Nope'.*Net, Data, Api/s);
  });

  it("a dangling consume (no publisher in the assembly) is a configuration error", () => {
    const a = analyzeAssembly(MULTI);
    a.byArtifact["Api"]!.consumes = ["/app/missing"];
    expect(() => resolveStackClosure(a, ["Api"])).toThrowError(/consumes SSM '\/app\/missing' but no stack.*publishes it/);
  });

  it("a dependency cycle is caught with the trail", () => {
    const a = analyzeAssembly(MULTI);
    a.byArtifact["Net"]!.dependsOn = ["Data"]; // Net→Data→Net
    expect(() => resolveStackClosure(a, ["Data"])).toThrowError(/Cyclic stack dependency/);
  });
});

describe("resolveCdkEntry (the cross-platform synth path)", () => {
  it("resolves the consumer's own aws-cdk CLI entry from its directory", () => {
    const consumer = path.join(HERE, "fixtures", "fake-consumer");
    const entry = resolveCdkEntry(consumer);
    expect(entry).not.toBeNull();
    expect(entry!.endsWith(path.join("aws-cdk", "bin", "cdk"))).toBe(true);
  });

  it("is null when aws-cdk is not installed there (the npx fallback applies)", () => {
    expect(resolveCdkEntry(path.join(HERE, "fixtures", "single-stack"))).toBeNull();
  });
});

describe("createSynthStackHandler over a pre-synthesized assembly (the CI/test path)", () => {
  const handler = createSynthStackHandler({ assemblyDir: REAL });

  it("returns the canonical surface for a named stack", async () => {
    const r = (await handler({ stack: "FeatureDashboardLocalData" })) as any;
    expect(r.status).toBe(200);
    expect(r.body.stackName).toBe("feature-dashboard-local-data");
    expect(r.body.resourceCounts["AWS::DynamoDB::Table"]).toBe(1);
  });

  it("merges a semantic projection OVER the canonical surface", async () => {
    const projected = createSynthStackHandler({
      assemblyDir: REAL,
      project: ({ stack, surface }) => ({
        tableCount: countOfType(stack, "AWS::DynamoDB::Table"),
        closureDepth: surface.closure.length,
      }),
    });
    const r = (await projected({ stack: "FeatureDashboardLocalData" })) as any;
    expect(r.status).toBe(200);
    expect(r.body.tableCount).toBe(1);
    expect(r.body.closureDepth).toBe(1);
    expect(r.body.publishes).toHaveLength(10); // canonical fields survive the merge
  });

  it("400s a missing stack id and 404s an unknown stack", async () => {
    expect(((await handler({})) as any).status).toBe(400);
    const r = (await handler({ stack: "Ghost" })) as any;
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("UNKNOWN_STACK");
  });
});
