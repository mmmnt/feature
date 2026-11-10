# SPEC-ADPKUR-004 (DRAFT): a loopback IP host is connected to as localhost, any other IP host is refused on Node 26

Status: draft, awaiting the founder (flip `status draft` to `agreed` in `node26-tls-host.feat`).
Ruling: 2026-11-10, chosen verbatim: "A: loopback→localhost (Recommended)".
Files: `node26-tls-host.feat`, `node26-tls-host.contract.json` (this directory mirrors `adapters/kurrent/`; on agreement they move there).

## The fault

Node 26 rejects an IP address as the TLS servername: `ERR_INVALID_ARG_VALUE: Setting the TLS ServerName to an IP address is not permitted`.
`@grpc/grpc-js` 1.14.7 (latest; `build/src/channel-credentials.js`, about lines 153-163) sets `connectionOptions.servername = remoteHost`
unconditionally, and `@kurrent/kurrentdb-client` 1.3.2 exposes no channel option. So the adapter cannot connect with any `kurrentdb://`
string that has `tls=true` (the default) and an IP host on Node 26. `tlsVerifyCert=false` does not help.

## The rule

1. Host exactly `127.0.0.1` or `::1` with tls=true: connect as `localhost`; only the host changes.
2. Any other IP literal with tls=true on Node >= 26: setup() refuses with `TLS_HOST_UNSUPPORTED`, before any connection.
3. Hostname, `kurrentdb+discover://`, tls=false, or a non-loopback IP on Node < 26: unchanged.

## Alternatives rejected

