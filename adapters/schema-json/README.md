# @mmmnt/feat-schema-json

**The JSON Schema adapter for Feat.** It resolves the schemas a spec's contract
declares, bundles them so each one is self-contained, and validates payloads
against them with [Ajv](https://ajv.js.org/). It speaks **draft-07** and
**draft 2020-12**.

Resolution is **compile-time only**. The generator resolves every schema through
this adapter and inlines the result into the generated test. Nothing resolves at
run time, which is why the output of `resolve()` must stand alone.

```jsonc
// feat.config.json
"schemas": {
  "adapter": "@mmmnt/feat-schema-json"
}
```

Unset, `schemas.adapter` defaults to this package. Naming it keeps the config
explicit, and a project can swap in its own resolver the same way.

## Where it sits

A `.feat` spec owns behavior. Its paired `.contract.json` (same basename) owns
shapes. A spec names a schema by role (`input`, `response`, `event`, `record`,
`error`) and `with <Name>` in predictions. The names are a closed space: a name
the contract does not declare is a parse error.

```
place.feat  ──►  place.contract.json  ──►  this adapter  ──►  schemas inlined in place.test.ts
 (behavior)        (shapes, $refs)          (resolve, bundle)     (nothing resolves at run time)
```

The adapter implements the `FeatSchemaAdapter` interface of
`@mmmnt/feat-types`. The generator calls:

- `resolve()` for a contract entry that is nothing but a `$ref`;
- `resolveInline()` for an inline entry whose nested properties `$ref` another
  file or a sibling entry of the same contract;
- `validate()` to check seed records against their schema.

An inline schema with no file reference is kept verbatim: its generated output
does not change.

## Install

```sh
npm install --save-dev @mmmnt/feat-schema-json
```

Requirements: a Node version that runs ES modules and Ajv 8 (the package sets no `engines` field; the Feature repository targets Node 20).
Dependencies: `@mmmnt/feat-types`, `ajv` 8 and `ajv-formats` 3. The package ships
`dist/` only.

`@mmmnt/feature` loads the adapter from `schemas.adapter`, so a project normally
installs it and names it in the config. It has no other options.

## `feat.config.json`

`schemas` takes exactly one key:

| Key | Type | Meaning |
|---|---|---|
| `schemas.adapter` | `string` | The module specifier: an npm package name or a local path. Its module must export `createAdapter(config)`. Here: `"@mmmnt/feat-schema-json"`. |

`schemas` rejects any other key, so there is nothing to tune. (The generator also
hands `createAdapter` the `projectRoot`, the directory of `feat.config.json`; see
"A root `$id` re-bases" below.) A whole config that uses it:

```jsonc
{
  "featVersion": "1.0",
  "schemas": { "adapter": "@mmmnt/feat-schema-json" },
  "services": {
    "database": { "adapter": "@mmmnt/feat-adapter-memory", "consistency": "strong" }
  },
  "specs": {
    "dir": "features",
    "pattern": "*.feat",
    "contractPattern": "*.contract.json",
    "outputPattern": "{name}.test.ts"
  }
}
```

## Dialects

The dialect follows the document's `$schema`:

| `$schema` | Compiled as |
|---|---|
| absent | draft-07 |
| `http://json-schema.org/draft-07/schema#` | draft-07 |
| `https://json-schema.org/draft/2020-12/schema` (`http` or `https`, with or without a trailing `#` or `/`) | draft 2020-12 |
| anything else, for example 2019-09 | not compiled: `validate()` throws Ajv's `no schema with key or ref "<uri>"` |

Both compilers run with `strict: false` and `allErrors: true`, and both load
`ajv-formats` (`uuid`, `date-time`, `email` and the rest). Unknown keywords are
ignored rather than refused.

The bundle root keeps its own `$schema`, so a 2020-12 contract reaches the
generated test still declaring 2020-12. The run-time matcher in
`@mmmnt/feat-runtime` applies the same rule.

A 2020-12 keyword proves the compiler is the right one. `prefixItems` is
enforced under 2020-12 and ignored under draft-07:

```jsonc
// contracts/span.json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "array",
  "prefixItems": [{ "type": "integer" }, { "type": "integer" }],
  "items": false
}
```

`[1, 2]` is valid. `[1, 2, 3]` fails with `(root) must NOT have more than 2
items`. `[1, "x"]` fails with `/1 must be integer`.

## Bundling

A `$ref` that points at another file is meaningless once the schema is inlined
into a test in a different directory: the base URI is lost in transit. So
`resolve()` follows every reference now, against the **source file's** location,
and carries the targets with the document.

```
contracts/common/ids.json     { "$defs": { "uuid": { "type": "string", "format": "uuid" } } }
contracts/order.json          { ..., "properties": { "orderId": { "$ref": "common/ids.json#/$defs/uuid" } } }
```

`resolve("../contracts/order.json", "features/place.contract.json")` gives a
`normalized` schema in which no `$ref` leaves the document:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["orderId"],
  "additionalProperties": false,
  "properties": {
    "orderId": { "$ref": "#/$defs/ids/$defs/uuid" },
    "total": { "type": "number", "minimum": 0 }
  },
  "$defs": { "ids": { "$defs": { "uuid": { "type": "string", "format": "uuid" } } } }
}
```

The rules:

- **A reference is a relative file path, a `#/json/pointer`, or both.** Paths
  resolve against the directory of `fromPath` (the contract file) for
  `resolve()`, and against the file that holds the `$ref` for references found
  inside a bundled document.
