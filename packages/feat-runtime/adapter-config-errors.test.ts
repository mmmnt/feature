// The README contract: "Exit codes everywhere: 0 success · 1 validation failure · 2 configuration error"
// (founder ruling 2026-11-10). A configuration error the harness or the adapter loader raises carries the
// runner's prefix `Configuration error (exit 2): ` and its `[CODE]`, so the runner's reporter can tell it
// from a failed test: an adapter that cannot be resolved, loaded or lacks createAdapter, an adapter that
// cannot seed() or deliver(), and a config createHarness cannot load.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHarness, HarnessConfigurationError, type HarnessCase } from "./src/harness.js";
import { importAdapter } from "./src/import-adapter.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(PKG, "fixtures/harness");
const PREFIX = "Configuration error (exit 2): ";

describe("importAdapter failures are configuration errors", () => {
  it("an npm specifier that cannot be resolved", async () => {
    const e = await importAdapter("no-such-adapter-package", FIXTURES).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HarnessConfigurationError);
    expect((e as HarnessConfigurationError).code).toBe("INVALID_CONFIG");
    expect((e as Error).message).toContain(`${PREFIX}[INVALID_CONFIG] Adapter module 'no-such-adapter-package' could not be resolved`);
  });
  it("a module that cannot be loaded", async () => {
    const e = await importAdapter("./throws-on-load.mjs", FIXTURES).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HarnessConfigurationError);
    expect((e as Error).message).toContain(`${PREFIX}[INVALID_CONFIG] Adapter module './throws-on-load.mjs' could not be loaded`);
    expect((e as Error).message).toContain("boom while loading");
  });
  it("a module with no createAdapter", async () => {
    const e = await importAdapter("./no-create.mjs", FIXTURES).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HarnessConfigurationError);
    expect((e as Error).message).toContain(`${PREFIX}[INVALID_CONFIG] Adapter module './no-create.mjs' lacks a createAdapter export`);
  });
});

describe("an adapter that cannot seed() or deliver()", () => {
  const caseOf = (given: object, extra: object = {}): HarnessCase =>
    ({
      anchor: "SPEC-T-BARE › 'a case'",
      name: "a case",
      specType: "command",
      given,
      ...extra,
      prediction: { type: "success", services: {} },
    }) as unknown as HarnessCase;
  const INLINE = { schemas: {}, goldens: {} };

  it("seed() is SEED_UNSUPPORTED", async () => {
    const h = await createHarness({ configPath: path.join(FIXTURES, "bare-service.config.json") });
    try {
      const e = await h.runCase(caseOf({ seeds: [{ service: "store", records: [] }] }), INLINE as never).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HarnessConfigurationError);
      expect((e as HarnessConfigurationError).code).toBe("SEED_UNSUPPORTED");
      expect((e as Error).message).toContain(`${PREFIX}[SEED_UNSUPPORTED] SPEC-T-BARE › 'a case': adapter for 'store' does not support seed()`);
    } finally {
      await h.teardown();
    }
  });

  it("deliver() is DELIVER_UNSUPPORTED", async () => {
    const h = await createHarness({ configPath: path.join(FIXTURES, "bare-service.config.json") });
    try {
      const e = await h.runCase(caseOf({}, { delivers: [{ service: "store", event: "Seen", payload: {} }] }), INLINE as never).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HarnessConfigurationError);
      expect((e as HarnessConfigurationError).code).toBe("DELIVER_UNSUPPORTED");
      expect((e as Error).message).toContain(`${PREFIX}[DELIVER_UNSUPPORTED] SPEC-T-BARE › 'a case': adapter for 'store' does not support deliver()`);
    } finally {
      await h.teardown();
    }
  });
});

describe("createHarness with a config loadConfig refuses", () => {
  it("throws a HarnessConfigurationError carrying the loader's code as [CODE]", async () => {
    const e = await createHarness({ configPath: path.join(FIXTURES, "no-such.config.json") }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(HarnessConfigurationError);
    expect((e as HarnessConfigurationError).code).toBe("CONFIG_NOT_FOUND");
    expect((e as Error).message).toContain(`${PREFIX}[CONFIG_NOT_FOUND] No config file exists at`);
  });
  it("names the detail the loader gave (an overlay that extends a missing base)", async () => {
    const e = await createHarness({ configPath: path.join(PKG, "fixtures/tiers/overlay-missing-base.config.json") }).catch((x: unknown) => x);
    expect((e as HarnessConfigurationError).code).toBe("EXTENDS_NOT_FOUND");
    expect((e as Error).message).toContain(`${PREFIX}[EXTENDS_NOT_FOUND]`);
    expect((e as Error).message).toContain("resolved to");
  });
});
