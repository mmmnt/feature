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
`{ type: INSERT | MODIFY | REMOVE, key: <without the prefix>, payload: { kind, value } }`, kinds string, set, hash,
list, zset. Seeds: `{ type: <kind>, values: { key, value } }`. The fault catalog is empty. See DESIGN.md.