- **Each referenced document is relocated once** into the bundle root's `$defs`
  and pointed at from every site that wanted it. The key is the file's base
  name without its extension (anything outside `A-Za-z0-9_-` becomes `_`); a
  clash gets `_2`, `_3`, and so on. Shared targets stay shared.
- **Cycles terminate.** A document is registered before its own references are
  rewritten, so `a.json` referencing `b.json` referencing `a.json` bundles to a
  `$ref` back to `#`.
- **`$defs` is the destination in every dialect**, draft-07 included. Ajv
  resolves JSON-pointer references into it. Pointers the root already owns
  (`#/$defs/...`) are left as authored, and its own `$defs` keep their place.
- **The root keeps `$id` and `$schema`.** A relocated document drops both: it is
  no longer a document in its own right, and a nested `$id` would re-base every
  pointer inside the bundle.
- **`$ref` is a reference only in a schema position.** A property literally named
  `$ref`, or an `enum` or `const` value that holds one, is data and is left alone.
- **Absolute URIs are left as authored.** A `$ref` with a scheme (`https:`,
  `urn:`) is not followed.
- **Output is deterministic.** Identical input gives byte-identical output.

### Inline schemas

An entry authored inline in the contract is its own document in the generated
test. `resolveInline(schema, fromPath)` bundles it the same way, with two
differences:

- a local pointer that resolves **inside** the schema stays as authored;
- a local pointer that does **not** names the contract document it was written
  in (`#/schemas/Kind`). That node is relocated into `$defs` under the last
  token of the pointer (`Kind`).

**A root `$id` re-bases relative file references** (draft-07 and 2020-12 alike).
Under JSON Schema's base-URI rules the `$id` is the schema's own address, and a
relative `$ref` resolves against it, not against wherever the contract file
happens to sit. A relative `$id` is a path under the **project root**, the
directory of `feat.config.json`. That is the same project-relative convention as
`error RFC7807 from "contracts/adrs/error-format"`. So this inline schema:

```jsonc
// packages/billing/features/entitlement-projection/entitlement-projection.contract.json
"AccountRegistered": {
  "$id": "contracts/identity/account-registered.json",
  "properties": { "envelope": { "$ref": "../adrs/event-envelope.json" } }
}
```

has the base `<projectRoot>/contracts/identity/account-registered.json`, and the
ref lands on `<projectRoot>/contracts/adrs/event-envelope.json`, not on
`features/adrs/...`. Only file references are re-based: a local `#/...` pointer
still means the schema itself or the contract document, as above. Left on the
contract file's directory, as before: an absolute-URI `$id` (`https:`, `urn:`)
names no file the adapter can reach, and an adapter created without a
`projectRoot` (a bare `createAdapter({})`) has nothing to anchor a relative
`$id` to. A `$ref` under a *nested* `$id` is still refused (see Errors).
`resolve()` of a bare `$ref` is unchanged; a referenced file is followed from its
own location.

