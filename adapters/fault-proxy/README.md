# @mmmnt/feat-fault-proxy

Transport faults for Feature's product adapters, through [Toxiproxy](https://github.com/Shopify/toxiproxy). This is a library, not an adapter: an adapter calls it to implement the `Connection` operation of its fault catalog (`Timeout`, `ConnectionReset`, `Partition`, and `BrokerLoss` when the product runs in a container you name). The first-party DynamoDB, Kafka, Kurrent, Neo4j and KMS adapters use it. If you only write `.feat` specs you never import it; you configure the adapter that does (its `options.proxy`).

```
 system under test ──► Toxiproxy proxy feat-<ns>-<product> ──► product
                               ▲ arm / disarm (this library)
 adapter ──────────────────────┘
 adapter's own instrument connection ─────────────────────────► product
```

One proxy per namespace and product, so a fault armed for one spec file never reaches another file's namespace. The adapter's own capture, seed and read clients never go through the proxy, so a fault applies to the system's path only.

## Installation

Requires Node.js 22 or newer, a reachable Toxiproxy server (the package's specs use `ghcr.io/shopify/toxiproxy:2.12.0`; run it with `-proxy-metrics` for `traffic()`), and for `BrokerLoss`, `docker` or `podman` on the `PATH`.

```bash
npm install @mmmnt/feat-fault-proxy
```

## Usage

```ts
import { createFaultProxy, FaultProxyError } from "@mmmnt/feat-fault-proxy";

const proxy = createFaultProxy({
  api: "http://127.0.0.1:8474",            // Toxiproxy API
  product: "kurrent",                      // proxy name: feat-<namespace>-kurrent
  upstream: "127.0.0.1:2113",              // host:port, as Toxiproxy reaches the product
  namespace: "s0123456789ab",              // the runner's namespace
  container: "kurrent-1",                  // optional: adds BrokerLoss to the catalog
  metrics: "http://127.0.0.1:8474/metrics" // optional: for traffic()
});

const { listen } = await proxy.open();     // point the system under test at `listen`
try {
  await proxy.arm("Timeout");              // downstream unless a stream is given
  // ... run the scenario ...
} catch (e) {
  if (e instanceof FaultProxyError) console.error(e.code, e.detail);
  throw e;
} finally {
  await proxy.close();                     // disarms, then removes the proxy
}
```

From a spec, the faults are armed through an adapter that offers them, for example:

```feat
given:
  fault events Connection Timeout until reset
```

## API

Exports: `createFaultProxy`, `FaultProxyError`, and the types `FaultProxy`, `FaultProxyOptions`, `FaultProxyErrorCode`, `FaultName`, `FaultStream`, `BrokerLossMode`, `ArmDetail`, `OpenProxy`, `Traffic`.

### `createFaultProxy(options): FaultProxy`

Creates the handle; no network until `open()`.

| Option | Type | Meaning |
| --- | --- | --- |
| `api` | string | Toxiproxy API base URL. Required. |
| `product` | string | Product label; the proxy is `feat-<namespace>-<product>`. Required. |
| `upstream` | string | `host:port` of the product as Toxiproxy reaches it. Required. |
| `namespace` | string | The runner's namespace. Required. |
| `container` | string | The product's container. Without it `BrokerLoss` is not in the catalog. |
| `metrics` | string | Toxiproxy `/metrics` URL, for `traffic()`. |
| `runtime` | string | Container runtime CLI. Default `"docker"`. |

### `FaultProxy`

| Member | Meaning |
| --- | --- |
| `catalog` | `["Timeout", "ConnectionReset", "Partition"]`, plus `"BrokerLoss"` with `container`. |
| `open()` | Gets or creates the proxy (`listen: ":0"`, Toxiproxy picks the port) and returns `{ name, listen, upstream }`. Idempotent. |
| `arm(fault, detail?)` | Arms a fault by name (a plain string). |
| `disarm()` | Removes this proxy's toxics, re-enables it, and unpauses or starts a container this handle paused or stopped. Never calls Toxiproxy's global reset. |
| `armed()` | The faults armed now, in arming order. |
| `traffic()` | `{ received, sent }` bytes through the proxy since the last `arm()`, or `"unobserved"` without `metrics`. |
| `close()` | Disarms, then removes the proxy. A no-op if never opened. |

### Faults

| Fault | Effect | Default stream |
| --- | --- | --- |
| `Timeout` | Toxiproxy `timeout` toxic (`timeout: 0`): the stream stalls. | `downstream` |
| `ConnectionReset` | Toxiproxy `reset_peer` toxic: the connection is reset. | `upstream` |
| `Partition` | The proxy is disabled: new connections are refused. | n/a |
| `BrokerLoss` | `<runtime> pause <container>`, or `stop` with `mode: "stop"`. | n/a |

`ArmDetail` is `{ stream?: "upstream" | "downstream" }` for `Timeout` and `ConnectionReset`, and `{ mode?: "pause" | "stop" }` for `BrokerLoss`. Direction matters: a downstream `Timeout` lets the product apply the request while the system never hears the answer (the ambiguous write); an upstream one drops the request before the product sees it. Each adapter documents the direction it arms.

Faults stack until `disarm()`; arming the same fault again replaces it. The library has no count: a byte stream cannot honour "once" or "times n", so adapters declare each `Connection` fault as until-reset and the harness refuses `once` and `times n` with `FAULT_UNSUPPORTED`. `BrokerLoss` is shared fate (pausing a container hits every namespace that uses it), so a spec file that arms it runs in the runner's serial pass.

`traffic()` counts bytes that crossed the proxy, which is evidence of exposure, not of consumption. An adapter with only this reports its fault evidence as `unobserved`.

### Errors

Every refusal is a `FaultProxyError` with `code` and `detail`; the message is `<code>: <detail>`.

| Code | Raised when |
| --- | --- |
| `PROXY_UNREACHABLE` | The Toxiproxy API or the `metrics` URL did not answer. |
| `PROXY_NOT_OPEN` | `arm()` or `disarm()` before `open()`. |
| `FAULT_UNSUPPORTED` | The fault is not in `catalog` (including `BrokerLoss` without `container`). |
| `CONTAINER_NOT_FOUND` | `BrokerLoss` names a container the runtime does not know. |
| `CONTAINER_RUNTIME_UNAVAILABLE` | The runtime CLI cannot be run, or `inspect`, `pause`, `stop`, `unpause` or `start` failed. |

A Toxiproxy error status the library does not translate is rethrown as it came.

## Using it from an adapter

1. In `setup()`, build the proxy from the adapter's `options.proxy` and the runner's namespace, then `open()`.
2. Make the `listen` address available so the host can point the system under test at it.
3. Declare the catalog from the library so they cannot drift: `catalog.Connection = Object.fromEntries(proxy.catalog.map((f) => [f, ["reset"]]))`.
4. `arm(fault)` when the harness arms one, `disarm()` on reset, `close()` at teardown.

## See also

- Spec: [fault-proxy.feat](fault-proxy.feat) (SPEC-FPX-001). Its probe starts Toxiproxy and throwaway containers, so it runs under `feat run`, not the package's `test` script.
- [ADR-0023](../../docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2, fault injection

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
pnpm build --filter=@mmmnt/feat-fault-proxy
pnpm --filter @mmmnt/feat-fault-proxy test
```

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
