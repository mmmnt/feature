// The credential-reference ladder, pure (no AWS calls; always runs): exactly
// one auth form, env-var NAMES never values, clear configuration errors.
import { afterEach, describe, expect, it } from "vitest";
import { createAdapter, resolveAuth, resolveEndpoint } from "./src/index.js";

describe("auth resolution ladder", () => {
  afterEach(() => {
    delete process.env.FEAT_TEST_AK;
    delete process.env.FEAT_TEST_SK;
    delete process.env.FEAT_TEST_ST;
  });

  it("absent auth resolves to the default chain", () => {
    expect(resolveAuth(undefined)).toEqual({ kind: "default" });
    expect(resolveAuth({})).toEqual({ kind: "default" });
  });

  it("profile, role, and env-named forms each resolve to their kind", () => {
    expect(resolveAuth({ profile: "staging-observer" }).kind).toBe("profile");
    expect(resolveAuth({ roleArn: "arn:aws:iam::1:role/feat-observer" }).kind).toBe("role");
    expect(resolveAuth({ accessKeyIdEnv: "FEAT_TEST_AK", secretAccessKeyEnv: "FEAT_TEST_SK" }).kind).toBe("static-env");
  });

  it("more than one form is a configuration error, not a precedence guess", () => {
    expect(() => resolveAuth({ profile: "x", roleArn: "arn:aws:iam::1:role/y" })).toThrowError(
      /exactly ONE.*configuration error/s,
    );
    expect(() =>
      resolveAuth({ roleArn: "arn:aws:iam::1:role/y", accessKeyIdEnv: "A", secretAccessKeyEnv: "B" }),
    ).toThrowError(/exactly ONE/);
  });

  it("env-named form requires both key names", () => {
    expect(() => resolveAuth({ accessKeyIdEnv: "FEAT_TEST_AK" })).toThrowError(/BOTH accessKeyIdEnv and secretAccessKeyEnv/);
  });

  it("env-named provider reads values lazily and names the missing var", async () => {
    const r = resolveAuth({ accessKeyIdEnv: "FEAT_TEST_AK", secretAccessKeyEnv: "FEAT_TEST_SK", sessionTokenEnv: "FEAT_TEST_ST" });
    if (r.kind !== "static-env") throw new Error("expected static-env");
    await expect(r.credentials()).rejects.toThrowError(/FEAT_TEST_AK is not set/);
    process.env.FEAT_TEST_AK = "ak";
    process.env.FEAT_TEST_SK = "sk";
    process.env.FEAT_TEST_ST = "st";
    await expect(r.credentials()).resolves.toEqual({ accessKeyId: "ak", secretAccessKey: "sk", sessionToken: "st" });
  });

  it("ephemeral is mutually exclusive with table/endpoint/auth", () => {
    expect(() => createAdapter({ options: { ephemeral: {}, table: "x" } })).toThrowError(/mutually exclusive/);
    expect(() => createAdapter({ options: { ephemeral: {}, auth: { profile: "p" } } })).toThrowError(/mutually exclusive/);
    expect(() => createAdapter({ options: { ephemeral: {}, endpoint: "http://x" } })).toThrowError(/mutually exclusive/);
  });

  it("a bad auth form is rejected at construction, before any AWS call", () => {
    expect(() => createAdapter({ options: { table: "t", auth: { profile: "a", roleArn: "arn:aws:iam::1:role/b" } } })).toThrowError(
      /exactly ONE/,
    );
  });
});

describe("endpoint resolution (endpoints belong to the environment)", () => {
  afterEach(() => {
    delete process.env.FEAT_TEST_EP;
  });

  it("absent = the real regional endpoint; literal passes through", () => {
    expect(resolveEndpoint({})).toBeUndefined();
    expect(resolveEndpoint({ endpoint: "http://127.0.0.1:8000" })).toBe("http://127.0.0.1:8000");
  });

  it("endpointEnv reads the named variable from the environment", () => {
    process.env.FEAT_TEST_EP = "http://localhost:4566";
    expect(resolveEndpoint({ endpointEnv: "FEAT_TEST_EP" })).toBe("http://localhost:4566");
  });

  it("an unset endpointEnv variable is a configuration error naming it", () => {
    expect(() => resolveEndpoint({ endpointEnv: "FEAT_TEST_EP" })).toThrowError(/FEAT_TEST_EP is not set/);
  });

  it("endpoint and endpointEnv together are a configuration error", () => {
    expect(() => resolveEndpoint({ endpoint: "http://a", endpointEnv: "FEAT_TEST_EP" })).toThrowError(
      /mutually exclusive/,
    );
  });

  it("ephemeral excludes endpointEnv like every external binding", () => {
    expect(() =>
      createAdapter({ options: { ephemeral: {}, endpointEnv: "FEAT_TEST_EP" } }),
    ).toThrowError(/mutually exclusive/);
  });
});
