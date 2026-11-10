# Neo4j adapter — design

Specs: `observe.feat` (SPEC-ADPNEO-001, 23 scenarios), `transport.feat` (SPEC-ADPNEO-002, 6).
Package: `@mmmnt/feat-adapter-neo4j` (new).

## Client
`neo4j-driver` **6.3.0** (npm latest 2026-10-29; deps `neo4j-driver-core`/`-bolt-connection` 6.3.0, rxjs;
engines node >=18; tags `latest-5.28` = 5.28.3, `latest-4.4`). Types read: `Session.executeRead/
executeWrite`, bookmark manager, `Neo4jError.code`. **Unverified:** 6.x against the local server
(Community 2026.01.4). **Verified 2026-11-09** against `neo4j:2026.01.4-community`: driver 6.3.0
connects, `SHOW TRANSACTIONS` works on Community, and an uncommitted node is invisible to other sessions.

## Modes: diff = snapshot (the assumption holds)
Neo4j Change Data Capture is documented as an **Enterprise Edition / Aura** feature (docs
neo4j.com/docs/cdc: heading "CDC on Neo4j DBMS Enterprise Edition", introduced in 5.13, enabled per
database with `txLogEnrichment` FULL|DIFF, `db.cdc.*` procedures). The local server is Community
(`NEO4J_EDITION=community`), so there is no change feed and the adapter declares
`{diff: "snapshot", state: true}`. If a deployment is Enterprise with CDC on, a later `diff: native`
binding (`db.cdc.current` + `db.cdc.query` from a cursor; `db.cdc.query` needs admin) can replace the
snapshot without changing a spec; not drafted, see README open questions.
Snapshot identity: node = (first declared label, declared key property) — `options.keys` is required
because `elementId` can be reused after a delete and would turn delete+create into MODIFY; relationship
= (start identity, type, end identity), parallel equal ones collapse with `count`. Blind spots: a node
created and removed inside the window; a write that leaves properties unchanged.

## settle
Truthful on a direct (`bolt://`) single-server connection once no other transaction is running: a
committed transaction is visible to a later read on the same server, and an open transaction is an
undecided effect, detected with `SHOW TRANSACTIONS` (needs the default admin; verified on
Community 2026.01.4: an open explicit transaction lists with `currentQuery ""` and status Running; the
instrument tags its own transactions with metadata `app: feat-instrument-<ns>` and ignores those). A routing URI (`neo4j://`) answers
false: another cluster member may serve the read (bookmarks only order the adapter's own writes).
Does not prove the system's post-return work.

## Namespace
Namespace comes from the runner (SPEC-RT-006), not an option. Community has one user database, so the namespace is a **label**: every node the system writes carries
`ns_<ns>` (its host configures it). A relationship is in the namespace when both ends carry the label;
exactly one end is `NAMESPACE_BREACH`. The label is stripped from reports. Seeds are nodes only.

## Faults (until reset; unobserved)
`Write.UNIQUE_CONSTRAINT_VIOLATION {property, value}` (founder ruling 2026-11-09, Neo4j both A): a uniqueness constraint on the *namespace label itself*
(so it cannot touch another namespace) plus a placeholder node holding detail.value (marked `__feat_fault`, never reported). Reset drops both.
Not offered: deadlock/lock timeouts (the default lock timeout is unbounded and would hang), read-only
mode (database access control is not assumed in Community). `Connection.*` via SPEC-FPX-001, with a
direct `bolt://` URI at the proxy: a routing driver follows the server's advertised addresses past it.

## Endpoints / test needs
Local Community container (`neo4j`, bolt, a generated throwaway password) started by the test; for `uri: "routing"` the server advertises the published host port, a Toxiproxy
container for -002, `fixtures/probe.mjs` with `keys {Order: orderId, Customer: customerId}`.
