# @mmmnt/feat-adapter-kms

Service adapter for Feat that turns **a KMS endpoint's key state into a capture
window by snapshot diff**: the adapter snapshots the namespace's keys, aliases,
tags and rotation status when the window opens and compares at the end, so every
key the system created, changed or scheduled for deletion becomes a captured
`INSERT`, `MODIFY` or `REMOVE` record. An unpredicted key change fails the suite
by prediction inversion. The adapter is built on the official
`@aws-sdk/client-kms`.

**Tests run against local-kms with fake static credentials. The adapter never
needs AWS for testing.** Point `endpoint` at a local-kms container and give it
throwaway credentials by environment-variable name; nothing in the adapter's own
suites, in this README's examples, or in a normal test setup contacts AWS.

```jsonc
// feat.config.json
"services": {
  "keys": {
    "adapter": "@mmmnt/feat-adapter-kms",
    "consistency": "eventual",
    "convergenceTimeout": 2500,
    "options": {
      "endpointEnv": "FEAT_KMS_ENDPOINT",          // or "endpoint": "http://localhost:8080"
      "region": "eu-west-2",
      "auth": { "accessKeyIdEnv": "FEAT_KMS_KEY_ID", "secretAccessKeyEnv": "FEAT_KMS_SECRET" },
      "emulator": "local-kms"
    }
  }
}
```

```
predict success:
  response 201 KeyCreated { alias: "orders" }
  keys has [ INSERT with KeyRow { aliases: ["orders"], keyState: "Enabled", enabled: true } ]
```

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## What it observes, and how

The adapter declares `observes = { diff: "snapshot", state: true }`. Nothing in
KMS, or in local-kms, emits changes, so the diff compares two snapshots.

- **Snapshot.** For every key in the namespace the adapter reads `ListKeys`,
  `DescribeKey`, `ListResourceTags`, `GetKeyRotationStatus` and `ListAliases`.
  `startCapture()` takes the first snapshot; `peekCapture()` and `stopCapture()`
  take another and diff by identity.
- **What it sees.** A key created, its state (`Enabled`, `Disabled`,
  `PendingDeletion`), its description, its rotation status, its user tags and its
  aliases. Scheduling a key for deletion is a `MODIFY` (state becomes
  `PendingDeletion`), not a `REMOVE`.
- **What it cannot see.** Any cryptographic use of a key (`Encrypt`, `Decrypt`,
  `Sign`, `GenerateDataKey`) leaves no state behind. "This key was not used" is
  unprovable here; a spec that predicts use needs another instrument (CloudTrail
  on a real account, which is out of scope). Key policy changes are not
  snapshotted either.
- **Settle.** `settle()` answers `true` only when a window is open **and**
  `options.emulator` is `"local-kms"`: a single-process emulator whose reads
  follow its acknowledged writes. Otherwise it answers `false`, because AWS
  documents KMS as eventually consistent: a change "might not be immediately
  visible", typically within seconds and sometimes minutes. The emulator claim is
  by construction, not independently verified. An empty window settles `true`
  under the emulator, which is how an absence is proven. It writes nothing.
- **No `deliver()`.**

Declare the service `eventual`. With `emulator: "local-kms"`, `settle()` ends the
convergence wait on proof; without it, the wait is always the full
`convergenceTimeout`. `eventual` services compare predictions unordered by
default.

### The captured record

```
{ type: INSERT | MODIFY | REMOVE, key: <identity>,
  payload: { keyState, enabled, keySpec, keyUsage, description,
             rotationEnabled, tags, aliases },
  timestamp: <capture time> }
```

Records are sorted by key. The specs' probe writes a record as `TYPE:key`, for
example `INSERT:orders,MODIFY:signing`; that is the same `(type, key)` pair.

- **Identity (`key`).** The key's first namespaced alias, relative to the
  namespace (`alias/<ns>/orders` is `orders`), else its `Name` tag, else its
  `KeyId`. A `KeyId` is random, so a spec cannot name a key that has neither an
  alias nor a `Name` tag. Deleting a key's **only** alias therefore changes its
  identity, and reads as one `REMOVE` (the alias identity) plus one `INSERT` (the
  new identity).
- **`tags`** holds the user tags; tags starting `feat:` are never reported.
  **`aliases`** are relative to the namespace and sorted.
- **`rotationEnabled`** is `false` when KMS refuses the status (asymmetric keys,
  some key states) rather than a failure.
- `REMOVE` carries the key's last known payload. `MODIFY` fires when the key
  state, `enabled`, description, rotation, user tags or aliases differ.
- `read()` returns the same shape with `type` `"Key"` and no diff.

## Install

```sh
npm install --save-dev @mmmnt/feature @mmmnt/feat-adapter-kms
```

- Node 20 or later (`engines.node` is `>=20`). The adapter is ESM.
- No peer dependencies. `@aws-sdk/client-kms` (pinned at 3.1164.0) and
  `@mmmnt/feat-fault-proxy` are regular dependencies.
- The supported emulator is `nsmithuk/local-kms`, the image the adapter's tests
  use, pinned by digest
  (`sha256:e070866476b20973a9e23a9b636204b7a222e4169a6e03198d27b80d47ed28e3`, a
  build of 2026-02-28 with no version tag). It serves KMS on port 8080, with a
  dummy account and region (the tests use region `eu-west-2`; the container's
  `KMS_ACCOUNT_ID` and `KMS_REGION` set the dummies). The transport specs add
  `ghcr.io/shopify/toxiproxy:2.12.0`.
- The adapter also accepts a real KMS endpoint, by omitting `endpoint` (the SDK
  default) and supplying real credentials. **That path is not exercised by any of
  the adapter's specs.** `settle()` never vouches there, so predictions rest on
  `convergenceTimeout`.
- The package ships `dist/` only. Its `fixtures/` helpers are internal.

### Credentials: never AWS in tests

`options.auth` takes the **names** of environment variables, never values. Set
them to throwaway strings (the adapter's own suites use `local` and `local`)
and set `endpoint` to local-kms. If you omit `auth`, the SDK default credential
chain applies, which on a developer machine can find real AWS credentials. In a
test config, always set both `endpoint` and `auth`, so that a missing variable is
a configuration error rather than a call to AWS.

## Configuration

A complete service entry. Every option is optional.

```jsonc
"services": {
  "keys": {
    "adapter": "@mmmnt/feat-adapter-kms",
    "consistency": "eventual",
    "convergenceTimeout": 2500,
    "options": {
      "endpointEnv": "FEAT_KMS_ENDPOINT",                // name of the variable holding the KMS API origin
      // "endpoint": "http://localhost:8080",            // or a literal; at most one of endpoint / endpointEnv
      "region": "eu-west-2",                             // the SDK region; local-kms accepts any
      "auth": {                                          // env-var NAMES holding static credentials, never the values
        "accessKeyIdEnv": "FEAT_KMS_KEY_ID",
        "secretAccessKeyEnv": "FEAT_KMS_SECRET",
        "sessionTokenEnv": "FEAT_KMS_SESSION_TOKEN"      // optional
      },
      "emulator": "local-kms",                           // lets settle() vouch; the only accepted value
      "settleTimeoutMs": 5000,                           // accepted for parity with the other product adapters; an emulator needs no wait
      "proxy": {                                         // transport faults on the system's path
        "api": "http://127.0.0.1:8474",                  // Toxiproxy API
        "upstream": "127.0.0.1:8080",                    // host:port of the KMS endpoint, as Toxiproxy reaches it
        "container": "local-kms",                        // accepted, but BrokerLoss is not offered by this adapter
        "metrics": "http://127.0.0.1:8474/metrics",      // Toxiproxy /metrics URL
        "runtime": "docker"                              // container runtime CLI; default "docker"
      }
    }
  }
}
```

| Option | Meaning |
| --- | --- |
| `endpoint` | The KMS API origin, literally. Absent (and no `endpointEnv`) means the SDK default endpoint. |
| `endpointEnv` | The name of an environment variable holding the origin. Setting **both** `endpoint` and `endpointEnv`, or naming a variable that is unset or empty, is a configuration error at `setup()`. |
| `region` | Passed to the SDK client. Absent: the SDK's own resolution. |
| `auth` | `accessKeyIdEnv` and `secretAccessKeyEnv` (required together), and optionally `sessionTokenEnv`: the **names** of variables, each of which must be set. Absent: the SDK default chain. |
| `emulator` | `"local-kms"` declares a single-process emulator whose reads follow its writes, so `settle()` may vouch. Absent: `settle()` always answers `false`. |
| `settleTimeoutMs` | Accepted and not used: an emulator needs no wait. |
| `proxy` | A Toxiproxy in front of the endpoint for `Connection` faults. `api` and `upstream` are required. The proxy's name is `feat-<ns>-kms`; there is no `name` option. |

The adapter does not reject unknown keys under `options`; a misspelled option is
ignored. The adapter's own client (snapshots, seeds, faults, reset) connects to
`endpoint` **directly** and never through the proxy. It attempts each request at
most twice (`maxAttempts: 2`).

## A minimal spec

```
feat 1.0

spec SPEC-KEY-010 "ProvisionSigningKey creates an aliased key"
context Platform
aggregate Keys
type command
status agreed

construct:
  handler at features/provision-key/handler.ts
  touches features/provision-key/**

enforce:
  create a key and the alias alias/<namespace>/orders
  rejects KEY_UNUSABLE when the key is disabled

contract:
  input ProvisionSigningKeyInput
  response KeyCreated
  record KeyRow
  error Refusal

scenario "a key is created under the namespace alias":
  given:
    A signing key already exists.
    seed keys [ Key with KeyRow { alias: "signing", description: "signing key" } ]
  when: ProvisionSigningKey { alias: "orders" }
  predict success:
    response 201 KeyCreated { alias: "orders" }
    keys has [ INSERT with KeyRow { aliases: ["orders"], keyState: "Enabled", enabled: true } ]

scenario "a disabled key is refused":
  given:
    seed keys [ Key with KeyRow { alias: "signing" } ]
    fault keys UseKey DISABLED { alias: "signing" } until reset
  when: ProvisionSigningKey { alias: "signing" }
  predict rejection KEY_UNUSABLE:
    response 409 Refusal { code: "KEY_UNUSABLE" }
    keys has []
```

A seed record's `values.alias` is required, relative to the
namespace: `CreateKey` with the tag `feat:namespace=<ns>` plus `CreateAlias`
`alias/<ns>/<alias>`. `values.description` (a string) and `values.tags` (a
string-to-string map) are optional. Seeds make symmetric keys, before the window,
so they are never in a capture; a seed without `values.alias` is a configuration
error. The fault line must say `until reset`, and its detail `alias` must name an
alias that already exists in the namespace, so seed it first.

## Namespaces

The runner derives a namespace per spec file, exactly `^s[0-9a-f]{12}$`
(SPEC-RT-006), and hands it to the adapter as the config's top-level
`namespace`. It is never an option.

- A key is **in the namespace** when it carries the tag `feat:namespace=<ns>`, or
  has any alias starting `alias/<ns>/`. Either is enough. The system under test
  must create its keys one of those ways; a key with neither is nobody's effect.
- Reported aliases and the identity drop the `alias/<ns>/` prefix. `feat:*` tags
  are never reported.
- `reset()` takes the namespace's keys out of the namespace and schedules them
  for deletion. First it restores every faulted key (see below), disarms any
  transport fault, and snapshots the namespace. Then, for each key, it cancels a
  deletion the system had scheduled (tag calls fail on a key that is pending
  deletion), deletes the key's namespaced aliases, removes the
  `feat:namespace` tag, and calls `ScheduleKeyDeletion` with the 7-day minimum
  pending window. The keys therefore stay in the KMS in `PendingDeletion` for
  seven days, outside every namespace. Other namespaces are left alone.

## Read

`read()` returns the namespace's keys. A `contains` assertion that carries a
`key.alias` literal makes the adapter call `DescribeKey` on `alias/<ns>/<alias>`
for each hinted alias instead of listing; if any entry has no alias, the whole
namespace is listed. Fault effects (a disabled key) are reported as they are.

## Faults

All faults are armed `until reset`. KMS reports no request it refused, so
`firedFaults` is not implemented and evidence is `unobserved`. A fault line with
any other count is refused with `FAULT_UNSUPPORTED` before it has an effect.

The `UseKey` faults are real KMS refusals, **produced by changing the key**. They
are armed after the seeds and before the window opens, so they are part of the
baseline: a capture shows no `MODIFY` for the fault itself, and a `read()` shows
the faulted state.

| Fault | Operation | Counts | Detail | What the system sees |
| --- | --- | --- | --- | --- |
| `DISABLED` | `UseKey` | `until reset` | `{ alias }` (required) | `DisableKey` on the aliased key. A use of the key is refused with `DisabledException`. |
| `PENDING_DELETION` | `UseKey` | `until reset` | `{ alias }` (required) | `ScheduleKeyDeletion` (7 days) on the aliased key. A use is refused with `KMSInvalidStateException`. |
| `ALIAS_NOT_FOUND` | `UseKey` | `until reset` | `{ alias }` (required) | `DeleteAlias` on `alias/<ns>/<alias>`, remembering the key. A use through the alias is refused with `NotFoundException`. |
| `Timeout` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy stalls the stream and never delivers; the system's call runs into its own deadline. Armed downstream (the library default; the adapter passes no direction), so an established connection can have a request applied whose answer the system never hears. |
| `ConnectionReset` | `Connection` | `until reset` | none | Needs `options.proxy`. Toxiproxy resets the connection (default direction upstream, on the request path). |
| `Partition` | `Connection` | `until reset` | none | Needs `options.proxy`. The proxy is disabled: the system's connections fail. |

`reset()` restores faulted keys first, in reverse order: `EnableKey` for
`DISABLED`; `CancelKeyDeletion` and then `EnableKey` for `PENDING_DELETION` (AWS
returns the key `Disabled`, local-kms returns it `Enabled`, and `EnableKey` is
idempotent, so both end `Enabled`); `CreateAlias` again for `ALIAS_NOT_FOUND`.
It reports the first failure after trying them all.

Not offered: throttling and access-denied (the emulator produces neither),
`BrokerLoss`, and `once` or `times` counts for every fault.

### Transport faults

Set `options.proxy` and the catalog gains `Connection.Timeout`,
`Connection.ConnectionReset` and `Connection.Partition`. The mechanism is
[`@mmmnt/feat-fault-proxy`](https://github.com/mmmnt/feature/blob/main/adapters/fault-proxy/README.md) (SPEC-FPX-001): one
Toxiproxy proxy per namespace, named `feat-<ns>-kms`. The proxy is opened at
`setup()`.

- A transport fault is on the **system's path only**. The adapter observes on its
  own direct client, so under a fault the capture, the settle and the state read
  still work, and an absence under a fault is still provable.
- Point the system's KMS client at the proxy's listen address, which the
  adapter's `proxyListen()` reports (it is asynchronous on this adapter). Under a
  transport fault the SDK reports a timeout or a connection error.
- Whether a fault was consumed is unobserved: the proxy reports bytes, not
  activations.
- Without `options.proxy` the catalog has no `Connection` entry, and arming one is
  refused with `FAULT_UNSUPPORTED`. `options.proxy.container` is passed to the
  library, but this adapter's catalog never offers `BrokerLoss`.

## Errors and refusals

Adapter errors are `KmsAdapterError`, with a `code` and a `detail`.

| Code | Raised by | When |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The namespace is missing or does not match `^s[0-9a-f]{12}$`. Defensive: the runner never passes another. |
| `KMS_UNREACHABLE` | `setup()` | The endpoint gave no HTTP answer to `ListKeys` (connection refused, timeout). The detail names the endpoint. An endpoint that answers with an error, such as a rejected credential, surfaces the SDK's own error instead. |
| `FAULT_TARGET_MISSING` | `fault()` | A `UseKey` fault has no `detail.alias`, or the alias does not exist in the namespace. |
| `FAULT_UNSUPPORTED` | `fault()` | The fault is not in the catalog (including `Connection` without `options.proxy`), or the count is not `until reset`. |

Plain `Error`s (no code) report both `endpoint` and `endpointEnv` set, an
`endpointEnv` or `auth` variable that is not set, a seed without `values.alias`,
and a call before `setup()`. Errors from the Toxiproxy layer keep the codes of
`@mmmnt/feat-fault-proxy` (`PROXY_UNREACHABLE`, `PROXY_NOT_OPEN`,
`FAULT_UNSUPPORTED`, `CONTAINER_NOT_FOUND`, `CONTAINER_RUNTIME_UNAVAILABLE`).

## Limitations

- **No cryptographic use is observable.** The snapshot sees state; an `Encrypt`,
  `Decrypt`, `Sign` or `GenerateDataKey` leaves none.
- **Key policy changes are not snapshotted.** Grants are not either.
- **Settle vouches only for local-kms.** Against any other endpoint it answers
  `false` and the wait is the full `convergenceTimeout`. A real KMS endpoint is
  not exercised by any spec.
- **Identity is the first namespaced alias**, then the `Name` tag, then the random
  `KeyId`. A key without an alias or `Name` tag cannot be named in a spec.
- **Reset schedules deletion, it does not delete.** Seven days is the KMS
  minimum, so reset leaves `PendingDeletion` keys behind on the endpoint.
- **Cost.** Each snapshot lists every key and calls `DescribeKey`,
  `ListResourceTags` and `GetKeyRotationStatus` for each (eight at a time), and
  `read()` without an alias hint does the same. Keep the endpoint small.
- Seeds make symmetric keys only.
- The system must create its keys with the `feat:namespace` tag or under
  `alias/<ns>/`; how the namespace reaches the system is the host's business.
- The `options.proxy` block needs a Toxiproxy server you run; the adapter does
  not start one.
- Options are not validated: unknown keys are ignored.

## Specs and design

- [`observe.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kms/observe.feat): SPEC-ADPKMS-001, snapshot diff of key state,
  namespace, settle, reset and faults.
- [`transport.feat`](https://github.com/mmmnt/feature/blob/main/adapters/kms/transport.feat): SPEC-ADPKMS-002, transport faults on the
  system's path (integration tier).
- [`DESIGN.md`](https://github.com/mmmnt/feature/blob/main/adapters/kms/DESIGN.md): the client and emulator, why the diff is a
  snapshot, the settle claim, the namespace and the faults, with sources. It is
  marked DRAFT.

The generated suites run under `feat run` against a throwaway local-kms
container (and Toxiproxy) that the fixture starts and removes on exit. They are
not part of the package's `test` script.

## License

MIT. Docs: https://github.com/mmmnt/feature/wiki
