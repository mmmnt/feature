// SPEC-ADPHND-003 fixture: records its evaluation, then serves two routes (Alpha, AlphaTwo).
(globalThis.__featHandlerRouteImports ??= []).push("alpha.mjs");
export async function alpha() {
  return { status: "OK", body: { route: "Alpha" } };
}
export async function alphaTwo() {
  return { status: "OK", body: { route: "AlphaTwo" } };
}
