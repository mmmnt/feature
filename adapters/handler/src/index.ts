// @mmmnt/feat-adapter-handler — direct function invocation (ADR-0009 routing).
// Route shape: response.commands[<Command>] = { module, export }. Modules resolve
// relative to the user project root (process.cwd()). Handlers return
// CapturedResponse-shaped results ({ status, body }).

import path from "node:path";
import { pathToFileURL } from "node:url";
import type { CapturedResponse, FeatResponseAdapter } from "@mmmnt/feat-types";

interface HandlerRoute {
  module: string;
  export: string;
}

interface HandlerAdapterConfig {
  commands: Record<string, HandlerRoute>;
  actors?: { default?: string } & Record<string, unknown>;
  projectRoot?: string;
}

/** What a handler reads the time from (SPEC-ADPHND-001): its third argument, never a patched Date. */
export interface HandlerClock {
  now(): number;
  iso(): string;
  frozen: boolean;
}

export interface HandlerContext {
  clock: HandlerClock;
}

// ISO-8601 instant WITH a zone designator (Z or +hh:mm); the parsed time must also be finite.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function invalidClock(value: string): Error {
  return Object.assign(
    new Error(`'${value}' is not an ISO-8601 instant with a zone designator (Z or +hh:mm)`),
    { code: "INVALID_CLOCK" },
  );
}

type Handler = (payload: Record<string, unknown>, actor?: unknown, ctx?: HandlerContext) => Promise<CapturedResponse>;

class HandlerAdapter implements FeatResponseAdapter {
  private handlers = new Map<string, Handler>();
  private frozenAt: number | null = null;

  async setClock(clock: string | null): Promise<void> {
    if (clock === null) {
      this.frozenAt = null;
      return;
    }
    const at = ISO_INSTANT.test(clock) ? Date.parse(clock) : NaN;
    if (!Number.isFinite(at)) throw invalidClock(clock);
    this.frozenAt = at;
  }

  private context(): HandlerContext {
    const frozenAt = this.frozenAt;
    const now = () => (frozenAt ?? Date.now());
    return { clock: { now, iso: () => new Date(now()).toISOString(), frozen: frozenAt !== null } };
  }

  constructor(private config: HandlerAdapterConfig) {}

  async setup(): Promise<void> {
    // Routes load lazily on first invocation; nothing to provision.
  }

  async teardown(): Promise<void> {
    this.frozenAt = null;
    this.handlers.clear();
  }

  async invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse> {
    let handler: Handler | undefined = this.handlers.get(command);
    if (!handler) {
      const route = this.config.commands[command];
      if (!route) throw new Error(`Command '${command}' is not routed in response.commands — configuration error.`);
      const root = this.config.projectRoot ?? process.cwd();
      const mod = (await import(pathToFileURL(path.resolve(root, route.module)).href)) as Record<string, unknown>;
      const fn = mod[route.export];
      if (typeof fn !== "function")
        throw new Error(`Module '${route.module}' lacks export '${route.export}' (INV-10) — configuration error.`);
      handler = fn as Handler;
      this.handlers.set(command, handler);
    }
    const actorContext =
      actor === "anonymous" ? null
      : actor !== undefined ? this.config.actors?.[actor]
      : this.config.actors?.default !== undefined ? this.config.actors[this.config.actors.default]
      : undefined;
    const result = await handler(input, actorContext, this.context());
    return result;
  }
}

export function createAdapter(config: Record<string, unknown>): FeatResponseAdapter {
  return new HandlerAdapter(config as unknown as HandlerAdapterConfig);
}
