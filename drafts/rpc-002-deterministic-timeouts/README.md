# SPEC-RPC-002: the timeout scenarios race the clock (DRAFT)

Status: draft, awaiting the owner. Nothing is built; the amended spec beside this file is a copy of
SPEC-RPC-002 at `status draft` (`adapters/stdio-jsonrpc/host-sharing.feat`).

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

## The amendment (the spec's header, items 1 to 5)

The short limit applies only to the request meant to time out (`invoke`); the fixture withholds that answer
until the client has ended the host, so the timeout is certain; the ended host stays up until RunFiles releases
it after the late setup, so "still exiting" is a fact; no sleeps. Every predicted fact is unchanged, and one
scenario is added to prove that a setup slower than the short limit is served. No adapter behaviour changes: the
adapters keep their 30 s limit, 2 s grace and HOST_TIMEOUT/HOST_ENDED handling.

## Decisions for the owner

1. **How the timeout scenarios stop racing.**
   - **A. The short limit applies to `invoke` only, the fake host withholds the late answer until the client
     ends it, and the ended host exits when RunFiles releases it (Recommended).** Nothing is left to the clock:
     each request meant to be answered runs under the adapters' own 30 s limit, and each event the scenario
     depends on happens because the previous one did. It changes the shape of the RunFiles-only registry
     parameter of ruling cd46cd64 (3) (it now names the methods it limits), and adds a second one (no grace
     kill for a `lateRole` file).
   - B. An injected clock: the registry takes a timer factory, and RunFiles fires the invoke's timeout itself
     once the fake host has logged the invoke. No wall clock at all, but a test seam in `HostConnection`.
   - C. Keep one limit for every request and raise it by measurement: about 5 s, over 20 times the slowest
     setup measured here. Each of the six timeout scenarios then waits about 5 s, and a start-up stall over 5 s
     still fails them.
2. **The fake host's mode name.** `late-invoke-slow-exit` becomes `late-invoke-held` (it no longer exits on a
   timer). Keep the old name if the owner prefers fewer changed lines; the behaviour changes either way.
3. **Node 26.** Not reproduced on Node 26 here (Node 24 only on this host); the mechanism does not depend on the
   Node version, only on start-up time.
4. **ADR.** Not needed: a test-driver and fixture change; the adapter's design (ADR for stdio-jsonrpc, rulings
   cd46cd64) is unchanged.
