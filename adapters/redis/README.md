# @mmmnt/feat-adapter-redis

Redis service adapter for Feat (SPEC-ADPRDS-001): a snapshot diff of the namespace's keys, state by key or namespace
scan, seeding, reset, and the instrument's credential and CA read from files.

```json
{
  "services": {
    "cache": {
      "adapter": "@mmmnt/feat-adapter-redis",
      "options": {
        "urlFile": "secrets/redis.url",
        "auth": { "user": "default", "passwordFile": "secrets/redis.password" }
      }
    }
  }
}
```

Options: `url` | `urlEnv` | `urlFile` (redis:// or rediss://, never with credentials in it); `auth` either
`{ username?, password }` (environment-variable names) or `{ user, passwordFile }` (`default` for a requirepass server);
`tlsCAFile` (PEM, rediss:// only).

The system under test writes every key under the namespace prefix `<namespace>:`. Records:
`{ type: INSERT | MODIFY | REMOVE, key: <without the prefix>, payload: { key, kind, value } }` (the key in the payload too, so a prediction can name it), kinds string, set, hash,
list, zset. Seeds: `{ type: <kind>, values: { key, value } }`. The fault catalog is empty. See DESIGN.md.

## Seed transform and storable seeds (SPEC-ADPRDS-002, ADR-0035)

`options.seedTransform: { host: { command: [...], cwd?, env? } }` names a spec host that
transforms every seed call's records before they are written (a consumer computing a value
only it can, e.g. a vector from its own pinned encoder). The adapter joins the spec file's
shared host (@mmmnt/feat-adapter-stdio-jsonrpc; the same process as a response role with the
same `host`), asks the optional protocol method `transformSeed` **twice** per seed call, and
writes the first answer only when both agree as canonical JSON and each keeps the records'
count, order, type and identity. Seeds only: what the adapter captures and reads is what is
stored. Every seed, transformed or plain, is checked against what Redis can store before
anything is written: a value fits its kind (string; a non-empty list of strings for set and list; a non-empty map of string fields for hash; `{ member, score }` items with a finite score for zset). A value that does not fit is now `SEED_VALUE_UNSTORABLE`; `SEED_INVALID` is an unknown kind or a missing key.

Refusals: `OPTIONS_INVALID` (no command), `SEED_TRANSFORM_UNAVAILABLE` (the host cannot be
started, at setup), `SEED_TRANSFORM_FAILED` (an error, method not found, the host ended, or a
changed count, order, type or identity), `SEED_TRANSFORM_NONDETERMINISTIC` (the two answers
differ), `SEED_VALUE_UNSTORABLE`.
