# ADR-0029 — the case's random seed, `random seed <n>`

Status: Accepted (founder ruling 5f05d5e1, 2026-11-14, "Seedable randomness"; requested by flmnt). Built in
SPEC-CORE-001 (amended), SPEC-RT-013 (new) and SPEC-RPC-002 (amended).

## Context

A system that draws at random (an invite code, a token) cannot be predicted by a literal, so a spec can only
say `any string` and a consumer proves the rest beside the spec, in a unit test. The language deliberately has
no transform functions (§5.1b, DP-3), so "this field is the hash of that code" cannot be written either. The
scenario clock (ADR-0012, ADR-0023) solved the same problem for time: the harness hands the product a
deterministic source. Randomness needs the same.

## Decision

1. A given line `random seed <n>` (n a whole number from 0 to 2^53 − 1) is recorded as `given.random`. Any
   other line that begins `random seed` is MALFORMED_SYNTAX.
2. The harness delivers the seed to the response adapter's optional `setSeed(seed)` after the clock, and
   `setSeed(null)` on the first case after a seeded one, so a seed never reaches the next case. A case that
   neither seeds nor follows a seeded case sends nothing, so an adapter or a spec host without `setSeed` runs
   every spec that does not seed.
3. A case with `random seed` and a response adapter without `setSeed` is refused RANDOM_UNSUPPORTED before any
   effect.
4. The Feat Host Protocol gains the request `setSeed { seed: integer | null }`, still protocol version 2: the
   request is sent only when a spec seeds, so a host that does not implement it is unaffected until a spec
   needs it, and then answers method not found. The stdio adapter refuses a seed that is not a whole number in
   range as INVALID_SEED before any host call.
5. What a seed means is the host's: the same seed yields the same draws in the same order within the case.
   The product's random source in production is untouched; only the spec host substitutes a seeded one.

## Rejected alternatives

- **A digest matcher** (`sha256 of @given.response.code`): a transform in the matcher language, which DP-3
  excludes.
- **setSeed on every case** (as setClock): every existing host would fail with method not found.
- **Seeding by default** (a seed per case derived from its anchor): makes randomness disappear from every
  test silently; seeding is a declared precondition of the scenario.
