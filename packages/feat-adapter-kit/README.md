# @mmmnt/feat-adapter-kit

**Executable conformance suites for Feat adapter authors.** Drop one call into
your vitest suite and the harness-facing contract is asserted for you: capture
window discipline, record shape, reset semantics, optional-method behavior.
Feature's own first-party adapters (memory, fs, handler, and the DynamoDB
adapter against DynamoDB Local) run these same suites.

If you only write `.feat` specs, you do not need this package. It is for people
who write an adapter: a module that exports `createAdapter(config)` for the
`response` or a `services.<key>` entry of `feat.config.json`.

## Where it sits

Feature observes a product through adapters. The harness opens a **capture
window** on every service adapter, runs the scenario, closes the window, and
compares what was captured with what the spec predicted. If it was captured and
not predicted, the case fails. That only works if every adapter keeps the same
discipline: nothing outside the window is captured, a reset leaves no stale
state, seeds are not effects.

The kit asserts that discipline for the two adapter kinds in
[`@mmmnt/feat-types`](https://github.com/mmmnt/feature/blob/main/packages/feat-types/src/index.ts):

- a **service adapter** (`FeatServiceAdapter`): the thing a `services.<key>`
  entry names, observed through `startCapture` and `stopCapture`;
- a **response adapter** (`FeatResponseAdapter`): the thing `response` names,
  driven through `invoke`.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-kit vitest
```

Requirements:

- Node 20 or later.
- `vitest` 1.0 or later. It is a **peer dependency**: the kit registers
  `describe` and `it` blocks in your vitest run.
- `@mmmnt/feat-types` (a dependency of the kit; you will import its types
  yourself when you write the adapter).

The kit exports two functions and two option types. It has no
`feat.config.json` options and no error codes of its own: a failing assertion is
an ordinary vitest failure.

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

`serviceAdapterContract(name, options)` registers one `describe` block named
`"<name>: Feat service adapter contract"`. Call it at the top level of a
`*.test.ts` file.

| Option | Type | Meaning |
|---|---|---|
| `factory` | `() => FeatServiceAdapter \| Promise<FeatServiceAdapter>` | Builds a fresh adapter. Required. |
| `act` | `(adapter) => Promise<void>` | Causes at least one observable effect while the window is open, the way the system under test would. Optional. Without it the effect-shape assertions are skipped; window discipline is still asserted. |
| `seedRecords` | `SeedRecord[]` | Sample records for `seed()`. Provide it only if the adapter supports seeding. |
| `deliverSample` | `{ event: string; payload: Record<string, unknown> }` | A sample event for `deliver()`. Provide it only for event-capable adapters. |

### How the suite drives the adapter

- `factory()` is called **once** per suite, in the first `beforeEach`. The suite
  then calls `setup()` (no arguments) on that one instance.
- `reset()` is called before **every** test.
- `teardown()` is called once, after the last test.

So one instance serves every test. If `act` reaches the instance through a
variable, assign it inside `factory` (see the example below).

### What is asserted

Always:

| Test | What it checks |
|---|---|
| an empty capture window captures nothing | `startCapture()` then `stopCapture()` returns `[]`. |
| `stopCapture` without `startCapture` does not throw and yields no records | `stopCapture()` returns `[]`. |
| `reset()` is repeatable and clears window state | Two resets, a reset inside an open window, then a fresh window captures nothing. |
| `read()` returns a record array or null | `read({})` answers `null` or an array. |

When `act` is given:

| Test | What it checks |
|---|---|
| effects inside the window are captured with the record shape | `act` runs inside a window; `stopCapture()` returns at least one record, and every record has a non-empty string `type` and an object `payload`. |
| effects before the window opens are not captured | `act` runs, then a window opens and closes with nothing in it. `act` must therefore be safe to call repeatedly. |

When `seedRecords` is given:

| Test | What it checks |
|---|---|
| `seed()` accepts records as preconditions | `seed` is a function and accepts the records. |
| seeded records are not captured by a later window | After `seed()`, a window opens and closes with nothing in it. |

When `seedRecords` is **not** given:

| Test | What it checks |
|---|---|
| `seed()`, if present, rejects with a clear configuration error | No `seed` method passes. If `seed` exists, calling it must reject with a message that matches `/configuration error\|does not support/`. |

When `deliverSample` is given:

| Test | What it checks |
|---|---|
| `deliver()` accepts a stimulus and EXCLUDES it from capture | `deliver` is a function. After delivering inside a window, no captured record has the delivered `type` and an identical payload. |

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

`responseAdapterContract(name, options)` registers a `describe` block named
`"<name>: Feat response adapter contract"`.

| Option | Type | Meaning |
|---|---|---|
| `factory` | `() => FeatResponseAdapter \| Promise<FeatResponseAdapter>` | Builds a fresh adapter. Required. |
| `command` | `string` | A command the adapter is configured to route. Required. |
| `payload` | `Record<string, unknown>` | An input that command accepts. Required. |
| `expectStatus` | `number \| string` | The expected `status`. If omitted, only the shape is checked. |

The suite calls `setup({})` once, `teardown()` once at the end, and asserts:

| Test | What it checks |
|---|---|
| `invoke()` returns the `{ status, body }` response shape | `invoke(command, payload)` resolves to an object with `status` and `body`, and `status` equals `expectStatus` when given. |
| an unrouted command rejects with a configuration error | `invoke("__FEAT_KIT_UNROUTED__", {})` rejects with a message that matches `/not routed\|configuration error/`. |

## A complete example

An adapter for an in-memory log, with its conformance test. With `act`,
`seedRecords` and `deliverSample` all given, the kit registers 9 service tests
(4 always, 2 for `act`, 2 for seeding, 1 for `deliver`), and 2 more for the
response adapter. All 11 pass.

```ts
// log-adapter.ts
import type { CapturedRecord, FeatServiceAdapter, SeedRecord } from "@mmmnt/feat-types";

/** An in-memory service: effects are recorded while a capture window is open. */
export class LogAdapter implements FeatServiceAdapter {
  private state: CapturedRecord[] = [];
  private window: CapturedRecord[] | undefined;

  /** What the "system under test" calls to cause an effect. */
  write(type: string, payload: Record<string, unknown>): void {
    const record = { type, payload, timestamp: Date.now() };
    this.state.push(record);
    this.window?.push(record);
  }

  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}
  async reset(): Promise<void> {
    this.state = [];
    this.window = undefined; // a reset mid-window must drop the stale window
  }
  async startCapture(): Promise<void> {
    this.window = [];
  }
  async stopCapture(): Promise<CapturedRecord[]> {
    const records = this.window ?? [];
    this.window = undefined;
    return records;
  }
  async read(): Promise<CapturedRecord[]> {
    return [...this.state];
  }
  async seed(records: SeedRecord[]): Promise<void> {
    // Preconditions are state, never effects: they do not enter the window.
    for (const r of records) this.state.push({ type: r.type, payload: r.values, timestamp: Date.now() });
  }
  async deliver(): Promise<void> {
    // A delivered stimulus is a cause, not an effect: record nothing.
  }
}
```

```ts
// log-adapter.test.ts
import { responseAdapterContract, serviceAdapterContract } from "@mmmnt/feat-adapter-kit";
import type { FeatResponseAdapter } from "@mmmnt/feat-types";
import { LogAdapter } from "./log-adapter.js";

let log: LogAdapter;

serviceAdapterContract("log-adapter", {
  factory: () => (log = new LogAdapter()),
  act: async () => log.write("Row", { id: 1 }),
  seedRecords: [{ type: "Row", values: { id: 0 } }],
  deliverSample: { event: "Ping", payload: { n: 1 } },
});

class PingResponder implements FeatResponseAdapter {
  async setup(): Promise<void> {}
  async teardown(): Promise<void> {}
  async invoke(command: string): Promise<{ status: number; body: Record<string, unknown> }> {
    if (command !== "Ping") throw new Error(`command '${command}' is not routed — configuration error`);
    return { status: 200, body: { pong: true } };
  }
}

responseAdapterContract("ping-responder", {
  factory: () => new PingResponder(),
  command: "Ping",
  payload: { n: 1 },
  expectStatus: 200,
});
```

```sh
npx vitest run
```

## What the kit does not cover

The kit asserts the capture contract that every adapter shares. It does not
exercise the optional parts of the adapter interface, because what they should do
depends on the product. Test these yourself:

- the runner's **namespace** (`^s[0-9a-f]{12}$`) and `reportedNamespace()`;
- **faults**: the `faults` catalog, `fault()`, `acceptsFaultDetail` and
  `firedFaults()`;
- **observation modes** (`observes`), and `read()` against a `contains` hint
  (`query.expect`);
- `peekCapture()` being non-destructive, and `settle()` vouching only when it can;
- `setClock()` on either adapter kind.

The first-party adapters pair the kit with their own tests for these.

## Configuring your adapter

Once it conforms, point `feat.config.json` at it. The module must export
`createAdapter(config)`:

```jsonc
// feat.config.json
{
  "featVersion": "1.0",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "./adapters/my-response.js",
    "commands": { "Ping": {} }
  },
  "services": {
    "log": {
      "adapter": "./adapters/log-adapter.js",
      "consistency": "strong",
      "options": {}
    }
  },
  "specs": { "dir": ".", "pattern": "*.feat", "contractPattern": "*.contract.json", "outputPattern": "{name}.test.ts" }
}
```

An adapter reference is an npm package name or a local path.
`consistency` is `acid`, `strong` or `eventual`; `eventual` also needs
`convergenceTimeout` (milliseconds).

## This release

No source change to the kit in Feature v0.1.48. It is republished as 0.1.7 against
`@mmmnt/feat-types` 0.2.0, with this README. The adapter
interface it asserts against grew optional members in that release (namespace,
faults, observation modes, `setClock`); the kit does not assert them.

## Docs

- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2: observation modes, the scenario clock, fault injection.
- [Adapter interface types](https://github.com/mmmnt/feature/blob/main/packages/feat-types/src/index.ts).
- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md).
- [`@mmmnt/feat-adapter-dynamodb`](https://github.com/mmmnt/feature/blob/main/adapters/dynamodb/README.md): a first-party adapter that runs the kit.

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## License

MIT
