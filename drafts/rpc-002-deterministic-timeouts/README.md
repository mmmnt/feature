# SPEC-RPC-002: the timeout scenarios race the clock (DRAFT)

Status: draft, revised to owner ruling 13 (2026-11-25, "Injected clock"); awaiting the flip. Nothing is built; the
amended spec beside this file is a copy of SPEC-RPC-002 at `status draft`, with `ADR-0041-DRAFT.md` for the seam.

## The failure

CI on main, Node 26: SPEC-RPC-002 "a role that sets up after a timeout, while the ended host is still exiting,
gets a fresh host and never the ended one", `lateRoleOutcome: expected "ok", got "HOST_TIMEOUT"`.

## Root cause (main 72f71de)

- `adapters/stdio-jsonrpc/src/host.ts:100-106`: every request starts its timer as it is written, with the
  connection's one limit.
- `adapters/stdio-jsonrpc/src/host.ts:177`: the registry gives every host it spawns its `requestTimeoutMs`.
  RunFiles builds the registry with the file's `requestTimeoutMs` (`src/run-files.ts:45`), 200 ms in all six
  timeout scenarios. So the late role's `setup` on the host it has just spawned
  (`src/run-files.ts:117-128`) must be answered within 200 ms of being written, and the window holds Node's start-up
  of `fixtures/fake-host.mjs`. The same holds for the first role's `setup` in every one of the six scenarios.
- Two more wall-clock races in the fixture, not yet seen failing: the first invoke is answered after a fixed
  600 ms (`fixtures/fake-host.mjs:98-115`) against the 200 ms limit, and `late-invoke-slow-exit` exits 1500 ms
  after stdin closes (`fake-host.mjs:16-18`) against the registry's 2 s kill (`src/host.ts:19`, `GRACE_MS`), which
  is what makes "the ended host is still exiting" true. And RunFiles sleeps 20 ms before counting live hosts
  (`src/run-files.ts:168`).

## Reproduction (Node 24.19.0, 16-core macOS host also running other work; not Node 26)

1. The scenario's own input through the built `runFiles` (`adapters/stdio-jsonrpc/dist/run-files.js`), from the
   repository root, 10 times with no load added: 9 answered `lateRoleOutcome: "ok"`; 1 answered
   `lateRoleOutcome: "HOST_TIMEOUT"` (with `endedHostAliveAtLateSetup: true`), the CI failure.
2. 20 times with 8 busy loops added: 10 answered `lateRoleOutcome: "ok"`, 5 `lateRoleOutcome: "HOST_TIMEOUT"`, and 5 failed the whole
   file `HOST_TIMEOUT` at the first role's setup.
3. The window itself, `HostConnection.spawn` then `request("setup")` against `fake-host.mjs --mode
   late-invoke-slow-exit`, 40 times: no load added, p50 173 ms, p90 215 ms, max 217 ms, 5 over 200 ms; 8 busy
   loops added, p50 188 ms, p90 210 ms, max 231 ms, 9 over 200 ms. The measure runs from spawn, so it is an upper
   bound on the timed window, which starts at the write.

A 200 ms limit is the same size as the thing it is supposed to leave alone.

## The amendment (the spec's header, items 1 to 6; ADR-0041 draft)

- **Clock:** `interface Clock { setTimeout(fn, ms): handle; clearTimeout(handle) }` in `src/clock.ts`; `systemClock` is
  the global pair. It drives the adapter's three timers: the request limit (`src/host.ts:100`), the grace kill on a
  timeout (`:127`) and on close (`:141`).
- **Where it is injected:** `HostRegistry(requestTimeoutMs = 30_000, clock = systemClock)`, handed to each
  `HostConnection`. A test-only seam: `defaultRegistry`, which every adapter uses, passes neither, so production
  is the real clock, 30 s and 2 s. No adapter option or `feat.config.json` key reaches it.
- **Ruling cd46cd64 (3):** the limit parameter is unchanged (shape and meaning); the clock is a second constructor
  parameter under the same "only the test driver passes it" rule. Unlike the earlier draft, nothing is limited to
  `invoke`.
- **How the scenarios advance it:** RunFiles uses a `ManualClock` (`advance(ms)` fires due timers in order). After
  an invoke it waits for the invoke to settle or for the host to log `hold invoke` (watched with `fs.watch`), and
  on hold advances by the limit: HOST_TIMEOUT, certain. For a `lateRole` file, after the late setup is recorded,
  it advances by the grace period: the registry's SIGKILL ends the held host. The fake host holds the late answer
  until stdin closes (no 600 ms) and `late-invoke-held` stays up until killed (no 1500 ms). The 20 ms sleep goes.
- **Facts unchanged**; one scenario added (a setup 500 ms late in wall time, limit 200, serves).

## For the owner before agreeing

1. **ADR-0041 is needed:** `HostRegistry` and `HostConnection` are exported (`src/index.ts:6`), so the clock
   parameter is public API. The draft keeps `systemClock` and `ManualClock` internal and exposes only the type.
2. **A hang instead of a timeout:** under the manual clock nothing times out unless RunFiles advances it, so a
   fake host that wrongly never answers hangs that scenario until the test timeout, rather than HOST_TIMEOUT.
3. **One event from outside the process:** RunFiles learns that the host holds the invoke from the fake
   host's log via `fs.watch` (event, not polling). The timeout scenarios run on Linux, where it is inotify.
4. **SPEC-RPC-001** (`src/exchange.ts:47`) keeps the real clock; its one timeout scenario uses a silent host.
5. Not reproduced on Node 26 (Node 24 only here); the cause does not depend on the version.
