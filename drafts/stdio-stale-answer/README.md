# stdio-stale-answer: a timeout on the shared host ends it (drafts)

SPEC-RPC-002 is agreed, so this is a draft amendment that needs the founder's ratification. Nothing
here is applied to the branch's specs or code. The draft was run with `run.patch` applied and the
draft copied into place, and then every file was restored from HEAD.

## The defect

`HostConnection` in `adapters/stdio-jsonrpc/src/host.ts` (0.7.0) hands every line the host writes to
the first pending request ("one request is outstanding at a time, so any line answers it"). On
`HOST_TIMEOUT` the timer drops the pending request but leaves the host working on it. When the late
answer to request n arrives, it is matched to request n+1: `PROTOCOL_VIOLATION: the answer carries id
n, the request carried n+1`. Request n+1's answer then lands on n+2, and so on. Every later result in
that spec file is wrong or misleading. A spec run in a consuming product showed it when a first
scenario crossed the 30 s limit.

## Domain delta

The shared host (`HostConnection`, `HostRegistry`, every role of a spec file):

- **A request times out.** It fails `HOST_TIMEOUT`, as today. The connection is then broken. It writes
  nothing more to that host and ends it: stdin is closed, and the process is killed after the grace period.
- **Every later call of every role of that file** fails `HOST_CRASHED`. That covers calls queued behind
  the timed-out one, calls in later cases, and setup and teardown. The detail names the request that
  timed out.
- **The registry entry is dropped**, as for a crash. If the file's roles all leave and set up again, the
  file gets a fresh host.
- **What does not happen:**
  - A line the host writes after the timeout is never taken as another request's answer.
  - No request is written to that host again.
  - Nothing is retried or reconnected, and no host is respawned while the file's roles are still joined.
  - No other file is affected.
  - No host process is left running.
  - No `PROTOCOL_VIOLATION` comes from a late answer.
  - The limit stays 30 s and cannot be configured on a shared host.
  - The protocol schema and version (2) are unchanged.
  - The one-shot exchange (SPEC-RPC-001) already kills its host on a timeout, and it is unchanged.
- **Error codes:** `HOST_TIMEOUT` is for the request that waited. `HOST_CRASHED` is for every call after
  it (Q2 below). No new code.

## Files

- `adapters/stdio-jsonrpc/host-sharing.feat` is SPEC-RPC-002 amended, at status draft.
  - It has a header block, a construct paragraph and three enforce lines.
  - It adds 5 scenarios, for 29 in all.
- `adapters/stdio-jsonrpc/host-sharing.contract.json` makes these changes:
  - `RunFilesInput.files[].requestTimeoutMs` is new.
  - `roleOutcomes` may be `HOST_TIMEOUT` or `PROTOCOL_VIOLATION`.
  - `receivedAfterTimeout` is new: the methods the host received after the client saw the timeout.
  - `SharingError.code` gains `HOST_CRASHED` and `HOST_TIMEOUT`.
- `run.patch` holds what the scenarios need in order to run. It does **not** fix the defect.
  - The fake host gains a `late-invoke` mode. It answers requests one at a time and answers the first
    invoke 600 ms late. It logs `recv <method>` for every request.
  - `HostRegistry` gains a constructor parameter for its request limit. The adapters' registry keeps 30 s.
  - RunFiles passes `requestTimeoutMs` to its registry and reports `receivedAfterTimeout`.

## Results (base origin/main b21c43e, Node 24.1.0)

- `feat lint` found 48 specs, with 0 errors and 0 warnings.
- `feat audit` found 0 errors. Its one warning is that the draft is not buildable until it is agreed.
- `feat generate` and then `feat verify` showed 48 files matching.
- SPEC-RPC-002 passed 25 of 29 against the current code. All 4 failures are the defect:
  - "a request the host does not answer in time fails HOST_TIMEOUT and every later call of the file
    fails HOST_CRASHED": log got `HOST_TIMEOUT` (it was queued behind the late invoke) and kv got
    `PROTOCOL_VIOLATION`.
  - "a host that timed out is sent nothing more…": the host received
    `["settle","peekCapture","peekCapture","stopCapture","teardown","teardown"]` after the timeout.
  - "a timeout fails the file's later cases too…": the result was `PROTOCOL_VIOLATION`, "the answer
    carries id 12, the request carried 13". This is the cascade itself.
  - "a timeout in one file leaves another file's host serving": file a's log got `HOST_TIMEOUT`. File b
    was unaffected.
- "a file whose roles all left after a timeout and set up again gets a fresh host" passes today. It
  guards the fix, which must not poison the registry.
- The 24 existing scenarios pass.
- SPEC-RPC-001 passed 60 of 60 with `run.patch` applied.
- The stdio-jsonrpc package typecheck passed, and its package tests passed 1 of 1.
- Not proven: no fix was written, so nothing yet shows that the amendment is satisfiable.

## Rulings workshop

Recorded as `3792ac58-972b-5a1e-9060-c4cbe4cd205e`. The open questions:

1. **After a timeout, end the host or match answers by id?** Recommended: end the host (drafted). Matching
   by id keeps a host that is still running the abandoned request. Its effects land in later capture
   windows, and the next request waits behind it.
2. **Which code do the calls after a timeout fail with?** Recommended: `HOST_CRASHED`, with a detail naming
   the request that timed out. It needs no new code, which consumers would have to match on.
3. **How does a scenario get a short limit?** Recommended: a `HostRegistry` constructor parameter that only
   RunFiles passes. The adapters' 30 s limit stays unconfigurable.
4. **How is the timed-out host ended?** Recommended: close stdin, then kill after the 2 s grace, in the
   background. The last teardown waits for the exit.
5. **Release.** Recommended: minor, 0.8.0, once the build is agreed.
