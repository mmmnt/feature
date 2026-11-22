# Draft — `deliver … to response` (ADR-0036)

Founder ruling aee7d787 (flmnt, 2026-11-22, B5-q3 "Feature change"): Feature lets a spec's `deliver` reach the response
role's invoke host, so flmnt's policy specs run at the integration tier on real stores with no relay service and no
`observes` lines on verified specs. Status: draft; nothing here is agreed.

## What changes

| Spec | Change | File here |
|---|---|---|
| SPEC-RT-016 (new) | Harness delivery: `response` targets the response adapter's optional `deliver()`; any other target is a service; order kept; DELIVER_UNSUPPORTED names the target | `packages/feat-runtime/harness-deliver.feat` + contract (8 scenarios) |
| SPEC-CORE-001 | `to response` is never UNKNOWN_SERVICE_KEY / UNOBSERVED_SERVICE; a typo is still UNKNOWN_SERVICE_KEY | `packages/feat-core/parse.change.diff` (2 scenarios, fixtures `ok/deliver-response.feat` + IR, `bad/deliver-unknown-target.feat` SPEC-BAD-135) |
| SPEC-RT-001 | A service named `response` is refused INVALID_CONFIG | `packages/feat-runtime/load-config.change.diff` (1 outline row, fixture `reserved-response.config.json`) |
| SPEC-RPC-001 | The response role delivers with the existing `deliver`, `service: "response"`; a host that refuses it is HOST_ERROR | `adapters/stdio-jsonrpc/transport.change.diff` (2 scenarios, fake-host mode `no-response-deliver`) |
| ADR-0036 | Decision, rejected alternatives, consequences | `ADR-0036-DRAFT.md` |

No IR schema change, no protocol schema change (version stays 2), no new refusal code.

`run.patch` is the code the drafts need to run (not applied on this branch): `harness.ts`, `parse.ts`, `load-config.ts`,
`feat-types` (`FeatResponseAdapter.deliver?`), the stdio-jsonrpc response role's `deliver`, the harness stub's `deliver`
option, the fake host's `deliver` case, and the fixtures. `flmnt-host.patch` is the matching change in flmnt's spec host
(`deliver` skips the set-up-service check when `service` is `response`); it belongs to flmnt's batch 5, not to Feature.

## Results (drafts in place, run.patch applied)

- `feat lint` / `audit`: 48 specs, 0 errors.
- Full Feature spec chain (`feat run`): 47 files, 961 tests, all passing; the new SPEC-RT-016 8/8, SPEC-CORE-001 96/96,
  SPEC-RT-001 9/9, SPEC-RPC-001 57/57.
- Defects put back, one per run:
  - harness routing removed → 6 of 8 SPEC-RT-016 cases red;
  - `parse.ts` change removed → 2 SPEC-CORE-001 cases red;
  - reserved-key check removed → 1 SPEC-RT-001 case red.
- flmnt, against its real spec host (scratch copy of `spec/batch-5` ed492d2 with the three policy drafts' `to log`
  changed to `to response`, `flmnt-host.patch` applied, this build linked into its node_modules):

  | Tier | Crate | Before (batch-5 report) | With the change |
  |---|---|---|---|
  | Unit (Linux gate container) | Lifecycle | 69 pass; policies fail "no policy is registered" | 69 of 87 pass; the 18 failures are only "no command StartExport is registered" and "no policy is registered for SnapshotImported / WritesPaused" |
  | Unit (host-built spec host) | Workspaces | 57 pass | 57 of 73 pass; the 16 failures are only "no command CompleteDeletion" and "no policy is registered for WorkspaceDeletionStarted" |
  | Integration (real KurrentDB, Redis) | Lifecycle | 7 policy cases **DELIVER_UNSUPPORTED** | 69 of 87 pass; only "not registered" failures, no DELIVER_UNSUPPORTED |
  | Integration | Workspaces | 5 policy cases **DELIVER_UNSUPPORTED** | 57 of 73 pass; only "not registered" failures |

  No SEED_*, contract or lint failures at either tier. With `flmnt-host.patch` removed, the Workspaces policy cases fail
  "the service response is not set up" instead, so the host change is load-bearing.

## The syntax flmnt's policy specs should use

```
deliver SnapshotImported { stream: "node::lifecycle", entryType: "snapshot.imported", … } to response
```

Keep `observes log` (and the `log has [...]` predictions) as they are; `response` needs no `observes` entry. The same
line runs at both tiers. flmnt's spec host must take `flmnt-host.patch`.

## Open questions (the drafts follow each recommendation)

1. **Syntax.** Recommend explicit `to response`: one meaning at every tier. Alternative: an implicit fallback when the
   named service cannot take a delivery — no spec edits, but `to log` would then mean "not the log" on some tiers.
2. **IR shape.** Recommend keeping `{event, payload, service}` with `response` reserved: no schema change. Alternative: a
   separate `target` field — explicit in the IR, but a schema change for every IR consumer.
3. **Protocol.** Recommend reusing `deliver` with `service: "response"`: no schema change, hosts already route `deliver`
   to policies. Alternative: a new optional method (e.g. `deliverToHost`) — an old host would answer method-not-found,
   a crisper refusal, at the cost of a schema change.
4. **A service named `response`.** Recommend refusing it at config load (INVALID_CONFIG): no ambiguity. Alternative: let
   such a service win over the role — no config breaks, but `to response` then depends on the config. None exists in
   either repo.

## Noted, out of scope

- flmnt's host `deliver` picks the first policy registered for an event (the batch-5 report's build note); ExportAfterPause
  and ImportAfterPause will both listen on WritesPaused.
- flmnt's host `deliver` runs the policy with no actor; batch-5's rulings have relays act under the delivered entry's
  actor, which the handlers read from the payload.