- B, restrict engines to Node < 26: shuts the adapter out of a current Node line, and the fault is the client stack's, not Feature's.
- C, monkey-patch `tls.connect` / `tls.TLSSocket` to drop an IP servername: a process-wide patch of a core module from a leaf adapter,
  it changes every TLS client in the test process (the system under test's too), and it hides a verification-relevant choice.
- D, wait for upstream only: leaves Node 26 broken for an unbounded time. The issue below is still worth filing; the rule can be removed
  when grpc-js stops sending an IP as the servername.

## Open choices (made here, for the founder to confirm)

1. **Loopback is exact (`127.0.0.1`, `::1`), not 127.0.0.0/8.** `localhost` resolves to 127.0.0.1 or ::1, never to 127.0.0.2, so rewriting
   127.0.0.2 would silently change the target. 127.0.0.2 is therefore "any other IP": refused on Node 26 (a scenario row pins it).
   Alternative: treat all of 127/8 as loopback and rewrite; simpler to explain, wrong for a service bound to another loopback address.
2. **The rewrite applies on every Node major**, not only 26: one loopback path across the CI matrix, testable on 20/22/24. The refusal
   alone depends on the Node major.
3. **Error code: a new `TLS_HOST_UNSUPPORTED`.** The adapter's codes are NAMESPACE_INVALID (the namespace), ALL_READ_DENIED (credentials)
   and FAULT_UNSUPPORTED (a fault arm); none names a connection-string problem, and reusing one would put a wrong name in front of the
   user. It joins `KurrentAdapterErrorCode` and the `ObserveError` enum of the contracts of this and the existing files (the existing
   contracts' enums need the value added when this is agreed; the probe maps `KurrentAdapterError` already).
4. **Node-version seam: `options.nodeMajor`**, an integer, default the running major from `process.versions.node`. It is part of the
   adapter's options (documented in README), so a scenario sets it without a second Node. Alternative: a module-level setter exported
   for tests only, which keeps the option surface smaller but cannot be driven from a spec file.
5. **Observation seam: `connectionTarget()`** returns the string the client is created from (no network); probe steps `target:` and
   `params:` redact it. The scenarios that connect prove the rewrite works; the ones that do not connect prove the rule.
6. **Multi-host strings** (`kurrentdb://h1,h2`) are judged host by host. **tls default**: the client's default is tls=true, so an absent `tls` is true.
7. **Fixture**: the `[::1]` scenario needs the fixture container's port published on the IPv6 loopback as well; if Docker cannot do that on
   a developer machine, that one scenario is the only one that cannot run there.
8. **Dev certificate**: tests use tlsVerifyCert=false, so the name `localhost` need not be on the certificate; a real user who relied on
   an IP SAN for 127.0.0.1 with verification on needs the certificate to name `localhost`. Worth a README line.

## Amendments to agreed text on agreement

- SPEC-ADPKUR-001 header and `construct`: one sentence, "the connection string's loopback IP host is connected to as localhost and another IP host with tls=true is refused on Node 26, see SPEC-ADPKUR-004", and the `ObserveError` enum gains TLS_HOST_UNSUPPORTED in observe/transport/broker-loss contracts.
- `adapters/kurrent/DESIGN.md` and README: the rule and the certificate note.
- `feat.config.json`: command `ObserveKurrentTlsHost` (module `adapters/kurrent/fixtures/probe.mjs`).

## Build plan notes (not spec scenarios)

- `.github/workflows/ci.yml`: the node matrix `[20, 22, 24]` becomes `[20, 22, 24, 26]` in both the workspace-tests and spec-chain jobs
  (the jobs that gate on `matrix.node == 24` stay on 24). Check the engines field and `@kurrent/kurrentdb-client` install on 26 first.
- Probe: `ObserveKurrentTlsHost`, steps `target:` and `params:`; fixture publishes the node on `[::1]`.
- The adapter: the host rewrite and the refusal live in `connectionString()` of `src/index.ts`, called by `setup()` before `db()`.

## Upstream issue text (ready to paste; NOT filed). Repository: grpc/grpc-node (package @grpc/grpc-js)

Title: `Node 26: TLS connections to an IP address fail with ERR_INVALID_ARG_VALUE because channel-credentials sets servername to the IP`

Body:

> **Problem description**
>
> On Node.js 26, `tls.connect` rejects an IP address as `servername` (`ERR_INVALID_ARG_VALUE: The argument 'servername' is invalid. Setting the TLS ServerName to an IP address is not permitted`).
> `@grpc/grpc-js` sets `connectionOptions.servername` to the remote host unconditionally in `SecureChannelCredentialsImpl`
> (`build/src/channel-credentials.js`, about lines 153-163 in 1.14.7), so any secure channel to an IP-address target now fails to connect, including `127.0.0.1` and `[::1]`.
> Per RFC 6066 section 3, SNI must not carry a literal IP address, so the name should not be sent in that case; certificate verification against an IP SAN is a separate matter, handled by `checkServerIdentity`.
>
> **Reproduction steps**
>
> 1. Node.js 26, `@grpc/grpc-js` 1.14.7.
> 2. Create a server with TLS on loopback (any), then:
>    ```js
>    const grpc = require('@grpc/grpc-js');
>    const creds = grpc.credentials.createSsl(ca);            // or createSsl(null, null, null, { rejectUnauthorized: false })
>    const client = new grpc.Client('127.0.0.1:50051', creds);
>    client.waitForReady(Date.now() + 2000, (err) => console.log(err));
>    ```
> 3. The channel never becomes ready; the connection attempt fails with the ERR_INVALID_ARG_VALUE above. The same code works on Node 24 and with the target `localhost:50051`.
>
> **Environment**
>
> - Node.js 26.x, `@grpc/grpc-js` 1.14.7
> - Observed through `@kurrent/kurrentdb-client` 1.3.2 (`kurrentdb://user:pass@127.0.0.1:2113?tls=true`)
>
> **Expected behaviour**
>
> `servername` is set only when the remote host is not an IP address (`net.isIP(host) === 0`), or the `grpc.ssl_target_name_override` option, when given, is used; an IP target connects, with verification against the certificate's IP SAN when `rejectUnauthorized` is true.
>
> **Additional context**
>
> Downstream libraries expose no channel option to work around it, so they can only rewrite the target host.
