// SPEC-ADPHND-003 fixture: records its evaluation, then throws, so the module cannot be imported.
(globalThis.__featHandlerRouteImports ??= []).push("throws.mjs");
throw new Error("throws.mjs fails while it is evaluated");
