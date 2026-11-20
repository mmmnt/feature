# ADR-0033 — a spec declares the services it observes (`observes`)

Status: DRAFT 2026-11-20, awaiting the founder's flip. Founder ruling 2026-11-20 N3 "Per-spec services" (NOT the
recommendation; flmnt workspace bc674142, decision f2f873a8): "Feature's grammar lets a spec declare the subset of
configured services it observes." Built in SPEC-CORE-001 (amended) and SPEC-DRV-002 (new).

## Context

INV-6 (grammar reference §5.3) puts every configured service in every prediction: `has []` is the explicit "nothing
happens here". A project that adds a service to its `feat.config.json` must therefore add a `<service> has []` line to
every prediction of every spec it already has, including verified ones. flmnt hit this when batch 2 added a `files`
service for Export's archive (FLMNT-SPEC-LCY-004): the mechanical `files has []` lines it added to verified Import,
PauseWrites and ResumeWrites (flmnt spec/batch-2 fcea0c4) changed three verified specs to say nothing new. The founder
ruled that those lines are reverted and that those specs declare they do not observe `files`.

## Decision

1. A header line `observes <service>[, <service>]...` may follow the header keywords. Each item is a service key of
   the active config (an IDENT in the closed service space, ADR-0007). The IR records it as a top-level `observes`, an
   array of the keys in written order.
2. No `observes` line means the spec observes every configured service: today's behaviour, unchanged. Its IR has no
   `observes` key, so every existing spec and corpus exemplar parses to the same IR.
3. Parse errors:
   - a key the config does not configure: `UNKNOWN_SERVICE_KEY`, listing the configured keys (the existing code: it is
     the same closed space);
   - a scenario that names a configured service the spec does not declare, in a `has` or `contains` prediction, a
     `seed`, a `deliver ... to`, a given `fault`, or an `@<service>[i]` capture reference (alone or inside `not`):
     the new `UNOBSERVED_SERVICE`, naming the service and listing the declared ones;
   - a prediction that omits a declared service: `INCOMPLETE_PREDICTION`, as today (INV-6 now reads "every observed
     service");
   - a bare `observes`, a key written twice, an empty item (leading, trailing or doubled comma), a second `observes`
     line: `MALFORMED_SYNTAX`, with the form as hint.
4. `observes` narrows what a success or an error predicts. It does not weaken the two absolute guarantees:
   - a rejection has zero effects on EVERY configured service: derive synthesises `has []` on each unobserved service
     for a rejection;
   - a query writes to no configured service: derive already synthesises `has []` on every service of a query
     (ADR-0011) and still does. A `contains` may name an observed service only.
   (This is the recommendation of open question F3-a in DESIGN.md. The alternative, F3-b, sets up only the observed
   services; see Rejected alternatives.)
5. Every configured service is still set up, reset and captured for every spec file. The harness diffs the services
   the resolved prediction names, which it already does, so the runtime, the emitted test file and the adapter
   interface do not change.
6. The language version stays `feat 1.0`: the change is additive, and every existing spec parses to the same IR.

## Consequences

- `schemas/builtspec.schema.json` gains `observes` (array of non-empty strings, minItems 1, uniqueItems);
  `@mmmnt/feat-types` gains `observes?: string[]` on BuiltSpec; the parser (feat-core) and derive implement it; the
  TextMate grammar scopes `observes` as a header keyword and its items as service IDENTs.
- The corpus gains exemplar #20, `corpus/spec-observes/`.
- `docs/grammar-reference.md` §2 (header), §5.3 (INV-6, the query guarantee, `predict rejection`) change as in
  `grammar-reference.change.md`.
- The parse error vocabulary gains `UNOBSERVED_SERVICE` (exit 1, a validation failure).
- A suite generated before this change never carries `observes`, so nothing regenerates for it.

## Rejected alternatives

- **Mechanical `has []` lines** (the recommendation the founder declined in N3): every verified spec changes whenever a
  service is added, and the lines assert nothing the spec is about.
- **An implicit `has []` on every unobserved service in every prediction**: identical in effect to the mechanical
  lines, only invisible; a success that wrote to an unobserved service would still fail, which is the opposite of
  "does not observe".
- **Observed services only, everywhere (F3-b)**: the harness would set up only the declared services, so a file need
  not have products it does not touch, but a rejection would no longer prove zero effects on every configured
  service, which the language states as non-negotiable, and it needs a harness change (a new SPEC-RT spec) and an
  emitted-file change.
- **Declaring the services NOT observed (`ignores files`)**: shorter for the common case, but a spec could not say
  what it covers, and a new service would silently join every spec that does not ignore it, which is today's problem.
- **The declaration in `construct:`**: the agent zone is freeform by law (DP-5); a compiler-checked declaration does
  not belong there.
- **A config-level map of spec globs to services**: the declaration would live away from the spec it governs and a
  reader of the spec could not see it.
