# @mmmnt/feat-adapter-model

Recorded-judge service adapter for [Feature](../../README.md), the `.feat` execution
specification language. Use it for a **judgment port**: the part of your system that asks a language model to
decide something. A spec seeds the answers the judge gives and predicts the asks the system makes. Nothing goes
over a network and no model is ever called, so a run is repeatable, free and needs no key.

The adapter keeps the port's records in one JSON Lines file per namespace. Your system reads its recorded answers
from that file and appends its asks to it. The adapter is the same at every tier, because there is no product
behind it (ADR-0028, SPEC-ADPMODEL-001).

## Installation

Requires Node.js 22 or newer.

```sh
npm install -D @mmmnt/feat-adapter-model
```

The project also needs `@mmmnt/feature`. The adapter has no runtime dependency beyond `@mmmnt/feat-types`.

## Configuration

```jsonc
// feat.config.json
"services": {
  "model": {
    "adapter": "@mmmnt/feat-adapter-model",
    "consistency": "strong",
    "options": { "dir": ".feature/judge" }
  }
}
```

| Option | Type | Meaning |
| --- | --- | --- |
| `options.dir` | string | Required. The directory holding the record files, absolute or relative to the project root (the directory holding `feat.config.json`). It is created if missing. |

`dir` is the only option. Any other key, a missing `dir` or one that is not a non-empty string is
`OPTIONS_INVALID` when the adapter is created. Point `dir` at a directory your project ignores (for example under
`.feature/`).

Declare the service `strong` or `acid`. `settle()` vouches as soon as a window is open, so absences are proven
without waiting out a timeout.

## The record file

The file is `<dir>/<namespace>.jsonl`, where the namespace is the one `feat run` derives for each spec file
(`^s[0-9a-f]{12}$`, SPEC-RT-006). The adapter creates the file empty at `setup()`, empties it at `reset()` (before
every case) and removes it at `teardown()`. Without a namespace the adapter refuses with `NAMESPACE_INVALID`.

Every record is one line: a JSON object, then LF.

```json
{"type":"judgment.answer","payload":{"purpose":"extraction","unitId":"ws:ws-1/entry:e-42","chunk":0,"candidates":[{"type":"Aggregate","name":"Order","context":"Sales"}]}}
{"type":"judgment.ask","payload":{"purpose":"extraction","unitId":"ws:ws-1/entry:e-42","chunk":0,"judgmentId":"0123456789abcdef0123456789abcdef"}}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | A non-empty string: the record type the spec names. |
| `payload` | yes | An object, kept exactly as written. |
| `key` | no | A string. Without it the record is keyed by its 1-based line number. |
| `timestamp` | no | A number. Without it the record is stamped with its line number. |
| `metadata` | no | An object. |

A last line without its LF is a write in progress and is not read until its LF lands. A complete line that is not
such an object fails the case with `RECORD_MALFORMED`, naming the file and the line number.

### What your system does

1. Learn the namespace (from `FEAT_NAMESPACE`, or from your spec host's setup) and the directory, and open
   `<dir>/<namespace>.jsonl`.
2. To answer a judgment, read the file's complete lines and find the recorded answer your port's key names (for
   example the hash of the chunk's inputs). Matching an ask to an answer is your port's job: the adapter carries no
   matching rule, so any payload shape works.
3. Append each ask as one line, with its LF, before your handler returns. A write buffered past the reply is
   outside the fence and may be missed (ADR-0021).

## Example

```feat
scenario "the extraction asks once and records the judge's candidates":
  given:
    seed model [ judgment.answer with RecordedJudgeAnswer { purpose: "extraction", unitId: "ws:ws-1/entry:e-42", chunk: 0, candidates: [{ type: "Aggregate", name: "Order", context: "Sales" }] } ]
  when: Extract { pointer: "ws:ws-1/entry:e-42" }
  predict success:
    response OK Extracted { candidates: 1 }
    model has [ judgment.ask with ModelAsk { purpose: "extraction", unitId: "ws:ws-1/entry:e-42", chunk: 0, judgmentId: matching "^[0-9a-f]{32}$" } ]
```

The seeded answer is in the file before the window opens, so it is never captured. Only the ask the system wrote
is. `model has []` asserts that the system asked nothing.

## Observation

The adapter declares `observes = { diff: "native", state: true }`.

| Prediction | What it reads |
| --- | --- |
| `model has [...]` | The complete lines appended after `startCapture`, in written order. `peekCapture` reads the same and consumes nothing. With no window open, both return `[]`. |
| `model contains [...]` | `read()`: every record in the file, seeded answers and asks, in written order. |

## Faults

The adapter declares no fault catalog. A `fault model ...` line is `FAULT_UNSUPPORTED` before the case runs. To
specify a judge that does not answer, seed no answer and predict your system's reaction.

## Errors

`ModelAdapterError { code, detail }`:

| Code | When |
| --- | --- |
| `OPTIONS_INVALID` | At creation: the options are not exactly `{ dir }` with `dir` a non-empty string. The detail names the key. |
| `NAMESPACE_INVALID` | At creation: no namespace, or one that does not match `^s[0-9a-f]{12}$`. |
| `RECORD_MALFORMED` | At a capture or a read: a complete line is not JSON, or not an object with a non-empty string `type` and an object `payload`, or its `key`, `timestamp` or `metadata` has the wrong type. The detail names the file and the line number. |

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
pnpm build --filter=@mmmnt/feat-adapter-model
pnpm --filter @mmmnt/feat-adapter-model test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
