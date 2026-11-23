# deliver-answer: a delivery's answer is the case's response (drafts)

Rulings: flmnt `814db4fb-8c72-577a-9f9e-132ec6916422` ("Feature change (Recommended)"), the mechanism for
`10d35eb4-a501-5547-b264-84224be37944`; DA1–DA4 `78c4b277-1afa-5363-bc0c-b7bbe9286caa`:
- **DA1:** the last delivery that answered is the case's response.
- **DA2:** the existing "no response captured" failure.
- **DA3:** "Whole reply body" (not the recommendation).
- **DA4:** "Answer issued too" (not the recommendation).
- **Readability:** "Matchers for prose (Recommended)", `b9ebf9cb-9286-5490-8ad2-683ff34f86b9`. Issued bodies state code, status,
  context and details as literals, with `sentence: any string, remedy: any string`. ADR: `ADR-0037-DRAFT.md`. Nothing here is applied to the branch's specs or
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

- **flmnt real host:** a scratch worktree at main `39723b5`, with `flmnt-host.patch` and this Feature build linked into
  node_modules. Re-run after #312 fixed main's build; the earlier run was on `595c3dd`.
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

## Readability (ruled b9ebf9cb)

Each issued body states code, status, context and details as literals, with `sentence: any string` and `remedy: any
string`. An object inside a list item must have exactly its declared keys (ADR-0034), so the prose fields are named
with a matcher rather than left out.

## Open question C3: should the answer name the policies that ran?

Once several policies listen on one event, the harness can't tell a spec's own policy is missing. flmnt's batch 8, for
example, has CloseExport, CloseImport and CloseRebuild on WritesResumed. Another policy for the same event still runs, the
delivery still succeeds, and a scenario that predicts "issued nothing" passes with the policy under test not registered
at all. That's a gate passing with zero work.

- **Recommend: yes.** Add `ran: [ { context, policy } ]` beside `issued` in the host's answer, listing every policy the
  delivery ran, in order.
  - A spec predicts `ran` to show its own policy ran, and a missing policy turns red. This matters most for "issued
    nothing" scenarios.
  - The cost is flmnt-side only. The kernel's `Policy` gains a `name`, which every `#[distributed_slice(POLICIES)]`
    registration must then state, and each policy spec's answer prediction names the policies.
  - Feature is unaffected, since the body is the host's own.
- **Alternative: no.** A policy spec relies on a `log has` or `issued` prediction that only its policy could produce. But
  every "issued nothing" or `log has []` scenario stays blind to a missing policy.

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
