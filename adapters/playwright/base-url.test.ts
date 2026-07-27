// resolveBaseUrl carries feat-adapter-http's exact contract: literal XOR
// env-named, loud configuration errors, empty default.
import { afterEach, describe, expect, it } from "vitest";
import { resolveBaseUrl } from "./src/index.ts";

afterEach(() => {
  delete process.env.FEAT_E2E_BASE_URL_TEST;
});

describe("resolveBaseUrl", () => {
  it("passes a literal through and defaults to empty", () => {
    expect(resolveBaseUrl({ baseUrl: "https://staging.example.com" })).toBe("https://staging.example.com");
    expect(resolveBaseUrl(undefined)).toBe("");
    expect(resolveBaseUrl({})).toBe("");
  });

  it("resolves the named environment variable", () => {
    process.env.FEAT_E2E_BASE_URL_TEST = "http://localhost:5173";
    expect(resolveBaseUrl({ baseUrlEnv: "FEAT_E2E_BASE_URL_TEST" })).toBe("http://localhost:5173");
  });

  it("fails loudly when the named variable is unset", () => {
    expect(() => resolveBaseUrl({ baseUrlEnv: "FEAT_E2E_BASE_URL_TEST" })).toThrow(
      "environment variable FEAT_E2E_BASE_URL_TEST is not set",
    );
  });

  it("refuses both forms at once", () => {
    expect(() => resolveBaseUrl({ baseUrl: "x", baseUrlEnv: "Y" })).toThrow("mutually exclusive");
  });
});
