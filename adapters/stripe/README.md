# @mmmnt/feat-adapter-stripe

Service adapter for [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. It turns a Stripe account's **Events API into a capture window**. Every
Stripe event that occurs while a scenario runs becomes a captured record. An unpredicted charge,
refund, subscription change or any other account activity fails the case by prediction inversion.

The adapter reads. It never creates or changes anything in the account.

**Use test-mode keys only.** The adapter cannot tell a test key from a live one and does not check
the prefix. A scenario that charges a card against a live account charges it.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-stripe
```

Requires Node 20 or later and `@mmmnt/feature` in the project. There is no Stripe SDK dependency:
the adapter calls `GET /v1/events` over the global `fetch`.

## Configuration

```jsonc
// feat.config.json
"services": {
  "stripe": {
    "adapter": "@mmmnt/feat-adapter-stripe",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "apiKeyEnv": "STRIPE_SECRET_KEY",
      "types": ["charge.succeeded", "refund.created"],
      "baseUrl": "http://127.0.0.1:12111"   // omit to reach https://api.stripe.com
    }
  }
}
```

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `options.apiKeyEnv` | string | `"STRIPE_SECRET_KEY"` | The name of the environment variable that holds the secret key. The key is never in config. |
| `options.types` | string[] | all types | Restricts capture to these event types. Omitted, every event the account emits is in scope. |
| `options.baseUrl` | string | `"https://api.stripe.com"` | API origin override, for a local stub or `stripe-mock`. Omit it to reach Stripe. |

Declare the service `eventual`, with a `convergenceTimeout` in milliseconds (config loading
rejects an `eventual` service without one). Stripe's event feed lags the API calls that cause it, so the harness
waits that long before it reads. `absenceTimeout` can set a shorter wait for absence proofs.

If the named variable is unset, the adapter refuses at construction:
`@mmmnt/feat-adapter-stripe: environment variable STRIPE_SECRET_KEY is not set — configuration error.`

## Example

```feat
feat 1.0

spec SPEC-CHK-001 "Check out an order"
context Checkout
aggregate Order
type command
status agreed

construct:
  handler at src/checkout.mjs
  touches src/**

enforce:
  a checkout makes exactly one charge

contract:
  input CheckoutInput
  response Receipt
  record Charge

scenario "a checkout charges once":
  when: Checkout { orderId: "o-1" }
  predict success:
    response 200 Receipt { orderId: "o-1" }
    stripe has [ charge.succeeded with Charge { id: any string } ]
```

Event types contain dots (`charge.succeeded`) and are written bare. Event order in a `has` list does
not matter on an `eventual` service. A scenario that must make no Stripe call predicts `stripe has []`.

## What it captures

Each event in the window is `{ type: event.type, key: event.id, payload: event.data.object, timestamp }`.
`timestamp` is `event.created` in milliseconds. The payload is the event's `data.object`, such as the
charge or the refund. Match it with a record schema in the contract.

How the window works: `startCapture` asks for the newest event and pins its id as a cursor. `stopCapture`
lists every event after the cursor, following `has_more` pagination 100 at a time, applies the `types`
filter, and returns them oldest first. The window is closed by `stopCapture` and by `reset()`. `stopCapture()` with no window open (never started, already stopped, or reset) returns `[]` and makes no request, as `peekCapture()` does.

## Observation modes

The adapter declares `observes = { diff: "native", state: true }` (SPEC-ADPSTR-001).

- `has` is the events listed after the cursor.
- `contains` is `read()`, which lists **the account's events** under the `types` filter, oldest first,
  with no cursor. It is state in the sense of "what the feed holds now". It is not a lookup of Stripe
  objects. For state, have the scenario's response carry it, or arrange it in `given: execute`.

## Peek and settle

- `peekCapture()` lists the window's events after the cursor exactly as `stopCapture` does, oldest
  first with the `types` filter applied, and does not move the cursor. It is read-only. With no
  window open it returns `[]` without making a request. The window has its own flag, because a null
  cursor means both "the account had no events at start" and "no window".
- `settle()` always resolves `false`, with no request. A fence needs a point after which everything
  written before it is visible. The Events API has none. Events arrive after the call that caused
  them with no documented bound, and Stripe does not guarantee that they arrive in the order they
  were generated, so the arrival of any event proves nothing about the earlier ones. A sentinel would
  also be a write to the account under test. The harness keeps its `convergenceTimeout`, which is the
  truthful wait.

## Seeding, isolation and state

- **No seeding.** A `seed` line on this service is a configuration error:
  `@mmmnt/feat-adapter-stripe does not support seeding — arrange state via the Stripe API in given: execute steps.`
  Create customers and payment methods through a handler or an `execute` step.
- **No cleanup.** `reset()` closes the window and clears the cursor. It does not touch the account.
  Isolate runs with test clocks or fixtures that are unique per run.
- **No namespace.** The runner's per-file namespace (SPEC-RT-006) is accepted and ignored. The Events
  feed is account-wide, so two spec files that run at once see each other's events. Use one account per
  concurrent run, restrict `types`, or run the Stripe specs serially.

## Errors

| Message | Cause |
| --- | --- |
| `@mmmnt/feat-adapter-stripe: environment variable <NAME> is not set — configuration error.` | The key variable is unset or empty. |
| `Stripe Events API <status>: <first 200 characters of the body>` | The Events API answered a non-2xx status, such as 401 for a bad key. |
| `@mmmnt/feat-adapter-stripe does not support seeding — ...` | A `seed` line targets this service. |

The adapter defines no error codes.

## Limitations

- **Eventual.** An absence proof (`stripe has []`) waits for the convergence timeout or the
  `absenceTimeout`, and cannot prove that nothing arrives later than that.
- **Account-wide feed.** See Seeding, isolation and state.
- **Webhooks are not used.** The adapter reads the Events API, not webhook deliveries.
- **Event retention.** The Events API only returns events that Stripe still retains.

## What changed in this release (v0.1.48, package 0.1.7)

- Declares `observes = { diff: "native", state: true }` (SPEC-ADPSTR-001, SPEC-RT-002).
- Adds `peekCapture()` (ADR-0020).
- Adds `settle()`, which always declines (ADR-0021).
- Tracks whether a window is open apart from the cursor, which `peekCapture()` depends on.

## Specs

- [SPEC-ADPSTR-001, peek and settle](https://github.com/mmmnt/feature/blob/main/adapters/stripe/observe.feat)
- [Grammar reference, observation modes](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [ADR-0023, adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)

Part of [Feature](https://github.com/mmmnt/feature). Adapter contract:
https://github.com/mmmnt/feature/wiki/Architecture

## License

MIT
