// Finds the project's own `feat` CLI for the extension, never a fetched one (ADR-0026, amended). The
// extension used to run `npx feat watch --json`, and without a local @mmmnt/feature npx fetched the npm
// package `feat`, which is not Feature, from the registry. No vscode import: testable under plain Node.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The `feat` bin of the first `node_modules/@mmmnt/feature/package.json` from `root` upward (a
 * workspace-hoisted install is found), as an absolute path; null when there is none, it names no `feat`
 * bin, or the file is absent.
 */
export function resolveFeatBin(root: string): string | null {
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const manifestPath = path.join(dir, "node_modules", "@mmmnt", "feature", "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { bin?: string | Record<string, string> };
      const rel = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.feat;
      if (rel === undefined) return null;
      const bin = path.resolve(path.dirname(manifestPath), rel);
      return existsSync(bin) ? bin : null;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** What the extension tells the user when the project has no @mmmnt/feature. */
export function featNotInstalledMessage(root: string): string {
  return (
    `Feat: @mmmnt/feature is not installed in ${root}. The extension runs the project's own feat and never ` +
    `fetches one; install it as a dev dependency (npm install --save-dev @mmmnt/feature, or ` +
    `pnpm add -D @mmmnt/feature), then run "Feat: Start watch".`
  );
}
