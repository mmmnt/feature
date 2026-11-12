// SPEC-ADPHND-003 fixture: records its evaluation, then serves the Beta route.
(globalThis.__featHandlerRouteImports ??= []).push("beta.mjs");
export async function beta() {
  return { status: "OK", body: { route: "Beta" } };
}
