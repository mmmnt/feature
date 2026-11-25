# @mmmnt/feat-adapter-dynamodb

The DynamoDB service adapter for Feature. It turns a DynamoDB table into a capture window: every write during a scenario becomes a captured `INSERT`, `MODIFY` or `REMOVE` record, so an unpredicted write fails the case by prediction inversion. The window comes from DynamoDB Streams by default, or from two consistent reads of the table when it has no stream. The adapter also reads state for `contains` predictions, seeds items before a scenario, scopes everything to the runner's per-file namespace, and injects faults on the system's path.

It needs a DynamoDB: a real table, a DynamoDB Local you run, or a private DynamoDB Local it scaffolds itself (ephemeral mode, which needs Docker).

## Installation

Requires Node.js 22 or newer.

```bash
npm install -D @mmmnt/feat-adapter-dynamodb
```

The AWS SDK v3 clients, `@mmmnt/feat-fault-proxy` (transport faults) and `@mmmnt/feat-adapter-stdio-jsonrpc` (seed transforms) are dependencies of the package.

## Usage

```jsonc
// feat.config.json, under "services"
"database": {
  "adapter": "@mmmnt/feat-adapter-dynamodb",
  "consistency": "eventual",
  "convergenceTimeout": 2500,
  "options": {
    "tableEnv": "FEAT_DDB_TABLE",
    "region": "us-east-2",
    "endpointEnv": "FEAT_DDB_ENDPOINT"
  }
}
```

Declare the service `eventual` with a `convergenceTimeout`: stream delivery lags the writes that cause it.

```feat
scenario "a request is stored":
  when: RequestBeta { email: "alice@example.com" }
  predict success:
    response 200 Receipt { ok: true }
    database has [ INSERT with BetaRow { SK: "REQUEST#42", email: @when.email } ]
```

A captured record is `{ type: INSERT | MODIFY | REMOVE, key: "PK=...|SK=...", payload }`. `key` lists the key attributes sorted by name; `payload` is the unmarshalled new image, or the old image for a `REMOVE`.

## Options

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `table` | string | | The table name. Give `table` or `tableEnv` unless `ephemeral` is set. |
| `tableEnv` | string | | Name of an environment variable holding the table name. |
| `region` | string | the SDK chain (`AWS_REGION`) | AWS region. |
| `endpoint` | string | the regional endpoint | API origin, such as `http://127.0.0.1:8000`. |
| `endpointEnv` | string | | Name of an environment variable holding the origin. Not both `endpoint` and `endpointEnv`. |
| `auth` | object | the SDK default chain | Credential references, exactly one form. See Access model. |
| `ephemeral` | object | | Scaffold a private DynamoDB Local. See Ephemeral mode. |
| `stream` | boolean | `true` | `false` serves the diff from two consistent reads instead of Streams. |
| `fence` | boolean | `false` | Let `settle()` vouch for a native capture with a sentinel row. |
| `namespaceMode` | `"keyPrefix"` | `"keyPrefix"` | How a namespace is carried. Only `"keyPrefix"` exists. |
| `proxy` | object | | A Toxiproxy in front of DynamoDB; turns on the `Connection` faults. |
| `seedTransform` | object | | `{ host: { command, cwd?, env? } }`: a spec host that transforms seeds before they are put. |

The runner passes the namespace itself; a `namespace` written in a config is refused by the runner with `NAMESPACE_CONFIGURED`.

## Observation

The adapter declares `observes = { diff, state: true }`, `diff` being `"native"` by default and `"snapshot"` with `stream: false`.

- **Native diff** reads DynamoDB Streams: `startCapture` pins a `LATEST` iterator on each shard and `stopCapture` drains them. The table must have Streams enabled with `NEW_AND_OLD_IMAGES` (or `NEW_IMAGE`); no active stream is `STREAM_NOT_ENABLED` at setup, and a `KEYS_ONLY` stream is refused. A shard created during a window is outside it.
- **Snapshot diff** (`stream: false`) compares two consistent scans of the namespace by primary key, needs no Streams permission, and cannot see an item written and deleted, or rewritten with an identical image, inside one window.
- **State** (`contains`) is `read()`. The predicted records' literal key fields pick the read: the full primary key is `GetItem`, the partition key alone (on a table with a sort key) is `Query`, anything else or no hint is a `Scan` of the namespace; all consistent. If any hint cannot name a partition key, the whole read is a scan. Results are `ITEM` records.

```feat
scenario "a seeded request is in the table":
  given:
    seed database [ ITEM with BetaRow { PK: "USER#7", SK: "REQUEST#7", email: "bob@example.com" } ]
  when: RequestBeta { email: "alice@example.com" }
  predict success:
    response 200 Receipt { ok: true }
    database has [ INSERT with BetaRow { SK: "REQUEST#42" } ]
    database contains [ ITEM with BetaRow { PK: "USER#7", SK: "REQUEST#7" } ]
```

**Peek and settle.** `peekCapture()` returns the records so far without closing the window (each record seen once across peeks and the final stop; `[]` with no window). `settle()` in snapshot mode is `true` inside a window. In native mode it is `false` unless `fence: true`, in which case it writes a sentinel row after the system's writes and drains until it arrives (up to 10 s). It declines with more than one open shard or a non-string key attribute. Sentinel and fault rows are never reported as the system's effect.

## Seeds

`seed database [ ... ]` puts each record with `PutItem` before the window opens, so a seed is never captured. Every record of a call is checked before the first put (`SEED_VALUE_UNSTORABLE`): the values are an item, each key attribute is present and is a non-empty string or finite number as the table types it, every number is in DynamoDB's range, and the item is at most 400 KB.

With `seedTransform`, the adapter joins the spec file's shared stdio host (see [`@mmmnt/feat-adapter-stdio-jsonrpc`](../stdio-jsonrpc/README.md)), asks its `transformSeed` method twice per seed call, and writes the first answer only when both agree as canonical JSON and keep the records' count, order, type and identity (ADR-0035).

## Namespace

The runner derives one namespace per spec file (`^s[0-9a-f]{12}$`) and also sets it as `FEAT_NAMESPACE` for in-process handlers. The adapter carries it as a key prefix:

- A stored partition key is `<ns>#<pk>`. The system under test builds the same key; the spec writes `<pk>`.
- The prefix is added to seeds, read hints and fault keys, and stripped from every reported key and payload. Keys outside the prefix are ignored.
- **`reset()` deletes every item in the namespace** between cases.
- The partition key must be a string (`NAMESPACE_KEY_NOT_STRING` otherwise).

Without a namespace the adapter sees the whole table and `reset()` deletes nothing.

## Faults

Every entry is `until reset`; `once` and `times <n>` are `FAULT_UNSUPPORTED`. No fault reports that it fired, so the evidence is `unobserved`.

| Fault | Offered | Effect |
| --- | --- | --- |
| `PutItem CONDITIONAL_CHECK_FAILED { pk, sk }` | always | Writes an instrument item at the key, so DynamoDB refuses the system's `attribute_not_exists` put. `sk` is required on a table with a sort key; a key already taken is left alone. |
| `Connection Timeout` | with `proxy` | The request is held on its way up (upstream), so the write is provably absent. |
| `Connection ConnectionReset` | with `proxy` | The connection is reset. |
| `Connection Partition` | with `proxy` | The path is cut. |

```feat
scenario "the system loses a conditional put":
  given:
    fault database PutItem CONDITIONAL_CHECK_FAILED { "pk": "USER#7", "sk": "REQUEST#7" } until reset
  when: RequestBeta { email: "alice@example.com" }
  predict rejection ALREADY_REQUESTED:
    response 409 ErrorResponse { code: "ALREADY_REQUESTED" }
    database has []
```

| `proxy` key | Meaning |
| --- | --- |
| `api` | Required. The Toxiproxy API URL. |
| `name` | Product label, default `"dynamodb"`. The proxy is `feat-<ns>-<name>`. |
| `upstream` | `host:port` of DynamoDB as Toxiproxy reaches it. Default: the host of `options.endpoint` (not `endpointEnv`). |
| `container`, `metrics`, `runtime` | Passed to `@mmmnt/feat-fault-proxy`; no effect on this catalog. |

At setup the adapter opens one proxy for the namespace; read its listen address from the Toxiproxy API (`GET /proxies/feat-<ns>-<name>`) and point the system under test's client at it. The adapter's own clients never use the proxy, so capture, fence and reads keep working under a fault. `reset()` removes the toxics. `proxy` needs the runner's namespace and an upstream, and is exclusive with `ephemeral`.

## Access model

The config carries credential references, never values. `auth` takes exactly one form:

```jsonc
"auth": { "profile": "acme-staging-observer" }
"auth": { "roleArn": "arn:aws:iam::123456789012:role/feat-observer", "roleSessionName": "feat-adapter-dynamodb" }
"auth": { "accessKeyIdEnv": "FEAT_AWS_KEY", "secretAccessKeyEnv": "FEAT_AWS_SECRET", "sessionTokenEnv": "FEAT_AWS_SESSION" }
```

Shared and live environments are observe-only: the adapter never creates or changes infrastructure there. A read-only observer policy:

```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:GetItem", "dynamodb:Query",
             "dynamodb:DescribeStream", "dynamodb:GetShardIterator", "dynamodb:GetRecords"],
  "Resource": ["arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE",
               "arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE/stream/*"] }]}
```

The stream actions serve native diff only. Add `dynamodb:PutItem` for seeds, the fence and the conditional-check fault, and `dynamodb:DeleteItem` for a namespace (its `reset()` deletes items).

## Ephemeral mode

For teams with no cloud access, the adapter starts a private DynamoDB Local container at `setup()`, creates a `PAY_PER_REQUEST` table with a `NEW_AND_OLD_IMAGES` stream, and removes the container at teardown. It uses fake static credentials and `us-east-1`.

```jsonc
"options": {
  "ephemeral": {
    "table": "feat-local",
    "image": "amazon/dynamodb-local",
    "exposeEnv": { "tableEnv": "FEAT_DDB_TABLE", "endpointEnv": "FEAT_DDB_ENDPOINT" }
  }
}
```

| `ephemeral` key | Default | Meaning |
| --- | --- | --- |
| `table` | `"feat-ephemeral"` | Table name. |
| `partitionKey` | `"PK"` | Partition key attribute. |
| `sortKey` | `"SK"` | Sort key attribute; `null` for a hash-only table. |
| `partitionKeyType` | `"S"` | `"S"` or `"N"`. A namespace needs `"S"`. |
| `sortKeyType` | `"S"` | `"S"` or `"N"`. |
| `image` | `"amazon/dynamodb-local"` | Container image. Pin a tag in CI. |
| `exposeEnv` | none | Environment variable names to publish the table and endpoint under for in-process handlers; restored at teardown. |

`ephemeral` is exclusive with `table`, `tableEnv`, `endpoint`, `endpointEnv`, `auth` and `proxy`, and needs `docker`.

## Errors

`DynamoAdapterError`s carry a stable `code`; the message is `@mmmnt/feat-adapter-dynamodb: <code>: <detail>`.

| Code | Raised | Cause |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The runner's namespace is off the pattern. |
| `NAMESPACE_KEY_NOT_STRING` | setup | A namespace is set and the partition key is not a string. |
| `STREAM_NOT_ENABLED` | setup | Native diff and no active stream. Enable Streams or set `stream: false`. |
| `FAULT_UNSUPPORTED` | `fault()` | Not in the catalog (including `Connection` without `proxy`), not `until reset`, or no string `pk`/`sk` detail. |
| `OPTIONS_INVALID` | setup | `seedTransform` is malformed. |
| `SEED_TRANSFORM_UNAVAILABLE` | setup | The transform host cannot be started. |
| `SEED_TRANSFORM_FAILED` | `seed()` | The host errored, lacks the method, ended, or changed count, order, type or identity. |
| `SEED_TRANSFORM_NONDETERMINISTIC` | `seed()` | The two answers differ. |
| `SEED_VALUE_UNSTORABLE` | `seed()` | A record DynamoDB cannot store (see Seeds). |

Other configuration errors (no code, each ending `— configuration error.`) cover: `endpoint` with `endpointEnv`; an unset `endpointEnv` or `tableEnv` variable; more than one `auth` form, or only half of the static-key pair; `ephemeral` with a conflicting option or without Docker; a `KEYS_ONLY` stream; `proxy` without a namespace or upstream; a failed seed put.

## Limitations

- A native window needs a `convergenceTimeout` unless the fence holds; an absence proof waits for it.
- Without a namespace the `CONDITIONAL_CHECK_FAILED` placeholder item is not removed by `reset()`.
- Numeric partition keys read and capture, but cannot be namespaced, and `settle` declines.
- Throttling cannot be produced by DynamoDB Local and is not offered.

The generated suites (`query-mode`, `transport`, `seed-transform`) start throwaway `amazon/dynamodb-local`, Toxiproxy and Node containers, so they run under `feat run`, not the package's `test` script.

## See also

- Specs: [query-mode.feat](query-mode.feat) (SPEC-ADPDDB-001), [transport.feat](transport.feat) (SPEC-ADPDDB-002), [seed-transform.feat](seed-transform.feat) (SPEC-ADPDDB-003)
- [ADR-0023](../../docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2; [ADR-0035](../../docs/adr/ADR-0035-seed-transform.md): seed transform
- [`@mmmnt/feat-fault-proxy`](../fault-proxy/README.md)

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
pnpm build --filter=@mmmnt/feat-adapter-dynamodb
pnpm --filter @mmmnt/feat-adapter-dynamodb test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
