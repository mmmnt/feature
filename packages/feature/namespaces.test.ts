// SPEC-RT-006: `feat run` checks the run's spec set for a namespace collision before any file starts, and it must
// check the value the harness will derive: the spec file's path relative to the directory of the BASE config
// (the path generation bakes into the suite as its namespace path), not relative to the working directory.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HarnessConfigurationError, deriveNamespace } from "@mmmnt/feat-runtime";
import { assertRunNamespaces } from "./src/namespaces.js";
import { generateAll } from "./src/pipeline.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const everyPathCollides = () => "0".repeat(64);

describe("the run's namespace check uses the base config's directory", () => {
  // cwd is /proj; the config lives in /proj/cfg, so a spec at /proj/specs/a.feat is `../specs/a.feat` to the harness
  const prepared = { config: { extends: "feat.base.config.json" }, configAbs: "/proj/cfg/feat.integration.config.json" } as never;
  const specs = ["specs/a.feat", "specs/b.feat"];

  it("names the colliding files by their path from the base config's directory", () => {
    const e = (() => {
      try {
        assertRunNamespaces("/proj", prepared, specs, everyPathCollides);
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(HarnessConfigurationError);
    expect((e as HarnessConfigurationError).code).toBe("NAMESPACE_COLLISION");
    expect((e as Error).message).toContain("../specs/b.feat and ../specs/a.feat derive the same namespace");
  });

  it("anchors on the base even when the overlay lives in another directory", () => {
    const overlay = { config: { extends: "../feat.config.json" }, configAbs: "/proj/tiers/feat.integration.config.json" } as never;
    expect(() => assertRunNamespaces("/proj", overlay, specs, everyPathCollides)).toThrow("specs/b.feat and specs/a.feat derive the same namespace");
  });

  it("passes a run whose files derive distinct namespaces", () => {
    expect(() => assertRunNamespaces("/proj", prepared, specs)).not.toThrow();
  });

  it("checks the namespace path generation bakes into each suite", async () => {
    const root = path.join(PKG, "fixtures/tier");
    let seen: { config: { extends?: string }; configAbs: string } | undefined;
    const files = await generateAll(root, "feat.integration.config.json", { onPrepared: (p) => (seen = p) });
    const baseDir = path.dirname(path.resolve(root, "feat.config.json"));
    for (const f of files) {
      const abs = path.resolve(root, f.specPath);
      const ns = deriveNamespace(abs, baseDir);
      expect(f.content).toContain(`"${path.relative(baseDir, abs).split(path.sep).join("/")}"`);
      expect(ns).toMatch(/^s[0-9a-f]{12}$/);
    }
    expect(() => assertRunNamespaces(root, seen as never, files.map((f) => f.specPath))).not.toThrow();
  });
});
