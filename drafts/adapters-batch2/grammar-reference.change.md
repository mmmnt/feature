# grammar-reference.md — changes for ADR-0033 (draft): `observes`

Applied to `docs/grammar-reference.md` in the same change that builds SPEC-CORE-001 (amended) and SPEC-DRV-002, with
the corpus exemplar `corpus/spec-observes/` (#20) and its row in `corpus/README.md`.

## §1 File structure

After `status <lifecycle>` add:

```
observes <service>, ...         ← optional (ADR-0033): the services this spec observes; absent = all configured
```

## §2 Header — new row

| Keyword | Form | Notes |
| --- | --- | --- |
| `observes` | `observes log, cache` | Optional, at most once (ADR-0033). The services this spec observes, each a key of the config's `services` (closed space: an unknown key is `UNKNOWN_SERVICE_KEY`). Absent = every configured service, as before. A key written twice, a bare `observes`, an empty item or a second line is `MALFORMED_SYNTAX`. Recorded in the IR as top-level `observes`, in written order. |

## §5.3 `predict` — replace the INV-6 paragraph and amend two others

**Completeness (INV-6)**: every service the spec observes must appear in every prediction: every configured service
when the spec has no `observes` line, the declared ones when it has. `has []` is the explicit "nothing happens here".
Omission is a validation error (`INCOMPLETE_PREDICTION`). A scenario that names a configured service the spec does not
observe (in a `has` or `contains`, a `seed`, a `deliver ... to`, a `fault`, or an `@<service>[i]` reference) is
`UNOBSERVED_SERVICE`.

`predict rejection <ID>:` row — "Error response + **zero effects across ALL configured services**" stays as written,
with: "including the services the spec does not observe: derive asserts `has []` on each of them (ADR-0033)."

**Query guarantee (ADR-0011)** — add: "This holds for every configured service, observed or not. A `contains` may
name an observed service only."

## §6 Configuration

No change: `observes` names services the config already declares; a tier overlay (ADR-0024) that drops a service a spec
observes makes that spec `UNKNOWN_SERVICE_KEY` in that tier, as a `has` line on it does today.

## corpus/README.md — new row

| 20 | `spec-observes/` | SPEC-PAU-001 | A spec observes a subset of the configured services (ADR-0033): `observes log, cache` with a third service (`files`) configured and never named; every prediction names exactly the observed two; recorded as top-level `observes` in written order |
