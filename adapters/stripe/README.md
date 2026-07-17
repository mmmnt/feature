# @mmmnt/feat-adapter-stripe

Service adapter for Feat that turns a Stripe account's **Events API into a
capture window**: every Stripe event that occurs while a scenario runs becomes
a captured record — so an unpredicted charge, refund, subscription change, or
any other account activity fails the suite by prediction inversion.

```jsonc
// feat.config.json
"services": {
  "stripe": {
    "adapter": "@mmmnt/feat-adapter-stripe",
    "consistency": "eventual",
    "convergenceTimeout": 5000,
    "options": {
      "apiKeyEnv": "STRIPE_SECRET_KEY",
      "types": ["charge.succeeded", "refund.created"]
    }
  }
}
```

```
predict success:
  response 200 CheckoutReceipt { orderId: any string }
  stripe has [ charge.succeeded with Charge { amount: 4900, currency: "usd" } ]
```

Records are `{ type: event.type, key: event.id, payload: event.data.object }`.
Declare the service `eventual` — Stripe's event feed lags the API calls that
cause it. The key comes from an environment variable (never config); point it
at **test-mode** keys. `options.types` narrows the observable universe;
omitted, everything the account emits is in scope. No SDK dependency.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT
