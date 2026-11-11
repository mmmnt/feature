# @mmmnt/feat-adapter-handler

Response adapter for [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. It routes a spec's `when:` stimulus to an in-process function. Each command
maps to a module path and an export. The adapter imports the module, calls the export with the
payload, the resolved actor and a context object, and takes the `{ status, body }` it returns as
the response that predictions match against.

No server is needed. This is the simplest way to run Feature against plain functions, and it is the
adapter Feature's own toolchain specs run through.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-handler
```

Requires Node 20 or later and `@mmmnt/feature` in the project. The handler modules are imported by
absolute file URL with a dynamic `import()`, so they can be plain ESM (`.mjs`, or `.js` under
`"type": "module"`) or any module format the running Node can load.

## Configuration

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-adapter-handler",
  "commands": {
    "Stamp": { "module": "src/handlers/stamp.mjs", "export": "stamp", "namespace": true },
    "Ping":  { "module": "src/handlers/ping.mjs",  "export": "ping" }
  },
  "actors": {
    "default": "operator",
    "operator": { "role": "operator" },
    "auditor":  { "role": "auditor" }
  }
}
```

| Key | Meaning |
| --- | --- |
| `commands.<Name>.module` | Path to the module, relative to the project root (the directory holding `feat.config.json`). |
| `commands.<Name>.export` | Name of the exported function. |
| `commands.<Name>.namespace` | Optional boolean. `true` declares that this handler reads `ctx.namespace`. See Namespace. |
| `actors.<name>` | An object handed to the handler as its second argument. Any shape. |
| `actors.default` | Name of the actor used when a scenario has no `as` clause. |

`anonymous` is reserved and is never declared. Command names, actor names and service keys are
closed spaces: a name that is not in the config is a parse error.

The adapter takes no `invoke` options. A configuration needs at least one service under `services`
(a `has []` prediction on each is how a handler-only scenario states "no side effects").

## The handler

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

Signature: `(payload, actor, ctx) => Promise<{ status, body }>`.

| Argument | Value |
| --- | --- |
| `payload` | The scenario's `when:` object, as written. |
| `actor` | The `actors` entry for the scenario's actor. `null` for `as anonymous`. The `default` actor when the scenario has no `as`. `undefined` when there is no default actor and none was named. |
| `ctx` | `{ clock, namespace }`, always supplied. |

A handler that takes only `(payload, actor)` keeps working: the extra argument is ignored.

The return value is the response. It must have the `{ status, body }` shape that the scenario's
`response <status> <Schema>` line is matched against. `status` is a number or a name such as `"OK"`,
as the spec writes it. An error the handler throws propagates out of the adapter's `invoke`. The module is
imported on the first call of a command and the export is reused until the adapter is torn down, which
is once per spec file.

TypeScript types are exported:

```ts
import type { HandlerContext, HandlerClock } from "@mmmnt/feat-adapter-handler";
```

## Example

The examples below use one service, `bus`, so each prediction can state that nothing else happened:

```jsonc
"services": {
  "bus": { "adapter": "@mmmnt/feat-adapter-memory", "consistency": "strong" }
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
    response 200 Stamp { orderId: "o-1", role: "operator", stampedAt: "2026-07-16T00:00:00.000Z", frozen: true }
    bus has []
```

## The scenario clock

`given: clock at "<instant>"` freezes the time a handler reads. The adapter implements the optional
`setClock(clock)` hook (SPEC-ADPHND-001). The harness calls it before every case: with the instant
when the case has a `clock at`, and with `null` when it has none.

- The instant must be ISO-8601 **with a zone designator**: `Z` or `+hh:mm`. `2026-07-16T02:00:00+02:00`
  is the same instant as `2026-07-16T00:00:00Z`.
- `ctx.clock.now()` is epoch milliseconds. It is constant across every invocation while the clock is
  frozen, and `Date.now()` when it is not.
- `ctx.clock.iso()` is `new Date(ctx.clock.now()).toISOString()`.
- `ctx.clock.frozen` says which. An unfrozen clock reads the wall, so a handler can use `ctx.clock`
  unconditionally.
- `setClock(null)` unfreezes. `teardown()` unfreezes. A later `setClock` replaces an earlier one.
- The clock is the **third argument**. The adapter never patches the global `Date`, because a patched
  `Date` leaks into the code under test and into every other adapter in the process. A handler that
  calls `Date.now()` directly reads the wall.

`setClock` refuses a string that is not an ISO-8601 instant with a zone, or that does not parse to a
finite time, with an error whose `code` is `INVALID_CLOCK`. The `clock:` values that fail:
`yesterday`, `2026-07-16`, `2026-07-16T00:00:00`, `2026-13-45T00:00:00Z`.

`now()` and `iso()` in a spec's `variables:` honour the clock regardless of the adapter.

## Namespace

The runner derives one namespace per spec file and hands it to every adapter as the top-level
`namespace` key of the config (SPEC-RT-006). The handler adapter exposes it as `ctx.namespace`
(`undefined` when the adapter runs outside a runner). A handler that writes data should key what it
writes by the namespace, so spec files that run in parallel do not see each other's data.

The risk is a handler that ignores `ctx.namespace` and writes where it likes. An absence proof such as
`records []` then passes while the system does the wrong thing. Reading the namespace is the only
signal the adapter has that a handler honoured it, so the adapter reports what was read
(SPEC-ADPHND-002).

- **Opt in per route.** Add `"namespace": true` beside `module` and `export` on the route. Only an
  opted-in route is held to the rule. A route without the marker is never checked, so every handler
  written before namespaces existed keeps working.
- **`reportedNamespace()`.** The harness calls it after a case's `invoke()` returns and before the
  predictions are compared. If the most recently invoked route is not opted in, it answers the
  delivered namespace. Otherwise it answers the namespace if a handler read `ctx.namespace` since the
  adapter was created or last torn down, and `undefined` if none did.
- **`NAMESPACE_NOT_HONOURED`.** When the harness delivered a namespace and the report is not that
  value, it refuses with this code, as a configuration error that exit-2s the run, after the handler
  has run:

  ```
  [NAMESPACE_NOT_HONOURED] the response adapter reports no namespace, but the namespace
  delivered for quiet.feat is s0a6671e84ceb.
  ```

- **No namespace configured.** Outside a runner there is nothing delivered, so nothing is checked.

The namespace is `"s"` plus the first 12 hex characters of the SHA-256 of the spec file's path
relative to the config directory. For `stamp.feat` beside `feat.config.json` it is `sda0c1f79d2bf`, so
this scenario holds:

```feat
scenario "the handler reads the namespace the runner derived for this file":
  when: Stamp { orderId: "o-2" }
  predict success:
    response 200 Stamp { orderId: "o-2", scope: "sda0c1f79d2bf", frozen: false }
    bus has []
```

Two things to know:

- The read is remembered for the life of the adapter, which is one spec file. Once any opted-in
  handler has read `ctx.namespace` in a file, the check is satisfied for every opted-in route in that
  file. Put a handler you want held to the rule in its own spec file, as `quiet.feat` does above.
- Reading `ctx.namespace` is what counts. The adapter cannot see whether the value was then used.

## Errors and refusals

| Code or message | Raised by | Cause |
| --- | --- | --- |
| `INVALID_CLOCK` | `setClock` (the adapter) | The clock is not an ISO-8601 instant with a zone designator, or is not a finite time. |
| `NAMESPACE_NOT_HONOURED` | The harness | An opted-in route's handler never read `ctx.namespace`. |
| `Command '<name>' is not routed in response.commands — configuration error.` | `invoke` | The command is not in `response.commands`. The parser normally catches this first. |
| `Module '<path>' lacks export '<name>' (INV-10) — configuration error.` | `invoke` | The module loaded but the export is missing or is not a function. |

## Limitations

- In process only. A handler shares the runner's process, its environment and its working directory.
- Modules are cached after the first import in a spec file. A change to a handler during a run is not picked up.
- `feat-adapter-http` and `feat-adapter-playwright` do not offer `setClock`, so a `clock at` against
  them is a `CLOCK_UNSUPPORTED` configuration error. Only a handler (or a service adapter that offers
  the hook) can honour it.

## What changed in this release (v0.1.48, package 0.1.8)

- **Scenario clock** (SPEC-ADPHND-001): `setClock`, and the `ctx` third argument with `ctx.clock`.
  `clock at` was in the grammar before, but no adapter honoured it.
- **Namespace** (SPEC-ADPHND-002, SPEC-RT-006 as amended): `ctx.namespace`, `reportedNamespace()` and
  the `namespace: true` route marker. The harness refuses an opted-in route whose handler ignores the
  namespace with `NAMESPACE_NOT_HONOURED`.
- A handler written with the old two-argument signature is unchanged.

## Specs

- [SPEC-ADPHND-001, the scenario clock](https://github.com/mmmnt/feature/blob/main/adapters/handler/clock.feat)
- [SPEC-ADPHND-002, the runner's namespace](https://github.com/mmmnt/feature/blob/main/adapters/handler/namespace.feat)
- [Grammar reference, `clock at` and command routing](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)

Part of [Feature](https://github.com/mmmnt/feature). Adapter contract:
https://github.com/mmmnt/feature/wiki/Architecture

## License

MIT
