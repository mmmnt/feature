# SPEC-FPX-001: traffic is read before Toxiproxy has counted it (DRAFT)

Status: draft, revised to owner rulings 14 ("wait for the close") and 15 ("Fold into this one") of 2026-11-25; awaiting the flip. Nothing is built; the amended spec beside this file is a copy of
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

## Rulings (2026-11-25) and what the owner should know

1. Where the wait lives: in the probe, on the close event (ruled, 14). The library's code is unchanged.
2. The hold/release scenario is in.
3. The 300 ms `send` window is folded in (ruled, 15; spec header items 4 and 5). Every outcome is the first event
   on the client, so the four `send:<ns>=echo` scenarios have no timer at all. Before agreeing, note:
   - `timeout` is an absence and cannot be proved by an event, so it keeps the 300 ms bound, only on a send whose
     namespace has a Timeout armed; on a downstream Timeout the bound starts after the echo server has received
     and echoed the text. A Timeout toxic that failed to hold and delivered the echo later than 300 ms after that
     would be missed by the trace (the traffic and upstreamSaw facts are unaffected).
   - A send on an unarmed path that never answers now hangs until the test timeout instead of reading `timeout`.
   - The probe has to track what it armed per namespace (arm and disarm steps) to tell the agent; a fault armed
     outside the script would not be known to it (the scenarios arm only through the script).
4. ADR: not needed.
