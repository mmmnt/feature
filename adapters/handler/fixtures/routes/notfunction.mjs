// SPEC-ADPHND-003 fixture: loads, but its `handler` export is a string.
(globalThis.__featHandlerRouteImports ??= []).push("notfunction.mjs");
export const handler = "not a handler";
