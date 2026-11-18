// cosign for the report (ADR-0032 decision 13): the consumer's own key, no transparency log. This module is the only
// place a cosign command line is built, so the offline guarantee is checked in one place (src/cosign.test.ts sweeps
// every other source file for a signing invocation that bypasses it).
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// cosign v3.1.4, pinned by the SHA-256 of each release binary (sigstore/cosign cosign_checksums.txt, tag commit
// 8843105d5771f142ffc8ec130e325e774547fc54). A download whose digest differs is refused.
export const COSIGN_VERSION = "v3.1.4";
export const COSIGN_SHA256: Record<string, string> = {
  "linux-amd64": "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa",
  "linux-arm64": "ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2",
  "darwin-amd64": "9d1e4abe2b6be279ed0d2ff706fde1ccd738747c834e3e6d44039c238867334f",
  "darwin-arm64": "9f9b8cd557cf2e5b3df3373a00baa005a86b02391e3e06dd0ce37b3a1533d3a4",
};

// A signing config with no services: no Fulcio, no OIDC, no transparency log, no timestamp authority. cosign v3
// otherwise takes the public-good config from TUF and uploads every attestation to the public Rekor log.
export const OFFLINE_SIGNING_CONFIG = {
  mediaType: "application/vnd.dev.sigstore.signingconfig.v0.2+json",
  rekorTlogConfig: {},
  tsaConfig: {},
} as const;

const SERVICE_KEYS = ["caUrls", "oidcUrls", "rekorTlogUrls", "tsaUrls"] as const;

// Refuses any signing config that names a service a signature could be sent to.
export function assertOffline(config: Record<string, unknown>): void {
  for (const k of SERVICE_KEYS) {
    const v = config[k];
    if (Array.isArray(v) ? v.length > 0 : v !== undefined)
      throw new Error(`signing config names ${k}: signing must not reach a transparency log or any other service`);
  }
}

export function writeSigningConfig(dir: string): string {
  assertOffline(OFFLINE_SIGNING_CONFIG as unknown as Record<string, unknown>);
  const p = path.join(dir, "signing-config.json");
  writeFileSync(p, JSON.stringify(OFFLINE_SIGNING_CONFIG));
  return p;
}

// The one signing command. The signing config must be offline; the flags that would reach a log are never passed.
export function attestArgs(o: { key: string; signingConfig: string; type: string; predicate: string; ref: string }): string[] {
  assertOffline(JSON.parse(readFileSync(o.signingConfig, "utf8")));
  return ["attest", "--key", o.key, "--signing-config", o.signingConfig, "--type", o.type, "--predicate", o.predicate, "--yes", o.ref];
}

// Verification with the given public key; there is no log entry to require (founder ruling 2026-11-17, "Add the flag").
export function verifyArgs(o: { key: string; type: string; ref: string }): string[] {
  return ["verify-attestation", "--key", o.key, "--insecure-ignore-tlog", "--type", o.type, "--output", "json", o.ref];
}

export function platform(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${os}-${arch}`;
}

// Downloads the pinned cosign once into `dir` and checks its digest before it is ever run.
export async function ensureCosign(dir: string): Promise<string> {
  const p = platform();
  const want = COSIGN_SHA256[p];
  if (!want) throw new Error(`no pinned cosign for ${p}`);
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, `cosign-${COSIGN_VERSION}-${p}`);
  if (!existsSync(bin) || createHash("sha256").update(readFileSync(bin)).digest("hex") !== want) {
    const res = await fetch(`https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-${p}`);
    if (!res.ok) throw new Error(`cosign download answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`cosign ${COSIGN_VERSION} ${p} digest ${got} is not the pinned ${want}`);
    writeFileSync(bin, bytes);
  }
  chmodSync(bin, 0o755);
  return bin;
}
