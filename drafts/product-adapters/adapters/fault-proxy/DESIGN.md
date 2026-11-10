# Fault-proxy library — design (DRAFT)

Spec: `fault-proxy.feat` (SPEC-FPX-001, 21 scenarios). Package `@mmmnt/feat-fault-proxy` (new): a
library the product adapters call, not an adapter and not a service.

## Parts reused
- `toxiproxy-node-client` **4.1.0** (npm, repo `ihsw/toxiproxy-node-client`, last change 2026-04-26,
  node >=18). Types read: `Toxiproxy` (`createProxy`, `get`, `getAll`, `reset`, `getVersion`), `Proxy`
  (`addToxic`, `update({enabled, listen, upstream})`, `remove`), `Toxic` types `latency | down |
  bandwidth | slow_close | timeout | slicer | limit_data | reset_peer`.
  **Correction to the brief/interface DESIGN: the package is not "existing" in this repository**; a
  search of all `package.json` files and the lockfile finds it nowhere (only DESIGN.md mentions it). It is
  a new dependency of the new package; **approved by the founder (ruling c7af7871, 2026-11-09)**.
  Pin an exact version in the package's `package.json`; it is a small single-maintainer client.
- Toxiproxy (server): toxics and `POST /proxies/{p}` `enabled:false` are documented; `POST /reset`
  "Enable all proxies and remove all active toxics" is **global**; `/metrics` exposes only
  `toxiproxy_proxy_received_bytes_total` / `sent_bytes_total` per proxy and direction, behind
  `-proxy-metrics`. No connection or toxic-activation counter is documented.
- The container runtime's CLI for broker loss, run with `execFile` (no shell).

## Decisions the specs carry
- **One proxy per namespace and product** (`feat-<ns>-<product>`, listen port chosen by Toxiproxy).
  A shared proxy would make a Partition on one host file cut every other host's traffic.
- **Disarm is proxy-scoped**: remove this proxy's own toxics, re-enable it. The global `reset()` is never
  called, since hosts run in parallel.
- **Faults hold until disarm.** Counts (once, times n) cannot be honoured on a byte stream; adapters
  declare each as `["reset"]` and the harness refuses other counts (`FAULT_UNSUPPORTED`, SPEC-RT-003
  as amended).
- **Direction matters.** A downstream `timeout` lets the product apply the request while the system
  never hears the answer (the ambiguous write); upstream drops the request first. Both are reachable.
- **Activation is not observable.** At best, with `-proxy-metrics`, `traffic()` says bytes crossed the
  proxy since arming; it is evidence of exposure, not of consumption. Adapters report `unobserved`.
- **BrokerLoss is shared-fate**: pausing a container hits every namespace using it. Ruled: it runs
  serially. SPEC-RT-005 and `../../BROKERLOSS-SERIAL.md` say how the runner enforces it.
- Toxic parameter values (`timeout: 0` = stall/RST immediately) are from the Toxiproxy README as
  understood; the probe's scenarios are what confirms them.

## Test needs
A Toxiproxy container (HTTP API on 8474; `-proxy-metrics` for the metrics scenario), a TCP echo server
(the probe), a throwaway container for BrokerLoss.
