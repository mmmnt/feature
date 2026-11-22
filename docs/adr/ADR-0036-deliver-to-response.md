# ADR-0036 — a scenario may deliver its event to the response role

Status: Accepted (founder, 2026-11-22: agreed b680b51c; D1–D4 ruled in 28f7d2d6, all as recommended). Founder ruling aee7d787 (flmnt, 2026-11-22, batch 5 workshop B5-q3, "Feature change", NOT the
recommendation): Feature lets `deliver` reach the invoke host, so a policy spec runs on real stores with no relay service
and no `observes` lines added to the consumer's verified specs. Specified in SPEC-RT-016 (new, harness delivery), and in
amendments to SPEC-CORE-001 (parse), SPEC-RT-001 (config load) and SPEC-RPC-001 (host protocol).

## Context

A `type policy`, `projection` or `saga` scenario is triggered by `deliver <Event> { … } to <service>` (ADR-0011). The
harness hands the event to that service adapter's optional `deliver()`. Only adapters that front a spec host
(stdio-jsonrpc) offer it; real-store adapters (Kurrent, Redis, Neo4j, DynamoDB) observe a store and cannot receive a
stimulus, so the case is refused DELIVER_UNSUPPORTED. flmnt's policies run inside its spec host (FLMNT-ADR-008 §5), so
at its integration tier (services on real stores, only the response role on the spec host) none of its policy specs can
run. The workaround — a dedicated stdio "relay" service that copies the response host — adds a service every spec file
must observe; flmnt's founder rejected it.

## Decision

1. **`to response` names the response role.** `deliver <Event> { … } to response` hands the event to the response
   adapter's new optional `deliver(event, payload)`. Every other target is a configured service, as before. A case may mix
   both targets; deliveries go out in the order listed, inside the capture window (SPEC-RT-016).
2. **`response` is reserved.** A config that names a service `response` is refused INVALID_CONFIG at load (SPEC-RT-001).
   `to response` is never UNKNOWN_SERVICE_KEY or UNOBSERVED_SERVICE (SPEC-CORE-001), so a spec that observes a subset of
   services needs no new `observes` entry.
3. **The IR does not change.** A delivery stays `{ event, payload, service }`; `service: "response"` is the reserved
   target.
4. **The protocol does not change.** The stdio-jsonrpc response role delivers with the existing `deliver` method,
   `{ service: "response", event, payload }`. A host that serves no response-role delivery answers an error, relayed as
   HOST_ERROR (SPEC-RPC-001). Protocol version stays 2.
5. **Refusals.** A target with no `deliver()` — including a response adapter without one, or `to response` with no
   response adapter configured — is DELIVER_UNSUPPORTED naming the target, before any later delivery and before the
   capture window closes.

## Rejected alternatives

- **An implicit fallback** (a delivery to a service that cannot take it goes to the response host instead). Rejected:
  the spec would say `to log` while the log never receives it; routing would depend on which adapter a tier configures,
  so one spec would mean different things at different tiers.
- **A separate IR field** (`target: "response"` beside `service`). Cleaner in the IR, but a schema change every consumer
  of the IR must follow, for a distinction one reserved name already makes.
- **A new protocol method** (e.g. `deliverToHost { event, payload }`). A host without it would answer method-not-found,
  a crisper refusal, but every existing host already dispatches `deliver` to its policies; reusing it costs nothing.
- **A relay service in the consumer** (flmnt's B5-q3 recommendation). Rejected by the founder: an extra service and
  `observes` lines on seven verified specs.

## Consequences

- Response adapters may implement `deliver()`; the stdio-jsonrpc response role does, the handler adapter does not
  (a handler-adapter spec that delivers `to response` is refused DELIVER_UNSUPPORTED).
- A spec host that serves response-role deliveries must accept `deliver` whose `service` is `response` without a
  service of that name being set up (flmnt's host: one condition in its `deliver`).
- A consumer config with a service named `response` stops loading; none is known (searched both repos).
