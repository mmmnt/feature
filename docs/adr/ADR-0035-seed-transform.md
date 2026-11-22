# ADR-0035 — a consumer's spec host may transform the store adapters' seeds, and every seed must be storable

Status: Accepted (founder, 2026-11-21: the set agreed, 094b5dcc; follow-ups ruled in 12081c37, all as recommended: Redis's value code split, identity changes refused, an oversized Kurrent event left to the server, canonical-JSON equality). Founder ruling 944b1d17 (2026-11-21, "Feature seed hook"); form and scope ruled in c141a704 (2026-11-21):
Q1 "Spec host only (Recommended)", Q2 "Optional method, v2 (Recommended)", Q3 "All seeds", Q4 "Check by doing it twice",
Q5 "All store adapters". Built in SPEC-ADPNEO-005, SPEC-ADPRDS-002, SPEC-ADPKUR-006, SPEC-ADPDDB-003 (new, one per adapter,
each an amendment of that adapter's seed spec in a spec of its own, as SPEC-ADPNEO-003/-004 and SPEC-ADPKUR-005 are), and
the SPEC-RPC-001 amendment (the optional `transformSeed` method in adapters/stdio-jsonrpc/transport.feat and schemas/feat-host-protocol.schema.json).

## Context

flmnt's QueryContext spec (FLMNT-SPEC-RET-002) seeds graph nodes whose `embedding` is stated as `{ encode: "<text>" }`
(flmnt ruling R3, e4d584d6). flmnt's spec host resolves that at the unit tier with its pinned encoder. At the integration
tier graph seeds go through @mmmnt/feat-adapter-neo4j, whose `SET n = $values` cannot store a map. flmnt's code does not run
on Node (FLMNT-ADR-008 §5); its encoder lives in its spec host. The same gap exists for every store adapter whose store
cannot hold the form a consumer states, and a seed a store refuses today surfaces as a raw driver error, sometimes after
earlier records of the same call were written.

## Decision

1. **One option on every store adapter** (Neo4j, Redis, Kurrent, DynamoDB): `options.seedTransform: { host: HostConfig }`.
   When set, every `seed()` call sends its records to that host as `transformSeed` and writes what comes back; without it
   no host is asked.
2. **The host is a spec host** (Q1), reached through the shared host registry of @mmmnt/feat-adapter-stdio-jsonrpc, so a
   consumer that already runs a spec host for the spec file serves the transform from the same process.
3. **The protocol gains an optional method and stays at version 2** (Q2).
4. **Twice, and they must agree** (Q4): each seed call is transformed twice; the two answers must be equal value for value
   (canonical JSON), else SEED_TRANSFORM_NONDETERMINISTIC and nothing of the call is written.
5. **An answer keeps each record's count, order, type and identity** (the key that says where the record goes: Neo4j's key
   property and a relationship's ends, Redis's key, Kurrent's stream, DynamoDB's key attributes); otherwise
   SEED_TRANSFORM_FAILED. Identity is compared for every answer, whatever its values are: an answer whose values are
   not a map has no key, so it is refused this way (amended by founder ruling 57cc575c, 2026-11-21, T2; agreed 6ecd9f57).
6. **Every seed is checked against its store's storable forms before anything is written** (Q3), transformed or not, as
   SEED_VALUE_UNSTORABLE. Each adapter's spec defines its store's rule, which follows what the real store stores (amended by
   founder ruling 6a6aa65c, 2026-11-21: Neo4j stores an empty list, so SPEC-ADPNEO-005 calls it storable).
7. **Seeds only.** What an adapter observes and reads is what is stored.
8. **One release** for all four adapters (Q5), with the same option, protocol and refusal codes.

## Rejected alternatives

- **A JavaScript module hook** (`{ module, export }`, as the handler adapter loads routes). A consumer whose code must not run
  on Node would have to ship Node code to use it (Q1).
- **Protocol version 3.** Every host and client would have to move for a method only a configured adapter sends (Q2).
- **Check transformed seeds only.** Leaves plain seeds failing as raw driver errors after partial writes (Q3).
- **Trust the host's determinism.** A nondeterministic host makes a spec pass or fail by chance; asking twice costs one more
  request per seed call (Q4).
- **Neo4j only, the others later.** Each later adapter would re-decide the same questions (Q5).
- **Kurrent: refuse an oversized event before the first append** (12081c37, "Leave it to the server"). The server's
  limit is its own configuration; guessing it would refuse events the server accepts. An event the server refuses is the
  server's error, after the call's earlier appends.
- **Equality by bytes** (12081c37, "Canonical JSON"). Key order and number spelling are not values; two answers are
  equal when their canonical JSON is.
- **The consumer routes graph seeds through its own spec host** and writes Neo4j itself: every consumer would re-implement
  the namespace label, the one-transaction rule and the relationship seeds of SPEC-ADPNEO-004.
- **Literal vectors in the spec**: unreadable, and it gives up flmnt's R3.
- **A transform on observed effects too**: a spec would then predict a value the store does not hold.

## Consequences

- The four store adapters depend on @mmmnt/feat-adapter-stdio-jsonrpc for the shared host.
- Refusal codes added to each: OPTIONS_INVALID (where an adapter lacks it), SEED_TRANSFORM_UNAVAILABLE, SEED_TRANSFORM_FAILED,
  SEED_TRANSFORM_NONDETERMINISTIC, SEED_VALUE_UNSTORABLE.
- Redis's value-shape refusal moves from SEED_INVALID to SEED_VALUE_UNSTORABLE; SEED_INVALID keeps an unknown kind and a
  missing key.
- Kurrent's and DynamoDB's seeds move from write-as-you-go to check-then-write.
- A shared fake transform host (adapters/stdio-jsonrpc/fixtures/seed-host.mjs) drives all four specs.
