# ADR-0028 — The model adapter: a recorded judge in one JSON Lines file per namespace

Status: Accepted (founder ruling 95a72156, 2026-11-14: "Judgment-port adapter (Recommended)"). Built in
SPEC-ADPMODEL-001 (new), package `@mmmnt/feat-adapter-model`.

## Context

A consumer's judgment port asks a language model to decide something (Sift: extract the constructs of an
entry, place a candidate, judge whether two definitions mean the same). A spec cannot predict a real model's
answer, and a test must never call one: the answer would change between runs, cost money and need a key.
The consumer's ADRs already name the instrument: a **recorded judge** (Sift SIFT-ADR-077, Enforcement: "a
recorded judge keyed by the hash of a chunk's inputs"). The spec seeds the answers the judge gives and
predicts the asks the system makes.

Sift's specs use the service key `model` for this port, with a closed set of record types in their
contracts: the answers seeded (`judgment.answer`, `judgment.answered`, `CoherenceVerdict`,
`RecordLagJudgment`, `MeaningAnswer`) and the asks predicted (`judgment.ask`, `judgment.requested`,
`MeaningJudgmentAsked`). Today a spec host serves the port in memory. To serve it from Feature at both tiers,
the system under test, which runs in another process and in any language, must reach the adapter's records,
and nothing may go over a network.

## Decision

1. **One file per namespace.** The adapter keeps the port's records in `<dir>/<namespace>.jsonl`, where
   `dir` is the one option (a path, relative to the project root, the directory holding the config) and the
   namespace is the runner's (SPEC-RT-006). The file is created empty at `setup()`, emptied by `reset()` and
   removed by `teardown()`. The adapter needs a namespace: without one it refuses at creation with
   `NAMESPACE_INVALID`.
2. **A record is one line.** Each line is a JSON object `{ "type": <non-empty string>, "payload": <object> }`
   with optional `key` (string), `timestamp` (number) and `metadata` (object), the Feat Host Protocol's
   CapturedRecord, ending in LF. A last line without its LF is a write in progress and is not yet a record.
   A line that is not such an object is `RECORD_MALFORMED`, naming the file and the line number.
3. **Seeds are lines the adapter writes; asks are lines the system writes.** `seed()` appends
   `{ "type", "payload" }` per record, so the system finds a recorded answer by reading the file. The system
   appends its asks to the same file. Matching an ask to its answer is the system's (its port's) job: the
   adapter carries no matcher semantics, so any payload shape passes through unchanged.
4. **Observation.** `observes = { diff: "native", state: true }`. The capture window is the lines appended
   after `startCapture()`; `peekCapture()` reads the same without closing it. `read()` is every record in the
   file, seeds included. A record without `key` is keyed by its line number, one without `timestamp` is
   stamped with it.
5. **Settle is truthful.** Every capture reads the file at the moment it is called, so whatever the system
   has written (its line complete) before `settle()` is visible to `stopCapture()`. `settle()` resolves true
   with a window open and false without one.
6. **No network, no model, no faults.** The adapter imports nothing but Node's file system and path modules
   and `@mmmnt/feat-types`; it opens no socket and calls no model. It declares no fault catalog, so a `fault
   model ...` line is `FAULT_UNSUPPORTED` before any effect (ADR-0023).

## Consequences

- A consumer adopts it at both tiers with a config change only: its specs' seeds and predictions are records
  of the types they already name. The system's port (in Sift, the spec host's `model` port backing) reads and
  appends `<dir>/<namespace>.jsonl`; the namespace reaches it as every namespace does.
- The judge is exactly what the spec seeds: an ask with no recorded answer is the system's to refuse, and an
  ask the spec did not predict fails the case by prediction inversion.
- A system that buffers its writes past its reply is outside the fence (ADR-0021), as for every adapter.

## Rejected alternatives

- **A loopback HTTP endpoint that answers asks.** A network listener for a test double, and the adapter
  would have to match asks to answers, moving the consumer's key derivation (the hash of a chunk's inputs)
  into Feature.
- **A directory of one file per record.** Ordering would rest on file names or mtimes; one append-only file
  keeps written order for free.
- **A closed record vocabulary in the adapter.** Feature's adapters are product-neutral; the vocabulary lives
  in the consumer's contracts, which already validate every seed and prediction.
- **Reading the Moment model from disk.** Not what the consumer's `model` service is: no spec seeds or
  predicts `.moment` content through it (founder ruling 95a72156).
