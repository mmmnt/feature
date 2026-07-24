// @mmmnt/feat-adapter-http — HTTP invocation (ADR-0009 routing, ADR-0012 actors).
// Route shape: { method, path } with {param} substitution from the payload; substituted
// params are removed from the body. GET/HEAD send remaining payload as query params.
// Actor material: response.actors[<name>].headers merged onto invoke.headers;
// `anonymous` sends no auth headers.

import type { CapturedResponse, FeatResponseAdapter } from "@mmmnt/feat-types";

interface HttpRoute {
  method: string;
  path: string;
}

interface HttpAdapterConfig {
  commands: Record<string, HttpRoute>;
  invoke?: { baseUrl?: string; baseUrlEnv?: string; headers?: Record<string, string> };
  actors?: { default?: string } & Record<string, unknown>;
}

/**
 * Resolve the base URL: literal `baseUrl`, or the value of the env var named
 * by `baseUrlEnv` — API origins belong to the ENVIRONMENT (a deployed stage
 * URL, an emulator's gateway), so per-tier configs reference them. Both set =
 * configuration error; named var unset = configuration error. Exported for
 * unit testing.
 */
export function resolveBaseUrl(invoke: { baseUrl?: string; baseUrlEnv?: string } | undefined): string {
  if (invoke?.baseUrl !== undefined && invoke?.baseUrlEnv !== undefined)
    throw new Error(
      "@mmmnt/feat-adapter-http: invoke.baseUrl and invoke.baseUrlEnv are mutually exclusive — configuration error.",
    );
  if (invoke?.baseUrlEnv !== undefined) {
    const value = process.env[invoke.baseUrlEnv];
    if (!value)
      throw new Error(
        `@mmmnt/feat-adapter-http: environment variable ${invoke.baseUrlEnv} is not set (invoke.baseUrlEnv) — configuration error.`,
      );
    return value;
  }
  return invoke?.baseUrl ?? "";
}

class HttpAdapter implements FeatResponseAdapter {
  constructor(private config: HttpAdapterConfig) {}

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}

  async invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse> {
    const route = this.config.commands[command];
    if (!route) throw new Error(`Command '${command}' is not routed in response.commands — configuration error.`);
    const baseUrl = resolveBaseUrl(this.config.invoke);

    const body: Record<string, unknown> = { ...input };
    const pathResolved = route.path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
      const v = body[name];
      delete body[name];
      return encodeURIComponent(String(v));
    });

    const headers: Record<string, string> = { ...(this.config.invoke?.headers ?? {}) };
    const actorName = actor ?? this.config.actors?.default;
    if (actorName && actorName !== "anonymous") {
      const material = this.config.actors?.[actorName] as { headers?: Record<string, string> } | undefined;
      Object.assign(headers, material?.headers ?? {});
    }

    const method = route.method.toUpperCase();
    let url = `${baseUrl}${pathResolved}`;
    const init: RequestInit = { method, headers };
    if (method === "GET" || method === "HEAD") {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) params.set(k, String(v));
      const qs = params.toString();
      if (qs) url += `?${qs}`;
    } else {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch {
      parsed = { raw: text };
    }
    return { status: res.status, body: parsed };
  }
}

export function createAdapter(config: Record<string, unknown>): FeatResponseAdapter {
  return new HttpAdapter(config as unknown as HttpAdapterConfig);
}
