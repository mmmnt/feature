# DynamoDB adapter, query mode — design (DRAFT amendment)

Specs: `query-mode.feat` (SPEC-ADPDDB-001, 24 scenarios), `transport.feat` (SPEC-ADPDDB-002, 6).
Package: the existing `@mmmnt/feat-adapter-dynamodb` (0.1.4); the spec is an amendment, nothing new
to install. Its AWS SDK v3 clients (`client-dynamodb`, `client-dynamodb-streams`, `util-dynamodb`) are
already dependencies. Read from `adapters/dynamodb/src/index.ts`: Streams capture with LATEST iterators,
ADR-0021 sentinel settle behind `options.fence` (declines with more than one open shard or non-string
keys), ADR-0020 peek, ephemeral DynamoDB Local scaffold, `read()` = a full Scan that ignores its query.

## What the amendment adds
- **observes.** `{native, true}` with a stream, `{snapshot, true}` with `options.stream:false` (no
  Streams permission needed; two consistent namespace reads compared by primary key; a put-then-delete
  or an identical-image overwrite inside the window is invisible).
- **query mode.** `read({expect})`: full primary key as literals -> `GetItem`, partition key only ->
  `Query`, else `Scan`; all `ConsistentRead`. A hint may return a superset, never fewer
  (interface DESIGN §a). This ends the scan-everything cost for `contains`.
- **namespace.** Stored partition keys are `<ns>#<pk>`; the adapter prefixes seeds and read hints and
  strips the prefix from every reported key, so one spec runs against the in-memory spec host and the
  product. Needs a string partition key (`NAMESPACE_KEY_NOT_STRING`). The fence sentinel's key is not
  prefixed, so it is never a record. A table-per-namespace mode (ephemeral only) is an option, see README.
- **faults.** `PutItem.CONDITIONAL_CHECK_FAILED {pk, sk}`: the adapter writes an instrument item at the
  key so the system's `attribute_not_exists` put is refused by DynamoDB itself; `until reset` only;
  nothing reports the refusal (`unobserved`). Throttling (`ProvisionedThroughputExceeded`) cannot be
  produced by DynamoDB Local, so it is not in the catalog. `Connection.*` via SPEC-FPX-001.

## settle
Native: unchanged and truthful only where the stream is one ordered sequence (one open shard, `fence:true`).
Real DynamoDB tables normally have several shards: settle declines, the harness keeps the ceiling.
Snapshot: true, because a consistent read of the base table sees every acknowledged write; cannot
prove anything about global secondary indexes (eventually consistent, never read here).

## Endpoints
Local: DynamoDB Local (`amazon/dynamodb-local`) via `options.endpoint` or `ephemeral`. A real cloud
endpoint is possible through the existing `auth` options and is not exercised or required here.

## What a test needs
A DynamoDB Local container the test starts (or `ephemeral`); tables `default` (PK,SK strings, stream on),
`numeric` (PK number), `nostream`; a Toxiproxy container for -002; `fixtures/query-probe.mjs`.
