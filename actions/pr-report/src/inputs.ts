// The Action's inputs, read as the runner passes them: `INPUT_<NAME>` with the name upper-cased and its spaces made
// underscores, its hyphens kept (`signing-key` arrives as `INPUT_SIGNING-KEY`). This module is the only reader of
// `INPUT_` variables (src/inputs.test.ts sweeps the rest of src/ for a direct read): a hand-spelled
// `INPUT_SIGNING_KEY` once left sign mode without its key on main.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export type Env = Record<string, string | undefined>;

export const inputName = (name: string): string => `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;

/** An input, trimmed; the fallback only when it is unset (an input passed empty, such as `evidence-prefix: ""`, is
 * empty, not the fallback). */
export function input(env: Env, name: string, fallback = ""): string {
  return (env[inputName(name)] ?? fallback).trim();
}

/** A secret input exactly as passed (a key's bytes and a password are not trimmed). */
export function rawInput(env: Env, name: string): string {
  return env[inputName(name)] ?? "";
}

/** Sign mode's key and password. */
export function signingSecrets(env: Env): { key: string; password: string } {
  return { key: rawInput(env, "signing-key"), password: rawInput(env, "signing-password") };
}

/** The merge statement the report run wrote, and the digest of its bytes as written. */
export function readStatementFile(file: string): { statement: any; digest: string } {
  const bytes = readFileSync(file);
  return {
    statement: JSON.parse(bytes.toString("utf8")),
    digest: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
  };
}
