# @mmmnt/feat-adapter-redis

Redis service adapter for [Feature](../../README.md). It observes the keys the system under test writes under the
run's namespace: a capture window is a snapshot diff of those keys, `contains` reads them back by key or by a scan of
the namespace, `seed` writes keys of every kind the adapter reads, and `reset` removes the namespace's keys between
cases. The instrument's URL, password and CA can be read from files (SPEC-ADPRDS-001). It is built on the official
`redis` client (node-redis 6.3.1).

## Installation

Requires Node.js 22 or newer.

```sh
npm install -D @mmmnt/feat-adapter-redis
```

The project also needs `@mmmnt/feature` and a Redis server the run can reach.

## Configuration

```jsonc
// feat.config.json
"services": {
  "cache": {
    "adapter": "@mmmnt/feat-adapter-redis",
    "consistency": "strong",
    "options": {
      "urlFile": "secrets/redis.url",
      "auth": { "user": "default", "passwordFile": "secrets/redis.password" }
    }
  }
}
```

| Option | Type | Meaning |
| --- | --- | --- |
| `options.url` | string | `redis://` or `rediss://` (TLS). It must not carry credentials: give them in `auth`. |
| `options.urlEnv` | string | The name of an environment variable holding the URL. |
| `options.urlFile` | string | Path of a file whose content is the URL. |
| `options.auth` | object | Optional. Either `{ username?, password }`, where both are **names of environment variables** (omit `username` for the `default` user), or `{ user, passwordFile }`, where `user` is the ACL user name itself (`default` for a `requirepass` server) and `passwordFile` a path. Never both forms. |
| `options.tlsCAFile` | string | Path of a PEM file of the CA the server's certificate is verified against. Only with a `rediss://` URL. |
| `options.seedTransform` | object | Optional. `{ host: { command: [...], cwd?, env? } }`: a spec host that transforms seeds before they are written (see below). |

Give one URL source. `urlFile` with `url` or `urlEnv` is `OPTIONS_INVALID`; with `url` and `urlEnv` both set and no
`urlFile`, `url` is used.

Files are read at setup, before any connection, relative to the working directory. Exactly one trailing LF or CRLF is
removed from the URL and password files and nothing else; the CA file is read as is. A refusal names the option, the
path and the cause, never the content. The password is passed to the client apart from the URL.

Declare the service `strong` or `acid`: `settle()` vouches whenever a window is open (see Observation).

## Example

The system under test writes every key under the prefix `<namespace>:`. It learns the namespace from `FEAT_NAMESPACE`,
which the runner sets for each spec file.

```feat
contract:
  input LoginInput
  response LoginResponse
  record CacheEntry
  record CacheSeed

scenario "a login stores a session":
  given:
    seed cache [ hash with CacheSeed { key: "user:alice", value: { plan: "pro" } } ]
  when: Login { user: "alice" }
  predict success:
    response OK LoginResponse { session: "sess-1" }
    cache has [ INSERT with CacheEntry { key: "session:sess-1", kind: "string", value: "alice" } ]
    cache contains [ string with CacheEntry { key: "session:sess-1", kind: "string", value: "alice" } ]
```

The seeded hash is written before the window opens, so it is not captured. `cache has []` asserts that the case wrote
no key.

## Observation

The adapter declares `observes = { diff: "snapshot", state: true }`.

**The window.** `startCapture` scans the keys matching `<namespace>:*` and reads each one by its type.
`peekCapture` and `stopCapture` read again and compare by key:

| Record `type` | When |
| --- | --- |
| `INSERT` | The key is new. The payload is its value now. |
| `MODIFY` | The key's value changed. The payload is its value now. |
| `REMOVE` | The key is gone. The payload is the value it had. |

Each record is `{ type, key, payload: { key, kind, value }, timestamp }`, with the key **without** the namespace
prefix, in key order. The key is in the payload as well, because predictions match the payload. Keys without the
prefix are never reported. A snapshot diff cannot see a key created and removed inside the window. `peekCapture`
does not close the window; with no window open, both return `[]`.

**Kinds.** `kind` and `value`:

| `kind` | `value` |
| --- | --- |
| `string` | the string |
| `set` | the members, sorted |
| `hash` | an object of the fields, sorted by field |
| `list` | the items, in order |
| `zset` | `[{ member, score }]` in score order |

