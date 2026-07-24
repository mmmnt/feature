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
`ITEM`-typed records. Credentials come from the standard AWS chain, never
config; `endpoint` points at [DynamoDB
Local](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.html)
(`docker run -p 8000:8000 amazon/dynamodb-local` — the adapter's own suite
runs against it for real). AWS SDK v3 clients are real dependencies: DynamoDB
requires SigV4 signing.

Part of [Feature](https://github.com/mmmnt/feature) — the `.feat` execution
specification language. Docs: https://github.com/mmmnt/feature/wiki

MIT
