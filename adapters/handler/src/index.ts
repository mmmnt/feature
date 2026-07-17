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

class HandlerAdapter implements FeatResponseAdapter {
  private handlers = new Map<string, (payload: Record<string, unknown>, actor?: unknown) => Promise<CapturedResponse>>();

  constructor(private config: HandlerAdapterConfig) {}

  async setup(): Promise<void> {
    // Routes load lazily on first invocation; nothing to provision.
  }

  async teardown(): Promise<void> {
    this.handlers.clear();
  }

  async invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse> {
    let handler = this.handlers.get(command);
    if (!handler) {
      const route = this.config.commands[command];
      if (!route) throw new Error(`Command '${command}' is not routed in response.commands — configuration error.`);
      const root = this.config.projectRoot ?? process.cwd();
      const mod = (await import(pathToFileURL(path.resolve(root, route.module)).href)) as Record<string, unknown>;
      const fn = mod[route.export];
      if (typeof fn !== "function")
        throw new Error(`Module '${route.module}' lacks export '${route.export}' (INV-10) — configuration error.`);
      handler = fn as typeof handler & ((payload: Record<string, unknown>, actor?: unknown) => Promise<CapturedResponse>);
      this.handlers.set(command, handler!);
    }
    const actorContext =
      actor === "anonymous" ? null
      : actor !== undefined ? this.config.actors?.[actor]
      : this.config.actors?.default !== undefined ? this.config.actors[this.config.actors.default]
      : undefined;
    const result = await handler!(input, actorContext);
    return result;
  }
}

export function createAdapter(config: Record<string, unknown>): FeatResponseAdapter {
  return new HandlerAdapter(config as unknown as HandlerAdapterConfig);
}
