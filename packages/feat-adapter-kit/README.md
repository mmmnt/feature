# @mmmnt/feat-adapter-kit

Executable conformance suites for Feat adapter authors. Drop one call into your
vitest suite and the harness-facing contract is asserted for you — capture-window
discipline, record shape, reset semantics, optional-method behavior. Feature's
own first-party adapters run these same suites.

## Service adapters

```ts
import { serviceAdapterContract } from "@mmmnt/feat-adapter-kit";
import { createAdapter } from "../src/index.js";

serviceAdapterContract("my-adapter", {
  factory: () => createAdapter({ options: { /* ... */ } }),
  act: async () => { /* cause one observable effect */ },
  seedRecords: [{ type: "Row", values: { id: 1 } }],   // only if you support seeding
  deliverSample: { event: "X", payload: {} },          // only if event-capable
});
```

Asserted: empty windows capture nothing; effects inside the window are captured
with the `{ type, payload }` record shape; effects before the window are not;
`reset()` is repeatable and clears window state; `read()` returns records or
null; seeded records never leak into capture; unsupported `seed()` rejects with
a clear configuration error; delivered stimuli are excluded from capture.

## Response adapters

```ts
import { responseAdapterContract } from "@mmmnt/feat-adapter-kit";

responseAdapterContract("my-adapter", {
  factory: () => createAdapter({ commands: { Ping: { /* route */ } } }),
  command: "Ping",
  payload: { n: 1 },
  expectStatus: "OK",
});
```

Asserted: `invoke()` returns the `{ status, body }` shape; unrouted commands
reject with a configuration error.

`vitest` is a peer dependency. Part of [Feature](https://github.com/mmmnt/feature) —
adapter contract reference: https://github.com/mmmnt/feature/wiki/Architecture

MIT
