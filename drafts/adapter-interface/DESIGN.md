# Adapter interface v2 — design (DRAFT, nothing applied)

Inputs: founder rulings 2026-11-09 (Sift workspace 79123645, 473acc1d), the parent's audit of the
v0.1.47 tree. Everything below is verified against that tree unless marked **assumption**.
Companion files: `ADR-0023-DRAFT.md` (modes, clock, faults), `ADR-0024-DRAFT.md` (tier bindings), `grammar-reference.change.md`, `schemas.change.md`,
`parser.change.md`, `corpus/given-fault/`, and five draft specs (list at the end).

## 0. Findings that shape the design

1. **Diff is not optional in this language.** `parse.ts` raises `INCOMPLETE_PREDICTION` unless
   every configured service has `records` (`has`) in every non-query prediction, and `derive`
   synthesises `records: []` for every service of every query. So every service adapter must
   serve the diff mode. "Support both" therefore means: always diff (native, or by comparing
   two snapshots), state (`read`) as the mode an adapter may or may not have. A normalized store
   (DynamoDB, Neo4j, KMS) offers diff natively (change streams) or as a snapshot diff; an event
   stream (Kurrent, Kafka) offers diff natively and state as its events.
2. **The derivation hash is not environment-agnostic today**, contrary to the docs. `pipeline.ts`
   hashes `config.services` and `config.response` whole; `derive` bakes the default
   `ordered`/`unordered` from `consistency`; `emit` bakes `CONVERGENCE_WINDOW_MS` and the invoke
   allowance from the config; the generated file embeds one `CONFIG_PATH`. Two tiers with
   different `services` give two different generated files. (`feat run` regenerates every run, so
   this only bites `feat verify` and committed generated files, which Feature itself commits.)
3. **A `fault` line parses today, silently, as freeform context** (§d). Exit 0, wrong IR. The
   exemplar does not "fail the parser"; it fails the corpus comparison. Reserving the word is
   part of the change.
4. `contains` calls `read({})` with an empty query, so a keyed store cannot narrow its read.
5. `awaitConvergence` waits the whole `convergenceTimeout` for any `contains` (state is never
   polled to a match). Fine for correctness; expensive at the integration tier (see Q4).

## a. Observation modes

**Recommendation: no grammar change.** `has [...]` already means "captured effects" (diff,
`stopCapture`) and `contains [...]` "resulting state" (`read`). What is missing is a declaration,
a check, and a query hint. All additive and optional.

```ts
// feat-types — every addition optional, so every existing adapter still compiles and runs
export type DiffMode = "native" | "snapshot";
export interface ObservationSupport {
  diff: DiffMode;      // "native": the product reports writes (stream, change feed, event feed).
                       // "snapshot": two reads compared; cannot see a write undone inside the window.
  state: boolean;      // read() answers the stored records (serves `contains`)
}
export interface ReadQuery {          // read(query) — the parameter already exists; today always {}
  expect?: { type: string; key?: Record<string, string | number | boolean | null> }[];
}
interface FeatServiceAdapter {
  readonly observes?: ObservationSupport;     // set at construction (may depend on options)
  read(query: ReadQuery): Promise<unknown | null>;
  /* startCapture / stopCapture / peekCapture / settle / seed / deliver: unchanged */
}
```

- **How a prediction chooses.** `has` = diff, `contains` = state; unchanged. A service may carry
  both (already allowed). Query specs keep the synthesised `has []`.
- **Query hint.** For a `contains`, the harness calls `read({ expect })`: one entry per predicted
  record, `type` plus, as `key`, the record's top-level value-block fields whose matcher is a
  literal (a `@when.x` is resolved to the value sent). It is a hint: the adapter may use it to
  `GetItem`, `MATCH (n:Order {orderId: $id})`, or filter a stream, and may return a superset,
  never fewer; `diffContains` is unchanged. An adapter that ignores it (every adapter today) is
  correct. This is how DynamoDB/Neo4j avoid scanning without any grammar.
