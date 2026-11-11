// Compile-time test (run by `pnpm test` via tsconfig.test.json): the parser in
// packages/feat-core emits `fn: "iso"` and an optional `offsetMs` for iso(), now(ms)
// and iso(ms) (ADR-0017). VariableDefinition must admit every call it emits.
import type { SpecVariable, VariableDefinition } from "./src/index.js";

export const emitted: VariableDefinition[] = [
  { kind: "call", fn: "now" },
  { kind: "call", fn: "unique" },
  { kind: "call", fn: "iso" },
  { kind: "call", fn: "now", offsetMs: 3_600_000 },
  { kind: "call", fn: "iso", offsetMs: -3_600_000 },
];

export const variable: SpecVariable = {
  name: "expiresAt",
  type: "string",
  definition: { kind: "call", fn: "iso", offsetMs: 259_200_000 },
};
