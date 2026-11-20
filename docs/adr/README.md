# Architecture decision records

ADR-0001 to ADR-0021 live outside this repository and were never committed here. Publication of
these records outside the repository is deferred (founder, 2026-11-09: "put the ADRs in the repo,
we can worry about publication later").

- [ADR-0022](ADR-0022-uppercamel-rejection-ids.md): rejection ids may be UPPER_SNAKE or UpperCamel, kept verbatim and compared case-sensitively.
- [ADR-0023](ADR-0023-adapter-interface-v2.md): adapter interface v2: observation modes, the scenario clock, fault injection.
- [ADR-0024](ADR-0024-tier-bindings.md): tier bindings: one set of specs, an overlay config per environment.
- [ADR-0025](ADR-0025-given-written-order.md): a given's seed and execute lines run in written order, recorded in the IR as `given.order`.
- [ADR-0026](ADR-0026-local-vitest.md): the runner runs the project's own vitest, resolved from the root, and never fetches one; no vitest is VITEST_NOT_INSTALLED, exit 2.
- [ADR-0027](ADR-0027-not-matcher.md): the negation matcher `not <matcher>`: present and the operand fails; `not not`, `not absent`, bare `not any` and `not { … }` refused; an unresolvable reference operand is a violation.
- [ADR-0028](ADR-0028-model-adapter-judgment-file.md): the model adapter is a recorded judge: one JSON Lines file per namespace, seeds are answers the adapter writes, asks are lines the system writes; no network, no model, no faults.
- [ADR-0030](ADR-0030-f32-digest-matcher.md): the f32 digest matcher `f32 <dims> sha256 "<hex>"`: an array of exactly dims numbers, each exactly an f32, whose little-endian f32 bytes hash to the digest; absent, non-array, wrong length, a non-f32 value and a differing digest are violations; `not f32 …` refused.
- [ADR-0031](ADR-0031-local-gate.md): the local gate is the explicit `scripts/ci-local.sh`, and pre-push only checks its pass record (the push held its connection idle through the gate and silently did not land); one gate at a time by the host-wide `~/.flmnt/gate.lock` and a CPU check; jobs serial (side by side measured not identical); turbo's build cache kept and bounded; `--changed`/`--rebased` scoped checks.
- [ADR-0032](ADR-0032-pr-report-action.md): a pull request build report Action (`actions/pr-report`): one updating comment and a required check, an auditable chain of evidence from PR head to signed provenance and the transparency log, main re-attests with a merge-linking attestation, fork PRs reported by a trusted follow-up; every push to main is attested, a direct commit (no pull request) included, under `pr-merge/v2` with the pushed range listed (decision 15).
