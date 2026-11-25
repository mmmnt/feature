# @mmmnt/feat-core

The `.feat` parser: source text in, `BuiltSpec` intermediate representation (IR) out. It is a hand-written
recursive-descent parser, deterministic (the same spec and config give the same IR on every call), and it enforces
the language's closed reference spaces at parse time: a spec that names a service, command, actor or schema that does
not exist is a parse error, never a silent pass. `feat parse` in [`@mmmnt/feature`](../feature/README.md) is this
parser on the command line; use the package to embed it in a service, an editor, a linter or a generator.

```
.feat source ──► feat-core (parse) ──► BuiltSpec ──► feat-derive ──► feat-emit-ts ──► test file
                       ▲                    │
              closed reference spaces       └──► feat-analyze (lint, audit, fmt)
              from feat.config.json
```

It depends on [`@mmmnt/feat-types`](../feat-types/README.md) for the IR types and on
[`@mmmnt/feat-runtime`](../feat-runtime/README.md) for `loadConfig`, so a tier overlay is resolved here exactly as
in the CLI.

## Installation

Requires Node.js 22 or newer.

```bash
npm install @mmmnt/feat-core
```

The package is ESM only and has no peer dependencies.

## Usage

### Parse a file

```ts
import { parse } from "@mmmnt/feat-core";
import type { BuiltSpec } from "@mmmnt/feat-types";

const result = await parse({ spec: "specs/create-user.feat", config: "feat.config.json" });

if (result.status === "OK") {
  const spec = result.body as unknown as BuiltSpec;
  console.log(spec.identity);
} else {
  const { code, message, line, hint } = result.body;
  console.error(`[${code}] line ${line ?? "?"}: ${message}`, hint ?? "");
}
```

Both paths resolve against `process.cwd()`. The config is read through `loadConfig`, so a config with `extends` is
merged first and the closed spaces are the merged ones.

### Parse text you already hold

`parseSource` does no I/O. `contextFromConfig` builds its context from a config document with the rules `parse`
uses:

```ts
import { contextFromConfig, parseSource } from "@mmmnt/feat-core";

const ctx = contextFromConfig({
  services: { filesystem: {} },
  response: { commands: { Greet: {} } },
});
// { serviceKeys: ["filesystem"], commands: ["Greet"], actors: [] }

const result = parseSource(source, ctx);
// a known command:   { status: "OK", body: <BuiltSpec> }
// `when: Wave { … }`: { status: "ERR", body: { code: "UNKNOWN_COMMAND",
//                       message: "Command 'Wave' is not configured.", hint: "Configured commands: Greet" } }
```

The actor key `default` names the default actor and is not a member of the actor space. `anonymous` is reserved and
never declared.

## API

| Export | Signature | Notes |
| --- | --- | --- |
| `parse` | `(input: ParseInput) => Promise<CapturedResponse>` | Reads the spec and the config, then calls `parseSource`. |
| `parseSource` | `(source: string, ctx: ConfigContext) => CapturedResponse` | Synchronous, no filesystem. |
| `contextFromConfig` | `(configDoc) => ConfigContext` | Takes `{ services?, response?: { commands?, actors? } }`. |
| `ParseInput` | `{ spec: string; config: string }` | Paths, relative to `process.cwd()` or absolute. |
| `ConfigContext` | `{ serviceKeys: string[]; commands: string[]; actors: string[] }` | The closed spaces. |
| `CapturedResponse` | `{ status: "OK" \| "ERR"; body: Record<string, unknown> }` | `body` is the `BuiltSpec` on `OK`, the error on `ERR`. |

