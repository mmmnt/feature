# deliver-answer: a delivery's answer is the case's response (drafts)

Rulings: flmnt `814db4fb-8c72-577a-9f9e-132ec6916422` ("Feature change (Recommended)"), the mechanism for
`10d35eb4-a501-5547-b264-84224be37944`. ADR: `ADR-0037-DRAFT.md`. Nothing here is applied to the branch's specs or
code. The drafts were run with `run.patch` applied, and then the tree was restored.

## Files

- `packages/feat-runtime/harness-deliver.feat` and `.contract.json`: SPEC-RT-016 amended, status draft. It goes from 8
  to 16 scenarios, and the contract's RunResult gains `violationCodes`, which the probe already returns.
- `adapters/stdio-jsonrpc/transport.feat`: SPEC-RPC-001 amended, status draft, with 2 new scenarios. 59 in all.
- `run.patch`: the code the drafts need.
  - feat-types: the response adapter's `deliver()` may answer a `CapturedResponse`.
  - harness: keeps the response role's answer.
  - stdio-jsonrpc: the response role returns the host's `{ status, body }`.
  - The protocol schema in both copies: `results.deliver` is empty or the invoke result.
  - The harness stub and the fake host: answer on request.
- `flmnt-host.patch`: flmnt's side, **for flmnt to land, not here**.
  - The kernel's `registration::issue` records `{ context, command, status, code? }` for every command issued in process.
  - The spec host's `deliver` answers `{ status: 200, body: { issued: [...] } }` to a delivery to `response`.
- `flmnt-wsp-009-scratch.patch`: the scratch FinishErasure predictions this was proven with, against flmnt's real host.

## Results

- **Spec tooling:** Feature `feat lint` is clean, with 48 specs, 0 errors and 0 warnings. `feat generate` was run, and the
  generated suites are not committed here.
- **Feature spec chain** (feat-runtime and stdio-jsonrpc, with `run.patch` applied): 17 files, 290 tests, all passing.
  RT-016 passes 16 of 16 and RPC-001 59 of 59.
- **Package checks:** typecheck passes for feat-types, feat-runtime and stdio-jsonrpc. Package tests: feat-runtime 92 of 92,
  stdio-jsonrpc 1 of 1.
- **Bugs put back, one per run** (each red, then restored):

  | Bug | Result |
  |---|---|
  | answer discarded | 4 of 16 RT-016 cases red |
  | a service's answer kept | 2 red |
  | first answer kept, not the last | 1 red |
  | old protocol schema (deliver result empty only) | 1 RPC-001 case red |

- **flmnt real-host run:** a scratch flmnt worktree at main `b5ba9f5`, with `flmnt-host.patch`, a host-built
  `flmnt-feat-host`, and this build's feat-runtime, feat-types and stdio-jsonrpc linked into node_modules.
  - Workspaces passes 81 of 81. WSP-009 passes 6 of 6, with every `issued` literal exactly what the host answered:
    - 200 for a completed deletion;
    - 409 ERASURE_INCOMPLETE;
    - 404 WORKSPACE_NOT_FOUND;
    - 409 DELETION_NOT_STARTED;
    - `[]` for a purge that lists streams.
  - With FinishErasure's empty-purge check dropped (the gap batch 6 found), 1 of 6 is red. It now catches it.
  - With the host answering nothing to response, 6 of 6 are red.

## The syntax flmnt's WSP-009 scenarios use

Contract: `response DeliveryAnswer`, with `DeliveryAnswer` declared in the `.contract.json`:
`{ issued: [ { context, command, status: integer, code?: string } ] }`, closed. Each scenario adds, beside its `log has`:

```
  deliver GraphErased { … } to response
  predict success:
    response 200 DeliveryAnswer { issued: [ { context: "flmnt-workspaces", command: "CompleteDeletion", status: 409, code: "ERASURE_INCOMPLETE" } ] }
    log has []
```

A delivery whose policies issue nothing is `response 200 DeliveryAnswer { issued: [] }`.
