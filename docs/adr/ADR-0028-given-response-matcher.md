# ADR-0028 — the given's response as a matcher, `@given.response.<path>`

Status: Accepted (founder ruling 5f05d5e1, 2026-11-14, "Agree as drafted"; requested by flmnt, ruling 00fd1773,
"Ask Feature for it"). Built in SPEC-CORE-001 (amended) and SPEC-RT-012 (new).

## Context

`@given.response.<path>` exists today as an **input-side** reference only: an `execute`, `when:` or
`deliver` payload may name an id the system minted during setup. A prediction cannot. So a spec cannot say
that the answer to the `when:` relates to the answer the `given` produced:

- a retried command answers **the same** id the first call minted (`inviteId: @given.response.inviteId`);
- a second call draws **a different** secret than the first (`code: not @given.response.code`).

Neither value can be written as a literal (both are minted), `any` pins nothing, and `@<service>[i]` sees only
what the capture window records, which excludes the `given`'s own writes (INV-9). The consumer today proves
these facts in a unit test beside the spec, outside the evidence chain.

## Decision

1. `@given.response.<path>` becomes a **matcher** as well as an input-side reference, valid in any value
   block of a prediction (`response`, records) and as the operand of `not` (ADR-0027). It reads the response
   body of the **most recent preceding `execute`**, as the input-side form does.
2. `@given[i].response.<path>` names the response of the i-th `execute` of the `given`, 0-based, in written
   order (ADR-0025). `@given.response` is `@given[last]`.
3. A reference that cannot resolve is a **violation**, never a pass (ADR-0021): a `given` with no `execute`,
   an index out of range, a path absent on that response body. A `given` execute that was refused still has
   a response body; its `status` is not addressable (body only).
4. The IR is `{ "matcher": "givenRef", "index"?: <int>, "path": "<path>" }`; `index` absent means the last.
5. A violation names the reference as written and the value it resolved to:
   `expected @given[0].response.inviteId = "…", got "…"`; under `not`, `expected not @given.response.code (= "…"), got "…"`.

## Rejected alternatives

- **Named captures** (`when (capture as first): …`, `@first.code`): more general, but a second naming
  scheme beside `@when` / `@given` / `@<service>`, and a scenario has one `when:` by construction; the
  `given`'s executes are the only earlier calls a scenario has.
- **Capturing the `given`'s writes** (dropping INV-9 for executes): would change every existing
  prediction's capture set.

## Out of scope

A **transform** (e.g. "this field is the SHA-256 of that response's code") is not a reference, and the language
excludes transform functions by design (§5.1b, DP-3). A system's random draws become predictable literals by
seeding instead (ADR-0029, founder ruling 5f05d5e1, "Seedable randomness").