- **What an adapter declares.** `observes`. An adapter with no declaration is treated as
  `{ diff: "native", state: true }`: nothing that runs today changes. The five shipped adapters
  get declarations when the draft specs build: memory `{native, true}`, stripe `{native, true}`,
  dynamodb `{native, true}` (`snapshot` if no stream is configured), fs `{snapshot, false}`
  (its `read()` returns null today), http/playwright/handler are response adapters.
- **When a spec asks for a mode the adapter lacks.** The only lackable mode is state. The harness
  checks before the case does anything (before the first reset): `contains` on a service whose
  adapter declares `state: false` throws `HarnessConfigurationError` code `MODE_UNSUPPORTED`
  (service, mode) — a failed test whose message begins "Configuration error (exit 2):", with no
  seed, execute or invoke having run. Today the same mistake surfaces as a late violation after
  the whole case ran (`read() did not return a record array`). Spec: SPEC-RT-002.
  Whether to also catch it at `feat audit` time (earlier still, but audit would have to import
  adapters) is Q3.
- **Evidence.** Per service the bundle records `observes` (§b), so a reader can tell a native
  absence proof from a snapshot one.

For the product-adapter specs: Kurrent and Kafka: `observes {native, true}`, `read` returns the
stream/topic events (state of an event stream is its events; `contains` there asserts "these events
exist", which is what memory already does). DynamoDB: `{native|snapshot, true}` with `read(expect)`
keyed. Neo4j, KMS: `state` native, `diff` snapshot unless the product offers a change feed
(**assumption**: neither is verified here).

## b. Per-tier service bindings

**Recommendation: a per-environment overlay file with `extends`, plus an environment-agnostic
derivation slice.** ADR-0016 already says per-environment config files are the intended pattern;
this adds the one thing separate standalone files lack, structural parity.

```
feat.config.json               environment "spec"         base: in-process, in-memory, strong
feat.integration.config.json   environment "integration"  { "extends": "feat.config.json", response, services, specs.exclude }
```

- **Merge.** The overlay replaces `environment`, `response`, `services.<key>`, `specs`, `report`
  whole, key by key (no deep merge: a Kurrent `options` must not inherit memory's). `featVersion`
  and `schemas` are inherited.
- **Parity (load time, exit 2).** The overlay may not add or remove a service key, command name
  or actor name: `TIER_SPACE_MISMATCH`. That is what makes "the same specs" true; separate
  standalone files can drift and nothing would notice (a spec valid in one is
  `UNKNOWN_SERVICE_KEY` in the other). Specs are parsed against the base.
- **Selecting.** `feat run --config feat.integration.config.json`. The generated suite resolves the
  config at run time: `process.env.FEAT_CONFIG ?? CONFIG_PATH` (set by `feat run`).
- **Excluding.** `specs.exclude` (globs). A spec that needs transport faults is excluded from the
  spec tier (§d). Without it the same-spec rule cannot hold for those specs.
- **Derivation hashes.** Change the `configSlice` in `pipeline.ts` from `{featVersion, response
  (adapter, commands, actors, invoke), services}` to `{featVersion, commands: names, actors:
  names, services: keys}`, and move the two things that read config out of generation:
  (1) the default ordering: `derive` stops filling `ordering` (the field is present only when the
  spec wrote `ordered`/`unordered`); the harness resolves a missing one from the **active**
  config's `consistency`; (2) the timing envelope: `emit` stops baking
  `CONVERGENCE_WINDOW_MS`/`INVOKE_ALLOWANCE_MS`; `feat run` hands the runner `testTimeout` and
  `hookTimeout` computed from the active config (Q2). After this, a generated file and its
  `Inputs-hash` are byte-identical across tiers, and changing a timeout or an adapter no longer
  regenerates anything. One-time cost: every committed generated file's header hash changes.
- **Evidence bundle.** Today: `project.environment` and a digest of `feat.config.json`. Add, in the
  next additive revision: `project.config` `{ base: {path, digest}, overlay: {path, digest}|null,
  resolved: digest }` and `project.bindings`: `response: {adapter, version}` and per service
  `{ key, adapter, version, consistency, convergenceTimeout, absenceTimeout, observes,
  faults: "observed"|"unobserved"|"none" }`. A reader of an `integration` bundle sees Kurrent
  at `eventual`, a snapshot-diff service flagged as such, and that a spec-tier bundle ran
  memory. `environment` stays the label; recommended names `spec` and `integration`; `local`
  keeps its "no evidence" rule.
- **Zero-change fallback** (if the founder wants nothing built yet): two standalone config files
  already work today with `feat run -c`, because `feat run` regenerates from the config it is given.
  Cost: drift is unchecked and the hash differs per tier.

## c. Clock hook

```ts
interface FeatResponseAdapter { setClock?(clock: string | null): Promise<void>; /* … */ }
interface FeatServiceAdapter  { setClock?(clock: string | null): Promise<void>; /* … */ }
export interface FeatClock { now(): number; iso(): string; frozen: boolean }
export interface FeatInvokeContext { clock: FeatClock }     // handler's third argument
```

- **When.** Every case, after the services are reset and before seeds/executes: the response adapter
  first, then each service in config order, `setClock(case.given.clock ?? null)`. A null on a case
  without `clock at` is what stops case 1's freeze reaching case 2 (response adapters have no
  `reset()`, so `setClock` is also their reset for time). The harness's own `variables` already
  use the same clock (`resolveVariables`), so `now()` in a spec and in the handler agree.
- **Who must offer it.** A case with `clock at` against a response adapter without `setClock` is
  `CLOCK_UNSUPPORTED` before any effect (the grammar's "v1: handler only" becomes enforced). A
  service adapter without it is simply not called. Format: ISO-8601 with a zone designator; an
  adapter refuses anything else (`INVALID_CLOCK`) rather than reading NaN.
- **Handler.** `handler(input, actorContext, { clock })`. Third argument, never a patched global
  `Date` (a leaking test double). Frozen `now()` is constant for the whole case; unfrozen it is
  `Date.now()`, so a handler can use `ctx.clock` unconditionally. Two-argument handlers are unaffected.
- **HTTP/Playwright** have no in-process reach; they stay without the hook, so `clock at` against
  them is `CLOCK_UNSUPPORTED` — a spec-tier feature. Open (Q5): an http `clockHeader` option that
  forwards the clock to systems with a test-time hook.
- Specs: SPEC-ADPHND-001 (the adapter), SPEC-RT-002 (delivery + refusal).

## d. Fault injection

### Grammar (inside `given:`)

```
fault <service> <Operation> <Fault> [{ json }] [once | times <n> | until reset]
```

`given fault …` in the ruling is this line in a `given:` block (house style: given items are
lines of the block, like `seed` and `clock at`). Service is a configured key (closed space).
`<Operation>` UpperCamel; `<Fault>` UpperCamel or UPPER_SNAKE (ADR-0022 token classes); both are
the adapter's vocabulary. Default `once`. Four layers:

| Layer | Draft |
| --- | --- |
| 1 grammar reference | `grammar-reference.change.md` §1 (new `given` row, the `clock at` row, the "faults are preconditions" paragraph) |
| 2 corpus exemplar | `corpus/given-fault/` — `.feat`, `.contract.json`, `feat.config.json`, hand-staged `.ir.json` (3 scenarios: once / `times 1` with detail / `until reset`) |
| 3 parser | `parser.change.md` — `parse.ts` given-phase branch (~636), closed-space `serviceRefs` (~757), derive `substituteGiven`, tmLanguage ×3 |
| 4 IR schema | `schemas.change.md` — `given.faults`, `definitions.fault`, `Fault` type |

### Adapter interface

```ts
export type FaultCatalog = Record<string, readonly string[]>;   // operation -> fault names it offers
export interface FaultArm { operation: string; fault: string; detail?: Record<string, unknown>; times: number | "reset" }
export interface FaultFiring { operation: string; fault: string; count: number }
interface FeatServiceAdapter {
  readonly faults?: FaultCatalog;                    // what this binding can inject
  fault?(arm: FaultArm): Promise<void>;              // arm; reset() MUST disarm everything
  firedFaults?(): Promise<FaultFiring[]>;            // optional: how often each armed fault was consumed
}
```

### Semantics

- **Order of a case.** preflight → reset → setClock → seeds → given executes → **arm faults (written
  order)** → startCapture → trigger → convergence → stopCapture → `firedFaults()` → diff. Arming after
  the executes means the setup commands never consume the fault; arming before the window means
  arming itself is never a captured effect.
- **Consumption.** `once` (default): the system's next call of `<Operation>` on `<service>` gets the
  fault; `times n`: the next n calls; `until reset`: every call until the next reset. The adapter's
  own `seed`, capture, `read` and `settle` are never faulted (they are the instrument).
- **Preflight.** `FAULT_UNSUPPORTED` (configuration error, before any effect, message lists the
  catalog) when the adapter lacks `fault()` or does not list the operation/fault.
- **What a scenario predicts.** The fault is not asserted; the reaction is, with existing forms:
  `predict rejection X` (zero effects on every service, so a half-write the product accepted
  before the fault fails as an unpredicted effect: this is what finds missing atomicity),
  `predict error`, or `predict success` when a retry recovers. New obligation: an armed fault that
  was not consumed (fewer firings than `times`, none for `until reset`) is a prediction violation
  `FAULT_NOT_CONSUMED`. An adapter without `firedFaults` is exempt and the evidence says
  `unobserved`.
- **Logical faults, both tiers.** Spec tier: the in-process host's fake of the product interprets the
  arm (it owns the call path). Integration tier: the product adapter makes the product return it
  natively where the product allows (**assumptions to verify per product**: Kurrent
  `WrongExpectedVersion` by an interleaved append from the adapter's own client; `AccessDenied`
  by a stream ACL; Kafka not-leader and DynamoDB throttling probably cannot be forced natively and
  need the proxy or are omitted from that binding's catalog). A fault a binding cannot produce is
  absent from its catalog, so it is `FAULT_UNSUPPORTED`, never faked.
- **Transport faults, integration only.** Catalog pseudo-operation `Connection`; faults `Timeout`,
  `ConnectionReset`, `Partition`, `BrokerLoss`; always `until reset` (a proxy cannot tell which
  operation a byte belongs to; `once`/`times` with `Connection` is `FAULT_UNSUPPORTED`).
  **Owner: the product adapter, through one shared library, not a new adapter.** A fault-proxy
  library (`@mmmnt/feat-fault-proxy`) wraps Toxiproxy's HTTP API (existing piece; the
  `toxiproxy-node-client` package) and, for broker loss, container control (pause/stop via the
  container runtime). Service config `options.proxy: { api, name }`; the system under test is
  pointed at the proxy's listen address in the integration environment, the adapter's own client at
  the product directly, so observation is never faulted. `reset()` removes every toxic and
  re-enables the proxy; a conformance check of that belongs in the adapter kit. Rejected: a
  `faultProxy` service of its own (it has no state to capture and `INCOMPLETE_PREDICTION` would force a
  `has []` on it).
- **Same spec at both tiers.** A scenario that uses a logical fault runs at both tiers if both
  catalogs offer it. A scenario that uses `Connection` is spec-tier-excluded via `specs.exclude`
  (e.g. `**/*.transport.feat`).

### Specs for the fault change (second round)

SPEC-CORE-001 amended (`packages/feat-core/parse.feat`, full copy, plus fixtures), SPEC-RT-003
(`harness-faults.feat`). Still not drafted: the `feat-adapter-kit` conformance additions for
`fault`/`setClock`/`observes` (reset disarms is asserted there, not in the harness).

## e. Draft specs (all `status draft`)

| Spec | File | Scenarios | Notes |
| --- | --- | --- | --- |
| SPEC-ADPMEM-001 | `adapters/memory/observe.feat` | 9 | peek non-destructive; settle true after yielding, false without a window |
| SPEC-ADPFS-001 | `adapters/fs/observe.feat` | 7 | peek yes; **settle false always** (mtime detection cannot prove visibility) |
| SPEC-ADPSTR-001 | `adapters/stripe/observe.feat` | 8 | peek yes; **settle false always** (no ordering/fence in the Events API) |
| SPEC-ADPHND-001 | `adapters/handler/clock.feat` | 8 (one outline, 4 rows) | `setClock`, third argument, `INVALID_CLOCK` |
| SPEC-RT-002 | `packages/feat-runtime/harness-observation.feat` | 9 | clock delivery order/null, `CLOCK_UNSUPPORTED`, `MODE_UNSUPPORTED`, legacy adapters, read hint |
| SPEC-RT-003 | `packages/feat-runtime/harness-faults.feat` | 15 | arming order, once / times n / until reset, written order + detail, reset disarms, `FAULT_NOT_CONSUMED` (3 ways), unobserved exempt, `FAULT_UNSUPPORTED` (4 ways, before any effect) |
| SPEC-CORE-001 (amended) | `packages/feat-core/parse.feat` (+ `parse.composed.feat`, fixtures) | 15 (outline: 13 existing + 7 new rows = 20; composed copy: 16 scenarios, 23 rows) | exemplar, freeform `faults`/`faultline`, 6 MALFORMED_SYNTAX rows, 1 UNKNOWN_SERVICE_KEY row |
| SPEC-RT-004 | `packages/feat-runtime/load-config-extends.feat` | 14 (two outlines: 2 + 6 rows) | overlay merge, inheritance, `EXTENDS_NOT_FOUND`, `EXTENDS_CHAIN`, `TIER_SPACE_MISMATCH` (6 rows) |

Each is driven by a probe in its package's `fixtures/` (part of the build, inside `touches`, not
shipped). Root `feat.config.json` needs (parent's edit): `specs.dir` widened to also cover
`adapters` (it is `packages` today, so `adapters/**` specs are not discovered), the five commands in
`drafts/adapter-interface/feat.config.json`, and for SPEC-RT-002 the fixture configs it names.

Pointers for the product-adapter specs (**assumptions**, verify against each product): Kurrent's
`$all` is totally ordered by commit position, so a sentinel append to a fence stream followed by
reading `$all` until it appears is a truthful `settle`; Kafka can fence per partition by fetching end
offsets after the stimulus returns and consuming to them (read_committed); DynamoDB already has the
stream sentinel (ADR-0021).

## f. Composing the two SPEC-CORE-001 amendments

`drafts/uppercamel-rejection-id/packages/feat-core/parse.feat` (ADR-0022) and
`drafts/adapter-interface/packages/feat-core/parse.feat` (ADR-0023) are both full copies of the
verified spec with status draft, so promoting one by replacement would drop the other. They touch
disjoint text: UpperCamel adds one construct paragraph, one exemplar scenario and three rows;
`fault` edits the MALFORMED_SYNTAX and UNKNOWN_SERVICE_KEY enforce lines, adds one construct
paragraph, two scenarios and seven rows. The only shared location is the end of the rejection
outline's examples table (both append). `parse.composed.feat` in this directory is the result of
applying both to the verified original (UpperCamel rows first); it parses with the current toolchain.
Order of promotion: whichever is flipped first replaces `parse.feat`; the second is then re-based by
promoting `parse.composed.feat` instead (or, if the second one is promoted alone, re-running the
mechanical merge). Fixtures live in different files (`fixtures/bad/rejection-id-*.feat`,
`fixtures/bad/fault-*.feat`, `fixtures/ok/fault-prefix-word.*`), so they never conflict. Parser side the
edits are also disjoint: ADR-0022 changes the `predict` regex (~line 614) and the rejects keyword;
ADR-0023 adds a branch in the given phase (~line 636) and a `serviceRefs` line (~757).
