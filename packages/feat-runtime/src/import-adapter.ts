// Config-driven adapter loading (INV-10, ADR-0001). Every adapter named in
// feat.config.json — response, service, schema — comes through this one door, so the
// resolution rules and the failure messages are the same wherever an adapter is named.
//
// Resolution rules: a path specifier ("./…", "/…") resolves against the project root;
// an npm specifier resolves from the project root's package.json, never from the
// toolchain's own node_modules — the project owns its adapters (ADR-0001).

import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export interface AdapterModule {
  createAdapter: (cfg: Record<string, unknown>) => unknown;
}

export async function importAdapter(specifier: string, projectRoot: string): Promise<AdapterModule> {
  let resolved: string;
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    resolved = path.resolve(projectRoot, specifier);
  } else {
    // Resolve npm specifiers from the USER project root, per ADR-0001.
    const req = createRequire(path.join(projectRoot, "package.json"));
    try {
      resolved = req.resolve(specifier);
    } catch (cause) {
      throw new Error(
        `Adapter module '${specifier}' could not be resolved from ${projectRoot} — ` +
          `configuration error. Install it in the project that owns feat.config.json.`,
        { cause },
      );
    }
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(resolved).href)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `Adapter module '${specifier}' could not be loaded from ${resolved} — configuration error: ` +
        `${(cause as Error).message}`,
      { cause },
    );
  }
  const createAdapter = mod.createAdapter ?? (mod.default as Record<string, unknown> | undefined)?.createAdapter;
  if (typeof createAdapter !== "function")
    throw new Error(`Adapter module '${specifier}' lacks a createAdapter export (INV-10) — configuration error.`);
  return { createAdapter: createAdapter as (cfg: Record<string, unknown>) => unknown };
}