```jsonc
// features/place.contract.json
{
  "$schema": "https://feat.dev/schemas/contract.json",
  "specId": "SPEC-PLC-001",
  "schemas": {
    "Order": { "$ref": "../contracts/order.json" },
    "Receipt": {
      "type": "object",
      "required": ["order", "kind"],
      "properties": {
        "order": { "$ref": "../contracts/order.json" },
        "kind": { "$ref": "#/schemas/Kind" }
      }
    },
    "Kind": { "enum": ["web", "phone"] }
  }
}
```

`Order` is a bare `$ref`, so the generator calls `resolve()`. `Receipt` has file
and sibling references, so it calls `resolveInline()`. Both come back
self-contained. `Kind` has none and is kept as written.

## API

The package's entry point exports one function.

```ts
import { createAdapter } from "@mmmnt/feat-schema-json";
import type { FeatSchemaAdapter, ResolvedSchema } from "@mmmnt/feat-types";

const adapter: FeatSchemaAdapter = createAdapter({});
```

### `createAdapter(config): FeatSchemaAdapter`

Returns the adapter. Each call builds its own Ajv instances, one per dialect.
The one `config` key it reads is `projectRoot` (an absolute path), which anchors a
relative root `$id` in `resolveInline()`. `feat generate` supplies it; every
other key is ignored.

### `adapter.resolve(ref, fromPath): Promise<ResolvedSchema>`

Resolves `ref` against `fromPath`, which is the path of the contract file, and
returns a self-contained bundle.

| `ResolvedSchema` field | Value |
|---|---|
| `id` | The absolute path of the document the bundle came from, plus `#<pointer>` when `ref` had one. |
| `format` | Always `"json-schema"`. |
| `raw` | The node the reference landed on, verbatim and unrewritten: the contract as authored. |
| `normalized` | The self-contained schema. This is what the generator inlines. |

`ref` must point at a JSON object. A plain-name fragment (`file.json#anchor`)
is not supported; only JSON-pointer fragments are.

### `adapter.resolveInline(schema, fromPath): Promise<ResolvedSchema>`

Bundles a schema authored inline in the contract at `fromPath`, re-basing
relative file references on a root `$id` (see "Inline schemas"). `id` is
`<absolute contract path>#inline`, and `raw` is the schema you passed.

### `adapter.validate(data, schema): { valid: boolean; errors?: string[] }`

Compiles `schema.normalized` with the dialect its `$schema` names and checks
`data`.

```ts
adapter.validate({ orderId: "5e2a7c90-1b3d-4e5f-8a6b-9c0d1e2f3a4b", total: 12 }, order);
// { valid: true }

adapter.validate({ orderId: "nope", extra: 1 }, order);
// { valid: false, errors: [
//     '(root) must NOT have additional properties',
//     '/orderId must match format "uuid"' ] }
```

Each error is `"<instance path> <message>"`. The instance path is a JSON
pointer into `data`, and `(root)` stands for the empty one. All errors are
reported, not just the first.

`validate` throws, rather than answering `valid: false`, when the schema itself
cannot be compiled: an unknown `$schema`, or a `$ref` that resolves to nothing.

**`validate` is idempotent.** One adapter instance serves a whole `feat generate`,
and the seed check calls it once per spec, so two specs that share
`event X from "contracts/identity/account-registered"` validate the same
`$id`-bearing schema twice. The adapter keeps the compiled validator by `$id`
and reuses it when the schema is deep-equal, so the second call neither
recompiles nor crashes. A schema without `$id` registers nothing and compiles
freely. A *different* schema that claims a `$id` the adapter already holds throws
an `Error` whose `code` is `SCHEMA_ID_CONFLICT` and whose message names the `$id`.

### A complete example

This runs against the fixture tree above (`contracts/common/ids.json`,
`contracts/order.json`, `contracts/span.json`, `features/place.contract.json`):

