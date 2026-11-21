# SPEC-RPC-001 amendment (draft) — the `transformSeed` method

For founder rulings 944b1d17 ("Feature seed hook") and c141a704 (Q2 "Optional method, v2 (Recommended)"), with
SPEC-ADPNEO-005, SPEC-ADPRDS-002, SPEC-ADPKUR-006 and SPEC-ADPDDB-003. Status: draft.

## Change

The Spec Host Protocol (version 2) gains one OPTIONAL method. A host that never serves a seed transform need not
implement it; the protocol version stays `2`, because no existing request or answer changes and a client sends it only
when a consumer's config names a seed-transform host.

| Method | `params` | `result` | Used by |
|---|---|---|---|
| `transformSeed` | `{ service, records: [{ type, values }] }` | `{ records: [{ type, values }] }` | a store adapter's seed transform |

- `values` travel as opaque objects, in both directions, as `seed`'s do. Everything else is closed.
- The answer is meant to hold as many records as the request, in the same order, each with the same `type` and identity.
  The transport does not judge it; the store adapter refuses a mismatch as SEED_TRANSFORM_FAILED.
- A store adapter sends the same request twice per seed call (c141a704 Q4) and compares the answers; a host must answer the
  same request the same way.
- A host that does not implement the method answers JSON-RPC `-32601` (method not found), as for any unknown method.

## The shared host

`HostRegistry.join(config, namespace)` is how a store adapter reaches the host: when the transform host's command equals
another role's command in the same spec file, it is the same process, so a consumer's one spec host serves its response
role, its service roles and every store adapter's transform. No new export.

## The shared fake host

`adapters/stdio-jsonrpc/fixtures/seed-host.mjs` (inside each store spec's touches, never shipped) implements the protocol
with the modes SPEC-ADPNEO-005 lists, selected by an environment variable, and counts the `transformSeed` requests it
received.

## New scenarios (to add to transport.feat)

- "a transformSeed round-trips its records": the fake host echoes `{ records }`, and the client returns them unchanged.
- "transformSeed's records travel opaque": a nested map inside `values` reaches the host and comes back byte-equal.
- "a host without transformSeed answers method not found": the client surfaces `-32601` to its caller.
