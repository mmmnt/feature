# @mmmnt/feat-adapter-playwright

Response adapter for Feat where a command is a **real browser journey**. Each
command routes to a journey module you author: it receives a Playwright `Page`,
drives the flow, and returns the normalized outcome predictions match against.
The spec doesn't change — `when: CheckoutWithCard {…}` reads the same whether
the stimulus is an HTTP call or a full browser checkout.

```jsonc
// feat.config.json
"response": {
  "adapter": "@mmmnt/feat-adapter-playwright",
  "invoke": { "baseUrl": "https://staging.example.com", "browser": "chromium", "headless": true },
  "commands": {
    "CheckoutWithCard": { "module": "journeys/checkout.mjs", "export": "checkoutWithCard" }
  },
  "actors": { "buyer": { "storageState": "playwright/.auth/buyer.json" } }
}
```

```js
// journeys/checkout.mjs
export async function checkoutWithCard(page, payload, ctx) {
  await page.goto(`${ctx.baseUrl}/checkout`);
  await page.fill("#plan", payload.plan);
  await page.click("#pay");
  await page.waitForSelector("#confirmation");
  return { status: 200, body: { orderId: await page.textContent("#order-id") } };
}
```

Journey contract: `(page, payload, ctx) => Promise<{ status, body }>` with
`ctx = { baseUrl, actor }`. Actors map to Playwright `storageState` files
(pre-authenticated sessions); `anonymous` gets a fresh context. Each invoke
runs in its own browser context; a configurable timeout (default 30s) fails
hung journeys. `playwright` is a peer dependency — your project provides it.

Pair with service adapters (filesystem, Stripe, …) to predict the full
footprint of a user journey, not just what the browser shows.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT
