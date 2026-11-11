# @mmmnt/feat-adapter-dynamodb

Service adapter for [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language. It turns a **DynamoDB table into a capture window**. Every write during a
scenario becomes a captured record, so an unpredicted `INSERT`, `MODIFY` or `REMOVE` fails the case by
prediction inversion. The window comes from DynamoDB Streams by default, or from two consistent reads
of the table when the table has no stream.

It also reads state for `contains` predictions, seeds records before a scenario, scopes everything to a
per-spec-file namespace, and can inject faults on the product's path.

## Install

```sh
npm install --save-dev @mmmnt/feat-adapter-dynamodb
```

Requires Node 20 or later and `@mmmnt/feature` in the project. The AWS SDK v3 clients
(`@aws-sdk/client-dynamodb`, `@aws-sdk/client-dynamodb-streams`, `@aws-sdk/credential-providers`) are
dependencies of the package, because DynamoDB requires SigV4 signing. `@mmmnt/feat-fault-proxy` is a
dependency too. The faults that need it also need a Toxiproxy server, described under Faults.

The adapter needs a DynamoDB: a real table, DynamoDB Local that you run, or the private DynamoDB Local
it scaffolds itself (Ephemeral mode, which needs Docker).

## Configuration

```jsonc
// feat.config.json
"services": {
  "database": {
    "adapter": "@mmmnt/feat-adapter-dynamodb",
    "consistency": "eventual",
    "convergenceTimeout": 2500,
    "options": {
      "tableEnv": "FEAT_DDB_TABLE",          // or "table": "feature-workspace-local"
      "region": "us-east-2",
      "endpointEnv": "FEAT_DDB_ENDPOINT"     // or "endpoint": literal; omit for AWS.
      // Endpoints belong to the ENVIRONMENT (an emulator edge, DynamoDB
      // Local, a VPC endpoint URL). Reference them like tableEnv, and the
      // same tier config observes whatever the environment provides.
    }
  }
}
```

Declare the service `eventual`. Stream delivery lags the writes that cause it.

### Every option

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `table` | string | | The table name, literally. Give one of `table` or `tableEnv` unless `ephemeral` is set. |
| `tableEnv` | string | | The name of an environment variable that holds the table name. |
| `region` | string | the SDK chain (`AWS_REGION`) | AWS region. |
| `endpoint` | string | the real regional endpoint | API origin, literally, such as `http://127.0.0.1:8000`. |
| `endpointEnv` | string | | The name of an environment variable that holds the origin. Give `endpoint` or `endpointEnv`, not both. |
| `auth` | object | the SDK default chain | Credential references. Exactly one form. See Access model. |
| `ephemeral` | object | | Scaffold a private DynamoDB Local instrument. See Ephemeral mode. |
| `stream` | boolean | `true` | `false` serves the diff from two consistent reads instead of Streams. See Observation. |
| `fence` | boolean | `false` | Let `settle()` vouch for the capture with a sentinel row. See Peek and settle. |
| `namespaceMode` | `"keyPrefix"` | `"keyPrefix"` | How a namespace is carried. Only `"keyPrefix"` exists. |
| `proxy` | object | | A Toxiproxy in front of DynamoDB, which turns on the `Connection` faults. See Faults. |

The runner also gives the adapter a top-level `namespace`. Never write one in a config file. The
runner refuses it with `NAMESPACE_CONFIGURED`.

## Example

```feat
feat 1.0

spec SPEC-BTA-001 "Request beta access"
context Beta
aggregate Request
type command
status agreed

construct:
  handler at src/beta/request.ts
  touches src/beta/**

enforce:
  a request writes one row

contract:
  input RequestInput
  response Receipt
  record BetaRow

scenario "a request is stored":
  when: RequestBeta { email: "alice@example.com" }
  predict success:
    response 200 Receipt { ok: true }
    database has [ INSERT with BetaRow {
      SK: "REQUEST#42"
      email: @when.email
    } ]
```

A record is `{ type: INSERT | MODIFY | REMOVE, key: "PK=...|SK=...", payload: <unmarshalled image> }`.
`key` lists the key attributes, sorted by name. `REMOVE` carries the old image. `payload` is the new
image, or the old one for a `REMOVE`.

## Observation

The adapter declares `observes = { diff, state: true }`. `diff` is `"native"` by default and
`"snapshot"` with `stream: false` (SPEC-ADPDDB-001).

**Native diff (the default)** reads DynamoDB Streams. `startCapture` pins a `LATEST` iterator on each
shard, and `stopCapture` drains them. The table **must have Streams enabled** with
`NEW_AND_OLD_IMAGES` (or `NEW_IMAGE`). A table with no active stream is refused at setup with
`STREAM_NOT_ENABLED`, and a `KEYS_ONLY` stream is rejected because predictions need images. A shard
created during a window is outside it. Windows are test-scale, seconds not hours.

**Snapshot diff** (`"stream": false`) takes two consistent reads of the namespace and compares them by
primary key. No Streams permission is needed and the table needs no stream. It reports an item that
exists now and did not before as `INSERT`, a changed image as `MODIFY`, and a missing one as `REMOVE`.
It cannot see an item written and deleted, or overwritten with an identical image, inside the window.
That is what "snapshot" means, and the adapter declares it.

**State** is `read()`, used by `contains` (see Query mode).

## Query mode

A `contains` prediction hands `read()` the predicted records' literal key fields. The adapter picks the
cheapest read that is complete for each hint, all with `ConsistentRead`:

| The hint carries | Read |
| --- | --- |
| The full primary key | `GetItem` |
| The partition key alone (on a table with a sort key) | `Query` |
| Anything else, or no hint | `Scan` of the namespace |

A hint may return a superset, never fewer records. Results are `ITEM`-typed records with the
unmarshalled item as the payload. When a prediction lists several records, each gets its own plan, but
if any hint cannot name a partition key the whole read is a `Scan`.

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

## Seeds

`seed database [ ... ]` puts each record with `PutItem` before the window opens, so a seed is never
captured. The values must include the table's key attributes. A string partition key gets the
namespace prefix. A failed put is a configuration error that names the record type and says the values
must include the key attributes. Seed values are literals.

## Namespace

The runner derives one namespace per spec file and hands it to the adapter (SPEC-RT-006). It matches
`^s[0-9a-f]{12}$`. With a namespace the adapter carries it as a **key prefix**:

- A stored partition key is `<ns>#<pk>`. The system under test builds the same key from the namespace
  its host gives it, for example from `FEAT_NAMESPACE`, which the runner sets for in-process handlers. The spec writes `<pk>` and never the prefix.
- The prefix is added to seeds and read hints, and stripped from every reported key and payload.
- Capture and read ignore keys outside the prefix, whether from the stream or from a scan.
- **`reset()` deletes every item in the namespace**, between cases, fault placeholders included. A
  namespace owns its items.
- The partition key must be a string. A table whose partition key is not `S` is refused at setup with
  `NAMESPACE_KEY_NOT_STRING`.
- A value off the pattern is refused with `NAMESPACE_INVALID`.

Without a namespace the adapter behaves as before: it sees the whole table and `reset()` deletes
nothing.

## Faults

The adapter offers a fault catalog (SPEC-ADPDDB-001, SPEC-ADPDDB-002). Arm a fault in `given:`:

```feat
scenario "the system loses a conditional put":
  given:
    fault database PutItem CONDITIONAL_CHECK_FAILED { "pk": "USER#7", "sk": "REQUEST#7" } until reset
  when: RequestBeta { email: "alice@example.com" }
  predict rejection ALREADY_REQUESTED:
    response 409 ErrorResponse { code: "ALREADY_REQUESTED" }
    database has []
```

Every entry declares `until reset`. `once` and `times <n>` are refused with `FAULT_UNSUPPORTED`. No
fault reports that it fired, so there is no `firedFaults`, and the evidence is `unobserved`.

| Fault | In the catalog | What it does |
| --- | --- | --- |
| `PutItem.CONDITIONAL_CHECK_FAILED { pk, sk }` | always | Writes an instrument item at the key, so DynamoDB itself refuses the system's `attribute_not_exists` put. `sk` is required when the table has a sort key. A key that is already taken is left alone. |
| `Connection.Timeout` | with `options.proxy` | The request is held on its way up, so the product never applies the write. The client times out. |
| `Connection.ConnectionReset` | with `options.proxy` | The connection is reset. |
| `Connection.Partition` | with `options.proxy` | The path is cut. |

Throttling cannot be produced by DynamoDB Local and is not offered.

### The transport faults and `options.proxy`

**Without `options.proxy` the catalog has no `Connection` entry.** Arming one is refused with
`FAULT_UNSUPPORTED`, and the detail lists what is offered:

```
the fault 'Connection.Partition' is not in the catalog (PutItem.CONDITIONAL_CHECK_FAILED)
```

```jsonc
"options": {
  "tableEnv": "FEAT_DDB_TABLE",
  "endpoint": "http://127.0.0.1:8000",
  "proxy": { "api": "http://127.0.0.1:8474", "name": "dynamodb" }
}
```

| `proxy` key | Meaning |
| --- | --- |
| `api` | Required. The Toxiproxy API. |
| `name` | The product label. Default `"dynamodb"`. The proxy is named `feat-<ns>-<name>`. |
| `upstream` | `host:port` of DynamoDB as Toxiproxy reaches it. Default: the host of `endpoint`. |
| `container`, `metrics`, `runtime` | Passed to `@mmmnt/feat-fault-proxy`. They matter for faults that DynamoDB does not offer (broker loss, traffic counts), and have no effect on this catalog. |

How it works. At setup the adapter opens one Toxiproxy proxy for the namespace. Toxiproxy picks the
listen port. Read it from the Toxiproxy API (`GET /proxies/feat-<ns>-<name>`) and point the **system
under test's** DynamoDB client at it. The adapter's own clients, for the table and the stream, use
`endpoint` directly and never the proxy, so under a fault the capture, the `settle` fence and the state
read still work, and an absence is still provable. `Timeout` is armed on the request path, so the write
is provably absent. `reset()` removes every toxic and re-enables the proxy.

`options.proxy` needs the runner's namespace and an upstream (from `proxy.upstream` or from
`endpoint`), or setup fails with a configuration error. It is exclusive with `ephemeral`. A timeout or
connection error is what the product's SDK sees, and the spec predicts how the product handles it.

