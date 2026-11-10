# ADR-0024 — Tier bindings: one set of specs, an overlay config per environment

Status: Accepted (founder, 2026-11-09: "agreed"; "put the ADRs in the repo"). Built; see the amendments below.

Builds on ADR-0016 (`environment`). Founder ruling 4 split this out of the first combined draft; ruling 2 (overlay `extends`) and the acceptance of one-time regeneration are the decision recorded below.

## Context

The same specs must run at two tiers: the spec tier (in-process spec host, in-memory, `strong`) and the
integration tier (real products through product adapters, real consistency with `convergenceTimeout` /
`absenceTimeout`). One `feat.config.json` cannot declare both. ADR-0016 already names per-environment
config files as the intended pattern, but the docs' claim that generated suites are environment-agnostic
is false in v0.1.47: `pipeline.ts` hashes `config.services` and `config.response` whole, `derive` bakes
the default `ordered`/`unordered` from `consistency`, `emit` bakes the convergence window and invoke
allowance, and the generated file embeds one `CONFIG_PATH`. Two tiers give two different generated files
and `Inputs-hash` values; nothing checks that two standalone config files keep the same service keys,
command names and actor names.

## Decision

1. **Overlay file.** A per-environment config has top-level `extends` naming a base (path relative to the
   overlay). The base is the spec tier (recommended `environment: "spec"`); an overlay is the integration
   tier (`"integration"`). One level only: a base that itself extends is `EXTENDS_CHAIN`; a missing base
   is `EXTENDS_NOT_FOUND`.
2. **Merge.** The overlay replaces `environment`, `response`, `services.<key>`, `specs`, `report` whole,
   key by key (no deep merge: a Kurrent `options` must not inherit memory's). `featVersion` and
   `schemas` are inherited and may not be redeclared. `environment` is not inherited. The merged
   document is what is validated.
3. **Parity.** The overlay may not add or remove a service key, command name or actor name:
   `TIER_SPACE_MISMATCH` at load, exit 2. Specs are parsed against the base.
4. **Selection.** `feat run --config <overlay>`; generated suites resolve the active config at run time
   (`FEAT_CONFIG`), not from a path baked at generate time. `specs.exclude` (globs) removes spec files
   from a tier (transport-fault specs from the spec tier).
5. **Environment-agnostic derivation.** The `Inputs-hash` config slice becomes `featVersion` plus the
   names of services, commands and actors. The default ordering moves to the harness (resolved from the
   active config's `consistency`); the timing envelope moves to `feat run`, which passes `testTimeout`
   and `hookTimeout` computed from the active config. The founder accepts the one-time regeneration of
   every committed generated file.
6. **Evidence.** The bundle records the base and overlay digests and, per binding, adapter, version,
   consistency, timeouts, `observes` (ADR-0023) and fault-consumption observability.

## Consequences

- A spec means the same thing in both tiers by construction; drift is a load error, not a surprise.
- After the one-time header-hash change, changing a timeout, an adapter or an option regenerates nothing.
- Standalone `npx vitest` on a generated file loses the baked timing envelope and needs `feat run` (or the
  runner flags) to supply it.
- `loadConfig` grows (SPEC-RT-004); the config schema gains `extends` and `specs.exclude`; `feat run`
  and `feat verify` take the base for generation.

## Rejected alternatives

- **Separate standalone config per tier.** Works today (zero-change fallback) but nothing keeps the
  spaces equal, and the hash differs per tier.
- **An `environments: { ... }` map inside one file.** Collides with `config.environment` as an explicit
  override, mixes both tiers' endpoints and secrets in one document, and cannot be gated per environment
  by file access.
- **Keep hashing the full slice.** Then "environment-agnostic" stays false.
- **Deep merge.** Stale adapter options leak across products.
- **Inherit `environment`.** An integration run would be stamped with the base's environment.
- **Multi-level `extends`.** Chains hide what a tier actually runs; one level is enough for two tiers.

## Amendments by later rulings (2026-11-09)

- **Ruling 0026e0ea and RT-004 "004 - a"**: per-key services merge. Built in d6315a4 (SPEC-RT-004,
  `loadConfig` resolves the overlay, refuses a missing base, a chain and a changed closed space).
  The founder's words (Sift workspace, 2026-11-09) were "004 - a", choosing option A: an overlay's
  `services` merges per key. Each `services.<key>` the overlay names replaces the base's entry whole,
  and every key it does not name is inherited from the base. That is decision 2 as written. Because an
  omitted key is inherited, an overlay cannot remove a service, so the draft's outline row expecting
  `filesystem` to be removed (`overlay-removes-service.config.json`) contradicted decision 2 and was
  deleted. Rejected: option B, under which a present `services` block is the tier's complete set and
  must equal the base's keys.
- **"Tier split A"**: the integration tier runs the container-heavy transport and broker-loss specs
  as its own pass through `feat.integration.config.json`, and the spec tier excludes them. Built in
  6212f3e.
- **Implementation of the decision**, for reference: 53b9838 (every command reads config through
  `loadConfig`), a0a1fd7 (`specs.exclude`), 4d37c0f (environment-agnostic generation, `FEAT_CONFIG`),
  8a9fa9d (evidence bundle records the overlay, its base and the bindings).
