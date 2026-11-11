# @mmmnt/feat-adapter-playwright

Response adapter for [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language, where a command is a **real browser journey**. Each command routes to a
journey module you write. The journey receives a Playwright `Page`, drives the flow, and returns the
normalised outcome that predictions match against. The spec does not change: `when: CheckoutWithCard {…}`
reads the same whether the stimulus is an HTTP call or a full browser checkout.

The adapter drives a browser. It observes nothing by itself. Pair it with service adapters
(filesystem, Stripe, DynamoDB, ...) to predict the full footprint of a user journey, not only what the
page shows.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-playwright playwright
npx playwright install chromium
```

Requires Node 20 or later, `@mmmnt/feature`, and `playwright` 1.40 or later in your project.
`playwright` is an optional peer dependency: your project provides it and the adapter resolves it from
the project root, so your version and your installed browsers are the ones used. Install whichever
browsers you configure (`chromium`, `firefox`, `webkit`).

## Configuration

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-adapter-playwright",
  "invoke": {
    "baseUrlEnv": "FEAT_E2E_BASE_URL",
    "browser": "chromium",
    "headless": true,
    "timeout": 30000
  },
  "commands": {
    "CheckoutWithCard": { "module": "journeys/checkout.mjs", "export": "checkoutWithCard" }
  },
  "actors": {
    "default": "buyer",
    "buyer": { "storageState": "playwright/.auth/buyer.json" }
  }
}
```

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `commands.<Name>.module` | string | | Path to the journey module, relative to the project root. |
| `commands.<Name>.export` | string | | Name of the exported journey function. |
| `invoke.baseUrl` | string | | The app origin, literally. |
| `invoke.baseUrlEnv` | string | | The name of an environment variable that holds the origin. |
| `invoke.browser` | `"chromium"` \| `"firefox"` \| `"webkit"` | `"chromium"` | The browser to launch. |
| `invoke.headless` | boolean | `true` | Run without a window. |
| `invoke.timeout` | integer (ms) | `30000` | Deadline for one journey. |
| `actors.<name>.storageState` | string | | Path to a Playwright storage-state file, relative to the project root. |
| `actors.default` | string | | The actor used when a scenario has no `as` clause. |

Give `baseUrl` or `baseUrlEnv`, not both. This is the same contract as `@mmmnt/feat-adapter-http`:
origins belong to the environment, so a per-tier config names a variable and the committed config is
the same everywhere. The base URL is resolved once at setup, before a browser launches. With neither
set the base URL is the empty string, `ctx.baseUrl` is `""`, and the browser context has no `baseURL`.

## The journey

```js
// journeys/checkout.mjs
export async function checkoutWithCard(page, payload, ctx) {
  await page.goto(`${ctx.baseUrl}/checkout`);
  await page.selectOption("#plan", payload.plan);
  await page.click("#pay");
  await page.waitForSelector("#confirmation");
  return { status: 200, body: { orderId: await page.textContent("#order-id") } };
}
```

Signature: `(page, payload, ctx) => Promise<{ status, body }>`.

| Argument | Value |
| --- | --- |
| `page` | A Playwright `Page` in a fresh browser context. |
| `payload` | The scenario's `when:` object, as written. |
| `ctx` | `{ baseUrl, actor }`. `baseUrl` is the resolved origin. `actor` is the actor name, or `null` when there is none. |

The context is created with `baseURL` set to the resolved origin, so `page.goto("/checkout")` works too.
The journey decides the outcome: it returns the `status` and `body` that the scenario's
`response <status> <Schema>` line is matched against. Nothing is normalised for you. Return the
numeric status the spec predicts and a body that matches the named schema.

TypeScript types are exported:

```ts
import type { JourneyContext } from "@mmmnt/feat-adapter-playwright";
import { resolveBaseUrl } from "@mmmnt/feat-adapter-playwright";
```

## Example

Against an app on `http://127.0.0.1:3000`:

```sh
FEAT_E2E_BASE_URL=http://127.0.0.1:3000 npx feat run
```

```feat
feat 1.0

spec SPEC-CHK-001 "Check out with a card"
context Checkout
aggregate Order
type command
status agreed

construct:
  handler at journeys/checkout.mjs
  touches journeys/**

enforce:
  a card checkout confirms an order

contract:
  input CheckoutInput
  response CheckoutReceipt

scenario "a buyer pays for the pro plan":
  when: CheckoutWithCard { plan: "pro" }
  predict success:
    response 200 CheckoutReceipt { orderId: "ord-77" }
    bus has []
```

`bus` is a service declared under `services` in the same config. Replace it with the services your
journey touches, such as a database or a payment account, so a write the page never shows still fails
the case.

## Actors

An actor maps to a Playwright `storageState` file: a pre-authenticated session with its cookies and
local storage. Create the file with your own login step, for example `context.storageState({ path })`.

- A scenario with `as buyer` runs in a context loaded from `buyer`'s `storageState`.
- A scenario with no `as` uses `actors.default`.
- `as anonymous` runs in a fresh context with no stored state.
- An actor with no `storageState`, or no default actor, also gets a fresh context.

## How a run behaves

- **One browser per adapter.** It launches at setup and closes at teardown, once per spec file.
- **One context per invocation.** Each `when:` stimulus, and each `execute` step, runs in its own new
  context, so cookies and storage never leak between cases. The context is closed afterwards, whether
  the journey returned or threw.
- **Timeout.** A journey that has not returned after `invoke.timeout` fails the case with
  `Journey '<command>' exceeded <ms>ms`. The race is abandoned, not cancelled, so a journey can still
  be running when the context closes.
- **Module loading.** A journey module is imported on the first call of its command and reused.

## Errors and refusals

| Message | Cause |
| --- | --- |
| `@mmmnt/feat-adapter-playwright requires 'playwright' in the project (peer dependency) — configuration error.` | `playwright` cannot be resolved from the project root. |
| `Unknown browser '<name>' — configuration error.` | `invoke.browser` is not a browser type of the installed `playwright`. |
| `@mmmnt/feat-adapter-playwright: invoke.baseUrl and invoke.baseUrlEnv are mutually exclusive — configuration error.` | Both are set. |
| `@mmmnt/feat-adapter-playwright: environment variable <NAME> is not set (invoke.baseUrlEnv) — configuration error.` | The named variable is unset or empty. Raised at setup. |
| `Command '<name>' is not routed in response.commands — configuration error.` | The command is not in `response.commands`. The parser normally catches this first. |
| `Module '<path>' lacks export '<name>' (INV-10) — configuration error.` | The journey module loaded but the export is missing or is not a function. |
| `Journey '<command>' exceeded <ms>ms` | The journey ran past `invoke.timeout`. |
| `Adapter used before setup() — configuration error.` | `invoke` was called before `setup()`. The harness never does this. |

The adapter defines no error codes. A missing browser binary surfaces as Playwright's own launch error.

## Limitations

- **No clock.** The adapter has no `setClock`, so `clock at` against this adapter is a
  `CLOCK_UNSUPPORTED` configuration error.
- **No namespace.** The runner's per-file namespace (SPEC-RT-006) is accepted and ignored. The app
  must isolate its own data.
- **Slow by nature.** Browser journeys take seconds. Raise `invoke.timeout` and the service's
  `convergenceTimeout` accordingly, and keep journey scenarios few.
- **Headless by default.** Set `invoke.headless` to `false` to watch a journey while debugging.

## What changed in this release (v0.1.48, package 0.1.8)

No source change in this release. The behaviour is as of 0.1.8, which added `invoke.baseUrlEnv`, with
the same contract as `@mmmnt/feat-adapter-http`.

## Specs

- [Grammar reference, command routing and actors](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [ADR-0023, adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)

Part of [Feature](https://github.com/mmmnt/feature). Adapter contract:
https://github.com/mmmnt/feature/wiki/Architecture

## License

MIT
