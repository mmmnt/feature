# KMS adapter — design (DRAFT)

Specs: `observe.feat` (SPEC-ADPKMS-001, 26 scenarios), `transport.feat` (SPEC-ADPKMS-002, 6).
Package: `@mmmnt/feat-adapter-kms` (new).

## Client and emulator
`@aws-sdk/client-kms` **3.1164.0** (latest 2026-11-06; engines node >=20). Commands confirmed in
`dist-types/commands`: ListKeys, DescribeKey, ListAliases, ListResourceTags, TagResource, UntagResource,
CreateAlias, DeleteAlias, DisableKey, EnableKey, ScheduleKeyDeletion, CancelKeyDeletion,
EnableKeyRotation, DisableKeyRotation, UpdateAlias. Emulator: `nsmithuk/local-kms` (the image the Sift
container runs; account 111122223333, region eu-west-2 are dummies via `KMS_ACCOUNT_ID`/`KMS_REGION`).
Its `src/handler` (GitHub) implements create/describe/list keys and aliases, enable/disable,
schedule/cancel deletion, tag/untag/list tags, rotation status/enable/disable, policy get/put,
encrypt/decrypt/re-encrypt/sign/verify/MAC, data keys, random. README: no change feed or audit log.
**The adapter is a key-state observer; it never needs AWS.**

## Modes: diff = snapshot (the assumption holds)
Nothing emits changes, so the diff compares two snapshots (ListKeys -> DescribeKey + ListResourceTags +
GetKeyRotationStatus, ListAliases). What it sees: key created, KeyState/Enabled change (disabled,
pending deletion), description, tags, aliases, rotation. What it **cannot** see: any cryptographic use
(Encrypt/Decrypt/Sign/GenerateDataKey leave no state), so "this key was not used" is unprovable here; a
spec that predicts use needs another instrument (CloudTrail on a real account, not in scope). Key policy
changes are not snapshotted (open question).
Identity: first namespaced alias (relative) else `Name` tag else KeyId (random, so a spec cannot name
it). Deleting a key's only alias therefore reads as REMOVE + INSERT (a scenario states it).

## settle
True for a declared `emulator: "local-kms"` (single process, reads follow its acknowledged writes);
false otherwise, because AWS documents KMS as eventually consistent (fetched: docs.aws.amazon.com KMS
developer guide, "AWS KMS eventual consistency": changes "might not be immediately visible", typically
seconds, sometimes minutes). The emulator claim is by construction, not independently verified.

## Namespace
Namespace comes from the runner (SPEC-RT-006), not an option. Key tag `feat:namespace=<ns>` or alias prefix `alias/<ns>/`; either puts a key in the namespace. Reset
deletes aliases, removes the tag (before scheduling: tag calls fail on a key pending deletion), then
`ScheduleKeyDeletion` at the 7-day minimum.

## Faults (until reset; unobserved)
`UseKey.DISABLED` (DisableKey), `UseKey.PENDING_DELETION` (ScheduleKeyDeletion), `UseKey.ALIAS_NOT_FOUND`
(DeleteAlias): real KMS refusals (DisabledException, KMSInvalidStateException, NotFoundException),
produced by changing the key, so a `read` also shows the faulted state. Reset restores first
(`EnableKey`; `CancelKeyDeletion` returns a key to Disabled in AWS, then `EnableKey`; alias recreated).
Throttling and access-denied are not produced by the emulator. `Connection.*` via SPEC-FPX-001.

## Test needs
A local-kms container the test starts (port 8080), dummy credentials, Toxiproxy container for -002,
`fixtures/probe.mjs`.