## Peek and settle

- `peekCapture()` drains the stream (or takes a snapshot diff) and returns the records so far, without
  closing the window. Repeated peeks and the final stop see each record once. With no window open it
  returns `[]`.
- `settle()` in snapshot mode resolves `true` inside a window, because a consistent read sees every
  acknowledged write, and `false` with none open.
- `settle()` in native mode resolves `false` unless `fence: true`. With the fence on, it writes a
  sentinel row after every write the system has made, drains the stream until the sentinel arrives,
  and resolves `true`, within 10 seconds. Sound only where the stream is one ordered sequence: one
  open shard and one writer (DynamoDB Local, the `feat run` lane). It declines with more than one open
  shard, or when any key attribute is not a string. The sentinel and fault rows are the instrument's.
  They are never reported as the system's effect.

## Access model

**Config carries credential references, never values.** The config is committed and hashed into
generated suites. `options.auth` takes exactly one form. Several at once is a configuration error:

```jsonc
"auth": { "profile": "acme-staging-observer" }                  // named profile (local dev)
"auth": { "roleArn": "arn:aws:iam::…:role/feat-observer",       // assume-role (enterprise CI; OIDC web identity works)
          "roleSessionName": "feat-adapter-dynamodb" }          // optional
"auth": { "accessKeyIdEnv": "FEAT_AWS_KEY",                     // env-var NAMES for static keys (escape hatch)
          "secretAccessKeyEnv": "FEAT_AWS_SECRET",
          "sessionTokenEnv": "FEAT_AWS_SESSION" }               // optional
```

