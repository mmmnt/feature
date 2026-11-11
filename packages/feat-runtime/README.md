# @mmmnt/feat-runtime

**The library every generated Feature test imports.** It loads and validates `feat.config.json`,
loads adapters, and runs each case as one fixed choreography: reset, preconditions, a capture window,
the stimulus, a consistency-aware sweep, and a prediction diff. A failure names the exact spec
coordinate it came from. If something was captured and not predicted, the case fails.

It is deliberately light, because it rides in every consumer's test process. Its dependencies are
`@mmmnt/feat-types`, Ajv and `ajv-formats`.

## Where it sits

```
generated test (feat-emit-ts)  --imports-->  feat-runtime  --loads-->  adapters (createAdapter)
         ^                                        |
   run by feat-runner (vitest)           loadConfig, createHarness, matcher
```

Most users never import it. `feat generate` writes test files whose only Feature import is this
package, and `feat run` runs them. Depend on it directly when you:

- load and validate a config the way Feature does (`loadConfig`), in a tool or a CI check;
- write an adapter or a spec host and want its contract and refusal codes in front of you;
- drive the harness from your own test code (`createHarness`, `runCase`);
- reuse the prediction matcher.

A generated suite also needs `vitest`.

## Install

```sh
npm install @mmmnt/feat-runtime
```

- Node 20 or later. The package is ESM only.
- Adapters named in your config are installed in your project, not here (`npm install
  @mmmnt/feat-adapter-memory`, for example). The runtime resolves them from your project root.

## Use

A harness over a config with a response adapter and one service. `AddItem` is routed by the config;
the stubs here stand in for your adapters.

```ts
import { createHarness, HarnessConfigurationError, type HarnessCase } from "@mmmnt/feat-runtime";

const h = await createHarness({ configPath: "feat.config.json", specPath: "specs/add-item.feat" });

const addItem: HarnessCase = {
  anchor: 'SPEC-ITM-001 › "adds"',
  name: "adds",
  when: { command: "AddItem", payload: { itemId: "a-1" } },
  prediction: {
    type: "success",
    response: { status: 201, schemaName: "AddResponse" },
    services: {
      store: {
        records: [{ type: "ItemAdded", schemaName: "ItemEvent", valueBlock: { itemId: { matcher: "whenRef", path: "itemId" } } }],
      },
    },
  },
};
const inline = { schemas: { AddResponse: { type: "object" }, ItemEvent: { type: "object" } }, goldens: {} };

try {
  await h.runCase(addItem, inline); // resolves when every prediction holds
} catch (e) {
  // A refused configuration carries a code; a violated prediction is a PredictionViolation.
  if (e instanceof HarnessConfigurationError) console.error(e.code, e.service, e.message);
  else throw e;
} finally {
  await h.teardown();
}
```

A generated test does exactly this: `createHarness` in `beforeAll`, `h.runCase(c, INLINE)` in each
`it`, `h.teardown()` in `afterAll`.

## What a case does

`runCase` runs these steps in order. The order is part of the contract.

1. **Preflight**, before any adapter is called. A case that asks for something its adapters cannot
   give is refused here: `CLOCK_UNSUPPORTED`, then for each fault `FAULT_UNSUPPORTED` and
   `FAULT_REQUIRES_SERIAL`, then `MODE_UNSUPPORTED`.
2. **Variables.** The spec's `variables:` table resolves once for the case (see below).
3. **Reset.** `reset()` on every service, in config order.
4. **Clock.** `setClock(clock)` to the response adapter, then to each service adapter that has one.
   `clock` is the case's `given.clock`, or `null`, on every case.
5. **Seeds.** `seed(records)` on each seeded service.
6. **Executes.** Each `given.executes` runs through the response adapter. A string `@given.response.<path>`
   in a later payload reads the most recent execute's response body.
7. **Faults.** Each `given.faults` entry is armed with `fault({ operation, fault, detail, times })`,
   in written order. Arming is never a captured effect.
8. **Capture window.** `startCapture({ specType })` on every service.
9. **Stimulus.** The `when` through the response adapter, then each `delivers` to its service. The
   response adapter's namespace is checked right after the invoke.
10. **Convergence.** The harness waits for eventual services (below).
11. **Capture.** `stopCapture()` on every service.
12. **Fault consumption.** For a service with `firedFaults()`, an armed fault that fired fewer times
    than armed adds a `FAULT_NOT_CONSUMED` violation.
13. **Diff.** The response, then each service's `records` (`has`) and `contains`. Every violation is
    collected, and the case throws one `PredictionViolation` listing them all.

## Configuration

`loadConfig({ path })` reads and validates a config file. A bad config does not throw. It
resolves `{ status, body }`:

```ts
import { loadConfig } from "@mmmnt/feat-runtime";

const r = await loadConfig({ path: "feat.integration.config.json" }); // path is relative to the cwd
if (r.status === "ERR") console.error(r.body.code, r.body.message, r.body.detail);
else console.log(r.body.environment); // the merged, validated config
```

On success `body` is the validated config. On failure `body` is `{ code, message, ...extra }`, with the
codes in the table below. Validation is Ajv, draft-07, against the schema this package bundles.

### The config file

A minimal `feat.config.json`. `schemas`, `services` and `specs` are required; no unknown top-level key
is allowed.

```json
{
  "featVersion": "1.0",
  "environment": "spec",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "@mmmnt/feat-adapter-handler",
    "commands": { "AddItem": { "module": "src/add-item.ts", "export": "addItem" } }
  },
  "services": {
    "store": { "adapter": "@mmmnt/feat-adapter-memory", "consistency": "strong" }
  },
  "specs": {
    "dir": "specs",
    "pattern": "**/*.feat",
    "contractPattern": "**/*.contract.json",
    "outputPattern": "{name}.test.ts"
  },
  "report": { "format": ["console", "junit"], "junitOutput": "reports/feat-junit.xml" }
}
```

| Key | Meaning |
| --- | --- |
| `featVersion` | Language version, `major.minor`. |
| `extends` | Makes this file a tier overlay of the named base. See below. |
| `environment` | Names the environment this config verifies, lower case with hyphens. Stamped into evidence. Not part of generation. |
| `schemas.adapter` | The schema adapter, a package name or a path. |
| `response` | `adapter`, `invoke` (adapter-wide options), `commands` (name to routing), `actors`. Required only when specs use `when:` or `execute`. |
| `services.<key>` | `adapter`, `consistency` (`acid`, `strong` or `eventual`), `convergenceTimeout` (ms), `absenceTimeout` (ms), `options`. |
| `specs` | `dir`, `pattern`, `contractPattern`, `outputPattern`, and optionally `exclude` (globs relative to `dir`). |
| `report` | `format` (`console` and `junit`) and `junitOutput`. |

`consistency: "eventual"` requires `convergenceTimeout`, or the load fails with
`MISSING_CONVERGENCE_TIMEOUT`. The schema also accepts `absenceTimeout`, and the evidence bundle
records it. The harness does not read it. A route under `response.commands.<Name>` may carry
`"namespace": true` to declare that its handler reads `ctx.namespace`.

An adapter specifier is a package name or a path. A specifier that starts with `.` or `/` resolves
against the directory of the config file you pass to `createHarness`. Any other specifier resolves
from that directory's `package.json`, never from the toolchain's own `node_modules`: the project
owns its adapters. An adapter module exports `createAdapter(config)`, as a named export or on its
default export.

### Tier overlays (`extends`, SPEC-RT-004, ADR-0024)

One set of specs runs at more than one tier: in-process and in-memory, then against real products.
An overlay is a config file with `extends` that replaces what differs.

```json
{
  "extends": "./feat.config.json",
  "environment": "integration",
  "services": {
    "store": {
      "adapter": "@mmmnt/feat-adapter-kurrent",
      "consistency": "eventual",
      "convergenceTimeout": 5000,
      "options": { "connectionStringEnv": "FEAT_KURRENT_URL" }
    }
  }
}
```

The rules:

- The base path is relative to the overlay. The base is read and validated as an ordinary config.
- **One level only.** A base that itself has `extends`, or a file that extends itself, is
  `EXTENDS_CHAIN`.
- `environment`, `response`, `specs` and `report` are replaced whole when the overlay has them.
  `services.<key>` is replaced whole for each key the overlay names. Every other service is the
  base's. Nothing is deep-merged, so one product's `options` never leak into another's.
- `environment` is not inherited. An overlay without one has none and resolves it at run time.
- `featVersion` and `schemas` are inherited, and an overlay may not redeclare them.
- **The closed spaces must match.** An overlay may not add a service key, and may not add or remove a
  command name or an actor name (`TIER_SPACE_MISMATCH`). Since an unnamed service is inherited, an
  overlay cannot remove one either.
- The merged document is what the schema validates, so an overlay file alone need not carry
  `schemas`, `services` or `specs`. The result keeps `extends`, so a consumer can tell an overlay.

A spec means the same thing in both tiers by construction, and drift is a load error.

### Environment

```ts
function resolveEnvironment(config: { environment?: string }): string;
```

Returns `config.environment` when set, else `FEAT_ENVIRONMENT`, else `ENVIRONMENT`. With none of the
three it throws `No environment declared — set ENVIRONMENT or FEAT_ENVIRONMENT, or pin config.environment — configuration error.`

`variablesSidecarPath(projectRoot, configPath)` returns
`<projectRoot>/.feature/run/<config file name without .json>-variables.jsonl`, where the harness
records each case's resolved variables.

## Namespaces (SPEC-RT-006)

Two spec files run in parallel against one product must not see each other's data. So the harness
derives one namespace per spec file, from the file's path alone:

```
namespace = "s" + the first 12 hex characters of sha256(path)
```

The path is relative to the config directory, with `/` separators, no leading `./`, and case kept.
It always matches `NAMESPACE_PATTERN`, `/^s[0-9a-f]{12}$/`. For example
`adapters/kurrent/observe.feat` gives `s0599e33863c1`, whether you write it with `/`, with `\`, or as
an absolute path under the config directory.

```ts
import { deriveNamespace } from "@mmmnt/feat-runtime";

deriveNamespace("adapters/kurrent/observe.feat", "/path/to/config/dir"); // "s0599e33863c1"
```

When `createHarness` gets a `specPath`, it:

- derives the namespace once and keeps it for the whole file, so `reset()` never changes it;
- creates the response adapter and every service adapter with `createAdapter({ ...config, namespace })`,
  `namespace` being a top-level key beside `options`;
- sets `process.env.FEAT_NAMESPACE` for the file, and restores the prior value on teardown;
- asks any adapter that implements `reportedNamespace()` to report the namespace it runs under. A
  service adapter is asked at setup. The response adapter is asked after each case's invoke and
  before any prediction is compared, because an in-process handler can only report it once it has
  read it. A report that differs from the delivered one is `NAMESPACE_NOT_HONOURED`. A host that
  ignores its namespace writes outside it, and an absence prediction would pass while the system
  misbehaves, so the check is not optional.

Without `specPath` there is no namespace.

Namespaces isolate data, not availability. A fault that takes a product away from every file is
exclusive and runs in the runner's serial pass.

`assertNoNamespaceCollision(specPaths, configDir)` checks a whole run's spec set. Two files that
derive one namespace throw `NAMESPACE_COLLISION`. `feat run` calls it before any file starts.
`assertNamespaceNotConfigured(config, configPath)` refuses a `namespace` key written in the response
config or in a service's `options` (`NAMESPACE_CONFIGURED`), because a configured value is shared by
every file. `createHarness` calls it on the merged config, after `loadConfig`'s own checks.

## Faults (SPEC-RT-003, SPEC-RT-005, ADR-0023)

A fault is a precondition, never an assertion. A spec writes
`fault <service> <Operation> <Fault> [{ detail }] [once | times <n> | until reset]` in `given:`, and
predicts what the system does about it with the ordinary `predict` forms.

An adapter declares what it can produce in a **catalog**: operation, then fault, then the counts that
fault accepts.

```text
faults: {
  Append: { WrongVersion: ["once", "times"], AccessDenied: ["reset"] },
  Connection: { Timeout: ["reset"] },
}
```

`once`, `times` and `reset` are the counts. `times` covers every `n`. The earlier shape, an array of
fault names per operation (`{ Append: ["WrongVersion"] }`), is still accepted and declares all three
counts. A case's `once` is `times 1`: it counts as `once` when the fault declares it, otherwise as
`times`.

At preflight, each fault of the case must pass `faultProblem(adapter, fault)`. It returns the reason
the adapter cannot arm it, or `undefined`:

| Reason in the message | Cause |
| --- | --- |
| `service '<s>' is not configured` | The fault names a service not in the config. |
| `has no fault() method` | The adapter implements no `fault()`. |
| `cannot carry a fault detail to the product` | The fault has a `detail` and `acceptsFaultDetail` is `false`. |
| `offers no operation '<op>' (offers: ...)` | The operation is not in the catalog. |
| `offers no fault '<f>' under '<op>' (offers: ...)` | The fault is not under that operation. |
| `declares only <counts>, not <count>` | The fault does not declare the count the case writes. |

Any of these refuses the case as `FAULT_UNSUPPORTED`, before the case has any effect.

A fault is armed after the seeds and the `given.executes`, so setup never consumes it, and before the
capture window opens, so arming is never a captured effect. After `stopCapture()`, for each service
that was armed and has `firedFaults()`, a fault armed `times n` must have fired `n` times, and one
armed `until reset` at least once. Otherwise the case gets the violation
`FAULT_NOT_CONSUMED: <anchor> › <service>: fault <Operation>/<Fault> armed for <n> call(s), consumed <m>`.
A service without `firedFaults()` is not checked. Adapters must disarm every fault in `reset()`.

A fault named in `EXCLUSIVE_FAULTS` from `@mmmnt/feat-types` (today `BrokerLoss`) is refused with
`FAULT_REQUIRES_SERIAL` unless `process.env.FEAT_SERIAL` is `1`. `feat run` sets it only in the
serial pass (see `@mmmnt/feat-runner`).

## Clock and observation modes (SPEC-RT-002, ADR-0023)

**Clock.** A case with `clock at` needs a response adapter with `setClock()`. If there is no response
adapter, at least one service adapter must have it. Otherwise: `CLOCK_UNSUPPORTED`. A service adapter
without `setClock` is never refused, it is simply not called. The clock reaches every adapter that has
the hook on every case, after the resets, as an ISO-8601 instant with a zone designator or `null`, so
one case's frozen clock never leaks into the next.

**Modes.** `has` is the diff mode and `contains` the state mode. Every adapter serves diff, through
`stopCapture()`. State is optional. An adapter declares `observes: { diff: "native" | "snapshot",
state: boolean }`. One that declares nothing is `{ diff: "native", state: true }`. A prediction with
`contains` on a service whose `observes.state` is `false` is refused as `MODE_UNSUPPORTED`, with
`mode` set to `"state"`.

For `contains`, the harness calls `read({ expect })`. `expect` has one entry per predicted record: its
`type`, and as `key` its top-level fields whose matcher is a literal or an `@when` reference. This is
a hint. The adapter may narrow its read, may answer more, never fewer.

## The adapter contract

The harness drives the interfaces in `@mmmnt/feat-types`. A service adapter, in outline:

```ts
import type { CapturedRecord, FaultArm, FaultFiring, FeatServiceAdapter } from "@mmmnt/feat-types";

export function createAdapter(cfg: { key: string; namespace?: string }): FeatServiceAdapter {
  let captured: CapturedRecord[] = [];
  let armed: FaultArm[] = [];
  const fired: FaultFiring[] = [];
  return {
    // operation -> fault -> the counts it accepts
    faults: { Append: { WrongVersion: ["once", "times"], AccessDenied: ["reset"] } },
    observes: { diff: "native", state: true },
    async setup() {},
    async teardown() {},
    async reset() {
      captured = [];
      armed = []; // reset() MUST disarm every fault
      fired.length = 0;
    },
    async fault(arm) {
      armed.push(arm);
    },
    async firedFaults() {
      return [...fired];
    },
    async startCapture(context) {
      captured = [];
      void context?.specType; // "query" | "command" | ...
    },
    async stopCapture() {
      return captured;
    },
    async read(query) {
      void query.expect; // a hint: answer at least these, never fewer
      return captured;
    },
    async reportedNamespace() {
      return cfg.namespace;
    },
  };
}
```

Required: `setup`, `teardown`, `reset`, `startCapture`, `stopCapture`, `read`. Optional: `seed`, `deliver`,
`setClock`, `faults` with `fault` and `firedFaults`, `observes`, `reportedNamespace`, `peekCapture`
and `settle` (below). A response adapter has `setup(config)`, `teardown()`, `invoke(command, input,
actor?)` and optionally `setClock` and `reportedNamespace`.

`createAdapter` receives, for a service, `{ key, ...serviceConfig, projectRoot, namespace? }`, and for
the response adapter `{ ...responseConfig, projectRoot, namespace? }`. The response adapter's `setup`
gets `response.invoke ?? {}`. `importAdapter(specifier, projectRoot)` is the one door every adapter
comes through, so resolution and failure messages are the same everywhere.

## Convergence

After the stimulus, the harness decides when to stop capturing. It considers only services that the
prediction names and whose `consistency` is `eventual`. The window never exceeds the largest of their
`convergenceTimeout`.

| Mode | When | Ends |
| --- | --- | --- |
| none | No eventual service in the prediction. | At once. |
| fence | Every such service has `settle()` and every one vouches `true` before the ceiling. | On proof. Absence predictions included. |
| peek | Every such service predicts records, no `contains`, and has `peekCapture()`. | When each target count has arrived and the capture went quiet for one more poll (150 ms). |
| ceiling | Anything else, including absence without a fence. | After the full `convergenceTimeout`. |

Set `FEAT_FENCE_AUDIT` to any value to check a fence against the clock it replaces: the harness
waits out the ceiling anyway and throws if the capture grew after `settle()` vouched.

The default ordering of `has` is the active tier's: `unordered` (a multiset) for an `eventual`
service, `ordered` (a sequence) for any other. A spec's `has ordered` or `has unordered` overrides it.

## The prediction matcher

```ts
import { applyMatcher, applyValueBlock, diffRecords, diffResponse } from "@mmmnt/feat-runtime";
```

All four are pure. They append violation strings to an array you pass and never throw.

A record matches a prediction when the types are equal, the captured payload validates against the
predicted schema (inlined at generate time), and then the payload equals the golden fixture or
satisfies the value block. Ajv compiles each schema once, in the dialect its `$schema` names
(draft-07 by default, 2020-12 when it says so).

```ts
import { applyValueBlock, diffRecords } from "@mmmnt/feat-runtime";
import type { InlineData, MatchContext } from "@mmmnt/feat-runtime";
import type { CapturedRecord, PredictedRecord } from "@mmmnt/feat-types";

const inline: InlineData = { schemas: { ItemEvent: { type: "object", required: ["itemId"] } }, goldens: {} };
const ctx: MatchContext = { when: { itemId: "a-1" }, inline };

const captured: CapturedRecord[] = [
  { type: "ItemAdded", payload: { itemId: "a-1" }, timestamp: 1 },
  { type: "ItemAdded", payload: { itemId: "zzz" }, timestamp: 2 },
];
const predicted: PredictedRecord[] = [
  { type: "ItemAdded", schemaName: "ItemEvent", valueBlock: { itemId: { matcher: "whenRef", path: "itemId" } } },
];

const violations: string[] = [];
diffRecords(captured, predicted, "unordered", ctx, "SPEC-X › row", violations);
console.log(violations); // [ 'SPEC-X › row: UNPREDICTED record ItemAdded' ]

const out: string[] = [];
applyValueBlock({ id: "nope" }, { id: { matcher: "any", ofType: "uuid" } }, ctx, "response", out);
console.log(out); // [ 'response › id: expected any uuid, got "nope"' ]
```

- `diffRecords(captured, predicted, ordering, ctx, anchor, out)`: `ordered` compares position by
  position. `unordered` pairs each predicted record with a distinct captured one (a multiset).
  Leftovers are reported as `UNPREDICTED record <type>` and gaps as `MISSING predicted record <type>`.
- `diffResponse(actual, predicted, ctx, anchor, out)`: status, then schema, then golden or value
  block.
- `applyValueBlock(actual, block, ctx, anchor, out)` and `applyMatcher(actual, present, matcher, ctx,
  anchor, out)`: one value block, or one matcher.

Matchers: `literal`, `whenRef` (`@when.<path>`), `deliverRef` (`@deliver.<path>`), `captureRef`
(`@<service>[i].<path>`, a value captured on another surface), `any` (optionally `uuid`, `timestamp`,
`string`, `number` or `boolean`), `regex`, `absent`, `goldenFixture` and `nested`. `@when` and
`@deliver` equal the values actually sent, after `@given.response.*` resolved. A `captureRef` whose
service captured nothing, or whose index is out of range, is a violation, never a pass. A
`placeholder` matcher that reaches the runtime is a violation too: derive should have replaced it.

`contains` is a subset check against `read()`: every predicted record must match a distinct state
record, and extra state is not a violation. Exclusivity belongs to `has`.

## Variables and given references

`resolveVariables(vars, frozenClock?)` resolves a case's `variables:` table once, and
`substituteVariables(value, resolved)` replaces every `${name}` of a declared name through a value
tree. A variable is `now()` (epoch milliseconds), `iso()` (an ISO-8601 string), `unique()`, a number,
or a template of strings and other variables. `now` and `iso` take an offset and honour a frozen
scenario clock, so a frozen clock stays fully deterministic. Resolved values are appended to the
sidecar from `variablesSidecarPath`.

```ts
import { resolveVariables, substituteVariables } from "@mmmnt/feat-runtime";

