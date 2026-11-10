# Kurrent adapter — design (DRAFT)

Specs: `observe.feat` (SPEC-ADPKUR-001, 23 scenarios), `transport.feat` (SPEC-ADPKUR-002, 7).
Package: `@mmmnt/feat-adapter-kurrent` (new), leaf, `createAdapter(config)`.

## Client
`@kurrent/kurrentdb-client` **1.3.2** (npm latest, registry-modified 2026-11-09; repo
`kurrent-io/KurrentDB-Client-NodeJS`; engines node >=20, matches Feature's >=20). `@eventstore/db-client`
6.2.1 is the pre-rename package; use the Kurrent one. Read from the published `.d.ts`:
`readAll({fromPosition: START|END|{commit,prepare}, direction, filter})`, `AppendResult.position`
(`{commit, prepare}`), `streamNameFilter({prefixes})`, `BaseOptions.requiresLeader`,
`ErrorType` (WRONG_EXPECTED_VERSION, ACCESS_DENIED, UNAVAILABLE, DEADLINE_EXCEEDED, NOT_LEADER,
STREAM_DELETED, ...), `getStreamMetadata/setStreamMetadata`, `deleteStream` (soft) and `tombstoneStream`.
Note 1.3.2 names the option `streamState` (not `expectedRevision`).

## Modes
- **diff = native.** The `$all` log is the change feed. Window start = the commit position of a marker
  the adapter appends to `feat-fence.<ns>` (exclusive cursor, so no inclusive/exclusive ambiguity at the
  boundary). Capture = `readAll` forwards from the cursor with a server-side stream-name prefix filter
  (`<ns>.`, `$$<ns>.`, `feat-fence.<ns>`), instrument events (metadata `feat: "instrument"`) dropped,
  system events dropped except `$streamDeleted`/`$metadata`. Order = commit position = the log: total.
- **state = true.** `read` = the namespace's streams read forwards. Streams are found by an `$all`
  prefix scan (the local container runs with projections off, so `$streams` does not exist), or named
  directly by `expect[].key.stream`. A soft-deleted stream reads empty, so state is not resurrected
  from `$all`.
- No `deliver()` (Kurrent has no inbound trigger; a stimulus is the system's own append).

## settle: what it proves
The interface drafter's assumption **holds**, with one made precise. `$all` is read in transaction-log
order and `AppendResult.position` is the log position of the append, so: append a fence marker after
the system's writes returned, read `$all` from the cursor until an event at or beyond the marker's
position is seen, and every write committed before it is visible to the capture. That is a proof, not a
timeout, and it also proves absence (an empty window settles true).
It does NOT prove: writes the system starts after its handler returned (ADR-0021 boundary); anything
on a multi-node cluster unless append and read go to the same node (commit positions are positions in
one node's log; the draft pins `nodePreference=leader` and `requiresLeader`; **not verified**, single
node is the tested shape); a read that lags past `settleTimeoutMs` (answers false).
Docs fetched: docs.kurrent.io node v1.1 reading-events (positions are transaction-log positions,
commit and prepare; `end` reads from the current end). Reading `$all` needs an admin identity
(same page), so setup fails with ALL_READ_DENIED for any other.

## Namespace
Namespace now comes from the runner (SPEC-RT-006) as config `namespace`; there is no option. Streams are `<ns>.<stream>`; the spec writes `orders`, the adapter reports `orders`. The namespace is exactly `^s[0-9a-f]{12}$`, fixed length with no dot, so one is never a prefix of another. Capture/read/reset are all
prefix-scoped. The fence stream is `feat-fence.<ns>`, outside the user prefix. Reset soft-deletes
(not tombstones: a tombstoned stream name is dead forever).

## Faults (all `until reset`; the product keeps no record of a refusal it issued)
- `AppendToStream.WRONG_EXPECTED_VERSION {stream}`: the adapter appends an instrument event so a stream
  that the system expects NOT to exist (NoStream) exists. Fires only for appends with that expectation;
  an append with `ANY` succeeds. A race interleaved between the system's read and write cannot be
  produced without sitting in the call path.
- `AppendToStream.ACCESS_DENIED {stream}`: sets the stream's `$acl` write role to one nobody holds.
  Verified against docs.kurrent.io server v25.0 user-authorization: "The $admins role bypasses all
  stream access checks such as ACLs", so the **system must connect as a non-admin** user (the instrument
  is admin, since `$all` needs it). Reset clears the ACL.
- Not offered: STREAM_DELETED (tombstone is irreversible, would poison the namespace),
  NOT_LEADER (no native way), timeouts (transport).
- `firedFaults` is not implemented -> evidence `unobserved`.
- Transport: `Connection.*` via SPEC-FPX-001. The client is gRPC over HTTP/2 and Toxiproxy is TCP-level, so
  it works unchanged; use a single-node connection string (no gossip discovery, which would hand the client
  the node's advertised address and bypass the proxy) and either a certificate naming the proxy host or
  `tlsVerifyCert=false` for the insecure test node. BrokerLoss pauses the container.

## Endpoints
Local: a KurrentDB container the test starts (the machine already has Sift's; the test must NOT use
it): single node, `KURRENTDB_RUN_PROJECTIONS=None`, insecure or dev certificate. Cloud/Kurrent Cloud
works by `connectionString`; nothing here needs AWS.

## What a test of the spec needs
A KurrentDB container (image `kurrentplatform/kurrentdb`, 26.x line seen locally) started per run on a
free port; fixture users: `admin` (default) and a non-admin `writer` and `reader` (created through the
users API); a Toxiproxy container for SPEC-ADPKUR-002; `fixtures/probe.mjs`.
