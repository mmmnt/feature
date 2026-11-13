# ADR-0025 — given steps run in written order

Status: Accepted (founder ruling cd1ed65b, 2026-11-12: "Feature: written order (Recommended)"). Built in
SPEC-CORE-001 (amended) and SPEC-RT-009 (new).

## Context

A scenario's `given:` mixes `seed` and `execute` lines freely (grammar reference §5.1), and a reader
takes them as history in the order they are written. The IR kept the two kinds in two arrays,
`given.seeds` and `given.executes`, and dropped their interleaving; the harness ran every seed, then
every execute. A given that wrote "execute EnableX, then seed XDisabled" therefore ended with the
execute's effect as the latest fact, the opposite of what it states, and no spelling of the given could
express "the command ran, then this event happened". A consumer's build found it on a gate whose latest
enablement event decides the outcome.

## Decision

1. The seed and execute lines of a given run in written order. Faults are still armed after every given
   step and before the capture window (ADR-0023), and the clock is still delivered before any of them.
2. The IR keeps `given.seeds` and `given.executes` as they are and adds `given.order`, an array of
   `"seed"` and `"execute"`, one per line in written order; the n-th `"seed"` is `seeds[n]` and the n-th
   `"execute"` is `executes[n]`. The parser writes it only when a given has both kinds: with one kind
   the array is already in written order, so the IR of every such given is unchanged.
3. Without `given.order` the harness runs every seed, then every execute. That is what an IR an earlier
   parser wrote means, so a suite generated before this change behaves as it did until it is regenerated.
4. An order that does not name each seed and each execute exactly once is a malformed IR. The harness
   refuses it before any adapter call, with an Error naming the case's anchor.
5. Anchors are unchanged (`given › seed[i]`, `given › execute[i]`), and so is `@given.response.<path>`:
   it reads the most recent execute before the line that uses it.
6. The language version stays `feat 1.0`; the Feat Host Protocol and the adapter interface are unchanged
   (the harness only calls the same `seed()` and `invoke()` in a different order).

## Consequences

- A spec whose given writes an execute before a seed changes meaning when it is regenerated: it now
  runs as written. This is the fix, and it is not additive; such a spec that passed only because seeds
  ran first fails until its prediction or its given is corrected. A given with one kind, or with every
  seed before every execute, behaves exactly as before.
- `feat verify` reports drift for a generated suite whose spec has such a given, since its cases now
  carry `given.order`: regenerating the suite is what picks the fix up.
- `schemas/builtspec.schema.json` gains `given.order`; `@mmmnt/feat-types` gains `Given.order` and
  `GivenStep`; derive copies the order into every case, an outline row's included.
- The corpus gains exemplar #16, `corpus/given-order/`.