const vars = resolveVariables(
  [
    { name: "when", type: "string", definition: { kind: "call", fn: "iso", offsetMs: 60_000 } },
    { name: "label", type: "string", definition: { kind: "template", parts: ["order-", { ref: "when" }] } },
  ],
  "2026-07-16T00:00:00Z",
);
substituteVariables({ note: "${label}" }, vars); // { note: "order-2026-07-16T00:01:00.000Z" }
```

A string that is exactly `@given.response.<path>` in a payload is replaced by that path of the most
recent execute's response body. An unresolvable reference fails the case loudly, naming the anchor.

## Errors and refusals

### `loadConfig`: the `ERR` body

| Code | When | Extra fields |
| --- | --- | --- |
| `CONFIG_NOT_FOUND` | No file at the path. | `path` |
| `INVALID_CONFIG` | The file is not valid JSON. The merged document violates the schema, and `detail` names the first failing path and the allowed values. A base config violates the schema, or is unreadable. An overlay redeclares `featVersion` or `schemas`. | `detail` |
| `MISSING_CONVERGENCE_TIMEOUT` | A service is `eventual` and has no `convergenceTimeout`. For an overlay, the merged service. | `detail`: the service key |
| `EXTENDS_NOT_FOUND` | The base file does not exist. | `detail` names the path as written and as resolved |
| `EXTENDS_CHAIN` | The base itself has `extends`, or the file extends itself. | `detail` names both files |
| `TIER_SPACE_MISMATCH` | An overlay adds a service, or adds or removes a command or an actor. | `space` (`service`, `command` or `actor`), `change` (`added` or `removed`), `detail`: the name |

### `HarnessConfigurationError`

A subclass of `Error` with `code`, and `service` and `mode` where they apply. Its message is
`Configuration error (exit 2): [CODE] <detail>`, so the runner's output shows the code. Each is raised
before the case has any effect. None is a silent pass.

| Code | When it fires | Raised at |
| --- | --- | --- |
| `CLOCK_UNSUPPORTED` | A case has `clock at` and no adapter that could receive it has `setClock()`. | Preflight |
| `MODE_UNSUPPORTED` | A prediction has `contains` on a service whose `observes.state` is `false`. `mode` is `"state"`. | Preflight |
| `FAULT_UNSUPPORTED` | A fault names an unconfigured service, an operation or fault the adapter does not offer, an adapter with no `fault()`, a detail the adapter cannot carry, or a count the fault does not declare. | Preflight |
| `FAULT_REQUIRES_SERIAL` | A case arms an exclusive fault and `FEAT_SERIAL` is not `1`. | Preflight |
| `NAMESPACE_COLLISION` | Two spec files of one run derive one namespace. | `assertNoNamespaceCollision`, before any file starts |
| `NAMESPACE_NOT_HONOURED` | An adapter reports a namespace other than the one delivered, or none. | A service adapter at setup. The response adapter after the invoke. |
| `NAMESPACE_CONFIGURED` | The response config or a service's `options` carries a `namespace` key. | `createHarness`, after the config loads |

Example message:

```
Configuration error (exit 2): [FAULT_UNSUPPORTED] SPEC-ITM-001 › "adds": fault store Append Timeout: the adapter for 'store' offers no fault 'Timeout' under 'Append' (offers: WrongVersion).
```

### Other failures

| Failure | Shape |
| --- | --- |
| A prediction does not hold | `PredictionViolation`, with `violations: string[]`. Its message is `Prediction violated:` and one line per violation, each starting with the case anchor. |
| An armed fault was never consumed | A `FAULT_NOT_CONSUMED:` line inside that `PredictionViolation`. |
| `createHarness` cannot load the config | A plain `Error` whose message is `Configuration error (exit 2): ` followed by the `ERR` body as JSON. The code is in the JSON, not in brackets. |
| An adapter cannot be resolved, loaded, or lacks `createAdapter` | A plain `Error` that says `configuration error`. It does not carry the `(exit 2):` prefix, so the runner treats the run as failed, not as a configuration error. |
| A case needs what the config lacks | A plain `Error` naming the anchor: a seed for an unknown service or an adapter without `seed()`, an `execute` or `when` with no response adapter, a `delivers` to an unknown service or an adapter without `deliver()`, a fixture seed that was not inlined at generate time, an undeclared `${variable}`, a `@given.response` reference that does not resolve. |
| `read()` answered something that is not an array | A violation: `adapter read() did not return a record array — configuration error.` |

## Bundled schema

`schemas/feat.config.schema.json` ships in this package, a copy of the repository's `schemas/` file
that a test keeps in sync, so validation works from `node_modules`. It is JSON Schema draft-07 and
exported as a subpath:

```ts
import { createRequire } from "node:module";

