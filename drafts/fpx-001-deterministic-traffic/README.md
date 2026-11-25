# SPEC-FPX-001: traffic is read before Toxiproxy has counted it (DRAFT)

Status: draft, awaiting the owner. Nothing is built; the amended spec beside this file is a copy of
SPEC-FPX-001 at `status draft` (`adapters/fault-proxy/fault-proxy.feat`). GitHub issue #4.

## The failure (issue #4)

"traffic is reported when the metrics endpoint is configured": `expected "open:a arm:a send:a=timeout
traffic:a=seen", got "… traffic:a=none"`. Three consecutive local full-gate runs at a 1-minute load of 21 to 24
(the same commit passed at 7.58), and GitHub CI once (PR #7, Spec chain, Node 24).

## Root cause

- Toxiproxy 2.12.0 (`ghcr.io/shopify/toxiproxy:2.12.0`, the image the probe pins) adds a connection's bytes to its
  counters only when the connection ends. `link.go` at tag v2.12.0 (read with `gh api
  repos/Shopify/toxiproxy/contents/link.go?ref=v2.12.0`): `read()` runs `io.Copy(link.input, source)` (line 122)
  and adds `ReceivedBytesTotal` after it returns (129-131), then closes its input (133); `write()` runs
  `io.Copy(dest, link.output)` (152), adds `SentBytesTotal` after it returns (158-160), then `dest.Close()` (163).
- The probe (`adapters/fault-proxy/fixtures/probe.mjs`, the `AGENT` source, `send()`) closes its client when the
  300 ms window ends and answers `timeout`. The next step, `traffic`, calls `traffic()`
  (`adapters/fault-proxy/src/index.ts:260-266`), which fetches `/metrics` once (`readCounters`, `:162-179`) and
  subtracts the baseline taken at the arm. Nothing orders that fetch after Toxiproxy has handled the close. When the
  fetch wins, the proxy has no series yet, the counters equal the baseline, and the step prints `none`.

## Reproduction

1. **The accounting rule, against the pinned image.** A scratch script: `docker run` the image with
   `-proxy-metrics`, `POST /proxies` (`listen 0.0.0.0:20000`, upstream the API port), a `timeout` toxic downstream
   with `timeout: 0` (as `arm:a:Timeout:downstream` makes), then a Node client connects through the published
   proxy port, writes `hello` and keeps the connection open. `/metrics` had no `toxiproxy_proxy_*_bytes_total`
   series for the proxy at 50 ms, 300 ms, 1 s and 3 s. Immediately after `socket.destroy()`, and at +10, +50 and
   +200 ms: `received_bytes_total{direction="upstream"} 5`, `sent_bytes_total{direction="upstream"} 5`,
   downstream 0 and 0.
2. **The scenario itself.** `ENVIRONMENT=spec npx vitest run adapters/fault-proxy/fault-proxy.test.ts -t "traffic
   is reported"` passed three times out of three on this host without added load. Under heavy added load (24 busy
   loops on the host and 8 in a container) five of six runs failed earlier, in the suite's `beforeAll` (vitest's
   default 10 s hook timeout, since this was vitest directly rather than `feat run`), so they say nothing about
   this prediction. **The `traffic:a=none` failure itself was not reproduced here**; the root cause rests on (1)
   and the source above.

## The amendment

`traffic()` is documented for what Toxiproxy counts (closed connections). The probe's `traffic` step, when the
library has a metrics URL, first waits for the echo server to see each proxied connection the script opened close,
which by `link.go`'s order comes after both upstream counters are added; then it reads once. No timer is added. Two
steps (`hold`, `release`) and one scenario prove the rule: a held connection is `none`, the same one released is
`seen`. The library's code does not change.

## Decisions for the owner

1. **Where the wait lives.**
   - **A. In the probe: the `traffic` step waits for the echo server to see the proxied connections close, an
     event, then reads once; `traffic()` is documented as counting closed connections (Recommended).** No adapter
     calls `traffic()` yet (checked: no `.traffic()` call under `adapters/` or `packages/` outside the probe), so
     the library's contract can say what Toxiproxy gives.
   - B. In the library: `traffic()` polls `/metrics` until this proxy's counters pass the baseline or a bound
     stated in the spec passes (the option in issue #4). It helps a future adapter that reads traffic right after
     the system's call; it is still a wall-clock bound, and a true `none` costs the whole bound.
   - C. Widen the window (a longer `send` or a sleep before `traffic`). A margin, not a fix.
2. **The prove-the-rule scenario** ("traffic counts a connection once it has closed, not while it is open").
   Recommended: add it. If a later Toxiproxy counts live connections, it fails and says so, rather than the
   main scenario turning flaky the other way.
3. **Sibling: the 300 ms `send` window.** Four scenarios predict `send:<ns>=echo`: the echo must come back within
   300 ms of the write, the same kind of dependence on load (not seen failing yet).
   - **A. A separate amendment, so issue #4's fix is not held up (Recommended).** Its likely shape: `send` ends on
     the first event (echo data, an error, a close), and only a send whose path the script armed with a Timeout
     ends on the window, since its answer never comes.
   - B. Fold that change into this amendment.
   - C. Leave it, or widen the window by measurement.
4. **ADR.** Not needed: a probe and documentation change; the library's design (rulings 58a4ac88, c7af7871) is
   unchanged.
