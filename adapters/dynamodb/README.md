# @mmmnt/feat-adapter-dynamodb

Service adapter for Feat that turns a **DynamoDB table into a capture window
via DynamoDB Streams**: every write during a scenario becomes a captured
record — an unpredicted `INSERT`, `MODIFY`, or `REMOVE` fails the suite by
prediction inversion.

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
      // Local, a VPC endpoint URL) — reference them like tableEnv, and the
      // same tier config observes whatever the environment provides.
    }
  }
}
```

```
predict success:
  response 200 Receipt { ok: true }
  database has [ INSERT with BetaRow {
    SK: "REQUEST#42"
    email: @when.email
  } ]
```

Records are `{ type: INSERT|MODIFY|REMOVE, key: "PK=...|SK=...", payload:
<unmarshalled image> }` — `REMOVE` carries the old image. The table **must
have Streams enabled** (`NEW_AND_OLD_IMAGES`, or `NEW_IMAGE`); a streamless
table is a configuration error at setup, and `KEYS_ONLY` is rejected
(predictions need images). Declare the service `eventual` — stream delivery
lags the writes that cause it.

`seed()` puts records directly (values must include the table's key
attributes). `read()` scans the table for `contains` assertions as
`ITEM`-typed records. AWS SDK v3 clients are real dependencies: DynamoDB
requires SigV4 signing.

## Access model

**Config carries credential references, never values** — the config is
committed and hashed into generated suites. `options.auth` takes exactly one
form (several at once is a configuration error):

```jsonc
"auth": { "profile": "acme-staging-observer" }                  // named profile (local dev)
"auth": { "roleArn": "arn:aws:iam::…:role/feat-observer" }      // assume-role (enterprise CI; OIDC web identity works)
"auth": { "accessKeyIdEnv": "FEAT_AWS_KEY",                     // env-var NAMES for static keys (escape hatch)
          "secretAccessKeyEnv": "FEAT_AWS_SECRET" }
```

Absent `auth` = the SDK default chain. **Shared/live environments are
observe-only** — the adapter never creates or mutates infrastructure it
evidences. The read-only observer policy an environment's owner provisions:

```json
{ "Version": "2012-10-17", "Statement": [{
  "Effect": "Allow",
  "Action": ["dynamodb:DescribeTable", "dynamodb:Scan",
             "dynamodb:DescribeStream", "dynamodb:GetShardIterator", "dynamodb:GetRecords"],
  "Resource": ["arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE",
               "arn:aws:dynamodb:REGION:ACCOUNT:table/TABLE/stream/*"] }]}
```

(`seed()` additionally needs `dynamodb:PutItem` — grant it only where `given:`
seeding is used.)

## Ephemeral mode — zero credentials, zero IaC

For teams with no cloud access at all, the adapter scaffolds its own
instrument: a private DynamoDB Local container + table + stream, created at
`setup()` and removed at teardown. A real DynamoDB engine, not a mock.

```jsonc
"options": { "ephemeral": { "table": "feat-local", "partitionKey": "PK", "sortKey": "SK" } }
```

Mutually exclusive with `table`/`tableEnv`/`endpoint`/`auth`; needs docker.
Alternatively point `endpoint` at a DynamoDB Local you run yourself
(`docker run -p 8000:8000 amazon/dynamodb-local` — the adapter's own suite
runs against the real engine either way).

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT

## Query mode, snapshot diff, namespace and faults (SPEC-ADPDDB-001, -002)

- **Query mode.** `contains` hands `read()` the predicted records' literal keys: a full primary key reads with
  `GetItem`, a partition key alone with `Query`, anything else with a `Scan` of the namespace, all with
  `ConsistentRead`. A hint may return a superset, never fewer.
- **Snapshot diff.** `options.stream: false` serves the diff from two consistent reads of the namespace compared by
  primary key; no Streams permission is needed. It cannot see an item written and deleted (or overwritten with an
  identical image) inside the window, and declares itself `snapshot`. `settle()` vouches inside a window.
  Native diff (the default) is unchanged and vouches only with `fence: true` and one open shard.
- **Namespace.** The runner hands the adapter its namespace (`^s[0-9a-f]{12}$`); stored partition keys are
  `<ns>#<pk>`, the prefix is added to seeds and read hints and stripped from every reported key, and capture and read
  ignore keys outside the prefix. The partition key must be a string (`NAMESPACE_KEY_NOT_STRING`). Without a
  namespace the adapter behaves as before.
- **Faults.** `PutItem.CONDITIONAL_CHECK_FAILED {pk, sk}` (until reset) writes an instrument item at the key, so
  DynamoDB itself refuses the system's `attribute_not_exists` put. `Connection.Timeout | ConnectionReset |
  Partition` (until reset) need `options.proxy: { api, name?, upstream?, container?, metrics?, runtime? }`: a Toxiproxy
  in front of DynamoDB through `@mmmnt/feat-fault-proxy`; the adapter's own clients never use it. `Timeout` is armed on
  the request path, so the product never applies the write. Nothing reports a refused request, so there is no
  `firedFaults` (evidence `unobserved`). Throttling cannot be produced by DynamoDB Local and is not offered.
- **Tests.** `query-mode.test.ts` and `transport.test.ts` are generated; their probe
  (`fixtures/query-probe.mjs`) starts throwaway `amazon/dynamodb-local:2.6.1`, `ghcr.io/shopify/toxiproxy:2.12.0` and
  `node:22.12.0-slim` containers named `feat-dynamodb-test-*` with fake credentials, and removes them on exit. They run
  under `feat run`, not under the package's `test` script. On Docker Desktop the system's client must run inside the
  Toxiproxy container's network namespace, which the probe does.
