# @mmmnt/feat-adapter-handler

The in-process response adapter for Feature. Each command in `response.commands` names a module and an export; the adapter imports the module, calls the export with the payload, the resolved actor and a context object, and takes the `{ status, body }` it returns as the response that predictions are matched against. No server is needed. It is the simplest way to run `.feat` specs against plain functions, and the adapter Feature's own specs run through.

## Installation

Requires Node.js 22 or newer.

```bash
npm install -D @mmmnt/feat-adapter-handler
```

`feat init` installs it and routes its starter command through it.

## Usage

```jsonc
// feat.config.json
{
  "featVersion": "1.0",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "response": {
    "adapter": "@mmmnt/feat-adapter-handler",
    "commands": {
      "Stamp": { "module": "src/handlers/stamp.mjs", "export": "stamp", "namespace": true }
    },
    "actors": {
      "default": "operator",
      "operator": { "role": "operator" }
    }
  },
  "services": {
    "bus": { "adapter": "@mmmnt/feat-adapter-memory", "consistency": "strong" }
  },
  "specs": { "dir": "specs", "pattern": "**/*.feat", "contractPattern": "**/*.contract.json", "outputPattern": "{name}.test.ts" }
}
```

```js
// src/handlers/stamp.mjs
export async function stamp(payload, actor, ctx) {
  return {
    status: 200,
    body: {
      orderId: payload.orderId,
      role: actor?.role ?? null,
      stampedAt: ctx.clock.iso(),
      frozen: ctx.clock.frozen,
      scope: ctx.namespace ?? null,
    },
  };
}
```

```feat
feat 1.0

spec SPEC-STP-001 "Stamp an order"
context Orders
aggregate Order
type command
status agreed

construct:
  handler at src/handlers/stamp.mjs
  touches src/**

enforce:
  the stamp carries the scenario clock

contract:
  input StampInput
  response Stamp

scenario "the handler reads the frozen clock":
  given:
    clock at "2026-07-16T00:00:00Z"
  when: Stamp { orderId: "o-1" }
  predict success:
    response 200 Stamp { orderId: "o-1", role: "operator", stampedAt: "2026-07-16T00:00:00.000Z", frozen: true, scope: any string }
    bus has []
```

## Configuration

| Key | Meaning |
| --- | --- |
| `commands.<Name>.module` | Path to the module, relative to the project root (the directory holding `feat.config.json`). |
| `commands.<Name>.export` | Name of the exported function. |
| `commands.<Name>.namespace` | Optional boolean. `true` declares that this handler reads `ctx.namespace` (see Namespace). |
| `actors.<name>` | An object handed to the handler as its second argument. Any shape. |
| `actors.default` | The actor used when a trigger has no `as` clause. |

`anonymous` is reserved and never declared. Command and actor names are closed spaces: a name not in the config is a parse error. The adapter reads no `invoke` options.

## The handler

Signature: `(payload, actor, ctx) => Promise<{ status, body }>`. Modules are loaded with a dynamic `import()` of their absolute file URL, so they are whatever the running Node can import.

| Argument | Value |
| --- | --- |
| `payload` | The trigger's payload object, as written. |
| `actor` | The `actors` entry for the trigger's actor; `null` for `as anonymous`; the `default` actor when there is no `as`; `undefined` when there is neither. |
| `ctx` | `{ clock, namespace }`, always passed. |

The return value is the response. `status` is a number or a name such as `"OK"`, as the spec's `response` line writes it. An error the handler throws propagates out of `invoke`.

TypeScript types are exported: `import type { HandlerContext, HandlerClock } from "@mmmnt/feat-adapter-handler"`.

**Loading.** `setup()` receives the commands the spec file's cases invoke and imports each of their routes once, in the generated suite's `beforeAll`, so a module's one-time work is not charged to the first case's timeout. A route not loaded at setup (no commands were passed, or the adapter runs outside a harness) is imported on its first call. A loaded export is reused until teardown, which is once per spec file; a change to a handler during a run is not picked up.

## The scenario clock

`given: clock at "<instant>"` freezes the time a handler reads. The harness calls `setClock` before every case: with the instant when the case has a `clock at`, with `null` when it has none.

- The instant must be ISO-8601 with a zone designator (`Z` or `+hh:mm`) and parse to a finite time; otherwise `setClock` throws an error with `code: "INVALID_CLOCK"`. `yesterday`, `2026-07-16`, `2026-07-16T00:00:00` and `2026-13-45T00:00:00Z` are refused.
- `ctx.clock.now()` is epoch milliseconds: constant while frozen, `Date.now()` when not. `ctx.clock.iso()` is its ISO string. `ctx.clock.frozen` says which.
- `setClock(null)` and `teardown()` unfreeze.
- The global `Date` is never patched. A handler that calls `Date.now()` reads the wall.

## Namespace

The runner derives one namespace per spec file (`"s"` plus the first 12 hex characters of the SHA-256 of the spec's path relative to the config directory: `stamp.feat` beside `feat.config.json` is `sda0c1f79d2bf`) and passes it to the adapter. The handler sees it as `ctx.namespace` (`undefined` outside a runner) and should key the data it writes by it, so spec files running in parallel do not see each other's data.

- **Opt in per route** with `"namespace": true`. A route without it is never checked.
- **`reportedNamespace()`** is called by the harness after a case's `invoke()`. For a route that is not opted in it answers the delivered namespace. For an opted-in route it answers the namespace if a handler read `ctx.namespace` since the adapter was created or last torn down, else `undefined`.
- **`NAMESPACE_NOT_HONOURED`.** When the report differs from the delivered namespace the harness refuses the run as a configuration error (exit 2), after the handler has run.

The read is remembered for the life of the adapter (one spec file): once any opted-in handler in a file has read `ctx.namespace`, every opted-in route in that file passes. Reading is what counts; the adapter cannot see whether the value was used.

## Errors

| Code or message | Raised by | Cause |
| --- | --- | --- |
| `INVALID_CLOCK` | `setClock` | The clock is not an ISO-8601 instant with a zone, or is not a finite time. |
| `ROUTE_UNLOADABLE` | `setup`; the harness makes it a configuration error (exit 2) | A route of a command the file invokes cannot be imported, or its export is missing or not a function. |
| `NAMESPACE_NOT_HONOURED` | The harness | An opted-in route's handler never read `ctx.namespace`. |
| `Command '<name>' is not routed in response.commands — configuration error.` | `invoke` | The command is not in `response.commands`. The parser normally catches this first. |
| `Module '<path>' lacks export '<name>' (INV-10) — configuration error.` | `invoke` | A route loaded on first call whose export is missing or not a function. |

## Limitations

- In process only: a handler shares the runner's process, environment and working directory.
- No `setSeed`, so a `random seed` precondition against this adapter is the harness's `RANDOM_UNSUPPORTED` configuration error.

## See also

- Specs: [clock.feat](clock.feat) (SPEC-ADPHND-001), [namespace.feat](namespace.feat) (SPEC-ADPHND-002), [routes.feat](routes.feat) (SPEC-ADPHND-003)
- [Grammar reference](../../docs/grammar-reference.md): `clock at`, command routing, actors

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
pnpm build --filter=@mmmnt/feat-adapter-handler
pnpm --filter @mmmnt/feat-adapter-handler test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
