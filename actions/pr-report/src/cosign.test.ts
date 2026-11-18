// No signing path can reach a transparency log (ADR-0032 decision 13; founder 2026-11-17: "enforce the empty
// --signing-config in the Action with a test that fails if any signing path could reach a log").
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OFFLINE_SIGNING_CONFIG, assertOffline, attestArgs, verifyArgs, writeSigningConfig } from "./cosign.js";

const here = path.dirname(new URL(import.meta.url).pathname);
// Source text with comments removed, so a word in prose is not mistaken for a command.
const code = (f: string) =>
  readFileSync(path.join(here, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("cosign signing stays offline", () => {
  it("signs only with a signing config that names no service", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "prr-cosign-"));
    const cfg = writeSigningConfig(dir);
    const args = attestArgs({ key: "k", signingConfig: cfg, type: "t", predicate: "p", ref: "r@sha256:0" });
    expect(args[0]).toBe("attest");
    expect(args[args.indexOf("--signing-config") + 1]).toBe(cfg);
    const written = JSON.parse(readFileSync(cfg, "utf8"));
    expect(written).toEqual(OFFLINE_SIGNING_CONFIG);
    for (const k of ["caUrls", "oidcUrls", "rekorTlogUrls", "tsaUrls"]) expect(written[k]).toBeUndefined();
    expect(args.join(" ")).not.toMatch(/--tlog-upload|--rekor-url|--fulcio-url|--timestamp-server-url|--use-signing-config/);
  });

  it("refuses a signing config that names a transparency log or any other service", () => {
    for (const k of ["rekorTlogUrls", "caUrls", "oidcUrls", "tsaUrls"]) {
      expect(() => assertOffline({ [k]: [{ url: "https://rekor.sigstore.dev" }] })).toThrow(/must not reach/);
      const dir = mkdtempSync(path.join(tmpdir(), "prr-cosign-"));
      const cfg = path.join(dir, "c.json");
      writeFileSync(cfg, JSON.stringify({ ...OFFLINE_SIGNING_CONFIG, [k]: [{ url: "https://x" }] }));
      expect(() => attestArgs({ key: "k", signingConfig: cfg, type: "t", predicate: "p", ref: "r" })).toThrow(/must not reach/);
    }
  });

  it("verifies without requiring a log entry", () => {
    expect(verifyArgs({ key: "k", type: "t", ref: "r" })).toContain("--insecure-ignore-tlog");
  });

  // Sweep, not a list: every source file but cosign.ts is read, and none may build a cosign signing command itself.
  it("no other source file builds a cosign signing command", () => {
    const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "cosign.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = code(f);
      expect(text, f).not.toMatch(/["'`](attest|sign|attest-blob|sign-blob)["'`]/);
      expect(text, f).not.toMatch(/--signing-config|--tlog-upload|--rekor-url|signingconfig/);
    }
    const own = code("cosign.ts");
    expect(own.match(/["'`]attest["'`]/g)?.length).toBe(1);
    expect(own).not.toMatch(/["'`](sign|sign-blob|attest-blob)["'`]/);
  });
});
