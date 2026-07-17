# Language Guide

A guided tour by example. The normative reference is `docs/grammar-reference.md` in the
repository; the `corpus/` directory holds nine complete exemplars.

## Anatomy of a spec

```feat
feat 1.0                          # version pragma — required first line

spec SPEC-USR-002 "SuspendUser"   # identity
context Users
aggregate User
type command                      # command|query|policy|projection|saga|infrastructure|integration|scaffold
status agreed                     # draft|agreed|built|verified

construct:                        # agent zone: how to build it
  handler at handlers/suspend-user.ts
  touches handlers/**             # change boundary — always required
  needs SPEC-USR-001              # cross-spec dependency (build-order DAG)

enforce:                          # agent zone: behavioral rules
  only admins may suspend users
  rejects UNAUTHORIZED when the caller is not an admin
  rejects UNKNOWN_USER when no user exists with the given email

contract:                         # compiler zone: the declared interface
  input SuspendUserInput
  response SuspendResult
  record UserRow
  error ErrorResponse
```

Every schema a scenario references must be declared here; shapes live in the paired
`<name>.contract.json` registry (plain JSON Schema, `$ref`-able for sharing).

## Scenarios and predictions

```feat
scenario "admin suspends a user":
  given:
    clock at "2026-07-16T00:00:00Z"                       # freeze time
    execute CreateUser { email: "a@ex.com", name: "A" }   # precondition via the real command
  when (as admin): SuspendUser { email: "a@ex.com" }      # actor from the registry
  predict success:
    response 200 SuspendResult { status: "suspended" }
    database has [ UPDATE with UserRow {
      email: @when.email                                  # bound to the input — no restated values
      status: "suspended"
      suspendedAt: "2026-07-16T00:00:00Z"
    } ]
```

Matchers inside value blocks: literals, `@when.<path>` / `@deliver[i].<path>` references,
`any` (optionally typed: `any uuid`, `any timestamp`, …), `matching "<regex>"`, `absent`,
nested blocks, and `equals fixture "<path>"` for whole-document goldens. Value blocks are
partial — shape completeness is the schema's job.

## Preconditions

Three tools in `given:`, freely mixed with freeform context lines:

- `execute <Command> { … }` — run a real command before the capture window opens.
- `seed <service> [ <Type> with <Schema> { …literal values… } ]` — inject state directly;
  `seed <service> from "fixture.json"` for bulk state.
- `clock at "<ISO>"` — freeze scenario time (handler-adapter deployments).

## Event-triggered specs

`projection`, `policy`, and `saga` specs are triggered by events, not commands:

```feat
scenario "requests shipment after the full sequence":
  deliver OrderPublished { orderId: "…" } to eventBroker
  deliver OrderPriced { orderId: "…", total: 129.5 } to eventBroker
  predict success:
    outbox has [ ShipmentRequested with ShipmentRequestedEvent {
      orderId: @deliver[0].orderId
      total: @deliver[1].total
    } ]
    eventBroker has []
```

Delivered stimuli are input, not output — they're excluded from capture, and these specs have no
`response` surface. State assertions use `contains` (resulting state via the adapter's read path)
alongside `has` (writes captured during the window).

**Queries can't lie**: a `type query` spec cannot even express a service write — side-effect
freedom is grammar, not discipline.

## Scenario outlines

```feat
scenario outline "unknown users are rejected":
  when (as admin): SuspendUser { email: <email> }
  predict rejection <code>:
    response 404 ErrorResponse { code: <code>, message: matching <msg> }
    database has []
  examples:
    | email                 | code           | msg       |
    | "missing@example.com" | "UNKNOWN_USER" | "missing" |
```

One derived test per row. Placeholders work in payloads, value blocks, the rejection-ID position,
and the `matching` argument.

## Configuration

`feat.config.json` declares the world a spec runs against: the schema adapter, the response
adapter with its **command routes** (`{method, path}` for HTTP; `{module, export}` for direct
handler invocation) and **actor registry**, and the **services** — each with an adapter, a
consistency model (`acid` / `strong` / `eventual` + convergence timeout), and adapter options.
Ordering defaults follow consistency (`acid` ordered, `eventual` unordered) and can be overridden
per prediction with `ordered` / `unordered`.
