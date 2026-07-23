// Full invoke choreography without a real browser: a fake `playwright` module
// is planted in the fixture project's node_modules, and the adapter resolves it
// from projectRoot exactly as it would in a consumer install.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAdapter } from "./src/index.js";

const PKG = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(PKG, "fixtures", "journey-e2e");

const FAKE_PLAYWRIGHT = `
export const chromium = {
  async launch(opts) {
    globalThis.__pw_log = [];
    globalThis.__pw_log.push(["launch", opts.headless]);
    return {
      async newContext(ctxOpts) {
        globalThis.__pw_log.push(["context", ctxOpts]);
        return {
          async newPage() { return { goto: async (url) => globalThis.__pw_log.push(["goto", url]) }; },
          async close() { globalThis.__pw_log.push(["context-closed"]); },
        };
      },
      async close() { globalThis.__pw_log.push(["browser-closed"]); },
    };
  },
};
`;

const JOURNEY = `
export async function checkout(page, payload, ctx) {
  await page.goto(ctx.baseUrl + "/checkout");
  return { status: 200, body: { plan: payload.plan, actor: ctx.actor } };
}
export async function slow() { await new Promise((r) => setTimeout(r, 5000)); return { status: 200, body: {} }; }
`;

describe("playwright adapter journeys", () => {
  beforeAll(() => {
    rmSync(FIX, { recursive: true, force: true });
    mkdirSync(path.join(FIX, "node_modules", "playwright"), { recursive: true });
    writeFileSync(path.join(FIX, "package.json"), JSON.stringify({ name: "fixture", type: "module" }));
    writeFileSync(
      path.join(FIX, "node_modules", "playwright", "package.json"),
      JSON.stringify({ name: "playwright", version: "1.99.0", type: "module", main: "index.js" }),
    );
    writeFileSync(path.join(FIX, "node_modules", "playwright", "index.js"), FAKE_PLAYWRIGHT);
    writeFileSync(path.join(FIX, "journeys.mjs"), JOURNEY);
  });

  afterAll(() => rmSync(FIX, { recursive: true, force: true }));

  function adapter(extra: Record<string, unknown> = {}) {
    return createAdapter({
      commands: {
        Checkout: { module: "journeys.mjs", export: "checkout" },
        Slow: { module: "journeys.mjs", export: "slow" },
      },
      invoke: { baseUrl: "http://shop.test", headless: true, ...(extra.invoke as object) },
      actors: { admin: { storageState: "auth/admin.json" } },
      projectRoot: FIX,
      ...extra,
    });
  }

  it("runs a journey and returns its normalized outcome", async () => {
    const a = adapter();
    await a.setup();
    const r = await a.invoke("Checkout", { plan: "pro" }, "admin");
    expect(r).toEqual({ status: 200, body: { plan: "pro", actor: "admin" } });
    await a.teardown();
    const log = (globalThis as Record<string, unknown>).__pw_log as unknown[][];
    expect(log.some((l) => l[0] === "goto" && l[1] === "http://shop.test/checkout")).toBe(true);
    expect(log.some((l) => l[0] === "context-closed")).toBe(true);
    expect(log.some((l) => l[0] === "browser-closed")).toBe(true);
  });

  it("anonymous runs a fresh context with no storageState", async () => {
    const a = adapter();
    await a.setup();
    await a.invoke("Checkout", { plan: "free" }, "anonymous");
    const log = (globalThis as Record<string, unknown>).__pw_log as unknown[][];
    const ctx = log.filter((l) => l[0] === "context").pop()![1] as Record<string, unknown>;
    expect(ctx.storageState).toBeUndefined();
    await a.teardown();
  });

  it("actor storageState resolves from the project root", async () => {
    const a = adapter();
    await a.setup();
    await a.invoke("Checkout", {}, "admin");
    const log = (globalThis as Record<string, unknown>).__pw_log as unknown[][];
    const ctx = log.filter((l) => l[0] === "context").pop()![1] as Record<string, unknown>;
    expect(ctx.storageState).toBe(path.join(FIX, "auth/admin.json"));
    await a.teardown();
  });

  it("times out a hung journey with a clear error", async () => {
    const a = adapter({ invoke: { timeout: 100 } });
    await a.setup();
    await expect(a.invoke("Slow", {})).rejects.toThrowError(/exceeded 100ms/);
    await a.teardown();
  });

  it("resolves browsers from a CJS default-only playwright build", async () => {
    // Real playwright ships CJS; under the adapter's raw dynamic import the
    // browser types can land solely on the default export (observed on 1.61:
    // named-export detection fails, `ns.chromium` is undefined). The fake
    // below hides `chromium` behind a computed key so the lexer cannot
    // surface it as a named export — only `default` carries it.
    const cjsFix = path.join(PKG, "fixtures", "journey-cjs");
    rmSync(cjsFix, { recursive: true, force: true });
    mkdirSync(path.join(cjsFix, "node_modules", "playwright"), { recursive: true });
    writeFileSync(path.join(cjsFix, "package.json"), JSON.stringify({ name: "fixture-cjs", type: "module" }));
    writeFileSync(
      path.join(cjsFix, "node_modules", "playwright", "package.json"),
      JSON.stringify({ name: "playwright", version: "1.99.0", main: "index.js" }),
    );
    writeFileSync(
      path.join(cjsFix, "node_modules", "playwright", "index.js"),
      `const impl = {
        async launch() {
          return {
            async newContext() {
              return {
                async newPage() { return { goto: async () => {} }; },
                async close() {},
              };
            },
            async close() {},
          };
        },
      };
      module.exports["chrom" + "ium"] = impl;`,
    );
    writeFileSync(
      path.join(cjsFix, "journeys.mjs"),
      `export async function ping(page, payload, ctx) { return { status: 200, body: { ok: true } }; }`,
    );
    const a = createAdapter({
      commands: { Ping: { module: "journeys.mjs", export: "ping" } },
      invoke: { headless: true },
      projectRoot: cjsFix,
    });
    await a.setup();
    const r = await a.invoke("Ping", {});
    expect(r).toEqual({ status: 200, body: { ok: true } });
    await a.teardown();
    rmSync(cjsFix, { recursive: true, force: true });
  });

  it("errors clearly on an unrouted command", async () => {
    // NOTE: the missing-peer error path (setup() without playwright resolvable)
    // is deliberately untested — NODE_PATH-style environment hoists make it
    // unfalsifiable on some dev machines; the guard is a plain try/catch.
    const a = adapter();
    await a.setup();
    await expect(a.invoke("Nope", {})).rejects.toThrowError(/not routed/);
    await a.teardown();
  });
});
