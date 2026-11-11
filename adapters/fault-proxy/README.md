# @mmmnt/feat-fault-proxy

**Transport faults for Feat's product adapters, through
[Toxiproxy](https://github.com/Shopify/toxiproxy).** A library, not an
adapter and not a service. Adapter authors call it to implement the
`Connection` pseudo-operation of the fault catalog: `Timeout`,
`ConnectionReset`, `Partition`, and, when the product runs in a container you
name, `BrokerLoss`.

The first-party Kurrent, Kafka, DynamoDB, Neo4j and KMS adapters use it. If you
write an adapter for a product that speaks TCP, you can use it the same way.
If you only write `.feat` specs, you never import this package. You configure
the adapter that does (for example `options.proxy` on
[`@mmmnt/feat-adapter-dynamodb`](https://github.com/mmmnt/feature/blob/main/adapters/dynamodb/README.md)).

## Where it sits

```
 system under test ──► Toxiproxy proxy (feat-<ns>-<product>) ──► product
                              ▲
                              │ arm / disarm        (this library)
 adapter ─────────────────────┘
 adapter's own instrument connection ─────────────────────────► product
```

- One proxy per **namespace and product**, named `feat-<namespace>-<product>`.
  A fault armed for one spec file never reaches another file's namespace.
- The host points the system under test at the proxy's listen address. The
  adapter's own instrument connection (its capture, seed and read clients)
  never goes through the proxy, so a fault applies to the system's path only.
- Toxiproxy is reused through `toxiproxy-node-client` (pinned at 4.1.0). Broker
  loss uses the container runtime's own CLI (`docker` or `podman`), run without
  a shell. Neither is reimplemented.

## Install

```sh
npm install @mmmnt/feat-fault-proxy
```

Requirements:

- Node 18 or later (the library uses the global `fetch`).
- A reachable Toxiproxy server. The package's own tests use
  `ghcr.io/shopify/toxiproxy:2.12.0`. Start it with `-proxy-metrics` if you want
  `traffic()` to report bytes.
- For `BrokerLoss`: `docker` or `podman` on the `PATH` of the process that runs
  the library, and the name of the product's container.

The package ships `dist/` only. Its `fixtures/` helpers are internal.

## Quick start

```ts
import { createFaultProxy, FaultProxyError } from "@mmmnt/feat-fault-proxy";

const proxy = createFaultProxy({
  api: "http://127.0.0.1:8474",      // Toxiproxy API
  product: "kurrent",                // proxy name: feat-<namespace>-kurrent
  upstream: "127.0.0.1:2113",        // host:port, as Toxiproxy reaches the product
  namespace: "s0123456789ab",        // the runner's namespace
  container: "kurrent-1",            // optional: adds BrokerLoss to the catalog
  metrics: "http://127.0.0.1:8474/metrics", // optional: for traffic()
});

const { listen } = await proxy.open();   // point the system under test at `listen`

try {
  await proxy.arm("Timeout");            // downstream by default
  // ... run the scenario ...
} catch (e) {
  if (e instanceof FaultProxyError) console.error(e.code, e.detail);
  throw e;
} finally {
  await proxy.close();                   // disarms, then removes the proxy
}
```

`listen` is the address Toxiproxy reports, for example `[::]:30011`. Toxiproxy
picks the port: the library creates the proxy with `listen: ":0"`.

## API

```ts
import {
  createFaultProxy,
  FaultProxyError,
  type FaultProxy,
  type FaultProxyOptions,
  type FaultProxyErrorCode,
  type FaultName,
  type FaultStream,
  type BrokerLossMode,
  type ArmDetail,
  type OpenProxy,
  type Traffic,
} from "@mmmnt/feat-fault-proxy";
```

### `createFaultProxy(options): FaultProxy`

Creates the handle. It does not touch the network until `open()`.

| Option | Type | Meaning |
|---|---|---|
| `api` | `string` | Toxiproxy API base URL, for example `http://127.0.0.1:8474`. Required. |
| `product` | `string` | Product label. The proxy is named `feat-<namespace>-<product>`. Required. |
| `upstream` | `string` | `host:port` of the product, as Toxiproxy reaches it. It can differ from the address the adapter's own client uses. Required. |
| `namespace` | `string` | The runner's namespace. Required. |
| `container` | `string` | The product's container, for `BrokerLoss`. Without it `BrokerLoss` is not in the catalog. |
| `metrics` | `string` | The Toxiproxy `/metrics` URL, for `traffic()`. The server must run with `-proxy-metrics`. |
| `runtime` | `string` | The container runtime's CLI. Default `"docker"`. |

### `FaultProxy`

| Member | Meaning |
|---|---|
| `catalog` | `readonly FaultName[]`. `["Timeout", "ConnectionReset", "Partition"]`, plus `"BrokerLoss"` when `container` was given. |
| `open()` | Gets or creates the proxy and returns `{ name, listen, upstream }` (`OpenProxy`). Idempotent: opening the same namespace again returns the same proxy and address. |
| `arm(fault, detail?)` | Arms a fault by name. Refuses a name outside the catalog with `FAULT_UNSUPPORTED`, and any arm before `open()` with `PROXY_NOT_OPEN`. |
| `disarm()` | Removes this proxy's toxics, re-enables the proxy, and unpauses or starts the container if this library paused or stopped it. |
| `armed()` | The faults armed now, in arming order. |
| `traffic()` | `{ received, sent }` bytes through this proxy since the last `arm()`, or `"unobserved"` when `metrics` is not set. |
| `close()` | Disarms, then removes the proxy. Does nothing if the proxy was never opened. |

`arm` takes the fault as a plain `string`, so an adapter can pass the name it
got from the harness. It does not type-narrow: anything outside the catalog is
a `FAULT_UNSUPPORTED` at run time.

### The faults

| Fault | What the library does | Default stream |
|---|---|---|
| `Timeout` | Adds a Toxiproxy `timeout` toxic (`timeout: 0`): the stream stalls and never delivers. | `downstream` |
| `ConnectionReset` | Adds a Toxiproxy `reset_peer` toxic (`timeout: 0`): the connection is reset. | `upstream` |
| `Partition` | Updates the proxy to `enabled: false`: new connections are refused. | n/a |
| `BrokerLoss` | Runs `<runtime> pause <container>`, or `stop` in stop mode. | n/a |

`ArmDetail`:

| Field | Applies to | Values |
|---|---|---|
| `stream` | `Timeout`, `ConnectionReset` | `"upstream"` or `"downstream"`. Ignored by the other faults. |
| `mode` | `BrokerLoss` | `"pause"` (default) or `"stop"`. Ignored by the other faults. |

**Stream direction matters.** Downstream is the direction of the product's
answer. A downstream `Timeout` lets the product receive and apply the request
while the system never hears the answer: the ambiguous write. An upstream
`Timeout` drops the request before the product sees it. They are different
faults for atomicity, and both are reachable, so the defaults are explicit:

- `Timeout` with no stream is **downstream**.
- `ConnectionReset` with no stream is **upstream**.

```ts
await proxy.arm("Timeout");                                 // the product applies it, the answer is lost
await proxy.arm("Timeout", { stream: "upstream" });         // the product never sees it
await proxy.arm("ConnectionReset");                         // cut on the request path
await proxy.arm("BrokerLoss", { mode: "stop" });            // stop the container
```

### Stacking, re-arming and disarm

- **Faults stack until `disarm()`.** Arming `Timeout` and then `Partition` holds
  both, and `armed()` lists `["Timeout", "Partition"]`.
- **Arming the same fault again replaces it.** A toxic name is unique on a
  proxy (`feat-Timeout`, `feat-ConnectionReset`), so the new stream wins.
- **Every fault holds until `disarm()`.** The library has no count. A byte
  stream cannot honour "once" or "times n", so an adapter declares each
  `Connection` fault in its catalog as `["reset"]` (until reset) and the harness
  refuses `once` and `times n` with `FAULT_UNSUPPORTED` (SPEC-RT-003 as amended).
- **`disarm()` is scoped to this proxy.** It removes this proxy's own toxics and
  re-enables the proxy. It never calls Toxiproxy's global `POST /reset`, which
  would clear the faults other hosts have armed.

### `traffic()`

```ts
const t = await proxy.traffic();
if (t === "unobserved") {
  // no metrics URL: claim nothing about whether the fault was exercised
} else {
  console.log(t.received, t.sent);
}
```

Toxiproxy documents no activation counter. The byte counters are evidence of
exposure (bytes crossed the proxy since arming), not of consumption. An adapter
that has only this should report its fault evidence as `unobserved`, as the
DynamoDB adapter does.

### Errors

Every refusal is a `FaultProxyError` with a `code` and a `detail` string. The
message is `"<code>: <detail>"`.

| Code | Raised when |
|---|---|
| `PROXY_UNREACHABLE` | The Toxiproxy API (or the `metrics` URL) did not answer. |
| `PROXY_NOT_OPEN` | `arm()` or `disarm()` ran before `open()` for this handle. |
| `FAULT_UNSUPPORTED` | The fault is not in `catalog`. This includes `BrokerLoss` when no `container` was given, and any name the library does not know (`Latency`, `DiskFull`). |
| `CONTAINER_NOT_FOUND` | `BrokerLoss` names a container the runtime does not know. |
| `CONTAINER_RUNTIME_UNAVAILABLE` | The runtime CLI cannot be run, or `inspect`, `pause`, `stop`, `unpause` or `start` failed for another reason. |

An answer from the Toxiproxy API with an error status that the library does not
translate (for example a conflicting proxy) is rethrown as it came.

## Using it from an adapter

An adapter that wants to offer `Connection.Timeout`, `ConnectionReset` and
`Partition` does four things:

1. Builds the proxy in `setup()` from its own `options.proxy` and the runner's
   namespace, then calls `open()`.
2. Exposes the `listen` address so the host can point the system under test at
   it.
3. Declares the catalog from the library, so the two cannot drift:

   ```ts
   catalog.Connection = Object.fromEntries(
     proxy.catalog.map((fault) => [fault, ["reset" as const]]),
   );
   ```

4. Calls `arm(fault)` when the harness arms one, `disarm()` on reset, and
   `close()` at teardown.

`BrokerLoss` is shared-fate: pausing a container hits every namespace that uses
it. A spec file that arms it runs alone, in the runner's serial pass
(SPEC-RT-005).

## Configuring an adapter that uses it

The library has no `feat.config.json` of its own. Adapters take the options
through their service entry. For example, the DynamoDB adapter:

```jsonc
// feat.config.json
"services": {
  "database": {
    "adapter": "@mmmnt/feat-adapter-dynamodb",
    "consistency": "eventual",
    "convergenceTimeout": 2500,
    "options": {
      "tableEnv": "FEAT_DDB_TABLE",
      "endpointEnv": "FEAT_DDB_ENDPOINT",
      "proxy": {
        "api": "http://127.0.0.1:8474",
        "metrics": "http://127.0.0.1:8474/metrics"
      }
    }
  }
}
```

The `proxy` keys mirror this package's options (`api`, `name`, `upstream`,
`container`, `metrics`, `runtime`). See each adapter's README for its own
defaults.

## How it is verified

SPEC-FPX-001 (`fault-proxy.feat`) is driven through a probe that
starts a pinned Toxiproxy container, a TCP echo server, and a throwaway `sleep`
container, and removes them on exit. The probe's trace uses these tokens:

| Token | Meaning |
|---|---|
| `open:a` | `open()` for namespace `a`. |
| `send:a=echo` | The text came back through the proxy. |
| `send:a=timeout` | Nothing came back in 300 ms. |
| `send:a=reset` | The connection was reset. |
| `send:a=refused` | The connection was refused. |
| `arm:a`, `disarm:a` | `arm()` and `disarm()`. |
| `armed:a=Timeout,Partition` | The faults the library reports. |
| `toxics:a=0`, `enabled:a=true` | What Toxiproxy reports. |
| `container=paused`, `container=stopped`, `container=running` | The throwaway container's state. |
| `traffic:a=seen`, `traffic:a=unobserved` | `traffic()` result. |
| `listen=distinct`, `listen=same` | Two opens compared. |

`upstreamSaw` counts the messages the echo server received. It is what tells a
downstream `Timeout` (`1`) from an upstream one (`0`).

The scenarios need Docker, so they run under `feat run`, not under the
package's `test` script.

## This release (0.1.0, Feature v0.1.48)

New package. Specified by SPEC-FPX-001, with these amendments:

- `ConnectionReset` defaults to **upstream**.
- `Timeout` armed without a stream is **downstream**.

## Specs and design

- [`fault-proxy.feat`](https://github.com/mmmnt/feature/blob/main/adapters/fault-proxy/fault-proxy.feat): SPEC-FPX-001.
- [`fault-proxy.contract.json`](https://github.com/mmmnt/feature/blob/main/adapters/fault-proxy/fault-proxy.contract.json): the probe's contract.
- [Design note](https://github.com/mmmnt/feature/blob/main/drafts/product-adapters/adapters/fault-proxy/DESIGN.md).
- [ADR-0023](https://github.com/mmmnt/feature/blob/main/docs/adr/ADR-0023-adapter-interface-v2.md): adapter interface v2, fault injection.

Part of [Feature](https://github.com/mmmnt/feature), the `.feat` execution
specification language.

## License

MIT
