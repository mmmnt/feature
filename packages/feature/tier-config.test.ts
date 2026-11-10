// ADR-0024: every command reads its config through loadConfig, so a tier overlay that drifts from its
// base (here: an added command) is refused with TIER_SPACE_MISMATCH by run, verify, audit, lint, fmt,
// generate and report alike — and a well-formed overlay is read by them as the merged config.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateAll } from "./src/pipeline.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(PKG, "bin/run.js");
const ROOT = path.join(PKG, "fixtures/tier");

function feat(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("node", [BIN, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number | null; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("every command reads the config through loadConfig", { timeout: 30_000 }, () => {
  for (const cmd of ["lint", "audit", "verify", "fmt", "report --evidence"]) {
    it(`feat ${cmd} refuses a drifting overlay`, () => {
      const r = feat([...cmd.split(" "), "--config", "feat.drifting.config.json"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("TIER_SPACE_MISMATCH");
    });
  }
  for (const cmd of ["generate", "run"]) {
    it(`feat ${cmd} refuses a drifting overlay`, () => {
      const r = feat([cmd, "--config", "feat.drifting.config.json"]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("TIER_SPACE_MISMATCH");
    });
  }
  it("feat lint reads a well-formed overlay as the merged config", () => {
    const r = feat(["lint", "--config", "feat.integration.config.json"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lint: 1 spec(s)");
  });
});

// The README contract: exit 2 is a configuration error, 1 a validation failure — on generate and verify too.
describe("a configuration error exits 2 on generate and verify", { timeout: 30_000 }, () => {
  const refusals: [string, string, string][] = [
    ["a drifting overlay", "feat.drifting.config.json", "TIER_SPACE_MISMATCH"],
    ["an overlay whose base is missing", "feat.orphan.config.json", "EXTENDS_NOT_FOUND"],
    ["a config that does not exist", "feat.nowhere.config.json", "CONFIG_NOT_FOUND"],
  ];
  for (const cmd of ["generate", "verify"]) {
    for (const [what, config, code] of refusals) {
      it(`feat ${cmd} exits 2 with ${code} for ${what}`, () => {
        const r = feat([cmd, "--config", config]);
        expect(r.code).toBe(2);
        expect(r.out).toContain(`[${code}]`);
      });
    }
  }
  it("feat verify still exits 1 for generated files that are not there (a validation failure)", () => {
    const r = feat(["verify", "--config", "feat.config.json"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("VERIFY_FAILED");
  });
});

describe("generation is the same in every tier (ADR-0024)", () => {
  it("a base and its overlay generate byte-identical files, whatever the tiers' services say", async () => {
    const spec = await generateAll(ROOT, "feat.config.json");
    const integration = await generateAll(ROOT, "feat.integration.config.json");
    expect(integration.map((f) => f.content)).toEqual(spec.map((f) => f.content));
    expect(spec[0]!.content).toContain("Inputs-hash: sha256:");
    // the embedded config path is the BASE's, not the overlay's
    expect(spec[0]!.content).toContain('"../feat.config.json"');
    expect(readFileSync(path.join(ROOT, "feat.integration.config.json"), "utf8")).toContain("eventual");
  });
});

describe("the run is told which files arm which faults (SPEC-RT-005)", () => {
  it("a generated file lists the Operation.Fault pairs its scenarios arm, from the IR", async () => {
    const files = await generateAll(path.join(PKG, "../../corpus/given-fault"), "feat.config.json");
    expect(files).toHaveLength(1);
    expect(files[0]!.faults).toEqual(["AppendToStream.AccessDenied", "AppendToStream.NotLeader", "AppendToStream.WrongExpectedVersion"]);
  });
  it("a file that arms no fault lists none", async () => {
    const files = await generateAll(ROOT, "feat.config.json");
    expect(files[0]!.faults).toEqual([]);
  });
});