const schema = createRequire(import.meta.url)("@mmmnt/feat-runtime/schemas/feat.config.schema.json");
console.log(schema.title); // "FeatConfig"
```

Validate a config document with it directly, for example in an editor or a pre-commit check. Note
that the schema describes a complete config. An overlay file alone fails its `required` list, which is
why `loadConfig` validates the merged document.

## API summary

| Export | Kind |
| --- | --- |
| `loadConfig`, `resolveEnvironment`, `variablesSidecarPath` | Config |
| `importAdapter` | Adapter loading |
| `createHarness`, `Harness`, `HarnessCase`, `CaseVariable` | Harness |
| `HarnessConfigurationError`, `PredictionViolation` | Errors |
| `faultProblem` | Faults |
| `deriveNamespace`, `normalizeSpecPath`, `assertNoNamespaceCollision`, `assertNamespaceNotConfigured`, `NAMESPACE_PATTERN` | Namespaces |
| `resolveVariables`, `substituteVariables` | Variables |
| `applyMatcher`, `applyValueBlock`, `diffRecords`, `diffResponse`, `InlineData`, `MatchContext` | Matcher |
| `CapturedResponse`, `LoadConfigInput`, `AdapterModule` | Types |

Environment variables the runtime reads or sets: `FEAT_ENVIRONMENT` and `ENVIRONMENT`
(`resolveEnvironment`), `FEAT_NAMESPACE` (set per file), `FEAT_SERIAL` (read in preflight) and
`FEAT_FENCE_AUDIT` (read in the convergence wait).

## What changed in 0.2.0

- **Namespaces (SPEC-RT-006).** `deriveNamespace` and its helpers, `createHarness({ specPath })`,
  `FEAT_NAMESPACE`, `reportedNamespace()` checks, and the codes `NAMESPACE_COLLISION`,
  `NAMESPACE_NOT_HONOURED` and `NAMESPACE_CONFIGURED`. A response route can declare
  `"namespace": true`.
- **Faults (SPEC-RT-003, SPEC-RT-005, ADR-0023).** Catalogs with per-fault counts, preflight refusal,
  arming after the executes, consumption checks, `faultProblem`, `FAULT_UNSUPPORTED`,
  `FAULT_NOT_CONSUMED` and `FAULT_REQUIRES_SERIAL`.
- **Clock and observation modes (SPEC-RT-002, ADR-0023).** `setClock` delivery on every case,
  `observes`, the `read()` query hint, `CLOCK_UNSUPPORTED` and `MODE_UNSUPPORTED`.
- **Tier overlays (SPEC-RT-004, ADR-0024).** `extends` in `loadConfig`, `EXTENDS_NOT_FOUND`,
  `EXTENDS_CHAIN`, `TIER_SPACE_MISMATCH`, and the default `has` ordering resolved from the active
  tier's `consistency`.
- **Codes in messages.** A harness configuration error's message now begins
  `Configuration error (exit 2): [CODE]`, so the runner's output shows which refusal it was.

## Specs and decisions

- [SPEC-RT-001](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/load-config.feat): load and validate `feat.config.json`.
- [SPEC-RT-002](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/harness-observation.feat): clock delivery and the observation-mode check.
- [SPEC-RT-003](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/harness-faults.feat): fault arming, consumption and refusal.
- [SPEC-RT-004](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/load-config-extends.feat): load a tier overlay.
- [SPEC-RT-005](https://github.com/mmmnt/feature/blob/main/packages/feat-runner/serial-faults.feat): the runner's serial pass for exclusive faults.
- [SPEC-RT-006](https://github.com/mmmnt/feature/blob/main/packages/feat-runtime/harness-namespace.feat): one namespace per spec file.
- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2.
- [ADR-0024](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0024-tier-bindings.md): tier bindings.
- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md): the language the predictions come from.

## License

MIT

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki
