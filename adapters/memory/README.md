# @mmmnt/feat-adapter-memory

In-memory event service adapter for Feat: runs deliver-triggered specs
(projection, policy, saga) with zero infrastructure. `deliver` routes an event
to the consumer modules you configure; anything a consumer publishes lands in
the event log and is captured while the window is open. Delivered stimuli are
excluded from capture — only the system's *response* to them counts. `read()`
returns the full log, which is what `contains` state assertions check.

```jsonc
// feat.config.json
"services": {
  "eventBus": {
    "adapter": "@mmmnt/feat-adapter-memory",
    "consistency": "acid",
    "options": {
      "consumers": {
        "OrderPublished": { "module": "src/sagas/ship-order.ts", "export": "onOrderPublished" }
      }
    }
  }
}
```

Consumer contract: `(payload, ctx) => void | Promise<void>`, where
`ctx.publish(event, payload)` emits onto the same bus. Module paths resolve
from the project root.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. Adapter contract: https://github.com/mmmnt/feature/wiki/Architecture

MIT
