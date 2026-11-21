# SPEC-RPC-001 amendment (draft) — the `transformSeed` method

For founder ruling 944b1d17 ("Feature seed hook"), with SPEC-ADPNEO-005. Status: draft.

## Change

The Spec Host Protocol (version 2) gains one OPTIONAL method. A host that never serves a seed transform need not
implement it; the protocol version stays `2`, because no existing request or answer changes and a client sends it only
when a consumer's config names a seed-transform host.

| Method | `params` | `result` | Used by |
|---|---|---|---|
| `transformSeed` | `{ service, records: [{ type, values }] }` | `{ records: [{ type, values }] }` | a product adapter's seed transform (SPEC-ADPNEO-005) |

- `values` travel as opaque objects, in both directions, as `seed`'s do. Everything else is closed.
- The answer holds as many records as the request, in the same order, each with the same `type`. A client that receives
  anything else reports it to its caller; the transport does not judge it (SPEC-ADPNEO-005 refuses it as
  SEED_TRANSFORM_FAILED).
- A host that does not implement the method answers JSON-RPC `-32601` (method not found), as for any unknown method.

## The shared host

`HostRegistry.join(config, namespace)` is how a product adapter reaches the host: when the transform host's command
equals another role's command in the same spec file, it is the same process, so a consumer's one spec host serves its
response role, its service roles and the transform. No new export.

## New scenarios (to add to transport.feat)

- "a transformSeed round-trips its records" — the fake host echoes `{ records }`; the client returns them unchanged.
- "transformSeed's records travel opaque" — a nested map inside `values` reaches the host and comes back byte-equal.
- "a host without transformSeed answers method not found" — the client surfaces `-32601` to its caller.
