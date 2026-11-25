# @mmmnt/feat-adapter-kms

The AWS KMS service adapter for Feature. It turns a KMS endpoint's key state into a capture window by snapshot diff: it snapshots the namespace's keys, aliases, tags and rotation status when the window opens and compares at the end, so every key the system created, changed or scheduled for deletion becomes a captured `INSERT`, `MODIFY` or `REMOVE` record, and an unpredicted key change fails the case by prediction inversion. It also reads key state for `contains`, seeds keys, and injects key and transport faults. It is built on `@aws-sdk/client-kms`.

Its specs run against [local-kms](https://github.com/nsmithuk/local-kms) with throwaway credentials; a normal test setup never contacts AWS.

## Installation

Requires Node.js 22 or newer.

```bash
npm install -D @mmmnt/feat-adapter-kms
```

`@aws-sdk/client-kms` (pinned at 3.1164.0) and `@mmmnt/feat-fault-proxy` are regular dependencies. The supported emulator is `nsmithuk/local-kms`, which serves KMS on port 8080.

## Usage

```jsonc
// feat.config.json, under "services"
"keys": {
  "adapter": "@mmmnt/feat-adapter-kms",
  "consistency": "eventual",
  "convergenceTimeout": 2500,
  "options": {
    "endpointEnv": "FEAT_KMS_ENDPOINT",
    "region": "eu-west-2",
    "auth": { "accessKeyIdEnv": "FEAT_KMS_KEY_ID", "secretAccessKeyEnv": "FEAT_KMS_SECRET" },
    "emulator": "local-kms"
  }
}
```

```feat
scenario "a key is created under the namespace alias":
  given:
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

In a test config set both `endpoint` (or `endpointEnv`) and `auth`: without `auth` the SDK default chain applies, which on a developer machine can find real AWS credentials.

## Options

| Option | Meaning |
| --- | --- |
| `endpoint` | The KMS API origin. Absent (and no `endpointEnv`): the SDK default endpoint. |
| `endpointEnv` | Name of an environment variable holding the origin. Both set, or the variable unset or empty, is a configuration error at `setup()`. |
| `region` | Passed to the SDK client. |
| `auth` | `{ accessKeyIdEnv, secretAccessKeyEnv, sessionTokenEnv? }`: names of environment variables, each of which must be set. Absent: the SDK default chain. |
| `emulator` | `"local-kms"` (the only value) declares a single-process emulator whose reads follow its writes, so `settle()` may vouch. |
| `settleTimeoutMs` | Accepted for parity with the other adapters; not used. |
| `proxy` | Toxiproxy in front of the endpoint for `Connection` faults: `api` and `upstream` required; `container`, `metrics`, `runtime` passed to the library. The proxy is `feat-<ns>-kms` (no `name` option). |

Unknown option keys are ignored. The adapter's own client connects to the endpoint directly, never through the proxy, with at most two attempts per request.

## Observation

The adapter declares `observes = { diff: "snapshot", state: true }`; nothing in KMS emits changes.

- **Snapshot.** For every key in the namespace: `ListKeys`, `DescribeKey`, `ListResourceTags`, `GetKeyRotationStatus`, `ListAliases`. `startCapture()` takes one; `peekCapture()` and `stopCapture()` take another and diff by identity.
- **What it sees:** a key created; its state (`Enabled`, `Disabled`, `PendingDeletion`), description, rotation, user tags and aliases. Scheduling deletion is a `MODIFY`, not a `REMOVE`.
- **What it cannot see:** cryptographic use (`Encrypt`, `Decrypt`, `Sign`, `GenerateDataKey`), key policy and grants.
- **Settle** answers `true` only inside a window with `emulator: "local-kms"`; otherwise `false`, since AWS documents KMS as eventually consistent, and the wait is the full `convergenceTimeout`.

A captured record:

```
{ type: INSERT | MODIFY | REMOVE, key: <identity>,
  payload: { keyState, enabled, keySpec, keyUsage, description, rotationEnabled, tags, aliases } }
```

- **Identity** is the key's first namespaced alias relative to the namespace (`alias/<ns>/orders` is `orders`), else its `Name` tag, else its random `KeyId`. Deleting a key's only alias reads as a `REMOVE` plus an `INSERT`.
- `tags` are the user tags (`feat:*` tags are never reported); `aliases` are relative and sorted; `rotationEnabled` is `false` when KMS refuses the status.
- Records are sorted by key. `read()` returns the same shape with `type: "Key"`; a `contains` whose records all carry a `key.alias` literal is answered by `DescribeKey` on each alias, otherwise the namespace is listed.

## Namespace, seeds and reset

The adapter requires the runner's namespace (`^s[0-9a-f]{12}$`; otherwise `NAMESPACE_INVALID`). A key is in the namespace when it has the tag `feat:namespace=<ns>` or any alias under `alias/<ns>/`; the system under test must create its keys one of those ways.

- **`seed`**: each record needs `values.alias` (relative); optional `values.description` (string) and `values.tags` (string map). The adapter calls `CreateKey` with the namespace tag (a symmetric key) and `CreateAlias alias/<ns>/<alias>`, before the window.
- **`reset()`** restores faulted keys (in reverse order, reporting the first failure after trying all), disarms transport faults, then for each namespace key cancels a deletion the system scheduled, deletes its namespaced aliases, removes the namespace tag and schedules deletion with the 7-day minimum. Keys therefore linger in `PendingDeletion` outside every namespace.

## Faults

Every fault is `until reset`; any other count is `FAULT_UNSUPPORTED`. No refusal is recorded, so evidence is `unobserved`. `UseKey` faults change the key after the seeds and before the window, so they are part of the baseline.

| Fault | Detail | Effect |
| --- | --- | --- |
| `UseKey DISABLED` | `{ alias }` | `DisableKey`; a use is refused with `DisabledException`. Restored with `EnableKey`. |
| `UseKey PENDING_DELETION` | `{ alias }` | `ScheduleKeyDeletion` (7 days); a use is refused with `KMSInvalidStateException`. Restored with `CancelKeyDeletion` then `EnableKey`. |
| `UseKey ALIAS_NOT_FOUND` | `{ alias }` | `DeleteAlias`; a use through the alias is refused with `NotFoundException`. Restored with `CreateAlias`. |
| `Connection Timeout` | none | With `proxy`. The stream stalls (downstream, the library default). |
| `Connection ConnectionReset` | none | With `proxy`. The connection is reset (upstream). |
| `Connection Partition` | none | With `proxy`. The proxy is disabled. |

The `UseKey` alias must already exist in the namespace (seed it first). Point the system's KMS client at the proxy address that the asynchronous `proxyListen()` reports. Not offered: throttling, access-denied, `BrokerLoss`.

## Errors

`KmsAdapterError`s carry `code` and `detail`.

| Code | Raised by | When |
| --- | --- | --- |
| `NAMESPACE_INVALID` | construction | The namespace is missing or off the pattern. |
| `KMS_UNREACHABLE` | `setup()` | The endpoint gave no HTTP answer to `ListKeys`. An endpoint that answers with an error surfaces the SDK's error instead. |
| `FAULT_TARGET_MISSING` | `fault()` | A `UseKey` fault without `detail.alias`, or the alias is not in the namespace. |
| `FAULT_UNSUPPORTED` | `fault()` | Not in the catalog (including `Connection` without `proxy`), or not `until reset`. |

Plain `Error`s report `endpoint` with `endpointEnv`, an unset `endpointEnv` or `auth` variable, a seed without `values.alias`, and a call before `setup()`. Toxiproxy errors keep the `@mmmnt/feat-fault-proxy` codes.

## Limitations

- A real KMS endpoint is accepted but not exercised by any of the adapter's specs.
- Each snapshot (and an unhinted `read()`) describes every key on the endpoint, eight at a time; keep the endpoint small.
- Toxiproxy is yours to run.

The generated suites start throwaway local-kms and Toxiproxy containers, so they run under `feat run`, not the package's `test` script.

## See also

- Specs: [observe.feat](observe.feat) (SPEC-ADPKMS-001), [transport.feat](transport.feat) (SPEC-ADPKMS-002)
- [DESIGN.md](DESIGN.md): the client and emulator, the snapshot, the settle claim, the namespace and the faults
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
pnpm build --filter=@mmmnt/feat-adapter-kms
pnpm --filter @mmmnt/feat-adapter-kms test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
