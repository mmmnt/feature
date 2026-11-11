// The run's namespace check (SPEC-RT-006): `feat run` refuses a collision before any file starts. It checks the
// value the harness derives, so it uses the same base: the spec file's path relative to the directory of the BASE
// config, the path generation bakes into each suite as its namespace path (a tier overlay's base, ADR-0024).

import path from "node:path";
import { assertNoNamespaceCollision, type Digest } from "@mmmnt/feat-runtime";
import type { Prepared } from "./pipeline.js";

/** `specPaths` are as `generateAll` reports them: relative to `root`. */
export function assertRunNamespaces(
  root: string,
  prepared: Pick<Prepared, "config" | "configAbs">,
  specPaths: readonly string[],
  digest?: Digest,
): void {
  const { config, configAbs } = prepared;
  const baseConfigAbs = config.extends ? path.resolve(path.dirname(configAbs), config.extends) : configAbs;
  assertNoNamespaceCollision(specPaths.map((p) => path.resolve(root, p)), path.dirname(baseConfigAbs), digest);
}
