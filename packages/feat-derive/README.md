# @mmmnt/feat-derive

**The derivation stage of Feature: a parsed spec plus the config in, a test topology out.**
`derive(spec, config)` turns the BuiltSpec IR of one `.feat` file into a `TestTopology`: a flat
list of concrete test cases, one per plain scenario and one per row of every scenario outline.

It is pure and deterministic. It reads no file, no clock and no environment, and it draws no random
number. The same IR and the same config give the same topology, which is what lets
`feat verify` byte-compare generated tests.

## Where it sits

```
.feat source  ->  feat-core (parse)  ->  BuiltSpec IR
                                            |
                                  feat-derive (this package)
                                            |
                                       TestTopology
                                            |
                              feat-emit-ts  ->  generated vitest file
                                            |
                      feat-runtime (harness) + feat-runner (vitest)
```

Most users get this package through [`@mmmnt/feature`](https://www.npmjs.com/package/@mmmnt/feature)
and never import it. Depend on it directly when you embed the pipeline: a service, an editor
plugin or a custom generator that parses specs with `@mmmnt/feat-core` and needs the cases a spec
expands to. It does not parse and it does not write files.

## Install

```sh
npm install @mmmnt/feat-derive @mmmnt/feat-types
```

- Node 20 or later. The package is ESM only.
- The only runtime dependency is `@mmmnt/feat-types`, which holds the `BuiltSpec` and `FeatConfig`
  types `derive` takes. Install it beside this package to name those types in your own code.
- To get a `BuiltSpec` you need a parser. `@mmmnt/feat-core` is the one Feature ships.

## Use

A spec with an outline, `specs/add-item.feat`:

```feat
feat 1.0

spec SPEC-ITM-002 "Add an item"
context Catalog
aggregate Item
type command
status agreed

construct:
  handler at src/add-item.ts
  touches src/**

enforce:
  rejects ITEM_EXISTS when the item id is already present

contract:
  input AddItemInput
  event ItemEvent
  error ItemError

scenario outline "adding items":
  given:
    seed store [ ItemAdded with ItemEvent { itemId: <id> } ]
  when: AddItem { itemId: <id>, name: <name> }
  predict rejection <code>:
    response 409 ItemError { code: <code> }
    store has []
  examples:
    | id | name | code |
    | "a-1" | "Anvil" | "ITEM_EXISTS" |
    | "b-2" | "Bolt" | "ITEM_LOCKED" |
```

Parse it, then derive it:

```ts
import { readFileSync } from "node:fs";
import { contextFromConfig, parseSource } from "@mmmnt/feat-core";
import { derive } from "@mmmnt/feat-derive";
import type { BuiltSpec, FeatConfig } from "@mmmnt/feat-types";

const config = JSON.parse(readFileSync("feat.config.json", "utf8")) as FeatConfig;
const parsed = parseSource(readFileSync("specs/add-item.feat", "utf8"), contextFromConfig(config));
if (parsed.status === "ERR") throw new Error(JSON.stringify(parsed.body));

const { cases, serviceKeys } = derive(parsed.body as unknown as BuiltSpec, config);
for (const c of cases) {
  console.log(c.anchor);
  console.log("  when   ", JSON.stringify(c.when?.payload));
  console.log("  seeds  ", JSON.stringify(c.given?.seeds?.[0]));
  console.log("  reject ", c.prediction.rejectionId);
}
console.log(serviceKeys);
```

With a config whose only service is `store`, this prints:

```
SPEC-ITM-002 › "adding items" › row[1]
  when    {"itemId":"a-1","name":"Anvil"}
  seeds   {"service":"store","records":[{"type":"ItemAdded","schemaName":"ItemEvent","values":{"itemId":"a-1"}}]}
  reject  ITEM_EXISTS
SPEC-ITM-002 › "adding items" › row[2]
  when    {"itemId":"b-2","name":"Bolt"}
  seeds   {"service":"store","records":[{"type":"ItemAdded","schemaName":"ItemEvent","values":{"itemId":"b-2"}}]}
  reject  ITEM_LOCKED
[ 'store' ]
```

Each row is its own case with its own seeds, payloads and prediction. Nothing is shared between rows.

## What derive does

**Cases.** One case per scenario that is not an outline. One case per row of a scenario outline,
in row order.

| | Plain scenario | Outline row `n` (1-based) |
| --- | --- | --- |
| `anchor` | `SPEC-ID › "scenario name"` | `SPEC-ID › "scenario name" › row[n]` |
| `name` | `scenario name` | `scenario name › row[n]` |

The anchor is what every failure message in the runtime quotes, so a failure points at an exact
spec coordinate.

**Placeholder substitution.** A whole-value `<name>` in an outline takes the row's value for that
column as written, whatever its kind: string, number, boolean, null, object or array. It is
substituted in:

- the `when` payload, each `deliver` payload and each `given.executes` payload, at any depth;
- the `detail` of each `given.faults` entry;
- the value blocks of the response prediction and of every service's `has` and `contains` records,
  including nested blocks;
- a rejection id written as `<name>`;
- a `matching` regex argument written as a placeholder;
- every inline seed record in `given.seeds` (SPEC-DRV-001, below).

A `<name>` that is only part of a string, as in `"Item-<n>"`, is not a placeholder. It stays as
written, in every field. A scenario that is not an outline is never substituted: its payloads and
seeds are the parsed ones.

**Seeds in an outline (SPEC-DRV-001).** Each row's case holds its own seeds array, its own records
and its own values, so a row can never reach another row's seeds and two cases never share an array.
The seed's service, each record's `type` and its `schemaName` are copied unchanged. A fixture seed
(`seed store from "data/items.json"`) is never substituted, its path included. It is carried into
every row as written. Reading it and checking it is the generator's job (SPEC-GEN-001).

**Query specs.** For a spec of type `query`, derive writes `records: []` for every service the
config declares, whether or not the author wrote anything. This is the implicit zero side effect
of ADR-0011, and it is why a query cannot be made to expect a write. A `contains` assertion on a
query is kept, because it asserts resulting state and claims no write.

**Command specs.** For every other type derive keeps what the spec declared, per service: `records`
and `contains`, with the row substituted. A service the spec does not mention is left out of the
case. The parser already requires every configured service in a prediction.

**Ordering.** `ordering` is set on a service's assertion only when the spec wrote `has ordered` or
`has unordered`. Otherwise it is absent, and the harness picks the default from the active config
when the test runs: `unordered` for an `eventual` service, `ordered` for any other (ADR-0024). The
derived topology therefore does not depend on the config's `consistency`, and the generated test is
identical in every tier.

**Carried through.** Each case also carries `specType` (so an adapter can tell a query from a
command), `given.clock`, `given.context` and the spec's `variables` table (ADR-0017) when it has
one. The harness resolves variables once per case.

`topology.serviceKeys` is the config's service keys, sorted. Of the config, derive reads only those
keys.

## API

```ts
function derive(spec: BuiltSpec, config: FeatConfig): TestTopology;
```

| Type | Fields |
| --- | --- |
| `TestTopology` | `specId`, `specName`, `cases: TestCase[]`, `serviceKeys: string[]` |
| `TestCase` | `anchor`, `name`, `specType?`, `given?`, `when?`, `delivers?`, `prediction: ResolvedPrediction`, `variables?` |
| `ResolvedPrediction` | `type` (`"success" \| "rejection" \| "error"`), `rejectionId?`, `errorCode?`, `response?`, `services: Record<string, ResolvedServiceAssertion>` |
| `ResolvedServiceAssertion` | `ordering?`, `records?`, `contains?` |

`BuiltSpec`, `FeatConfig` and the types of `given`, `when` and the records come from
`@mmmnt/feat-types`. The topology is plain JSON: `@mmmnt/feat-emit-ts` writes it into the
generated file, and the harness in `@mmmnt/feat-runtime` receives it as `HarnessCase` values.

## Errors

`derive` has no error codes. It throws a plain `Error` in one case:

| Message | When |
| --- | --- |
| `Outline row is missing a value for placeholder '<name>'` | A placeholder in a payload, a value block, a seed, a fault detail or a regex argument names a column the row does not have. |

The parser (`@mmmnt/feat-core`) catches undeclared services, commands, schemas and actors earlier,
with codes. `feat generate` does not wrap a throw from derive, so it propagates as it is. SPEC-DRV-001
calls this refusal `DERIVE_THREW`. That is the label its test probe gives the throw, not a code on
the error.

One limit: a rejection id written as `<name>` is looked up without that check, so a name with no
column becomes the string `"undefined"` instead of throwing. A well-formed outline has a column for
every placeholder.

## What changed in 0.2.0

- **Outline seeds (SPEC-DRV-001).** A row's values are substituted into its own copy of every inline
  seed record. Before, every row received the same seeds array with its `{ "$placeholder": ... }`
  objects intact, and the adapters were seeded with those literal objects. Fixture seeds and
  scenarios that are not outlines are unchanged.
- **Ordering is no longer baked in (ADR-0024).** `ordering` appears only when the spec wrote it. The
  default comes from the active tier's config at run time.
- **Fault preconditions (ADR-0023).** `given.faults` is carried into each case, with outline values
  substituted into a fault's `detail`.

## Specs and decisions

- [SPEC-DRV-001](https://github.com/mmmnt/feature/blob/main/packages/feat-derive/derive-seeds.feat): derive substitutes each outline row into its own seeds.
- [SPEC-GEN-001](https://github.com/mmmnt/feature/blob/main/packages/feature/generate-seed-fixtures.feat): the generator checks each row's seeds after derive and inlines fixtures.
- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md): observation modes, the scenario clock and fault injection.
- [ADR-0024](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0024-tier-bindings.md): tier bindings and environment-agnostic generation.
- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md): outlines, seeds, `has` and `contains`, queries.

## License

MIT

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution specification
language. Docs: https://github.com/mmmnt/feature/wiki
