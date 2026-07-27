// @mmmnt/feat-adapter-playwright — response adapter where a command is a real
// browser journey. Each command routes to a consumer-authored journey module:
//   (page, payload, ctx) => Promise<{ status, body }>
// The journey drives the flow; the returned outcome is what predictions match.
// Playwright is a peer dependency, resolved from the consumer's project root.
// Actors map to Playwright storageState files (pre-authenticated sessions);
// `anonymous` runs a fresh context with no stored state.

import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import type { CapturedResponse, FeatResponseAdapter } from "@mmmnt/feat-types";

interface JourneyRoute {
  module: string;
  export: string;
}

interface PlaywrightAdapterConfig {
  commands: Record<string, JourneyRoute>;
  invoke?: {
    baseUrl?: string;
    /** Name of the env var carrying the base URL — app origins belong to the ENVIRONMENT. */
    baseUrlEnv?: string;
    /** chromium (default) | firefox | webkit */
    browser?: "chromium" | "firefox" | "webkit";
    headless?: boolean;
    /** Per-journey timeout in ms (default 30000). */
    timeout?: number;
  };
  actors?: { default?: string } & Record<string, unknown>;
  projectRoot?: string;
}

/**
 * Resolve the base URL: literal `baseUrl`, or the value of the env var named
 * by `baseUrlEnv` — app origins belong to the ENVIRONMENT (a deployed stage
 * URL, a local dev server), so per-tier configs reference them. Both set =
 * configuration error; named var unset = configuration error. The exact
 * contract of @mmmnt/feat-adapter-http's resolveBaseUrl. Exported for unit
 * testing.
 */
export function resolveBaseUrl(invoke: { baseUrl?: string; baseUrlEnv?: string } | undefined): string {
  if (invoke?.baseUrl !== undefined && invoke?.baseUrlEnv !== undefined)
    throw new Error(
      "@mmmnt/feat-adapter-playwright: invoke.baseUrl and invoke.baseUrlEnv are mutually exclusive — configuration error.",
    );
  if (invoke?.baseUrlEnv !== undefined) {
    const value = process.env[invoke.baseUrlEnv];
    if (!value)
      throw new Error(
        `@mmmnt/feat-adapter-playwright: environment variable ${invoke.baseUrlEnv} is not set (invoke.baseUrlEnv) — configuration error.`,
      );
    return value;
  }
  return invoke?.baseUrl ?? "";
}

export interface JourneyContext {
  baseUrl: string;
  actor: string | null;
}

type Journey = (
  page: unknown,
  payload: Record<string, unknown>,
  ctx: JourneyContext,
) => Promise<CapturedResponse>;

// Minimal structural types for the slice of Playwright we drive (peer dep —
// we must not import its types at build time).
interface PWBrowser {
  newContext(options?: Record<string, unknown>): Promise<PWContext>;
  close(): Promise<void>;
}
interface PWContext {
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}
interface PWBrowserType {
  launch(options?: Record<string, unknown>): Promise<PWBrowser>;
}

class PlaywrightAdapter implements FeatResponseAdapter {
  private browser: PWBrowser | null = null;
  private journeys = new Map<string, Journey>();
  private readonly root: string;
  private baseUrl = "";

  constructor(private config: PlaywrightAdapterConfig) {
    this.root = config.projectRoot ?? process.cwd();
  }

  async setup(): Promise<void> {
    // Resolve once, loudly, before any browser spends time launching.
    this.baseUrl = resolveBaseUrl(this.config.invoke);
    const req = createRequire(path.join(this.root, "package.json"));
    let pw: Record<string, PWBrowserType>;
    try {
      pw = (await import(pathToFileURL(req.resolve("playwright")).href)) as unknown as Record<string, PWBrowserType>;
    } catch {
      throw new Error(
        "@mmmnt/feat-adapter-playwright requires 'playwright' in the project (peer dependency) — configuration error.",
      );
    }
    const kind = this.config.invoke?.browser ?? "chromium";
    // CJS builds of playwright may surface browser types only on the default
    // export under raw dynamic import (named-export detection is best-effort).
    const ns = pw as Record<string, PWBrowserType> & { default?: Record<string, PWBrowserType> };
    const browserType = ns[kind] ?? ns.default?.[kind];
    if (!browserType) throw new Error(`Unknown browser '${kind}' — configuration error.`);
    this.browser = await browserType.launch({ headless: this.config.invoke?.headless ?? true });
  }

  async teardown(): Promise<void> {
    await this.browser?.close();
    this.browser = null;
  }

  private async journeyFor(command: string): Promise<Journey> {
    let journey = this.journeys.get(command);
    if (journey) return journey;
    const route = this.config.commands[command];
    if (!route) throw new Error(`Command '${command}' is not routed in response.commands — configuration error.`);
    const mod = (await import(pathToFileURL(path.resolve(this.root, route.module)).href)) as Record<string, unknown>;
    const fn = mod[route.export];
    if (typeof fn !== "function")
      throw new Error(`Module '${route.module}' lacks export '${route.export}' (INV-10) — configuration error.`);
    journey = fn as Journey;
    this.journeys.set(command, journey);
    return journey;
  }

  async invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse> {
    if (!this.browser) throw new Error("Adapter used before setup() — configuration error.");
    const journey = await this.journeyFor(command);

    const actorName = actor ?? this.config.actors?.default;
    const contextOptions: Record<string, unknown> = {};
    if (this.baseUrl) contextOptions.baseURL = this.baseUrl;
    if (actorName && actorName !== "anonymous") {
      const material = this.config.actors?.[actorName] as { storageState?: string } | undefined;
      if (material?.storageState) contextOptions.storageState = path.resolve(this.root, material.storageState);
    }

    const context = await this.browser.newContext(contextOptions);
    try {
      const page = await context.newPage();
      const timeout = this.config.invoke?.timeout ?? 30_000;
      const outcome = await Promise.race([
        journey(page, input, { baseUrl: this.baseUrl, actor: actorName ?? null }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Journey '${command}' exceeded ${timeout}ms`)), timeout),
        ),
      ]);
      return outcome;
    } finally {
      await context.close();
    }
  }
}

export function createAdapter(config: Record<string, unknown>): FeatResponseAdapter {
  return new PlaywrightAdapter(config as unknown as PlaywrightAdapterConfig);
}
