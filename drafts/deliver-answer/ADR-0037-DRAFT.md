# ADR-0037 — A delivery's answer is the case's response

- **Status:** Draft
- **Rulings:** flmnt founder ruling `814db4fb-8c72-577a-9f9e-132ec6916422` (2026-11-22, "Feature change (Recommended)"), the
  mechanism for flmnt ruling `10d35eb4-a501-5547-b264-84224be37944` (a spec host reports what a delivered policy issued).
- **Amends:** SPEC-RT-016 (harness deliver), SPEC-RPC-001 (the `deliver` result), ADR-0036.

## Context

ADR-0036 lets a `type policy` scenario `deliver <Event> { … } to response`, so a policy runs inside its product's spec
host on real stores. The harness then threw away what the host answered. A response prediction was compared only
against a `when:` invoke's answer, and a policy scenario has no `when:` (TRIGGER_MISMATCH, ADR-0011). So a spec could see
what a policy appended, but never what it issued or what was refused. When a refused command appends nothing, every
reading of that refusal leaves the log the same, and no scenario can tell them apart. flmnt's FinishErasure (FLMNT-SPEC-WSP-009)
reads three refusals of CompleteDeletion, and a dropped empty-purge check went undetected for that reason.

## Decision

1. The response adapter's optional `deliver(event, payload)` may answer a `CapturedResponse`. When the target is
   `response` and it answers one, the harness keeps it as the case's captured response, and a `response` prediction
   is compared against it exactly as against a `when:` answer.
2. One response per case: the last delivery to response that answered one. A later delivery that answers nothing does
   not clear it.
3. A service's answer to a delivery is never the case's response.
4. A response predicted when no delivery to response answered fails as every case already does: `response: no response
   captured`. No new refusal code.
5. Protocol (SPEC-RPC-001): `deliver`'s result is either empty, as before, or the invoke result's shape `{ status, body,
   headers?, metadata? }`. Any other shape violates the closed result. This only widens the result: every existing host's
   `{}` conforms, and the protocol stays version 2.
6. No grammar change. A policy scenario could already write a `response` line; it now has something to compare against.

## Rejected alternatives

- **An `outcomes` relay service** (a stdio-jsonrpc service copying the response host, whose capture reports what was
  issued). It's flmnt-only, but it's the relay-service shape rejected in B5-q3, and it adds `observes` lines to verified specs.
- **A list of every delivery's answer** (`response` predicted as a list). It's more expressive, but it changes what
  `response` means between `when:` and `deliver` cases. A case that needs several answers can be split into several
  cases.
- **Refusing a response prediction when several deliveries to response answer.** That's safer against ambiguity, but it
  rules out a scenario whose earlier deliveries are setup.
- **A new protocol method** for answered deliveries. It gives a crisper error from an old host, but it changes the schema
  for no gain, because an old host's `{}` already means "no answer".

## Consequences

- A host that answers `{ status, body }` to a delivery needs a client at this protocol revision. An older
  `@mmmnt/feat-adapter-stdio-jsonrpc` refuses that answer with PROTOCOL_VIOLATION, so a product must bump the adapter
  with its host change, in the same change.
- Existing policy specs that predict no response are unchanged, whatever their host answers.