Absent `auth` means the SDK default chain. Env-named credentials need both `accessKeyIdEnv` and
`secretAccessKeyEnv`.

**Shared and live environments are observe-only.** The adapter never creates or mutates infrastructure
it evidences. The read-only observer policy an environment's owner provisions:

```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": ["dynamodb:DescribeTable", "dynamodb:Scan", "dynamodb:GetItem", "dynamodb:Query",
             "dynamodb:DescribeStream", "dynamodb:GetShardIterator", "dynamodb:GetRecords"],
  "Resource": ["arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE",
               "arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE/stream/*"] }]}
```

`dynamodb:GetItem` and `dynamodb:Query` serve query mode. The stream actions are needed for native diff
only. A snapshot-diff table needs `DescribeTable`, `Scan`, `GetItem` and `Query`. Grant more only where
a feature needs it:

- `dynamodb:PutItem` for `seed`, for `fence: true` sentinels and for `PutItem.CONDITIONAL_CHECK_FAILED`.
- `dynamodb:DeleteItem` for a namespace, because `reset()` deletes the namespace's items. Use a
  namespace only against a table where that is acceptable, such as a test table or the ephemeral one.

## Ephemeral mode: zero credentials, zero IaC

For teams with no cloud access at all, the adapter scaffolds its own instrument: a private DynamoDB
Local container, a table and a stream, created at `setup()` and removed at teardown. It is a real
DynamoDB engine, not a mock.

