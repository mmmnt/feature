# The evidence bundle (`feat-evidence/1`)

`feat report --evidence <path>` writes a self-contained, digest-anchored record
of a project's spec state and verification results at a point in time:

- **spec inventory** — every discovered spec with its id, lifecycle status, and
  content digest (plus the committed generated file's digest when present);
- **verify** — whether the committed generated tests byte-match the specs
  (`feat verify` semantics, evaluated at production time);
- **run** — the most recent `feat run` result (test/failure/error counts and a
  digest of the JUnit artifact), when one exists;
- **producer** — the exact `@mmmnt` toolchain versions in effect;
- **project** — the language version and a digest of `feat.config.json`.

The schema is `schemas/evidence.schema.json` (also shipped inside the
`@mmmnt/feature` package for programmatic consumers).

## What it is for

A bundle answers, reproducibly and after the fact: *what specs existed, did the
committed tests match them, and did they pass — under which toolchain?* Emit
one per CI run and archive it as a build artifact and you have a longitudinal
record of delivery conformance with no additional infrastructure.

Producing bundles is free, local, and requires no account — like every
capability in the toolchain. The `signature` field is null when produced
locally; attestation (signing on ingestion, and the ledger of bundles over
time) is account-side functionality.

## Producing

```sh
feat run                             # optional — populates the run block
feat report --evidence evidence.json
```

Production never fails the build by itself: a project whose specs don't parse
still gets an honest bundle (the inventory records `parse_error`; `verify`
reports `fail`). Gate on `feat verify && feat run` as usual — the bundle is a
record, not a gate.
