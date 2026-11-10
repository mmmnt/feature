# DRAFT — grammar-reference change for the adapter-interface ADR (Layer 1 of 4)

Apply to `docs/grammar-reference.md` only after the founder flips the ADR and
`packages/feat-core/parse.feat` (the `fault` amendment, `drafts/adapter-interface/packages/feat-core/parse.feat`) to `agreed`. The language version stays `feat 1.0` (founder ruling 3: `fault` is reserved inside `given:`
in 1.0). Title and header bumps follow whatever lands first
(`uppercamel-rejection-id` proposes v1.2).

## 1. §5.1 `given:` — "Three line kinds" becomes "Four line kinds"; add a row; replace the `clock at` row

Add after the `seed` row:

> | `fault` (ADR-0023) | `fault <service> <Operation> <Fault> [{ <json> }] [once \| times <n> \| until reset]` | Arms a **logical fault** the product will return, as a precondition: after the seeds and the `given` executes have run, before the capture window opens, in written order. It is consumed by the system's next call of `<Operation>` on `<service>` (`once`, the default), by the next `<n>` calls (`times <n>`), or by every call until the case ends (`until reset`). `<service>` is a configured service key (INV-7). `<Operation>` is UpperCamel and `<Fault>` is UpperCamel or UPPER_SNAKE (§1.2, ADR-0022); both are the **adapter's vocabulary** (`AppendToStream` `WrongExpectedVersion`, `Produce` `NOT_LEADER_OR_FOLLOWER`), not the language's. The optional `{ … }` is literal data for the adapter (the stream, the node, the code); it takes no matchers and no `@when`. |

Replace the `clock at` row:

> | `clock at` (ADR-0012, ADR-0023) | `clock at "2026-07-16T00:00:00Z"` | Freezes scenario time: an ISO-8601 instant **with a zone designator**. The harness delivers it, on every case (a null when the case has no `clock at`), to every adapter that offers the optional `setClock` hook, after the resets and before anything runs. The **response adapter** must offer the hook or a case that uses `clock at` is a configuration error (`CLOCK_UNSUPPORTED`) — never a silent pass. v1 adapters that do: handler (it passes the clock to the handler as the third argument, `ctx.clock`). Remote protocols need their own test-time hooks. |

Add under the table, after "Fixture JSON is data":

> **Faults are preconditions, not predictions.** A fault is never asserted: the scenario predicts
> what the system *does about it* with the existing forms — a `predict rejection` (zero effects
> across every service, so a partial write the product accepted before the fault is an
> unpredicted effect and fails), a `predict error`, or a `predict success` when a retry
> recovers. One obligation is added: a fault that was armed and **not consumed** (the system
> never called `<Operation>`, or fewer than `<n>` times) fails the case, because the scenario
> did not exercise what it claims. An adapter that cannot observe consumption says so, and the
> evidence bundle records `unobserved`. A fault the service's adapter does not offer
> (`<Operation>`/`<Fault>` absent from its declared catalog, or no `fault()` at all) is a
> configuration error (`FAULT_UNSUPPORTED`) raised before the case has any effect and listing
> the catalog. Faults apply to the **system's** calls to the product; an adapter's own capture,
> `read()`, `seed()` and `settle()` are never faulted.
>
> **Transport faults** (timeout, connection reset, partition, broker loss) are named under the
> pseudo-operation `Connection`, hold `until reset` only, and exist only in integration
> bindings (§6); a spec-tier adapter does not offer them, so a scenario that uses one belongs
> to a spec file the spec tier excludes (`specs.exclude`, §6).

## 2. §5.3 `predict` table — clarify the two service forms (no grammar change)

Replace the `has` and `contains` rows:

> | `<service> has [ <record>, ... ]` | Exactly these records **captured** — the **diff** observation mode: what was written during the window (ADR-0023). |
> | `<service> contains [ <record>, ... ]` | **Resulting state** — the **state** observation mode: the adapter's `read()` answers the stored records; the predicted records must be among them (ADR-0011). Polled to convergence for eventual services; may appear alongside `has` for the same service. |

Add after "Closed key space (INV-7)":

> **Observation modes (ADR-0023)**: `has` is the *diff* mode and `contains` the *state* mode.
> Diff is not optional: INV-6 puts a `has` on every service of every prediction, so every
> adapter serves it. State is the mode an adapter may lack. An adapter declares what it serves
> (`observes`); a `contains` on a service whose adapter does not serve state is a configuration
> error (`MODE_UNSUPPORTED`) before the case has any effect. An adapter that declares nothing is
> treated as serving both (the legacy contract). An event stream (Kurrent, Kafka) serves diff
> natively and state as the stream's events; a normalized store (DynamoDB, Neo4j) serves state
> natively and diff either natively (change streams) or by comparing two snapshots, which the
> adapter says (`diff: "snapshot"`) and the evidence records, because a snapshot diff cannot
> see a write that was undone inside the window.

## 3. §6 Configuration — add the tier overlay

Add to the example block (a second file, `feat.integration.config.json`):

```json
{
  "extends": "feat.config.json",
  "environment": "integration",
  "response": { "adapter": "@mmmnt/feat-adapter-http",
                "invoke": { "baseUrl": "https://orders.integration.example" },
                "commands": { "CreateFlow": { "method": "POST", "path": "/flows" } },
                "actors": { "default": "operator", "operator": { "headers": { "authorization": "Bearer ${OPERATOR_TOKEN}" } } } },
  "services": {
    "eventStore": { "adapter": "@mmmnt/feat-adapter-kurrent", "consistency": "eventual",
                    "convergenceTimeout": 5000, "absenceTimeout": 1500,
                    "options": { "connection": "kurrentdb://kurrent:2113?tls=false" } }
  },
  "specs": { "exclude": [] }
}
```

and these bullets:

> - **Tier overlay (ADR-0024)**: optional top-level `extends` names a base config (path relative
>   to this file). The file is the base with `environment`, `response`, `services`, `specs`
>   and `report` **replaced whole, key by key** (a replaced `services.eventStore` carries none of
>   the base's options); `featVersion` and `schemas` are inherited and may not be redeclared.
>   The overlay may not add or remove a member of the three closed reference spaces the config
>   holds — service keys, command names, actor names (schema names live in each spec's contract) —
>   so a spec means the same thing in every tier; one that does is `TIER_SPACE_MISMATCH` (load time, exit 2). The base is the
>   **spec tier** (in-process, in-memory, `strong`); an overlay is the **integration tier**
>   (real products, real consistency). Specs are parsed against the base.
> - **Selecting a tier**: `feat run --config <overlay>`; the generated suites resolve the active
>   config at run time (`FEAT_CONFIG`, set by `feat run`), not from a path baked in at generate time.
> - **Excluding specs per tier**: optional `specs.exclude` (globs) removes spec files from a
>   tier's run; a spec that needs transport faults is excluded from the spec tier.
> - **Derivation is environment-agnostic**: generated suites and their `Inputs-hash` depend only
>   on the closed spaces and `featVersion`; adapters, consistency, timeouts and options never
>   enter the hash. The default `ordered`/`unordered` of a prediction and the timing envelope
>   are resolved by the harness and the runner from the **active** config.