On `OK`, `body` is a `BuiltSpec` (see [`@mmmnt/feat-types`](../feat-types/README.md)). It carries no source
locations, which keeps the IR byte-comparable. Its JSON Schema is `schemas/builtspec.schema.json` at the repository
root. The first scenario of [`corpus/create-user`](../../corpus/create-user/create-user.feat), trimmed:

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
            "valueBlock": { "status": { "matcher": "literal", "value": "active" }, "deletedAt": { "matcher": "absent" } } }
        ]
      }
    }
  }
}
```

## The closed reference spaces

Inside a compiler-zone block every bare word is a keyword or a name validated against one of these spaces.

| Space | Where the names come from | Checked in |
| --- | --- | --- |
| services | the keys of `services` in `feat.config.json` | every `<service> has`/`contains`, `seed <service>`, `deliver … to <service>`, `fault <service> …`, `observes` line and `@<service>[i].<path>` capture reference |
| commands | the keys of `response.commands` | every `when:` and `execute` |
| actors | the keys of `response.actors`, minus `default` (`anonymous` always accepted) | every `as <actor>` clause |
| schemas | the spec's own `contract:` block | every `response … <Schema>` and `<Type> with <Schema>` in a prediction or a seed |
| variables | the spec's own `variables:` block | every `${name}` reference |

`response` is a reserved delivery target (`deliver <Event> { … } to response`, ADR-0036), never a service. A
prediction on a non-`query` spec must give a `has` for every configured service (or every observed one, when the
spec declares `observes`); `has []` is the explicit zero-assertion.

## Error codes

A spec failure is a returned `{ status: "ERR", body }`, never a throw. `body` is `{ code, message, line?, hint? }`;
`line` is 1-based and is present where the scanner can place the error.

| Code | When |
| --- | --- |
| `MISSING_PRAGMA` | the first non-comment line is not `feat <major>.<minor>` |
| `UNSUPPORTED_VERSION` | the pragma's major is not 1 |
| `MALFORMED_SYNTAX` | a compiler-zone block breaks the grammar: an unknown type, status or contract role; a malformed value, payload, record list, `fault`, `observes` or `random seed` line; an unknown prediction form; a scenario with no trigger; a rejection id that is neither `UPPER_SNAKE` nor `UpperCamel`; `partial` in data, inside a value or beside `equals fixture`; a refused `not` form; a tab in leading whitespace; a bad variable |
| `UNKNOWN_SERVICE_KEY` | a prediction, delivery, `fault` line, capture reference or `observes` line names an unconfigured service |
| `UNKNOWN_COMMAND` | a `when:` or `execute` names a command absent from `response.commands` |
| `UNKNOWN_ACTOR` | an `as <actor>` clause names an actor absent from `response.actors` |
| `UNDECLARED_SCHEMA` | a scenario references a schema `contract:` does not declare |
| `DUPLICATE_SCENARIO_NAME` | two scenarios share a name (names are failure anchors) |
| `TRIGGER_MISMATCH` | `when:` on a `projection`, `policy` or `saga`, or `deliver` on any other type |
| `QUERY_SIDE_EFFECT` | a `query` spec predicts a non-empty `has` |
| `INCOMPLETE_PREDICTION` | a non-`query` prediction has no `has` for a configured (or observed) service |
| `UNOBSERVED_SERVICE` | a spec that declares `observes` names another configured service (ADR-0033) |
| `MISSING_MINIMUM` | the spec lacks a complete header, a construct directive, an enforce directive, a contract entry or a scenario |
| `UNKNOWN_VARIABLE` | a `${name}` names a variable `variables:` does not declare |

The agent-zone blocks (`construct:` and `enforce:`) are freeform: a keyword line becomes a typed node, any other line
is kept verbatim as a directive.

A config problem is not returned as `ERR`: `parse` throws `Error("Configuration error [CODE] message")` when
`loadConfig` refuses the config (for example `CONFIG_NOT_FOUND`, `INVALID_CONFIG`, `EXTENDS_NOT_FOUND`,
`EXTENDS_CHAIN`, `TIER_SPACE_MISMATCH`), and reading a missing spec throws `ENOENT`. In the `feat` CLI an `ERR` exits
`1` and a refused config exits `2`.

## Tier overlays (ADR-0024)

A config may be an overlay: a file with a top-level `extends` naming a base config. An overlay may not add or remove
a service key, command name or actor name, so specs parse to the same IR whichever tier's config you hand `parse`.

## Conformance

The parser's ground truth is the repository's [`corpus/`](../../corpus/README.md): each exemplar is a `.feat` file
paired with its expected `.ir.json`, plus the bad-input vectors in [`fixtures/bad`](fixtures/bad). The parser's own
contract is the spec [SPEC-CORE-001](parse.feat). The language is defined in the
[grammar reference](../../docs/grammar-reference.md).

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
pnpm build --filter=@mmmnt/feat-core
pnpm --filter @mmmnt/feat-core test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
