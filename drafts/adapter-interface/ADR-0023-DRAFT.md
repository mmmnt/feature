# ADR-0023 (DRAFT) — Adapter interface v2: observation modes, the scenario clock, fault injection

Status: draft. The founder's rulings of 2026-11-09 (Sift workspace decision 05537e6e, as relayed;
the verbatim words are in that entry) ratify the direction below; the ADR itself still awaits the
flip to agreed. Tier bindings are ADR-0024. `DESIGN.md` carries the evidence and the full interface.

## Context

Feature's adapters were written for one environment each. Founder rulings of 2026-11-09
(79123645, 473acc1d) ask that every product adapter serve a **query** observation as well as a
**diff** one, that **faults** be injectable (logical at both tiers, transport at the integration
tier), and that **`clock at`** reach adapters. The v0.1.47 audit found: `has` already maps to
`stopCapture` (diff) and `contains` to `read` (state), but nothing declares which an adapter serves
and `read` is always called with `{}`; INV-6 makes `has` mandatory for every service, so diff is never
optional; `clock at` reaches no adapter although the grammar says the handler adapter honours it; and a
`fault` line in `given:` parses today as silent freeform context.

## Decision

**D1 — Observation modes, no grammar change.** `has` is the diff mode, `contains` the state mode.
Adapters gain an optional `observes: { diff: "native" | "snapshot", state: boolean }` and `read(query)`
receives a hint `{ expect: [{ type, key? }] }` built from the predicted records' literal fields (a
hint: the adapter may narrow, may return a superset, never fewer). An adapter that declares nothing is
`{ diff: "native", state: true }`. The harness refuses, before any effect, a `contains` on a service that
does not serve state: `MODE_UNSUPPORTED`, a configuration error (`HarnessConfigurationError`,
"Configuration error (exit 2)"). Diff cannot be refused: every adapter has `stopCapture` and INV-6 puts
`has` on every service; a store with no change feed serves diff by comparing snapshots and says so
(`snapshot`), and the evidence bundle records it.

**D2 — The clock hook (ruling 1: via `setClock`, as drafted).** Optional `setClock(clock: string | null)`
on response and service adapters, delivered on every case after the resets (a null when the case has no
`clock at`). A case with `clock at` against a response adapter lacking it is `CLOCK_UNSUPPORTED`. The
handler adapter honours it by passing `{ clock: { now, iso, frozen } }` as the handler's third argument,
never by patching `Date`; the instant must carry a zone designator (`INVALID_CLOCK` otherwise).

**D3 — Faults (ruling 3: `fault` is reserved inside `given:` in `feat 1.0`).** New `given:` line
`fault <service> <Operation> <Fault> [{ json }] [once | times <n> | until reset]`. A line that is
exactly `fault` or begins `fault` plus a space or tab is a fault line: well-formed ones land in
`given.faults`, any other is `MALFORMED_SYNTAX`, never freeform; `faults`, `faultline` are not
reserved. The version stays 1.0 because no existing line in the repo is affected and the old behaviour
(silently ignoring a fault) is a defect, not a contract. Adapters optionally declare `faults` (a catalog
operation -> fault names) and implement `fault(arm)` (and may implement `firedFaults()`). The harness
arms after seeds and executes, before the capture window, in written order; the adapter's own
instrumentation is never faulted; `reset()` disarms. A fault is a precondition, never an assertion: the
scenario predicts the system's reaction with the existing forms, and an armed fault that was not
consumed is a violation (`FAULT_NOT_CONSUMED`; exempt and recorded `unobserved` when the adapter
cannot see consumption). A fault the binding does not offer is `FAULT_UNSUPPORTED` before any effect.
Transport faults live under the pseudo-operation `Connection`, hold until reset, are offered only by
integration bindings, and are implemented by the product adapter through one shared Toxiproxy-based
library (plus container control for broker loss), never by a service of their own.

## Consequences

- Additive for every adapter and spec that exists: all new members are optional, an undeclared adapter
  keeps both modes, a case without `clock at` or `fault` changes nothing but a `setClock(null)` that
  adapters without the hook never see.
- A `contains` mistake, an unsupported `clock at`, and an unavailable fault all become failures before
  the case runs, with a message naming the service and what to change.
- Language change: the `fault` line (four layers: grammar reference, `corpus/given-fault`, parser/IR,
  corpus re-validated). SPEC-CORE-001 is amended (composition with the ADR-0022 amendment in DESIGN.md).
- Snapshot-diff services cannot prove "nothing happened" against a write undone inside the window; the
  evidence marks them.
- The product adapters inherit a concrete contract: declare `observes`; implement `peekCapture` and,
  only where truthful, `settle`; keep faults and observation on separate connections.
- Truthful `settle` is not universal: memory yes; fs and stripe no (SPEC-ADPFS-001, SPEC-ADPSTR-001
  state why). The harness keeps the ceiling for an adapter that answers false.

## Rejected alternatives

- **D1: new prediction keywords (`queries [...]`, `diff [...]`).** Grammar growth for something
  `has`/`contains` already express, and every existing spec would have to say which.
- **D1: a capability bag negotiated at run time (`supports("diff")`).** Lets an adapter change its
  answer between cases; a static declaration is auditable and goes in the evidence.
- **D1: let `diff: false` exist.** INV-6 requires `has` on every service, so such a service could never
  be predicted.
- **D1: make the mode a config key on the service.** A project could claim a mode the adapter lacks.
- **D1: pass the predicted records to `read` as a filter the adapter must apply.** Moves matcher
  semantics (`any uuid`, regex) into every adapter.
- **D2: patch the global `Date`/use fake timers in the harness.** Leaks into every adapter in the
  process and into the code under test unconditionally.
- **D2: a clock argument on `reset()`.** Response adapters have no `reset()`; two mechanisms.
- **D2: silently ignore `clock at` where unsupported.** A passing test that tested nothing.
- **D3: `feat 1.1` for the new line.** A version bump for a prefix no file uses; the cost falls on every
  project for a change that affects none.
- **D3: leave `fault ...` freeform when it does not match.** That is the defect: a typo in a
  precondition would silently become a comment and the scenario would pass untested.
- **D3: fault as a `when:`-like stimulus or a `predict` line.** A fault is neither the trigger nor an
  observed effect; as a precondition it composes with every trigger and keeps INV-9.
- **D3: a `faults:` block in config.** Hides a per-scenario precondition from the spec.
- **D3: transport faults through a pseudo-service.** `INCOMPLETE_PREDICTION` would force `has []` on a
  service with nothing to capture.
- **D3: build our own fault proxy.** Toxiproxy exists and is the standard instrument.
- **D3: logical faults by wrapping the product client inside the system under test.** Requires the
  system to cooperate and does not exercise the real client at the integration tier.
