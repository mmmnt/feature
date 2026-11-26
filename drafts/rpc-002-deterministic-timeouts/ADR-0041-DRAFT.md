# ADR-0041 (DRAFT): the stdio JSON-RPC host's timers run on an injected clock

Status: draft, awaiting the owner. Number follows ADR-0040 (drafts/parser-strict-lines); renumber if another lands first.
Inputs: owner ruling 13, 2026-11-25, "Injected clock"; founder rulings cd46cd64 (2026-11-23) on the timeout:
end the host, HOST_ENDED, (3) "the shorter limit is a HostRegistry constructor parameter only the test driver
passes", (4) close stdin, then kill after 2 s.
Governs: `adapters/stdio-jsonrpc/src/host.ts`, a new `src/clock.ts` and `src/manual-clock.ts`,
`src/run-files.ts`, `fixtures/fake-host.mjs`; SPEC-RPC-002 (amended beside this file).

## Context

SPEC-RPC-002's timeout scenarios race wall time: a 200 ms request limit against Node's start-up of the fake host
(measured from spawn to the setup answer: p50 173 ms, max 217 ms; with load, max 231 ms), a 600 ms late answer
against that limit, a 1500 ms exit against the 2 s kill, and a 20 ms sleep. The late-role scenario failed CI on
Node 26. The owner ruled that the timeouts are driven by an injected clock the scenarios advance.

`HostRegistry` and `HostConnection` are exported from the package (`src/index.ts:6`), so a constructor parameter
is public API: this is a design change to an adapter.

## Decision

1. `src/clock.ts` exports `interface Clock { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(handle: unknown): void }`
   and `systemClock`, the global `setTimeout`/`clearTimeout`.
2. `HostConnection` takes its clock at spawn and uses it for its three timers: the request limit, the kill after
   the grace period when a request times out, the kill after the grace period on close. Nothing else in the adapter
   reads time.
3. `HostRegistry`'s constructor is `(requestTimeoutMs = 30_000, clock = systemClock)`. `defaultRegistry`, which
   every adapter uses, passes neither: production runs on the real clock, 30 s and 2 s, unchanged. No adapter
   option and no `feat.config.json` key reaches the clock (a config cannot construct one); the only way in is a
   registry built by the caller, which only the test driver does. Ruling cd46cd64 (3) stands: the limit parameter
   keeps its shape and meaning, and the clock is a second parameter under the same rule.
4. `src/manual-clock.ts` (not exported from the package index) is the clock RunFiles injects: time moves only by
   `advance(ms)`, which fires every timer due by then in due order, including timers scheduled while firing.
5. RunFiles advances it only after an event: the host logging that it holds the invoke (`advance(limit)`), and, for
   a `lateRole` file, the late role's setup having been recorded (`advance(grace)`). The fake host holds its late
   answer until its stdin closes instead of sleeping 600 ms, and the held mode stays up until killed instead of
   exiting after 1500 ms.

## Consequences

- No wall-clock wait is left in SPEC-RPC-002's scenarios; their predicted facts are unchanged, and the six that
  name `requestTimeoutMs` keep it as the virtual limit (HOST_ENDED's detail still says "200 ms").
- A host that never answers a request the scenario does not mean to time out now hangs its RunFiles run until the
  test's own timeout, instead of failing HOST_TIMEOUT after 30 s. The failure is still a failure, and later.
- The package's public types gain `Clock` (as the type of the new parameter); `systemClock` and `ManualClock` stay
  internal.
- SPEC-RPC-001's one-shot `exchange` keeps the real clock (its timeout scenario's host is silent, so it cannot race).

## Rejected alternatives

- Limit only `invoke` and hold the answer (the earlier draft): still wall time for the limit itself, and it changed
  the shape of the ruling-(3) parameter. Declined by the owner.
- One limit raised by measurement (about 5 s): slow, and still wall time.
- An adapter or config option for the clock: production has no use for one, and it would let a spec's config bend
  the adapter's timeout.
