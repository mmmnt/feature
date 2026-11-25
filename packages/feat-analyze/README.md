# @mmmnt/feat-analyze

Pure analysis of `.feat` specs: lint, audit and format. Each function takes a parsed `BuiltSpec` (or the source
text) and returns findings you can print, gate on or show in an editor. It reads no files, starts no process and
never exits. `feat lint`, `feat audit` and `feat fmt` in [`@mmmnt/feature`](../feature/README.md) are thin callers
over these functions and print the strings they return.

```
.feat source ──► feat-core (parse) ──► BuiltSpec ──► lintSpec / lintOptionalFields / lintNestedOpen ──► Finding[]
      │                                    └───────► auditSpec   ──► { errors, warnings }
      └─────────────────────────────────────────────► formatSource ──► { formatted, changed, hasLeadingTab }
```

The package depends only on [`@mmmnt/feat-types`](../feat-types/README.md). It does not parse: get a `BuiltSpec`
from [`@mmmnt/feat-core`](../feat-core/README.md). Whether a spec has a paired `<name>.contract.json` and a
generated test file is a filesystem question, so `feat audit` adds those warnings itself.

## Installation

Requires Node.js 22 or newer.

```bash
npm install @mmmnt/feat-analyze @mmmnt/feat-core
```

`@mmmnt/feat-core` is needed only to parse specs yourself, as below. The package is ESM only.

## Usage

```ts
import { parseSource } from "@mmmnt/feat-core";
import { auditSpec, formatSource, lintSpec } from "@mmmnt/feat-analyze";
import type { BuiltSpec } from "@mmmnt/feat-types";

const source = `feat 1.0

spec SPEC-USR-001 "CreateUser"
context Users
aggregate User
type command
status draft

construct:
  handler at handlers/create-user.ts

enforce:
  rejects DUPLICATE_EMAIL when a user with this email already exists
  rejects INVALID_EMAIL when the address is malformed

contract:
  input CreateUserInput
  response UserResponse
  record UserRow
  error ErrorResponse

scenario "rejects duplicate email":
  when: CreateUser { email: "alice@example.com" }
  predict rejection DUPLICATE_EMAIL:
    response 409 ErrorResponse { code: "DUPLICATE_EMAIL" }
    database has []
`;

const parsed = parseSource(source, { serviceKeys: ["database"], commands: ["CreateUser"], actors: [] });
if (parsed.status !== "OK") throw new Error(JSON.stringify(parsed.body));
const spec = parsed.body as unknown as BuiltSpec;

console.log(lintSpec(spec));
console.log(auditSpec(spec));
console.log(formatSource(source).changed);
```

prints:

```
[
  { level: 'warn', message: "warn: schema 'UserResponse' is declared but never referenced by a scenario" },
  { level: 'warn', message: "warn: schema 'UserRow' is declared but never referenced by a scenario" },
  { level: 'info', message: 'info: status draft — not buildable until agreed' }
]
{
  errors: [
    'B3: no `touches` change boundary declared',
    'B2: `rejects INVALID_EMAIL` is never predicted by any scenario'
  ],
  warnings: [ 'status draft — not buildable until agreed' ]
}
false
```

## API

| Export | Signature |
| --- | --- |
| `lintSpec` | `(spec: BuiltSpec) => Finding[]` |
| `lintOptionalFields` | `(spec: BuiltSpec, registry: Record<string, object>) => Finding[]` |
| `lintNestedOpen` | `(spec: BuiltSpec, registry: Record<string, object>) => Finding[]` |
| `auditSpec` | `(spec: BuiltSpec) => AuditResult` |
| `formatSource` | `(source: string) => FormatResult` |
| types | `Finding`, `AuditResult`, `FormatResult` |

```ts
interface Finding { level: "error" | "warn" | "info"; message: string } // message is prefixed with its level
interface AuditResult { errors: string[]; warnings: string[] }
interface FormatResult { formatted: string; changed: boolean; hasLeadingTab: boolean }
```

`registry` is the spec's contract as the schema adapter resolves it (schema name to JSON Schema).

### `lintSpec`

| Rule | Level | Message |
| --- | --- | --- |
| A contract schema no scenario references | `warn` | `warn: schema 'X' is declared but never referenced by a scenario` |
| A variable nothing references | `warn` | `warn: variable 'x' is declared but never referenced` |
| The same `kind Schema` declared twice in `contract:` | `warn` | `warn: duplicate contract declaration 'kind X'` |
| The spec is a draft | `info` | `info: status draft — not buildable until agreed` |

A schema is referenced by a prediction's response, a record in a `has` or `contains` list, or a `with <Schema>` on
an inline seed record. `input` entries count as used, and `stream` entries are not checked. A variable is referenced
by a `${name}` anywhere in a scenario or in another variable's template. Findings come in that rule order.

### `lintOptionalFields` (ADR-0038)

A predicted response or record value block that leaves out an optional property of its schema is an error unless the
block is marked `partial`. Optional means declared and not required, following `allOf` and the schema's local `$ref`s.

```
error [OPTIONAL_UNSTATED]: scenario "<name>" › <response | <service> <type>>: <Schema> leaves out optional '<p>' — state each (absent, any, or a value), or mark the block '<Schema> partial { … }' (ADR-0038)
```

### `lintNestedOpen` (ADR-0039)

The migration lint for exact nested blocks: from `@mmmnt/feat-runtime` 0.10.0 a nested value block is exact, so a
nested block whose schema lets the object carry undeclared keys is named. It checks every predicted response, `has`
record and `contains` record, `partial` or not. A nested schema is closed when it says `additionalProperties: false`
or `unevaluatedProperties: false` directly, through a local `$ref`, through an `allOf` part, or in every
`anyOf`/`oneOf` branch. A property no schema describes is open. Literal objects and `any` are not nested blocks.

```
warn [NESTED_SCHEMA_OPEN]: scenario "<name>" › <where> › <key> › …: <Schema> leaves '<key.path>' open, so from feat-runtime 0.10.0 a key the block does not state fails the scenario (ADR-0039) — close it (additionalProperties: false), or check the block states every key
```

### `auditSpec` (buildability, ADR-0008)

| Rule | Fails when | Message |
| --- | --- | --- |
| B1 | the type is `command`, `query`, `policy`, `projection` or `saga` and there is no `handler at` | ``B1: no `handler at` for a code-producing spec type`` |
| B3 | there is no `touches` | ``B3: no `touches` change boundary declared`` |
| B2, predicted | a scenario predicts `rejection X` and no `rejects X when …` line exists | ``B2: predicted rejection 'X' has no `rejects X when …` line`` |
| B2, declared | a `rejects X` line exists and no scenario predicts it | ``B2: `rejects X` is never predicted by any scenario`` |

Errors come in the order B1, B3, B2 (predicted, then declared). `infrastructure`, `integration` and `scaffold` specs
are exempt from B1, not from B3. Rejection ids compare exactly and case-sensitively (ADR-0022). In a scenario
outline, a rejection id written as a placeholder (`<code>`) is resolved through the `examples:` rows. The one warning
is `status draft — not buildable until agreed`.

### `formatSource`

Conservative, content-preserving and idempotent. It strips trailing spaces and tabs from every line, collapses runs
of blank lines to one, drops blank lines at the end, ends the file with one newline and turns CRLF into LF. It never
re-indents, reorders or rewrites a token. `hasLeadingTab` is true when a line begins with a tab character; the parser
refuses tab indentation (`MALFORMED_SYNTAX`), and `feat fmt` reports such a file and leaves it alone.

## In the CLI

| Command | Calls | Exit codes |
| --- | --- | --- |
| `feat lint` | `lintSpec`, `lintOptionalFields`, `lintNestedOpen` on every spec | `1` when a spec does not parse or any finding is `error` level; warnings never fail |
| `feat audit` | `auditSpec`, plus the paired-file warnings | `1` when a spec does not parse or has a B1 to B3 error |
| `feat fmt [--check]` | `formatSource` | `1` when a file has a leading tab, or with `--check` when a file would change |

A configuration error is exit `2`.

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
pnpm build --filter=@mmmnt/feat-analyze
pnpm --filter @mmmnt/feat-analyze test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
