# @mmmnt/feat-adapter-memory

In-memory event service adapter for [Feature](https://github.com/mmmnt/feature), the `.feat`
execution specification language. It runs deliver-triggered specs (`projection`, `policy`, `saga`)
with no infrastructure. `deliver` routes an event to the consumer modules you configure. Anything a
consumer publishes lands in an in-memory event log and is captured while the window is open.

Use it for the spec tier, where specs run in process and fast, and as the stand-in for a bus or an
event store in any config that needs a service key but no real service.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-memory
```

Requires Node 20 or later and `@mmmnt/feature` in the project. There are no runtime dependencies
beyond `@mmmnt/feat-types`.

## Configuration

```jsonc
// feat.config.json
"services": {
  "eventBus": {
    "adapter": "@mmmnt/feat-adapter-memory",
    "consistency": "strong",
    "options": {
      "consumers": {
        "OrderPublished": [
          { "module": "src/sagas/ship-order.mjs", "export": "onOrderPublished" }
        ]
      }
    }
  }
}
```

| Option | Type | Meaning |
| --- | --- | --- |
| `options.consumers` | object | Optional. Maps an event type to one consumer route, or to an array of routes. Each route is `{ "module": "<path>", "export": "<name>" }`. |

Module paths resolve from the project root (the directory holding `feat.config.json`). An event type
with no consumer is logged and delivers to nothing. A config with no `consumers` is valid: the adapter
is then a plain log that can be seeded and read.

Declare the service `strong` or `acid`. Everything the adapter sees is a synchronous write to its own
log, so there is nothing to wait for and no `convergenceTimeout` is needed.

### The consumer

```js
// src/sagas/ship-order.mjs
export async function onOrderPublished(payload, ctx) {
  ctx.publish("ShipmentRequested", { orderId: payload.orderId, address: payload.address });
}
```

Signature: `(payload, ctx) => void | Promise<void>`. `ctx.publish(event, payload)` appends an event to
the same log. The adapter awaits each consumer before `deliver` returns, and consumers of one event
run in the order configured. A consumer that throws fails the case. The event a consumer publishes does
not trigger consumers: only `deliver` does.

```ts
import type { PublishContext } from "@mmmnt/feat-adapter-memory";
```

## Example

A policy spec:

```feat
feat 1.0

spec SPEC-SHP-001 "Ship a published order"
context Orders
aggregate Order
type policy
status agreed

construct:
  handler at src/sagas/ship-order.mjs
  touches src/**

enforce:
  a published order requests one shipment

contract:
  event ShipmentRequestedEvent

scenario "publishing an order requests a shipment":
  deliver OrderPublished { orderId: "o-1", address: "1 Main St" } to eventBus
  predict success:
    eventBus has [ ShipmentRequested with ShipmentRequestedEvent { orderId: @deliver.orderId } ]
```

The delivered `OrderPublished` is the stimulus and is not in the capture. Only the
`ShipmentRequested` the consumer published is. `eventBus has []` would assert that the policy
emitted nothing.

## Observation

The adapter declares `observes = { diff: "native", state: true }` (SPEC-ADPMEM-001).

| Prediction | What it reads |
| --- | --- |
| `eventBus has [...]` | The records published in the window: from `startCapture` to `stopCapture`. |
| `eventBus contains [...]` | `read()`, which is the **whole log**: seeded records, delivered events, and published events, in order. |

Records are `{ type, key, payload, timestamp }`. `type` is the event name, `payload` is the object
published, `key` is the log sequence number as a string, and `timestamp` is the same number.

A delivered event is **excluded from capture**. It is the input, not the output. A seeded record is
excluded too. Both are in the log, so `contains` sees them:

```feat
scenario "a seeded order is in the log and not in the window":
  given:
    seed eventBus [ OrderPublished with OrderRow { orderId: "o-9" } ]
  when: CountOrders {}
  predict success:
    response 200 Ok
    eventBus has []
    eventBus contains [ OrderPublished with OrderRow { orderId: "o-9" } ]
```

## Seeds

`seed eventBus [ <Type> with <Schema> { ... } ]` in a `given:` block appends each record to the log
with `type` as the event name and the values as the payload. Seeds are written before the window
opens, so they are never captured. They are not delivered: no consumer runs for a seeded record. To
run a consumer, use `deliver` (in a deliver-triggered spec) or an `execute` step in `given:`.
Seed values are literals. There are no matchers in a seed.

## Peek and settle

- `peekCapture()` returns what `stopCapture()` would return right now, in the same order and shape,
  without closing the window or consuming anything. With no window open it returns `[]`. A peek after
  `reset()` is `[]`.
- `settle()` resolves `false` when no window is open. Otherwise it yields the event loop once
  (`setImmediate`) and resolves `true`. Every write the adapter sees is a synchronous push onto its
  own log, issued by `seed` or by a consumer the adapter awaits, so after that yield the capture has
  caught up. It writes nothing to the log. Work that a consumer detached from its own promise is not
  seen by any fence.

## Namespaces

The runner derives a namespace per spec file and passes it to every adapter (SPEC-RT-006). This
adapter does not use it, and does not need to. The log lives in the adapter instance, which is created
per spec file, so spec files cannot see each other's records. `reset()` empties the log, and closes
the window, between cases.

## Errors

| Message | Cause |
| --- | --- |
| `Module '<path>' lacks export '<name>' (INV-10) — configuration error.` | A consumer route names an export that is missing or is not a function. Raised on the first `deliver` of that event type. |

The adapter defines no error codes. It serves both observation modes, so it never raises
`MODE_UNSUPPORTED`.

## Limitations

- **Process-local.** The log is gone when the process exits. Nothing is shared between spec files.
- **Not a broker.** There are no partitions, no ordering across event types beyond arrival order, no
  retries and no redelivery.
- **Consumers load lazily.** A bad module path or export surfaces at the first `deliver` of its event
  type, not at setup.
- **No faults.** The adapter offers no fault catalog.

## What changed in this release (v0.1.48, package 0.1.7)

- Declares `observes = { diff: "native", state: true }` (SPEC-ADPMEM-001, SPEC-RT-002).
- Adds `peekCapture()` (ADR-0020).
- Adds `settle()`, which vouches inside an open window (ADR-0021).
- `startCapture` accepts the spec type the harness passes (ADR-0011) and ignores it.

## Specs

- [SPEC-ADPMEM-001, peek and settle](https://github.com/mmmnt/feature/blob/main/adapters/memory/observe.feat)
- [Grammar reference, observation modes](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [ADR-0023, adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)

Part of [Feature](https://github.com/mmmnt/feature). Adapter contract:
https://github.com/mmmnt/feature/wiki/Architecture

## License

MIT
