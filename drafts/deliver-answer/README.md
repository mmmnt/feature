# deliver-answer: a delivery's answer is the case's response (drafts)

Rulings: flmnt `814db4fb-8c72-577a-9f9e-132ec6916422` ("Feature change (Recommended)"), the mechanism for
`10d35eb4-a501-5547-b264-84224be37944`; DA1–DA4 `78c4b277-1afa-5363-bc0c-b7bbe9286caa`:
- **DA1:** the last delivery that answered is the case's response.
- **DA2:** the existing "no response captured" failure.
- **DA3:** "Whole reply body" (not the recommendation).
- **DA4:** "Answer issued too" (not the recommendation). ADR: `ADR-0037-DRAFT.md`. Nothing here is applied to the branch's specs or
code. The drafts were run with `run.patch` applied, and then the tree was restored.

## Files

- `packages/feat-runtime/harness-deliver.feat` and `.contract.json`: SPEC-RT-016 amended, status draft. It goes from 8
  to 16 scenarios, and the contract's RunResult gains `violationCodes`, which the probe already returns.
- `adapters/stdio-jsonrpc/transport.feat`: SPEC-RPC-001 amended, status draft, with 3 new scenarios. 60 in all. The third is a delivery to a service answered, DA4.
- `run.patch`: the code the drafts need.
  - feat-types: the response adapter's `deliver()` may answer a `CapturedResponse`.
  - harness: keeps the response role's answer.
  - stdio-jsonrpc: the response role returns the host's `{ status, body }`.
  - The protocol schema in both copies: `results.deliver` is empty or the invoke result.
  - The harness stub and the fake host: answer on request.
- `flmnt-host.patch`: flmnt's side, **for flmnt to land, not here**.
  - The kernel's `registration::issue` records `{ context, command, status, body }` for every command issued in
    process, where `body` is the whole reply body, or null when there is none (DA3).
  - The spec host's `deliver` answers `{ status: 200, body: { issued: [...] } }` to every delivery, on any role (DA4).
- `flmnt-wsp-009-scratch.patch`: the scratch FinishErasure predictions this was proven with, against flmnt's real host.

## Results

- **Spec tooling:** Feature `feat lint` reports 48 specs, 0 errors and 0 warnings.
- **Feature spec chain** (feat-runtime and stdio-jsonrpc, with `run.patch` applied): 291 of 291 pass. RT-016 passes 16 of
  16 and RPC-001 60 of 60.
- **Package checks:** typecheck passes, and package tests pass for feat-runtime and stdio-jsonrpc.
- **Bugs put back in Feature, one per run** (each red, then restored):

  | Bug | Result |
  |---|---|
  | answer discarded | 4 of 16 RT-016 cases red |
  | a service's answer kept | 2 red |
  | first answer kept, not the last | 1 red |
  | old protocol schema | 1 RPC-001 case red |

- **flmnt real host:** a scratch worktree at `595c3dd`, with `flmnt-host.patch` and this Feature build linked into
  node_modules. Main at `3b5f0b7` does not compile.
  - Workspaces passes 81 of 81, and WSP-009 6 of 6. Every literal is what the host answered:
    - CompleteDeletion's success body is `{ id, by, at }`.
    - Its refusal body is `{ code, status, sentence, remedy, context, details }`.
    - The details are `{ workspace, streams }` for ERASURE_INCOMPLETE, and `{ workspace }` for WORKSPACE_NOT_FOUND
      (404) and DELETION_NOT_STARTED (409).
  - **Bugs put back, one per run:**
    - empty-purge check dropped: 1 of 6 red;
    - host answers `{}`: 6 of 6 red;
    - body left out of each item: 5 of 6 red (the purge that issues nothing stays green).
  - **Lifecycle:** 122 of 131, with the same 9 failures with and without the patch. They are Export and Rebuild cases
    that fail on a macOS host, so they come from the machine, not this change.

## Readability (follow-up question)

An object inside a list item must have exactly its declared keys (ADR-0034). So each issued item names its whole
reply body. Recommend matchers for the reply's prose (`sentence: any string`, `remedy: any string`), with code, status,
context and details as literals. That checks everything a policy decides on and nothing that's only wording. The
alternatives:
- `body: any object` is short but checks nothing of the body.
- Full literals pin the prose, so every rewording of a refusal breaks the policy specs.

## The syntax flmnt's WSP-009 scenarios use

Contract: `response DeliveryAnswer`, with `DeliveryAnswer` declared in the `.contract.json`:
`{ issued: [ { context, command, status: integer, body: object | null } ] }`, closed.

```
  deliver GraphErased { … } to response
  predict success:
    response 200 DeliveryAnswer { issued: [ { context: "flmnt-workspaces", command: "CompleteDeletion", status: 409, body: { code: "ERASURE_INCOMPLETE", status: 409, sentence: any string, remedy: any string, context: "Workspaces", details: { workspace: "6f9619ff-8b86-4d11-b42d-00c04fc964ff", streams: ["6f9619ff-8b86-4d11-b42d-00c04fc964ff::operational"] } } } ] }
    log has []
```

A completed deletion is `{ context: "flmnt-workspaces", command: "CompleteDeletion", status: 200, body: { id: "…", by:
"person-1", at: "2026-11-20T10:00:00.000Z" } }`. A delivery whose policies issue nothing is `response 200 DeliveryAnswer
{ issued: [] }`.