A namespaced key of any other type (a stream, a module type) fails the case with `KIND_UNSUPPORTED`.

**State.** `contains` calls `read()`. When every predicted record states a literal `key` (or an `@when` reference that
resolves to one), the adapter looks up exactly those keys; otherwise it scans the namespace. A state record is
`{ type: <kind>, key, payload: { key, kind, value } }`.

**Settle.** `settle()` is `true` with a window open and `false` without one. Redis runs one command at a time, so a
command the system has had answered is applied before the adapter's next read. It cannot see a write the system has
not sent yet.

## Seeds

`seed cache [ <kind> with <Schema> { key: "<key>", value: <value> } ]`. The record type is the kind, and the values are
`{ key, value }`. Each key is written under the namespace prefix, all of one seed call in one `MULTI`, before the window
opens.

| Kind | `value` must be |
| --- | --- |
| `string` | a string |
| `set`, `list` | a non-empty array of strings |
| `hash` | a non-empty object whose fields are strings |
| `zset` | a non-empty array of `{ member, score }`, `member` a string and `score` a finite number |

A type that is not one of the kinds, or a `key` that is not a non-empty string, is `SEED_INVALID`. A value that does not
fit its kind is `SEED_VALUE_UNSTORABLE`. Both are checked before anything is written.

### Seed transform (SPEC-ADPRDS-002, ADR-0035)

`options.seedTransform: { host: { command, cwd?, env? } }` names a spec host that transforms every seed call's records
before they are written, for a value only the consumer can compute (for example a vector from its own pinned encoder).
The adapter joins the spec file's shared host (`@mmmnt/feat-adapter-stdio-jsonrpc`; the same process as a response
role with the same `host`) at setup and asks the optional protocol method `transformSeed` **twice** per seed call. It
writes the first answer only when both answers agree as canonical JSON and each keeps the records' count, order, type
and key. The transformed records are then checked like any other seed. Only seeds are transformed: what the adapter
captures and reads is what is stored.

## Reset and faults

`reset()` unlinks every key of the namespace and closes the window. The fault catalog is empty: every Redis-level fault
(CONFIG, ACL, CLIENT PAUSE, maxmemory) is server-wide and would fault every other namespace's run on a shared server, so
any `fault cache ...` line is `FAULT_UNSUPPORTED`.

## Errors

`RedisAdapterError { code, detail }`:

| Code | When |
| --- | --- |
| `NAMESPACE_INVALID` | At creation: the namespace does not match `^s[0-9a-f]{12}$`, the pattern the runner derives. |
| `OPTIONS_INVALID` | No URL; a URL that is not `redis://`/`rediss://` or that carries credentials; `urlFile` with another URL source; `auth` mixing its two forms, naming neither a password variable nor a `passwordFile`, or the file form without `user`; `auth` variables that are not set; `tlsCAFile` without `rediss://`; a malformed `seedTransform`. |
| `CREDENTIAL_FILE_UNREADABLE` | A file the options name is missing, a directory, unreadable or empty. |
| `REDIS_UNREACHABLE` | At setup: the server did not answer `PING` (including a TLS certificate that `tlsCAFile` does not verify). |
| `KIND_UNSUPPORTED` | A namespaced key holds a type the adapter does not read. |
| `SEED_INVALID` | A seed's type is not a kind, or its key is not a non-empty string. |
| `SEED_VALUE_UNSTORABLE` | A seed's value does not fit its kind. |
| `FAULT_UNSUPPORTED` | Any fault is armed. |
| `SEED_TRANSFORM_UNAVAILABLE` | At setup: the seed-transform host could not be started or did not set up. |
| `SEED_TRANSFORM_FAILED` | The host answered an error, does not implement `transformSeed`, ended, or changed the count, order, type or key. |
| `SEED_TRANSFORM_NONDETERMINISTIC` | The two answers differ. |

## Specs

- [SPEC-ADPRDS-001, the adapter](observe.feat)
- [SPEC-ADPRDS-002, seed transform and storable seeds](seed-transform.feat)
- [Design notes](DESIGN.md)
- [ADR-0035, seed transform](../../docs/adr/ADR-0035-seed-transform.md)

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
pnpm build --filter=@mmmnt/feat-adapter-redis
pnpm --filter @mmmnt/feat-adapter-redis test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
