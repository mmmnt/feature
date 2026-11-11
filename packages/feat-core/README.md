# @mmmnt/feat-core

**The `.feat` parser: source text in, BuiltSpec intermediate representation
out.** It is deterministic (the same spec and config give the same IR on every
call) and it enforces the language's closed reference spaces at parse time, so
a spec that names a service, command, actor or schema that does not exist is a
parse error and never a silent pass.

If you only write `.feat` specs, you do not need this package: `feat parse` in
[`@mmmnt/feature`](https://www.npmjs.com/package/@mmmnt/feature) is the same
parser on the command line. Use this package when you embed the parser in a
service, an editor, a linter or a code generator.

## Where it sits

```
.feat source ──► feat-core (parse) ──► BuiltSpec ──► feat-derive ──► feat-emit-ts ──► test file
                       ▲                    │
              closed reference spaces       └──► feat-analyze (lint, audit, fmt)
              from feat.config.json
```

`@mmmnt/feat-core` is a hand-rolled recursive-descent parser. It depends on
[`@mmmnt/feat-types`](https://www.npmjs.com/package/@mmmnt/feat-types) for the
`BuiltSpec` type and on `@mmmnt/feat-runtime` for `loadConfig`, so a tier overlay
is resolved the same way here as in the CLI.

## Install

```sh
npm install @mmmnt/feat-core
```

Requirements:

- Node 20 or later (the repository's `engines` field).
- The package is ESM only (`"type": "module"`). It has no peer dependencies; its
  two `@mmmnt` dependencies install with it.

## Usage

### Parse a file

```ts
import { parse } from "@mmmnt/feat-core";

const result = await parse({ spec: "specs/create-user.feat", config: "feat.config.json" });

if (result.status === "OK") {
  const spec = result.body;          // a BuiltSpec
  console.log(spec.identity);
} else {
  const { code, message, line, hint } = result.body;
  console.error(`[${code}] line ${line ?? "?"}: ${message}`, hint ?? "");
}
```

Both paths resolve against `process.cwd()`. The config is read through
`loadConfig`, so a config with `extends` is merged first, and the closed spaces
are the merged ones (see [Tier overlays](#tier-overlays)).

### Parse text you already hold

`parseSource` does no I/O. Give it the source and the three closed spaces:

```ts
import { parseSource } from "@mmmnt/feat-core";

const result = parseSource(source, {
  serviceKeys: ["database", "events"],
  commands: ["CreateUser"],
  actors: ["admin"],
});
```

`contextFromConfig` builds that context from a parsed `feat.config.json`, with
exactly the rules `parse` uses:

```ts
import { contextFromConfig, parseSource } from "@mmmnt/feat-core";

const ctx = contextFromConfig({
  services: { database: {}, events: {} },
  response: { commands: { CreateUser: {} }, actors: { default: "admin", admin: {} } },
});
// { serviceKeys: ["database", "events"], commands: ["CreateUser"], actors: ["admin"] }
```

The actor `default` names the default actor and is not a member of the actor
space. `anonymous` is reserved and never declared.

## API

| Export | Signature | Notes |
| --- | --- | --- |
| `parse` | `(input: ParseInput) => Promise<CapturedResponse>` | Reads the spec file and the config, then calls `parseSource`. |
| `parseSource` | `(source: string, ctx: ConfigContext) => CapturedResponse` | Synchronous, no filesystem. |
| `contextFromConfig` | `(configDoc) => ConfigContext` | Takes `{ services?, response?: { commands?, actors? } }`. |
| `ParseInput` | `{ spec: string; config: string }` | Paths, relative to `process.cwd()` or absolute. |
| `ConfigContext` | `{ serviceKeys: string[]; commands: string[]; actors: string[] }` | The closed spaces. |
| `CapturedResponse` | `{ status: "OK" \| "ERR"; body: Record<string, unknown> }` | `body` is the `BuiltSpec` on `OK`, the error on `ERR`. |

On `OK`, `body` is a `BuiltSpec` (cast it:
`result.body as unknown as BuiltSpec`, with the type from
`@mmmnt/feat-types`). It holds `featVersion`, `identity`, `construct`,
`enforce`, `contract`, `scenarios`, and `variables` when the spec declares a
`variables:` block. It carries **no source locations**: location data serves
language-server surfaces only, and leaving it out is what keeps the IR
byte-comparable.

A trimmed example, for the first scenario of the spec in the
[root README](https://github.com/mmmnt/feature#readme):

```json
{
  "name": "successful user creation",
  "when": { "command": "CreateUser", "payload": { "email": "alice@example.com", "name": "Alice" } },
  "prediction": {
    "type": "success",
    "response": {
      "status": 201,
      "schemaName": "UserResponse",
      "valueBlock": {
        "id": { "matcher": "any", "ofType": "uuid" },
        "email": { "matcher": "whenRef", "path": "email" }
      }
    },
    "services": {
      "database": {
        "records": [
          { "type": "INSERT", "schemaName": "UserRow",
            "valueBlock": { "email": { "matcher": "whenRef", "path": "email" } } }
        ]
      }
    }
  }
}
```

## The closed reference spaces

Inside a compiler-zone block every bare word is a keyword or a name validated
against one of these spaces. Nothing is prose.

| Space | Where the names come from | Checked in |
| --- | --- | --- |
| services | the keys of `services` in `feat.config.json` | every `<service> has [...]` or `contains`, every `seed <service>`, every `deliver ... to <service>`, every `fault <service> ...`, and every `@<service>[i].<path>` capture reference |
| commands | the keys of `response.commands` | every `when:` and `execute` |
| actors | the keys of `response.actors`, minus `default` (`anonymous` is always accepted) | every `as <actor>` clause |
| schemas | the spec's own `contract:` block | every `response ... <Schema>`, every `<Type> with <Schema>` in a prediction or a seed |
| variables | the spec's own `variables:` block | every `${name}` reference |

A prediction that is not on a `query` spec must give a `has` for **every**
configured service. `has []` is the explicit zero-assertion, and a service named
only under `contains` still counts as omitted.

## Error codes

A failure is a returned `{ status: "ERR", body }`, never a throw. `body` is
`{ code, message, line?, hint? }`. `line` is 1-based and is present only on the first three
rows below, the errors the scanner can place. The semantic checks run after the
whole file has been read and carry no line; most carry a `hint` that lists the
valid names.

| Code | When | `line` | `hint` |
| --- | --- | --- | --- |
| `MISSING_PRAGMA` | the first non-comment line is not `feat <major>.<minor>` | yes | "Add 'feat 1.0' as the first line." |
| `UNSUPPORTED_VERSION` | the pragma's major is not 1 | yes | no |
| `MALFORMED_SYNTAX` | a compiler-zone block breaks the grammar: an unknown spec type, status or contract role; a malformed value, payload or record list; an unknown prediction form; a scenario with no trigger; a `predict rejection` id that is neither `UPPER_SNAKE` nor `UpperCamel`; a malformed `fault` line; an unknown variable function or type; a duplicate variable or a cycle | usually | usually lists the valid forms |
| `UNKNOWN_SERVICE_KEY` | a prediction, a delivery, a `fault` line or a capture reference names a service absent from `services` | no | the configured services |
| `UNKNOWN_COMMAND` | a `when:` or `execute` names a command absent from `response.commands` | no | the configured commands |
| `UNKNOWN_ACTOR` | an `as <actor>` clause names an actor absent from `response.actors` | no | the configured actors |
| `UNDECLARED_SCHEMA` | a scenario references a schema that `contract:` does not declare | no | the declared schemas |
| `DUPLICATE_SCENARIO_NAME` | two scenarios in one spec share a name (names are failure anchors) | no | yes |
| `TRIGGER_MISMATCH` | `when:` on a `projection`, `policy` or `saga`, or `deliver` on any other type | no | no |
| `QUERY_SIDE_EFFECT` | a `query` spec predicts a non-empty `has` on a service | no | no |
| `INCOMPLETE_PREDICTION` | a prediction on a non-`query` spec has no `has` for a configured service | no | yes |
| `MISSING_MINIMUM` | the spec lacks a complete header, one construct directive, one enforce directive, one contract entry or one scenario | no | yes |
| `UNKNOWN_VARIABLE` | a `${name}` reference, in a scenario or in another variable, names a variable that `variables:` does not declare | no | the declared variables |

That is thirteen codes. The agent-zone blocks (`construct:` and `enforce:`) are
freeform: a keyword line becomes a typed node, any other line is kept verbatim
as a directive, and a parse error inside them is not possible.

Config problems are **not** returned as `ERR`. `parse` throws
`Error("Configuration error [CODE] message")` when `loadConfig` refuses the
config (`CONFIG_NOT_FOUND`, `INVALID_CONFIG`, `MISSING_CONVERGENCE_TIMEOUT`,
`EXTENDS_NOT_FOUND`, `EXTENDS_CHAIN`, `TIER_SPACE_MISMATCH`), and the file read
throws (`ENOENT`) if the spec is missing. `parseSource` takes no config and never
throws for these.

A short tour of what each rejection looks like:

```
feat 1.0                                  → MISSING_PRAGMA (it must come first)
  predict rejection duplicateEmail:       → MALFORMED_SYNTAX, line 31, hint names both valid forms
  database has [...]  with no `events`    → INCOMPLETE_PREDICTION, hint: "'has []' is the explicit zero-assertion"
  when: DeleteUser { ... }                → UNKNOWN_COMMAND, hint: "Configured commands: CreateUser"
```

## Language details this version parses

The full reference is the
[grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md).
Three things changed in this release and are worth knowing when you embed the
parser.

**Rejection ids (ADR-0022).** The id in `rejects <ID> when ...` and in
`predict rejection <ID>:` is either `UPPER_SNAKE` (`[A-Z0-9_]+`) or `UpperCamel`
(`[A-Z][A-Za-z0-9]*`). The two forms can mix in one spec. An id is kept verbatim
in the IR and compared case-sensitively and exactly: `NotOperator` and
`NOT_OPERATOR` are different ids. Anything else in that position of a
`predict rejection` line (`notOperator`, `Not_Operator`, `not-operator`) is
`MALFORMED_SYNTAX`, and the hint names both valid forms.

**Fault lines (ADR-0023).** Inside a scenario's `given:` block, `fault` is a
reserved first word. A line that is exactly `fault`, or starts with `fault`
followed by a space or tab, is a fault line and is never freeform context:

```
given:
  fault database Put TIMEOUT { "ms": 5 } times 2
  fault broker Connection Partition until reset
```

The form is `fault <service> <Operation> <Fault> [{ json }] [once | times <n> | until reset]`.
`<Operation>` is `UpperCamel`, `<Fault>` is `UpperCamel` or `UPPER_SNAKE`, and
`<n>` is a positive integer. A well-formed line lands, in written order, in the
scenario's `given.faults` as `{ service, operation, fault, detail?, times }`.
`times` is always present: `1` for `once` and for the default, `n`, or `"reset"`:

```json
[
  { "service": "database", "operation": "Put", "fault": "TIMEOUT", "detail": { "ms": 5 }, "times": 2 },
  { "service": "broker", "operation": "Connection", "fault": "Partition", "times": "reset" }
]
```

Anything else that begins with the reserved word is `MALFORMED_SYNTAX`. A word
that only begins with the same letters (`faults`, `faultline`) is not reserved
and stays freeform. The fault's service joins the closed service space, so an
unknown one is `UNKNOWN_SERVICE_KEY`.

**Tier overlays (ADR-0024).** `parse` reads the config through `loadConfig`.

### Tier overlays

A config can be a per-environment overlay: a file with a top-level `extends`
naming a base config. The overlay may not add or remove a service key, a
command name or an actor name, and `loadConfig` refuses one that does. Specs are
parsed against the **base**'s spaces, and since the spaces are equal by
construction, `parse` gives the same IR whichever tier's config you hand it.

## Determinism and the conformance suite

The parser holds no state between calls and reads no clock or randomness: the
same source and the same closed spaces give the same IR, key for key.

Its conformance suite is the repository's
[`corpus/`](https://github.com/mmmnt/feature/tree/main/corpus): fifteen
exemplars, each a `.feat` file paired with its expected `.ir.json`, plus the
bad-input vectors in
[`packages/feat-core/fixtures/bad`](https://github.com/mmmnt/feature/tree/main/packages/feat-core/fixtures/bad).
The corpus grows with every language change. The parser's own contract is itself
a spec,
[SPEC-CORE-001](https://github.com/mmmnt/feature/blob/main/packages/feat-core/parse.feat),
with one scenario per exemplar.

### Notes on indentation

The parser measures indentation as a character count and does not reject a tab
in leading whitespace; a tab-indented spec parses. The grammar reference says a
leading tab is a parse error, and `feat fmt` reports one as such and refuses to
rewrite the file. Use spaces.

## Exit codes

This is a library and never exits the process. In the `feat` CLI, an `ERR` result
exits `1`, and a refused config exits `2`.

## What changed in 0.4.0

- **UpperCamel rejection ids** beside `UPPER_SNAKE`, kept verbatim, with a
  `MALFORMED_SYNTAX` hint that names both valid forms (SPEC-CORE-001, ADR-0022).
- **`fault` lines in `given:`** are reserved, parsed into `given.faults`, and
  malformed ones are `MALFORMED_SYNTAX` rather than silent freeform context
  (SPEC-CORE-001, ADR-0023). `UNKNOWN_SERVICE_KEY` now also covers a fault's
  service.
- **`parse` reads the config through `loadConfig`**, so a tier overlay's merged
  spaces apply and a drifting overlay is refused (ADR-0024).
- **Three bad-input vectors** for the rejection-id forms
  (`rejection-id-kebab`, `rejection-id-lower-camel`,
  `rejection-id-mixed-case-snake`) and seven for fault lines joined
  `fixtures/bad`.

## Specs and decisions

- [SPEC-CORE-001](https://github.com/mmmnt/feature/blob/main/packages/feat-core/parse.feat):
  parse a `.feat` file to BuiltSpec IR (status `agreed`)
- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [ADR-0022: UpperCamel rejection ids](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0022-uppercamel-rejection-ids.md)
- [ADR-0023: adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)
  (the `fault` line)
- [ADR-0024: tier bindings](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0024-tier-bindings.md)

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT
