# ADR-0035 — a consumer's spec host may transform a product adapter's seeds (DRAFT)

Status: Draft, for founder ruling 944b1d17 (2026-11-21, "Feature seed hook"). Specs: SPEC-ADPNEO-005 (new) and a
SPEC-RPC-001 amendment (protocol.change.md).

## Context

flmnt's QueryContext spec (FLMNT-SPEC-RET-002) seeds graph nodes whose `embedding` is stated as `{ encode: "<text>" }`
(flmnt ruling R3, e4d584d6). flmnt's spec host resolves that at the unit tier with its pinned encoder. At the integration
tier graph seeds go through @mmmnt/feat-adapter-neo4j, whose `SET n = $values` cannot store a map, so the spec cannot run
against a real Neo4j. flmnt's code does not run on Node (FLMNT-ADR-008 §5); its encoder lives in its spec host.

## Decision

1. The Neo4j adapter takes `options.seedTransform: { host: HostConfig }`. When set, every `seed()` call first sends its
   records to that host as `transformSeed` and writes what comes back; without it nothing changes.
2. The host is reached through the shared host registry of @mmmnt/feat-adapter-stdio-jsonrpc, so a consumer that already
   runs a spec host for the spec file serves the transform from the same process.
3. The transform applies to seeds only. What the adapter observes and reads is what is stored.
4. A transformed value must be storable (a scalar or a homogeneous list of scalars); anything else is refused
   SEED_VALUE_UNSTORABLE before anything is written. A failed or malformed transform is SEED_TRANSFORM_FAILED; a host
   that cannot be started is SEED_TRANSFORM_UNAVAILABLE at setup.

## Rejected alternatives

- **A JavaScript module hook** (`{ module, export }`, resolved against the project root as the handler adapter does).
  Simplest inside Feature, but a consumer whose code must not run on Node would have to ship Node code to use it.
- **The consumer routes graph seeds through its own spec host** and writes Neo4j itself. Keeps Feature unchanged, but
  every consumer re-implements the namespace label, the one-transaction rule and the relationship seeds of
  SPEC-ADPNEO-004. (This was the recommendation the founder declined.)
- **Literal vectors in the spec.** No tooling change; unreadable, and it gives up flmnt's R3.
- **A transform on observed effects too.** A spec would then predict a value the store does not hold.

## Consequences

- @mmmnt/feat-adapter-neo4j depends on @mmmnt/feat-adapter-stdio-jsonrpc for the shared host.
- The Spec Host Protocol gains an optional method; its version stays 2.
- Other product adapters (Redis, Kurrent, DynamoDB) can take the same option later, each by its own spec.