```ts
import path from "node:path";
import { createAdapter } from "@mmmnt/feat-schema-json";
import type { ResolvedSchema } from "@mmmnt/feat-types";

const contract = path.resolve("features/place.contract.json");
const schemas = JSON.parse((await import("node:fs")).readFileSync(contract, "utf8")).schemas;
const adapter = createAdapter({});

const order = await adapter.resolve(schemas.Order.$ref, contract);
console.log(order.id, order.format);
console.log(JSON.stringify(order.normalized));
console.log(JSON.stringify(order.raw));

const uuid = "5e2a7c90-1b3d-4e5f-8a6b-9c0d1e2f3a4b";
console.log(adapter.validate({ orderId: uuid, total: 12 }, order));
console.log(adapter.validate({ orderId: "nope", extra: 1 }, order));

const span = await adapter.resolve(schemas.Span.$ref, contract);
console.log(adapter.validate([1, 2], span), adapter.validate([1, 2, 3], span), adapter.validate([1, "x"], span));

const receipt = await adapter.resolveInline!(schemas.Receipt, contract);
console.log(receipt.id);
console.log(JSON.stringify(receipt.normalized));
console.log(adapter.validate({ order: { orderId: uuid }, kind: "web" }, receipt), adapter.validate({ order: { orderId: uuid }, kind: "fax" }, receipt));

for (const [label, fn] of [
  ["missing file", () => adapter.resolve("../contracts/none.json", contract)],
  ["bad pointer", () => adapter.resolve("../contracts/order.json#/properties/nope", contract)],
  ["plain-name fragment", () => adapter.resolve("../contracts/order.json#anchor", contract)],
] as const) { try { await fn(); } catch (e) { console.log(label, "->", (e as Error).message); } }
```

## Errors

Resolution failures are plain `Error`s whose message starts with
`Schema resolution:`. They carry no code.

| Message | Raised when |
|---|---|
| `referenced schema file '<path>' could not be read` | A `$ref` names a file that does not exist or cannot be read. |
| `'<path>' is not valid JSON: <cause>` | A referenced file is not JSON. |
| `'<ref>' (from <path>) uses a plain-name fragment; only JSON-pointer fragments are supported` | A `$ref` ends in `#name` rather than `#/pointer`. |
| `pointer '#<pointer>' does not resolve in <path>` | A JSON pointer names nothing in its file. |
| `'<ref>' (from <path>) does not point at a JSON Schema object` | The target is not an object (for example an array or a string). Also raised for a relocated file or node. |
| `'<ref>' in <path> sits under a subschema that declares its own $id, which re-bases relative references — unsupported. Give the subschema its own file.` | A relative `$ref` appears under a nested `$id`. |

`validate` throws one coded error:

| `code` | Raised when |
|---|---|
| `SCHEMA_ID_CONFLICT` | Two different schemas claim the same `$id` on one adapter instance. Give each its own `$id`, or make them identical. |

A failure stops generation, loudly. The generator never falls back to reading
the referenced file verbatim, which would put `$ref`s into the generated test
that resolve against nothing.

## This release (0.2.1, Feature v0.1.48)

Patch release, on 0.2.0.

- **draft 2020-12 validates.** `validate()` compiles a `$schema` of
  `https://json-schema.org/draft/2020-12/schema` with its own dialect instead of
  refusing it. Ajv's default compiler knew draft-07 only.
- **Inline contract schemas are bundled too.** A nested cross-file `$ref`, or a
  sibling `#/schemas/<Name>` reference, inside an inline entry now reaches the
  generated test resolved. This adds the optional `resolveInline()` to the
  `FeatSchemaAdapter` interface.

## Fixed after 0.2.1 (regression findings c1 and c2, founder ruling 2026-11-10)

- **`validate()` no longer crashes on a repeated `$id`.** It used to compile
  `normalized` on one shared Ajv, which refused the second compile with
  `schema with key or id "..." already exists`. See "`validate` is idempotent" above.

- **A root `$id` on an inline schema re-bases its relative `$ref`s.** They used
  to resolve against the contract file's directory, so a consumer's
  `"$id": "contracts/identity/account-registered.json"` with
  `{"$ref": "../adrs/event-envelope.json"}` failed with
  `referenced schema file '.../features/adrs/event-envelope.json' could not be read`.
  See "Inline schemas".

## Docs

- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md): contract roles and `.contract.json`.
- [`feat.config.schema.json`](https://github.com/mmmnt/feature/blob/main/schemas/feat.config.schema.json): the config schema.
- [`contract.schema.json`](https://github.com/mmmnt/feature/blob/main/schemas/contract.schema.json): the shape of `.contract.json`.
- [`inline.test.ts`](https://github.com/mmmnt/feature/blob/main/adapters/schema-json/inline.test.ts): the adapter's tests.
- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2.

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## License

MIT
