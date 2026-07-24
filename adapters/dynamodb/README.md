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
      "endpoint": "http://127.0.0.1:8000"    // DynamoDB Local; omit for AWS
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
