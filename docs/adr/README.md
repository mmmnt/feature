# Architecture decision records

The design decisions behind Feature, one file per decision. A new design decision is a new ADR here,
numbered after the last, and an entry in this index.

ADR-0001 to ADR-0021 were recorded before this directory existed and are not in the repository. Other
ADRs and the grammar reference still cite them by number.

Two different records carry the number ADR-0028: the given's response as a matcher, and the model
adapter. Both are listed; the files are not renumbered, so links to either file keep working.

ADR-0021 is likewise cited for two different decisions: the fence, where the harness asks each eventual
service's adapter to `settle()` before it reads (`packages/feat-runtime`, the model adapter's README),
and cross-surface capture references, `@<service>[i].<path>` (grammar reference §5.4). Neither record is
in the repository.

| ADR | Decision |
| --- | --- |
| [ADR-0022](ADR-0022-uppercamel-rejection-ids.md) | Rejection ids may be UPPER_SNAKE or UpperCamel, kept verbatim and compared case-sensitively. |
| [ADR-0023](ADR-0023-adapter-interface-v2.md) | Adapter interface v2: observation modes, the scenario clock, fault injection. |
| [ADR-0024](ADR-0024-tier-bindings.md) | Tier bindings: one set of specs, an overlay config per environment. |
| [ADR-0025](ADR-0025-given-written-order.md) | A given's seed and execute lines run in written order, recorded in the IR as `given.order`. |
| [ADR-0026](ADR-0026-local-vitest.md) | The runner runs the project's own vitest, resolved from the root, and never fetches one; no vitest is `VITEST_NOT_INSTALLED`, exit 2. |
| [ADR-0027](ADR-0027-not-matcher.md) | The negation matcher `not <matcher>`: present and the operand fails; `not not`, `not absent`, bare `not any` and `not { … }` refused; an unresolvable reference operand is a violation. |
| [ADR-0028](ADR-0028-given-response-matcher.md) | `@given.response.<path>` and `@given[i].response.<path>` are matchers in a prediction's value blocks and under `not`, reading the response body of a given's `execute`; an unresolvable reference is a violation; IR `{ matcher: "givenRef", index?, path }`. |
| [ADR-0028](ADR-0028-model-adapter-judgment-file.md) | The model adapter is a recorded judge: one JSON Lines file per namespace, seeds are answers the adapter writes, asks are lines the system writes; no network, no model, no faults. |
| [ADR-0029](ADR-0029-seeded-randomness.md) | The given line `random seed <n>` (IR `given.random`) reaches the response adapter's optional `setSeed`, and `setSeed(null)` on the next case; a seed with no `setSeed` is `RANDOM_UNSUPPORTED`; the Host Protocol gains `setSeed`, still version 2. |
| [ADR-0030](ADR-0030-f32-digest-matcher.md) | The f32 digest matcher `f32 <dims> sha256 "<hex>"`: an array of exactly dims numbers, each exactly an f32, whose little-endian f32 bytes hash to the digest; `not f32 …` refused. |
| [ADR-0031](ADR-0031-local-gate.md) | The local gate is the explicit `scripts/ci-local.sh`, and pre-push only checks its pass record; one gate at a time by the host-wide `~/.flmnt/gate.lock` and a CPU check; jobs serial; turbo's build cache kept and bounded; `--changed`/`--rebased` scoped checks. |
| [ADR-0032](ADR-0032-pr-report-action.md) | A pull request build report Action (`actions/pr-report`): one updating comment and a required check, a chain of evidence from PR head to signed provenance verified against the repository's own key (no transparency log); every push to main is attested under `pr-merge/v2`. |
| [ADR-0033](ADR-0033-observes.md) | A spec may declare `observes <service>, ...`; no line means every configured service; `UNKNOWN_SERVICE_KEY` and `UNOBSERVED_SERVICE`; a rejection and a query still prove zero effects on every configured service. |
| [ADR-0034](ADR-0034-list-matchers.md) | Matchers inside a list: `{ matcher: "list", items }`, exact in length and order, with `{ matcher: "object", fields }` for an object item; a list with no matcher stays a literal. |
| [ADR-0035](ADR-0035-seed-transform.md) | A spec host may transform the store adapters' seeds (`options.seedTransform: { host }`, protocol method `transformSeed`); every seed is checked against its store's storable forms (`SEED_VALUE_UNSTORABLE`) before anything is written. |
| [ADR-0036](ADR-0036-deliver-to-response.md) | `deliver <Event> { … } to response` hands the event to the response adapter's optional `deliver()`; `response` is a reserved target, never a service. |
| [ADR-0037](ADR-0037-deliver-answer.md) | What the response role answers to a delivery is the case's captured response, so a delivery-only case can predict `response`; a service's answer is never kept. |
| [ADR-0038](ADR-0038-optional-field-lint.md) | A predicted record or response block that leaves out an optional property of its schema is the lint error `OPTIONAL_UNSTATED` unless it is marked `partial`; the IR records `"partial": true`. |
| [ADR-0039](ADR-0039-exact-nested-blocks.md) | A nested value block is exact: an undeclared key of its object is a violation in `has`, `contains` and responses, inside `partial` blocks too; the migration lint `NESTED_SCHEMA_OPEN` warns on a nested block whose schema is open. |
| [ADR-0040](ADR-0040-strict-lines.md) | The parser refuses what it silently dropped, replaced or rewrote: a scenario with no `predict` is `MISSING_MINIMUM`; every quoted string is a JSON string (`\uXXXX` decoded, any other escape `MALFORMED_SYNTAX`); a second line where one is allowed, and a trailing `#` comment on a line read by keyword, are `MALFORMED_SYNTAX`; header directives are read in the header only; `feat 1.0` stays. |
| [ADR-0041](ADR-0041-injected-clock.md) | The stdio JSON-RPC host's three timers (the request limit, the grace kill on a timeout and on close) run on a `Clock` given as `HostRegistry`'s second constructor parameter, the real clock by default; only SPEC-RPC-002's RunFiles injects a manual clock, which it advances on events, so its timeout scenarios never race wall time. |
