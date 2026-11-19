// The runner passes `signing-key` as `INPUT_SIGNING-KEY`, hyphen kept; sign mode once read `INPUT_SIGNING_KEY` and
// went to main without its key. Inputs are read only through src/inputs.ts, under the runner's names.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { input, inputName, rawInput, signingSecrets } from "./inputs.js";

const here = path.dirname(new URL(import.meta.url).pathname);

// the environment a runner gives a step `with: { signing-key: …, signing-password: …, evidence-prefix: "" }`
const runner = {
  "INPUT_SIGNING-KEY": "-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----\nabc\n-----END ENCRYPTED SIGSTORE PRIVATE KEY-----\n",
  "INPUT_SIGNING-PASSWORD": " pass word ",
  "INPUT_EVIDENCE-PREFIX": "",
  "INPUT_SIGN-STATEMENT": " target/merge-statement/merge-statement.json ",
};

describe("the Action's inputs, as the runner passes them", () => {
  it("names an input as the runner does: upper-cased, spaces to underscores, hyphens kept", () => {
    expect(inputName("signing-key")).toBe("INPUT_SIGNING-KEY");
    expect(inputName("check name")).toBe("INPUT_CHECK_NAME");
  });

  it("sign mode receives the key and the password the runner passed, byte for byte", () => {
    expect(signingSecrets(runner)).toEqual({
      key: runner["INPUT_SIGNING-KEY"],
      password: " pass word ",
    });
    expect(signingSecrets({ INPUT_SIGNING_KEY: "x" }).key).toBe("");
  });

  it("an input passed empty is empty, not its fallback; an unset one is the fallback", () => {
    expect(input(runner, "evidence-prefix", "feat-evidence-")).toBe("");
    expect(input({}, "evidence-prefix", "feat-evidence-")).toBe("feat-evidence-");
    expect(input(runner, "sign-statement")).toBe("target/merge-statement/merge-statement.json");
    expect(rawInput(runner, "sign-statement")).toBe(" target/merge-statement/merge-statement.json ");
  });

  // Sweep, not a list: every source file but inputs.ts is read, and none may read an INPUT_ variable itself.
  it("no other source file reads an INPUT_ variable", () => {
    const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "inputs.ts");
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const code = readFileSync(path.join(here, f), "utf8").replace(/^\s*\/\/.*$/gm, "");
      expect(code, f).not.toMatch(/INPUT_/);
    }
  });
});
