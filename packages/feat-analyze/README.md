# @mmmnt/feat-analyze

**Pure analysis for `.feat` specs: lint, audit and format.** Three functions,
no filesystem, no process, no CLI. Each takes a parsed spec (or the source text)
and returns findings you can print, gate on or show in an editor.

If you only write `.feat` specs, you do not need this package. The `feat lint`,
`feat audit` and `feat fmt` commands in
[`@mmmnt/feature`](https://www.npmjs.com/package/@mmmnt/feature) are thin
callers over these functions and print the exact strings they return. Use this
package when you embed the same checks in a service, an editor or a bot.

## Where it sits

```
.feat source ──► feat-core (parse) ──► BuiltSpec ──► lintSpec(spec)   ──► Finding[]
      │                                    └───────► auditSpec(spec)  ──► { errors, warnings }
      └─────────────────────────────────────────────► formatSource(src) ──► { formatted, changed, hasLeadingTab }
```

The package depends only on
[`@mmmnt/feat-types`](https://www.npmjs.com/package/@mmmnt/feat-types), for the
`BuiltSpec` type. It does not parse. To get a `BuiltSpec`, use
[`@mmmnt/feat-core`](https://www.npmjs.com/package/@mmmnt/feat-core).

What the library leaves to a caller, because it needs the filesystem: whether a
spec has a paired `<name>.contract.json`, and whether its generated test file
exists. `feat audit` adds both as warnings.

## Install

```sh
npm install @mmmnt/feat-analyze @mmmnt/feat-core
```

Requirements:

- Node 20 or later (`engines`).
- ESM only (`"type": "module"`).
- `@mmmnt/feat-types` installs with it. `@mmmnt/feat-core` is only needed if you
  parse specs yourself, as below.

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

That prints:

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

### `lintSpec(spec: BuiltSpec): Finding[]`

Language-quality rules beyond the buildability gate (ADR-0007, ADR-0017).

```ts
interface Finding {
  level: "error" | "warn" | "info";
  message: string;      // already prefixed with its level, e.g. "warn: ..."
}
```

| Rule | Level | Message |
| --- | --- | --- |
| A contract schema that no scenario references | `warn` | `warn: schema 'X' is declared but never referenced by a scenario` |
| A variable that nothing references | `warn` | `warn: variable 'x' is declared but never referenced` |
| The same `kind schema` declared twice in `contract:` | `warn` | `warn: duplicate contract declaration 'kind X'` |
| The spec is still a draft | `info` | `info: status draft — not buildable until agreed` |

What counts as a reference to a schema: the response schema of a prediction,
every record schema in a `has` or `contains` list, and every `with <Schema>` on
an inline seed record. `input` entries are used by definition (they are the
`when:` payload's contract), and `stream` entries are never checked. A variable
is referenced when a `${name}` appears anywhere in a scenario, or in the template
of another variable.

Findings come in rule order: schemas, variables, duplicates, status. No rule in
this release returns `level: "error"`; the type allows it so a future rule can.
A parse failure is the caller's to report, since there is no spec to lint.

### `auditSpec(spec: BuiltSpec): AuditResult`

The buildability gate of an `agreed` spec (ADR-0008).

```ts
interface AuditResult {
  errors: string[];     // B1 to B3: block the gate
  warnings: string[];   // lifecycle surfacing: advisory
}
```

| Rule | Fails when | Message |
| --- | --- | --- |
| **B1** | the spec type is `command`, `query`, `policy`, `projection` or `saga` and there is no `handler at` | ``B1: no `handler at` for a code-producing spec type`` |
| **B3** | there is no `touches` | ``B3: no `touches` change boundary declared`` |
| **B2**, predicted | a scenario predicts `rejection X` and no `rejects X when ...` line exists | ``B2: predicted rejection 'X' has no `rejects X when …` line`` |
| **B2**, declared | a `rejects X` line exists and no scenario predicts it | ``B2: `rejects X` is never predicted by any scenario`` |

Errors come in the order B1, B3, B2 (predicted first, then declared). Types
`infrastructure`, `integration` and `scaffold` are exempt from B1 but not from
B3. B2 is two-way: every rejection a spec promises is predicted, and every
predicted rejection is promised. Rejection ids are compared exactly and
case-sensitively (ADR-0022), so `NotOperator` and `NOT_OPERATOR` are different
ids.

In a scenario outline, a rejection id written as a placeholder (`<code>`) is
resolved through the `examples:` rows: every string value in that column counts
as a predicted id.

The one warning is `status draft — not buildable until agreed`, for a spec whose
status is `draft`. An `agreed`, `built` or `verified` spec has none.

### `formatSource(source: string): FormatResult`

Conservative, content-preserving, idempotent formatting.

```ts
interface FormatResult {
  formatted: string;
  changed: boolean;          // formatted !== source
  hasLeadingTab: boolean;    // a line that begins with a tab character
}
```

It does exactly four things: it strips trailing spaces and tabs from every
line, collapses any run of blank lines to one, removes blank lines at the end of
the file, and ends the file with one newline. CRLF line endings become LF. It
never re-indents, reorders or rewrites a token, and formatting its own output
changes nothing.

`hasLeadingTab` reports a tab as the first character of a line. `feat fmt`
treats it as an error and leaves that file alone. A space followed by a tab is
not detected. The parser itself does not reject tab indentation (see
[`@mmmnt/feat-core`](https://www.npmjs.com/package/@mmmnt/feat-core)).

## In the CLI

| Command | Calls | Exit codes |
| --- | --- | --- |
| `feat lint` | `lintSpec` on every spec | `0`, or `1` if any spec fails to parse. Warnings and notes never fail the run. |
| `feat audit` | `auditSpec`, plus the paired-file warnings | `0`, or `1` if any spec has an error (a parse failure or a B1, B2 or B3 error). Warnings never fail the run. |
| `feat fmt` | `formatSource`; `--check` reports without writing | `0`, or `1` with `--check` when any file would change, or when any file has a leading tab. |

A configuration error is exit `2`, as everywhere in the toolchain. The library
itself returns values and never exits.

## What changed in 0.1.8

Nothing. `@mmmnt/feat-analyze` is unchanged in release v0.1.48 and stays at
0.1.8, the version it had in v0.1.47. This README is the only addition: until
now the package had none.

## Specs and decisions

- [Grammar reference](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md):
  the language the rules apply to
- [ADR-0022: UpperCamel rejection ids](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0022-uppercamel-rejection-ids.md):
  why B2 compares ids exactly
- ADR-0007 (declared-but-unused lint), ADR-0008 (the buildability rules B1 to
  B3 and the `draft`, `agreed`, `built`, `verified` lifecycle) and ADR-0017 (the
  variable lint) record the rules. ADR-0001 to ADR-0021 are not in the
  repository yet.

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT
