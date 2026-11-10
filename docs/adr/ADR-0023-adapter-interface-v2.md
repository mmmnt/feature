# ADR-0023 — Adapter interface v2: observation modes, the scenario clock, fault injection

Status: Accepted (founder, 2026-11-09: "agreed"; "put the ADRs in the repo"). Built; see the amendments below.

Tier bindings are ADR-0024. `DESIGN.md` (untracked, in `drafts/adapter-interface/`) carries the evidence and the full interface; it is not part of this record.

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

## Amendments by later rulings (2026-11-09)

Each item is checked against the repository history. Sift ruling ids (c7af7871, 18b625af, a59656b7,
58a4ac88, 0026e0ea) are not themselves commits; where a commit message does not cite the id, the
implementing commit is named and the id is cited from FEATURES.md.

- **Ruling c7af7871** (cited in a30fc08, 76c33e5 and the adapter commits):
  - Catalogs declare counts: an adapter's fault catalog names, per fault, which of `once`, `times`,
    `reset` it accepts (an array declares all three); a fault outside the catalog or armed with an
    undeclared count is `FAULT_UNSUPPORTED`. Built in a30fc08 (SPEC-RT-003 amended).
  - Integration (transport) faults are `until reset` only. Built in the adapter commits that cite
    c7af7871, e.g. fd4d845 (Kurrent); HEAD `adapters/kurrent/transport.feat` refuses a Connection
    fault armed with any other count.
  - The runner derives the namespace: one per spec file, from its path. Built in 7fedf88
    (SPEC-RT-006, cites 58a4ac88; c7af7871 not cited there).
  - Kafka uses the Confluent client (`@confluentinc/kafka-javascript` 1.11.0). Built in 65aa5e1.
  - BrokerLoss is serial: it runs in the serial pass after the parallel one. Built in e547150 and
    fd4d845, on the serial pass from 51552e8.
  - The fault-proxy library uses `toxiproxy-node-client` 4.1.0. Built in 76c33e5.
- **Rulings 18b625af and a59656b7** (cited in FEATURES.md, not in a commit message): the stdio
  adapter's `setup` sends `protocol: 2` and the namespace, and requires an echo `{protocol,
  namespace}`; the namespace matches `^s[0-9a-f]{12}$`; a wrong echo is `PROTOCOL_MISMATCH` or
  `NAMESPACE_NOT_HONOURED` before any case. Built in e114614 (SPEC-RPC-001) and 0dcd910
  (SPEC-RPC-002, pins protocol 2); the pattern is in 7fedf88.
- **"Namespace timing A"**: the response adapter's namespace is checked after the case's invoke and
  before the predictions; a service adapter's at setup. Built in 59acb9d (SPEC-RT-006 amendment).
- **"Fault shape B"**: the stdio adapter maps the harness arm onto the protocol's fault request with
  `kind = operation.fault`; its catalog declares only `once` and `times n`; a reset count or a
  detail is refused. Built in 69d9e62 (SPEC-RPC-001 amendment).
- **"RPC-002 A"**: one spec host per spec file, shared by the response and service roles. Built in
  0dcd910.
- **FPX "reset defaults upstream" and "listen= follows traces"**: in the fault-proxy library,
  ConnectionReset defaults to the upstream stream; the probe's `listen=` value follows the traces.
  Built in 76c33e5 (`adapters/fault-proxy/fault-proxy.feat`).
- **Product rulings**, each built in the commit named:
  - Kurrent `$tb` A (the capture drops the server's own `$metadata {"$tb": n}` after a soft delete)
    and Kurrent secure dev node: 1996908.
  - Kafka two-broker B: 65aa5e1; f0a69a2 later gave broker 2 a direct listener.
  - Neo4j both A: fe6399a; Neo4j firedFaults `orderId=zz`: f9d374c.
  - KMS `INSERT:k1`: f06f87b.
