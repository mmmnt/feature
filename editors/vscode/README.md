# Feat — execution specifications

**Write the spec. Predict every effect. Anything unpredicted is a failure.**

`.feat` files are execution specifications: they instruct how a feature is
built and predict its complete observable footprint — the response, every
database write, every file touched, every event published. They compile
deterministically into complete test suites with zero human-authored test
code. This extension makes the spec a live document:

- **Syntax highlighting** for the full `.feat` language — identity, triggers,
  predictions, matchers, and stimulus references each carry distinct scopes,
  so the spec reads as structure, not a wall of keywords.
- **Live spec-anchored feedback**: the extension runs `feat watch --json`
  behind the scenes. When an implementation violates a prediction, the failing
  `scenario` line squiggles **in the spec itself** — not in a generated test
  file. The status bar shows green or the current violation count.

## Setup

1. Install this extension.
2. Open a project containing a `feat.config.json` with
   [`@mmmnt/feature`](https://www.npmjs.com/package/@mmmnt/feature) installed.

That's the whole setup. Watch starts automatically (disable via
`feat.watch.autoStart`); `Feat: Start watch` / `Feat: Stop watch` control it
manually.

## The language in one glance

```
scenario "successful user creation":
  when: CreateUser { email: "alice@example.com", name: "Alice" }
  predict success:
    response 201 UserResponse { id: any uuid, email: @when.email }
    database has [ INSERT with UserRow { email: @when.email, status: "active" } ]
```

Prediction inversion is the contract: a predicted effect that doesn't happen
fails, and an effect that happens without being predicted **also fails**. The
suite that enforces it is generated, byte-deterministic, and locked to the
spec by `feat verify`.

Part of [Feature](https://github.com/mmmnt/feature) — docs at the
[project wiki](https://github.com/mmmnt/feature/wiki).