```jsonc
"options": {
  "ephemeral": {
    "table": "feat-local",
    "partitionKey": "PK",
    "sortKey": "SK",
    "image": "amazon/dynamodb-local",
    "exposeEnv": { "tableEnv": "FEAT_DDB_TABLE", "endpointEnv": "FEAT_DDB_ENDPOINT" }
  }
}
```

| `ephemeral` key | Default | Meaning |
| --- | --- | --- |
| `table` | `"feat-ephemeral"` | Table name in the instrument. |
| `partitionKey` | `"PK"` | Partition key attribute, a string. |
| `sortKey` | `"SK"` | Sort key attribute, a string. `null` makes a hash-only table. |
| `image` | `"amazon/dynamodb-local"` | Container image. Pin a tag in CI. |
| `exposeEnv` | none | Names of environment variables to publish the instrument's table and endpoint under, so in-process handlers read them as the deployed code will. Restored at teardown. |

The table is created with `PAY_PER_REQUEST` billing and a `NEW_AND_OLD_IMAGES` stream. The adapter uses
fake static credentials and `us-east-1` for the instrument.

`ephemeral` is mutually exclusive with `table`, `tableEnv`, `endpoint`, `endpointEnv`, `auth` and
`proxy`. It needs Docker, and refuses at setup without it. To avoid Docker in the adapter, point
`endpoint` at a DynamoDB Local you run yourself
(`docker run -p 8000:8000 amazon/dynamodb-local`). The adapter's own suite runs against the real engine
either way.

## Errors and refusals

Four refusals are `DynamoAdapterError`s, with a stable `code` and a `detail` that names the offender.
The message is `@mmmnt/feat-adapter-dynamodb: <code>: <detail>`.

| Code | Raised | Cause |
| --- | --- | --- |
| `NAMESPACE_INVALID` | Construction | The runner's namespace does not match `^s[0-9a-f]{12}$`. |
| `NAMESPACE_KEY_NOT_STRING` | Setup | A namespace is set and the table's partition key is not a string. |
| `STREAM_NOT_ENABLED` | Setup | Native diff, and the table has no active stream. Enable Streams, or set `"stream": false`. |
| `FAULT_UNSUPPORTED` | `fault()` | The fault is not in the catalog (including `Connection` with no `options.proxy`), its count is not `until reset`, or `PutItem.CONDITIONAL_CHECK_FAILED` has no string `pk` (and `sk`, with a sort key). |

Configuration errors with no code, each ending `— configuration error.`:

- `options.endpoint and options.endpointEnv are mutually exclusive`.
- `environment variable <NAME> is not set (options.endpointEnv)`.
- `no table name — set options.table or options.tableEnv (env var unset?)`.
- `options.auth must carry exactly ONE of profile | roleArn | accessKeyIdEnv+secretAccessKeyEnv`.
- `env-named credentials need BOTH accessKeyIdEnv and secretAccessKeyEnv`, and `environment variable <NAME> is not set`.
- `options.ephemeral is mutually exclusive with table/tableEnv/endpoint/auth/proxy`.
- `options.ephemeral needs docker`, and `ephemeral instrument never became ready` or `never became ACTIVE`.
- The stream is `KEYS_ONLY`: use `NEW_AND_OLD_IMAGES` (or `NEW_IMAGE`).
- `options.proxy needs the runner's namespace`, and `options.proxy needs an upstream`.
- `seeding '<type>' failed (...)`: seed values must include the table's key attributes.
- `Adapter used before setup()`.

## Limitations

- **Eventual capture.** A native window needs a `convergenceTimeout` unless `fence: true` holds. An
  absence proof waits for it.
- **Snapshot blind spots.** An item written and deleted, or overwritten with an identical image, inside
  one window is invisible to `stream: false`.
- **One window per shard set.** New shards created mid-window are outside it.
- **A namespace deletes.** `reset()` empties the namespace's items. Do not aim a namespaced adapter at
  a table whose items you want to keep.
- **Fault placeholders without a namespace.** The `CONDITIONAL_CHECK_FAILED` placeholder item is
  removed by `reset()` only when a namespace is set. Without one, it stays in the table.
- **String partition keys for the fence and the namespace.** Numeric key tables read and capture, but
  cannot be namespaced and `settle` declines.
- **No throttling.** DynamoDB Local cannot produce it, so it is not offered.

## What changed in this release (v0.1.48, package 0.2.0)

- **Query mode** (SPEC-ADPDDB-001): `contains` reads with `GetItem`, `Query` or `Scan` from the hint.
- **Snapshot diff** (SPEC-ADPDDB-001): `options.stream: false`, for tables without a stream.
- **Namespace** (SPEC-ADPDDB-001, SPEC-RT-006): a key-prefix namespace, with `NAMESPACE_INVALID` and
  `NAMESPACE_KEY_NOT_STRING`.
- **Faults** (SPEC-ADPDDB-001, SPEC-ADPDDB-002): `PutItem.CONDITIONAL_CHECK_FAILED`, and the
  `Connection` catalog (`Timeout`, `ConnectionReset`, `Partition`) when `options.proxy` is set, through
  `@mmmnt/feat-fault-proxy`. The catalog has no `Connection` entry without `options.proxy`.
- `STREAM_NOT_ENABLED` is now a coded refusal.
- Declares `observes = { diff: "native" | "snapshot", state: true }` (SPEC-RT-002).
- `peekCapture()` (ADR-0020) and the `fence` option for `settle()` (ADR-0021) are unchanged.

## Tests

`query-mode.test.ts` and `transport.test.ts` are generated from the specs. Their probe
(`fixtures/query-probe.mjs`) starts throwaway `amazon/dynamodb-local:2.6.1`,
`ghcr.io/shopify/toxiproxy:2.12.0` and `node:22.12.0-slim` containers named `feat-dynamodb-test-*` with
fake credentials, and removes them on exit. They run under `feat run`, not under the package's `test`
script. On Docker Desktop the system's client must run inside the Toxiproxy container's network
namespace, which the probe does.

## Specs

- [SPEC-ADPDDB-001, query mode, snapshot diff, namespace and faults](https://github.com/mmmnt/feature/blob/main/adapters/dynamodb/query-mode.feat)
- [SPEC-ADPDDB-002, transport faults on the system's path](https://github.com/mmmnt/feature/blob/main/adapters/dynamodb/transport.feat)
- [Grammar reference, observation modes and `fault`](https://github.com/mmmnt/feature/blob/main/docs/grammar-reference.md)
- [ADR-0023, adapter interface v2](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md)

Part of [Feature](https://github.com/mmmnt/feature). Adapter contract:
https://github.com/mmmnt/feature/wiki/Architecture

## License

MIT
