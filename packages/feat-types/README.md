# @mmmnt/feat-types

The shared contracts of the Feature toolchain: the `BuiltSpec` IR, `FeatConfig`, and the interfaces an adapter
implements. Import types from here when you write an adapter (a module that exports `createAdapter` for `response`,
a `services.<key>` entry or `schemas` in `feat.config.json`) or a tool that reads the IR. If you only write `.feat`
specs you do not need it; the `feat` CLI pulls it in.

Every other `@mmmnt` package depends on these types:

| Package | Uses this package for |
| --- | --- |
| `@mmmnt/feat-core` | the `BuiltSpec` it produces |
| `@mmmnt/feat-derive`, `@mmmnt/feat-emit-ts` | the IR they turn into a test topology and a test file |
| `@mmmnt/feat-runtime` | the adapter interfaces it drives, and `FeatConfig` |
| `@mmmnt/feat-analyze` | the `BuiltSpec` it lints and audits |
| every adapter | the interface it implements |

The language-neutral source of truth is the JSON Schema set in the repository
([`schemas/`](https://github.com/mmmnt/feature/tree/main/schemas)). These types
mirror it by hand. Where the two differ, the
source in `src/index.ts` is what the toolchain compiles against.

## Installation

Requires Node.js 22 or newer.

```bash
npm install -D @mmmnt/feat-types
```

ESM, no dependencies. The package is types plus one runtime constant, `EXCLUSIVE_FAULTS` (see [Faults](#faults));
import everything else with `import type`.

```ts
import type { BuiltSpec, FeatConfig, FeatServiceAdapter } from "@mmmnt/feat-types";
import { EXCLUSIVE_FAULTS } from "@mmmnt/feat-types";
```

## Writing an adapter

An adapter is an ES module that exports `createAdapter(config)`. (`createAdapter`
may also be a property of the default export.) The harness loads it by the
specifier in `feat.config.json`:

- an npm name resolves **from the project root's `package.json`**, never from
  the toolchain's own `node_modules`: the project owns its adapters;
- a path starting `.` or `/` resolves against the project root (the directory
  holding the config).

A module that cannot be resolved, cannot be imported, or has no `createAdapter`
export is a configuration error before any case runs.

`createAdapter` receives the config entry plus fields the harness adds:

| Role | Config entry | `createAdapter` argument |
| --- | --- | --- |
| response | `response` | `{ ...response, projectRoot, namespace? }`, so `adapter`, `invoke`, `commands`, `actors`. Then `setup(response.invoke ?? {})` is called. |
| a service | `services.<key>` | `{ key, ...service, projectRoot, namespace? }`, so `adapter`, `consistency`, `convergenceTimeout`, `absenceTimeout`, `options`. Then `setup()` is called with no argument. |
| schema | `schemas` | `{ ...schemas, projectRoot }`, so `adapter`. Used by `feat generate` and `feat verify`, not by the test run. |

`projectRoot` is the directory of the active config. `namespace` is present
whenever the run knows the spec file (see [Namespace](#namespace)).

### A complete service adapter

This adapter keeps events in memory. It declares what it can serve, so each
optional member is a choice rather than boilerplate.

```ts
import type {
  CapturedRecord,
  FaultArm,
  FaultCatalog,
  FaultFiring,
  FeatServiceAdapter,
  ObservationSupport,
  ReadQuery,
  SeedRecord,
} from "@mmmnt/feat-types";

export function createAdapter(config: Record<string, unknown>): FeatServiceAdapter {
  const namespace = typeof config.namespace === "string" ? config.namespace : undefined;
  let window: CapturedRecord[] | undefined;
  const stored: CapturedRecord[] = [];
  let armed: FaultArm[] = [];
  const fired = new Map<string, number>();

  const faults: FaultCatalog = { Append: { REJECTED: ["once", "times"] } };
  const observes: ObservationSupport = { diff: "native", state: true };

  return {
    faults,
    observes,
    reportedNamespace: () => namespace,
    async setup() {},
    async teardown() {},
    async reset() {
      stored.length = 0;
      window = undefined;
      armed = [];
      fired.clear();
    },
    async seed(records: SeedRecord[]) {
      for (const r of records) stored.push({ type: r.type, payload: r.values, timestamp: Date.now() });
    },
    async startCapture(context?: { specType?: string }) {
      void context?.specType;
      window = [];
    },
    async peekCapture() {
      return [...(window ?? [])];
    },
    async settle() {
      await new Promise((r) => setImmediate(r));
      return true;
    },
    async stopCapture() {
      const out = window ?? [];
      window = undefined;
      return out;
    },
    async read(query: ReadQuery) {
      const types = new Set((query.expect ?? []).map((e) => e.type));
      return stored.filter((r) => types.size === 0 || types.has(r.type));
    },
    async fault(arm: FaultArm) {
      armed.push(arm);
    },
    async firedFaults(): Promise<FaultFiring[]> {
      return [...fired].map(([id, count]) => {
        const [operation, fault] = id.split("/") as [string, string];
        return { operation, fault, count };
      });
    },
  };
}
```

`armed` is where a real adapter would make the product's next `Append` fail,
and where it would count each consumption into `fired`. This sketch arms and
reports but never fires, so a scenario that used its fault would fail with
`FAULT_NOT_CONSUMED`. A conformance suite for the capture and invoke contract is
in [`@mmmnt/feat-adapter-kit`](../feat-adapter-kit/README.md).

## The order the harness calls things

For each adapter, once per spec file: `createAdapter`, then `setup()`, then (for
a service) a namespace check. For each case in that file, in this order:

1. **Preflight, before any effect.** A refused case throws a configuration
   error and nothing has happened: a `clock at` with no `setClock`
   (`CLOCK_UNSUPPORTED`), a `fault` the adapter does not offer
   (`FAULT_UNSUPPORTED`), an exclusive fault outside the serial pass
   (`FAULT_REQUIRES_SERIAL`), a `contains` on a service whose `observes.state`
   is `false` (`MODE_UNSUPPORTED`).
2. `reset()` on every service adapter.
3. `setClock(clock | null)` on the response adapter if it has one, and on every
   service adapter that has one. Every case gets a call, with `null` when the
   case has no `clock at`. Then `setSeed(n)` on the response adapter when the
   case declares `random seed <n>`, and `setSeed(null)` on the case after one
   that did (ADR-0029).
4. `seed(records)` for each `seed` in `given:` and `invoke(...)` on the response
   adapter for each `execute`, interleaved in written order (`given.order`,
   ADR-0025). A service adapter with no `seed` is a configuration error:
   `Configuration error (exit 2): [SEED_UNSUPPORTED] … does not support seed()`,
   and `feat run` exits 2.
5. `fault(arm)` for each `fault` in `given:`, in written order. Faults are armed
   after the seeds and executes, so setup never consumes one.
6. `startCapture({ specType })` on every service adapter. This opens the window.
7. The trigger: `invoke(command, input, actor?)` for `when:`, or
   `deliver(event, payload)` for each delivery (on the response adapter for
   `deliver … to response`, ADR-0036).
8. The convergence wait (below).
9. `stopCapture()` on every service adapter closes the window and returns the
    records.
10. `firedFaults()` for each service that had a fault armed.
11. The diff against the prediction. For `contains`, `read(query)` is called
    here.

After the last case in the file, `teardown()` runs on every service adapter and
then on the response adapter.

## `FeatServiceAdapter`

| Member | Required | What it does |
| --- | --- | --- |
| `setup()` | yes | Connect. Called once per spec file. |
| `teardown()` | yes | Disconnect. |
| `reset()` | yes | Return to a clean state before every case. Must disarm every fault. |
| `startCapture(context?)` | yes | Open the capture window. `context.specType` is the running spec's type (`command`, `query`, ...). An adapter that reports resulting state uses it to withhold that state from a `query`, whose predicted `records: []` would otherwise read a seeded row as a side effect. |
| `stopCapture()` | yes | Close the window and return every record captured in it. Effects outside the window are not captured. |
| `read(query)` | yes | Resulting state, for `contains`. Return an array of `CapturedRecord`; anything else is a violation ("adapter read() did not return a record array"). |
| `seed(records)` | no | Write precondition state directly. A seed is never an effect: it must not appear in the capture. |
| `deliver(event, payload)` | no | Deliver an event as a stimulus (the trigger of `projection`, `policy` and `saga` specs). Delivered stimuli are excluded from capture. Event-capable adapters only. |
| `peekCapture()` | no | Report the records captured so far without consuming them. Lets the harness leave the convergence window early. |
| `settle()` | no | Prove the capture has caught up. See [Convergence](#convergence-peekcapture-and-settle). |
| `observes` | no | The observation modes served. Default `{ diff: "native", state: true }`. |
| `faults` | no | The fault catalog. |
| `acceptsFaultDetail` | no | `false` when the adapter cannot carry a fault's `{ json }` detail to the product. Default `true`. |
| `fault(arm)` | no | Arm a fault as a precondition. |
| `firedFaults()` | no | How often each armed fault was consumed. |
| `setClock(clock)` | no | Receive the scenario clock. |
| `setSeed(seed)` | no | Receive the case's random seed, or `null` (ADR-0029). |
| `reportedNamespace()` | no | Report the namespace the adapter is running under. |

### Records

```ts
interface CapturedRecord {
  type: string;                        // what a prediction's `INSERT with ...` names
  key?: string;
  payload: Record<string, unknown>;    // what the prediction's value block is compared with
  timestamp: number;
  metadata?: Record<string, unknown>;
}

interface SeedRecord {
  type: string;
  schemaName?: string;
  values: Record<string, unknown>;
}
```

A prediction's `<service> has [ ... ]` is compared with what `stopCapture()`
returns. A record that was captured and not predicted fails the case. That is
the language's central rule, and it is why `reset()` and the window boundaries
matter.

### Observation modes

`has` is the **diff** mode (`stopCapture`). `contains` is the **state** mode
(`read`). Declare what you serve with `observes`:

```ts
interface ObservationSupport {
  diff: "native" | "snapshot";
  state: boolean;
}
```

- `diff` is never optional: every service needs `has` (INV-6). `"native"` means
  the product reports writes. `"snapshot"` means the adapter compares two reads,
  so it cannot see a write undone inside the window, and it says so.
- `state: false` makes a `contains` on that service `MODE_UNSUPPORTED`, a
  configuration error before the case runs.
- An adapter that declares nothing is `{ diff: "native", state: true }`.

`read(query)` receives a hint built from the predicted records:

```ts
interface ReadQuery {
  expect?: { type: string; key?: Record<string, string | number | boolean | null> }[];
}
```

`key` holds the literal top-level fields of each predicted record, with `@when`
values already resolved. It is a **hint**: you may narrow your read with it, you
may answer more than asked, you may never answer less.

### Convergence, `peekCapture` and `settle`

A service declared `eventual` (with a required `convergenceTimeout`) is read
after a wait. The timeout is a **ceiling**. The harness ends the wait as early
as it can prove safe, in this order:

1. **fence.** Every eventual service in the prediction implements `settle()` and
   every one resolves `true` before the ceiling. The window ends on proof, and an
   absence prediction (`has []`) becomes a fact rather than a timeout.
2. **peek.** Every eventual service in the prediction predicts at least one
   record, none uses `contains`, and each implements `peekCapture()`. The
   harness polls every 150 ms and leaves once each target count has arrived and
   the capture was quiet for one more poll.
3. **ceiling.** Anything else waits the full `convergenceTimeout`: absence with
   no fence, a `settle()` that returned `false` or never answered, `contains`,
   or no `peekCapture`. The ceiling is the largest `convergenceTimeout` among
   the eventual services in the prediction.
4. **none.** No eventual service in the prediction, so capture is immediate.

Rules for the two optional methods:

- `peekCapture()` must be callable repeatedly between `startCapture` and
  `stopCapture`, and must not consume what `stopCapture` will return.
- `settle()` resolves `true` only when everything the system under test has
  **already written** is visible to `stopCapture`. Resolve `false` when you
  cannot vouch, and the harness keeps the ceiling. Writes the system starts
  after its handler returned are outside any fence, so an in-process adapter
  should yield the event loop before vouching. A rejected `settle()` counts as
  `false`, and one that does not answer by the ceiling falls through to the peek
  rule with the time that is left.
- Do not implement `settle()` unless it is truthful. The memory adapter can
  vouch. The filesystem and Stripe adapters cannot, and their specs say why.

Set `FEAT_FENCE_AUDIT=1` to audit a fence: the harness waits out the ceiling
anyway and fails the case if the capture grew after `settle()` vouched.

### Faults

A fault is a **precondition**, never an assertion. The scenario arms it in
`given:` with

```
fault <service> <Operation> <Fault> [{ json }] [once | times <n> | until reset]
```

and predicts the system's reaction with the usual forms.

```ts
type FaultCount = "once" | "times" | "reset";
type FaultCatalog = Record<string, readonly string[] | Record<string, readonly FaultCount[]>>;

interface FaultArm {
  operation: string;
  fault: string;
  detail?: Record<string, unknown>;
  times: number | "reset";    // 1 for once; n for `times n`; "reset" for `until reset`
}

interface FaultFiring {
  operation: string;
  fault: string;
  count: number;
}
```

- `faults` is a catalog of `Operation -> Fault names`. The array form
  (`{ Put: ["TIMEOUT"] }`) declares all three counts. The object form names the
  counts per fault (`{ Put: { TIMEOUT: ["once", "times"] } }`).
- The harness turns `times` into a count word: `"reset"` is `reset`; `1` is
  `once` if you declare it, else `times`; anything else is `times`. A count you
  did not declare is `FAULT_UNSUPPORTED`.
- Transport faults live under the pseudo-operation `Connection`. The product
  adapters offer them `until reset` only.
- `reset()` **must** disarm every fault. Your own capture, `read()` and `seed()`
  are never faulted.
- If you set `acceptsFaultDetail` to `false`, an arm with a `{ json }` detail is
  refused (`FAULT_UNSUPPORTED`).
- If you implement `firedFaults()`, an armed fault that the system never
  consumed fails the case with `FAULT_NOT_CONSUMED`. The harness sums, per
  `Operation/Fault`, the counts armed (`reset` counts as 1) and compares them
  with the counts you report. Without `firedFaults()` consumption is not
  checked.
- **Exclusive faults.** `EXCLUSIVE_FAULTS` is `["BrokerLoss"]`. These are faults
  that cannot share a product with any other spec file, because they pause
  something every namespace shares. A file that arms one runs alone, in a serial
  pass after the parallel one, and the harness refuses to arm one anywhere else
  (`FAULT_REQUIRES_SERIAL`). Entries are the part of `Operation.Fault` after the
  dot.

### Clock

```ts
setClock?(clock: string | null): Promise<void>;
```

`clock` is an ISO-8601 instant with a zone designator, or `null` for "no frozen
clock". A case with `clock at` is `CLOCK_UNSUPPORTED` unless the right adapter
has `setClock`. When a `response` is configured, only the response adapter is
consulted. With no `response`, any service adapter with `setClock` satisfies it.
Do not patch the global `Date` to honour the clock. The handler adapter passes
it to the handler instead.

### Namespace

```ts
interface ReportsNamespace {
  reportedNamespace?(): string | undefined | Promise<string | undefined>;
}
```

The runner gives every spec file one namespace, derived from the file's path
alone: `s` plus the first 12 hex characters of the SHA-256 of the path relative
to the config directory, so it matches `^s[0-9a-f]{12}$`. It arrives as
`config.namespace` in `createAdapter`, and as the `FEAT_NAMESPACE` environment
variable while the file's adapters are alive. Isolate your data under it: two
spec files running in parallel against one product must never see each other's
records. Namespaces isolate data, not availability.

If you implement `reportedNamespace()`, the harness calls it and compares. For a
service adapter that happens right after `setup()`. For the response adapter it
happens after the first `invoke()` and before any prediction is compared. A
different answer, or none, is `NAMESPACE_NOT_HONOURED`.

A `namespace` key written in `feat.config.json` (in `response`,
`response.invoke` or a service's `options`) is refused as `NAMESPACE_CONFIGURED`,
because a configured value would be shared by every file.

## `FeatResponseAdapter`

```ts
interface FeatResponseAdapter extends ReportsNamespace {
  setClock?(clock: string | null): Promise<void>;
  setSeed?(seed: number | null): Promise<void>;                 // ADR-0029
  setup(config: Record<string, unknown>, context?: ResponseSetupContext): Promise<void>;
  teardown(): Promise<void>;
  invoke(command: string, input: Record<string, unknown>, actor?: string): Promise<CapturedResponse>;
  deliver?(event: string, payload: Record<string, unknown>): Promise<CapturedResponse | void>; // ADR-0036
}

interface ResponseSetupContext {
  commands?: string[];                     // the commands the spec file's cases invoke (SPEC-RT-008)
}

interface CapturedResponse {
  status: number | string;                 // 201, 409, "OK", "ERR"
  body: Record<string, unknown> | null;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}
```

`invoke` is how `when:` and `execute` reach the system. `command` is a key of
`response.commands` (a closed space, validated at parse time), `actor` is a key
of `response.actors`, and `setup` receives `response.invoke` (or `{}`) and, from a
harness built with the file's cases, `{ commands }`: each command those cases
invoke, given executes before the stimulus, once each (SPEC-RT-008). An adapter
can load what those commands need there, under the hook timeout, instead of in
the first case. It may ignore the argument. When
`response.invoke.timeout` is a number, it is the per-invoke allowance in
milliseconds that `feat run` uses to size the test timeout (default 30 000).

A case that declares `random seed <n>` is `RANDOM_UNSUPPORTED` without `setSeed`. A scenario that writes
`deliver <Event> { … } to response` needs `deliver`, or it is `DELIVER_UNSUPPORTED` (service `response`); what
`deliver` returns becomes the case's captured response, so a delivery-only case can predict `response` (ADR-0037).

## `FeatSchemaAdapter`

```ts
interface FeatSchemaAdapter {
  resolve(ref: string, fromPath: string): Promise<ResolvedSchema>;
  resolveInline?(schema: Record<string, unknown>, fromPath: string): Promise<ResolvedSchema>;
  validate(data: unknown, schema: ResolvedSchema): { valid: boolean; errors?: string[] };
}

interface ResolvedSchema {
  id: string;
  format: string;
  raw: unknown;
  normalized: Record<string, unknown>;   // self-contained: it is inlined into the generated test
}
```

`feat generate` calls `resolve` for a contract entry that is only a `$ref`, and
`resolveInline` (when you provide it) for an inline schema whose nested
properties point at another file or at a sibling entry. `normalized` is what
gets inlined, so it must already be self-contained: the generated test lands in
a different directory and nothing resolves at run time. Without `resolveInline`
the pipeline falls back to `resolve("#/schemas/<name>")`, which cannot keep the
schema's own local pointers. `validate` also checks seed values at generate time
(the `SEED_*` codes in `@mmmnt/feature`). The default adapter is
`@mmmnt/feat-schema-json`.

## The IR and the config

`BuiltSpec` is the parsed spec, without source locations. The exported types:

| Type | What it is |
| --- | --- |
| `BuiltSpec` | `{ featVersion, identity, observes?, construct, enforce, contract, variables?, scenarios }` (`observes`: ADR-0033) |
| `SpecIdentity`, `SpecType`, `SpecStatus` | The header. Types: `command`, `query`, `policy`, `projection`, `saga`, `infrastructure`, `integration`, `scaffold`. Statuses: `draft`, `agreed`, `built`, `verified`. |
| `ConstructInstruction` | `handler`, `import`, `register`, `emitsTo`, `touches`, `needs`, `custom` |
| `EnforceStep` | `validate`, `load`, `apply`, `onSuccess`, `onRejection`, `constraint`, `rejects` (with `rejectionId`) |
| `ContractReference` | `input`, `response`, `event`, `record`, `error` with `schemaName`, or `stream` with `pattern` |
| `Scenario` | `{ name, given?, when?, delivers?, prediction, examples?, loc? }` |
| `Given` | `{ clock?, random?, context?, executes?, seeds?, order?, faults? }` (`random`: `random seed <n>`, ADR-0029) (`order`: `GivenStep[]`, the seeds and executes in written order, ADR-0025) |
| `Seed`, `SeedRecord`, `Fault`, `Invocation`, `Delivery` | The preconditions and triggers. A `Seed` is either `{ service, records }` or `{ service, fixture }`. |
| `Prediction` | `success`, `rejection` (with `rejectionId`) or `error` (with `errorCode`), plus `response` and per-service `services` |
| `ServicePrediction`, `PredictedRecord`, `ResponsePrediction` | `records` (from `has`), `contains`, `ordering`; a record or response may carry `golden` and `partial: true` (ADR-0038) |
| `Matcher`, `ValueBlock` | `literal`, `whenRef`, `deliverRef`, `captureRef`, `givenRef` (ADR-0028: `@given[i].response.<path>`), `any`, `regex`, `absent`, `placeholder`, `goldenFixture`, `nested`, `not` (ADR-0027: `{ matcher: "not", operand }`), `f32Digest` (ADR-0030: `{ matcher: "f32Digest", dims, sha256 }`), `list` and `object` (ADR-0034: `{ matcher: "list", items }`, `{ matcher: "object", fields }`) |
| `SpecVariable`, `VariableDefinition`, `VariableType` | The `variables:` block; a source call is `now`, `iso` or `unique`, and `now` and `iso` take an optional `offsetMs` |

`FeatConfig` mirrors `feat.config.json`: `featVersion`, `extends`,
`environment`, `schemas`, `response` (`ResponseConfig`), `services`
(`ServiceConfig`, with `Consistency` of `acid`, `strong` or `eventual`), `specs`
and `report`. The field-by-field reference is in
[`@mmmnt/feature`](../feature/README.md). To validate a file, use
[`schemas/feat.config.schema.json`](../../schemas/feat.config.schema.json).

## Specs and decisions

- [ADR-0023: adapter interface v2](../../docs/adr/ADR-0023-adapter-interface-v2.md) (observation modes, the scenario
  clock, fault injection)
- [ADR-0024: tier bindings](../../docs/adr/ADR-0024-tier-bindings.md)
- [ADR-0029: seeded randomness](../../docs/adr/ADR-0029-seeded-randomness.md)
- [ADR-0036](../../docs/adr/ADR-0036-deliver-to-response.md) and [ADR-0037](../../docs/adr/ADR-0037-deliver-answer.md):
  delivery to the response adapter
- [SPEC-RT-002](../feat-runtime/harness-observation.feat), [SPEC-RT-003](../feat-runtime/harness-faults.feat),
  [SPEC-RT-005](../feat-runner/serial-faults.feat), [SPEC-RT-006](../feat-runtime/harness-namespace.feat)

## Changelog

Per-release changes are in [CHANGELOG.md](CHANGELOG.md). Every `@mmmnt` package is released at the same version.

## Contributing

This package is part of the [Feature monorepo](https://github.com/mmmnt/feature). See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the development setup, the spec-driven rules and the
local gate.

```bash
git clone https://github.com/mmmnt/feature.git
cd feature
pnpm install
pnpm build --filter=@mmmnt/feat-types
pnpm --filter @mmmnt/feat-types test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
