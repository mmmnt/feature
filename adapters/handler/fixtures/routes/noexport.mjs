// SPEC-ADPHND-003 fixture: loads, but has no `handler` export.
(globalThis.__featHandlerRouteImports ??= []).push("noexport.mjs");
export const other = 1;
