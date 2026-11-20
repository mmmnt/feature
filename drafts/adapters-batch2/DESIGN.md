# flmnt batch 2: the three Feature changes (drafts, nothing applied)

Requested by flmnt for batch 2 (FLMNT-SPEC-LCY-004 Export, FLMNT-SPEC-WSP-006 PurgeStreams). Founder rulings
2026-11-20, flmnt workspace bc674142, stream `::domain`: 16268202 (EXP-q4), 415d6541 (WSP-q1), f2f873a8 (N2, N3, N4);
batch agreed in advance once revised, 2ce1cf5f ("The Feature adapter work comes first ... each released and pinned").
Every spec here is a draft: a new spec is `status draft`; an amendment of an agreed spec is a full copy whose header
says "Amendment DRAFT ... awaiting the founder's flip", its status line unchanged (the 7413273 convention). The
founder flips; tooling flips built/verified.

| Item | Spec | Draft file(s) | Scenarios |
| --- | --- | --- | --- |
| F1 archive members + clearOnReset | SPEC-ADPFS-002 (new) | `adapters/fs/archive.feat`, `.contract.json` | 22 (30 cases with outline rows) |
| F2 Kurrent `stream.deleted` | SPEC-ADPKUR-001 (amended) | `adapters/kurrent/observe.feat`, `.contract.json` | 25 → 31 (1 changed, 6 new) |
| F3 per-spec observed services | SPEC-CORE-001 (amended), SPEC-DRV-002 (new), ADR-0033 | `packages/feat-core/parse.feat` + fixtures, `packages/feat-derive/derive-observes.feat` + fixtures, `corpus/spec-observes/`, `schemas/builtspec.schema.json`, `ADR-0033-DRAFT.md`, `grammar-reference.change.md` | CORE 22 → 28 (+6, 13 new fixture rows), DRV-002 4 |

Checked by applying the drafts to a scratch state of this branch: `feat lint`, `feat generate` (both tiers) and
`feat audit` were clean (0 errors; the only warnings are "status draft"), then everything outside `drafts/` was
restored.

---

## F1 — SPEC-ADPFS-002: archive members, clearOnReset (`@mmmnt/feat-adapter-fs`)

### Domain delta

Adapter options (validated at `setup()`):
- `archives: [glob]`: a FILE_WRITTEN record whose path matches is read at diff time (peek and stop agree).
- `clearOnReset: boolean` (default false).

Records (the adapter's events):
- `FILE_WRITTEN { path, members }` for a matching archive: `members` in archive order, one per regular file, each
  `{ name, json }` (`.json`), `{ name, lines }` (`.jsonl`, each line parsed, a final newline adds none, `\r\n` ok) or
  `{ name, text }` (other, UTF-8). Directory entries are not members.
- `ARCHIVE_UNREADABLE { path, reason, member? }` (new type) in place of FILE_WRITTEN when the archive cannot be read in
  full; reason `zstd | tar | json | utf8`. A violation by prediction inversion (it is never what the spec predicted),
  never skipped, never partly reported.
- `FILE_WRITTEN { path }` / `FILE_DELETED { path }` otherwise, unchanged.

Commands and their refusals:
- `setup()`: OPTIONS_INVALID (archives not an array of non-empty strings, clearOnReset not a boolean);
  CLEAR_SCOPE_UNSAFE (clearOnReset on and the scope is the project root, an ancestor, or outside it);
  ZSTD_UNSUPPORTED (archives given on a Node without `zlib.zstdDecompressSync`).
- `reset()` with clearOnReset: removes every file and directory under the scope, keeps the scope directory and the
  names the snapshot never descends into (node_modules, dist, .turbo, .git, coverage, reports); a missing scope stays
  missing; CLEAR_FAILED (the scope is not a directory, or an entry cannot be removed).
- Without clearOnReset, reset writes nothing (SPEC-ADPFS-001 unchanged).

No new dependency: ustar parsing in-house (ustar prefix, GNU `L` long names, pax `x` path, `g` ignored), zstd through
`node:zlib`, globs through `node:path` `matchesGlob`. Archive fixtures come from real producers (bsdtar, GNU tar,
zstd CLI), never from the adapter's own code; GNU long names matter because flmnt's writer (tar 0.4, flmnt 76841c7b)
emits them for a path over 100 bytes, and a keyframe stream's file (`workspaces/<id>/<session>/keyframe.jsonl`, N5) is
about that long.

### Scenarios (one line each)

1. an archive written in the window is reported with its members in archive order
2. an empty .jsonl member is no lines
3. a member name longer than 100 bytes is read whole, from a GNU long-name or a pax header (outline, 2 rows)
4. a glob reaches into subdirectories when it says so
5. a written file that matches no archive glob is reported as before, with no members
6. without the archives option an archive is a file like any other
7. a deleted archive is reported deleted, with no members
8. an archive that existed before the window and did not change is not reported
9. a peek reports the members and the stop reports the same
10. an archive that cannot be read in full is captured as ARCHIVE_UNREADABLE, never skipped (outline, 8 rows: not
    zstd, truncated, not tar, bad checksum, bad .json, bad .jsonl line, bad UTF-8, symlink entry)
11. an empty file matching a glob is an unreadable archive, not an archive with no members
12. reset with clearOnReset empties the scope and keeps the scope directory
13. reset with clearOnReset keeps the names the adapter never descends into
14. reset without clearOnReset writes nothing to the tree
15. reset with clearOnReset and no scope directory leaves it absent
16. what reset removes is never a record of the next window
17. REFUSAL CLEAR_FAILED: a reset whose scope is a file is refused, and the file is left
18. REFUSAL OPTIONS_INVALID: an option of the wrong shape is refused at setup (outline, 4 rows)
19. REFUSAL CLEAR_SCOPE_UNSAFE: clearOnReset on a scope not strictly inside the project root (outline, 4 rows)
20. a root scope is not refused when clearOnReset is off
21. REFUSAL ZSTD_UNSUPPORTED: archives on a Node without zstd is refused at setup
22. without archives the adapter runs on a Node without zstd

### Size: M

Adapter about 250 lines (tar reader about 90, member decoding, glob, clear, option checks), probe steps, twelve
fixture archives plus `make.sh`, README. One package release (0.1.11), then flmnt pins it.

---

## F2 — SPEC-ADPKUR-001 amended: a system soft delete is `stream.deleted`

### Domain delta

- Capture: a `$metadata` record whose body has `$tb` equal to the Int64 maximum (delivered as 2^63) is reported as
  `{ type: "stream.deleted", key: <stream>, payload: { streamId: <stream> }, metadata: { revision, commitPosition } }`,
  `<stream>` without `$$` and without the namespace prefix. That `$metadata` record is no longer captured.
- Unchanged: the server's own `{ $tb: n < max }` record after a soft delete is dropped (ruling 2026-11-09, Kurrent
  $tb A); every other `$metadata` record is captured as `$metadata`; `$streamDeleted` is kept as it is.
- No new refusal. Probe: answers `lastPayloads`; new step `meta:<ns>:<stream>:maxAge=<n>`; a stream name may hold `:`.

### Scenarios (one line each)

1. CHANGED: a soft delete by the system is reported as stream.deleted naming the stream, and its $metadata record is
   not captured
2. a stream name with separators (`ws-1::domain`) is named whole in stream.deleted
3. a soft delete of a stream that has other metadata is still a stream.deleted
4. a metadata write that is not a delete is still captured as $metadata
5. a delete then a rewrite in one window is a stream.deleted then the write, and the server's $tb record is still dropped
6. a peek reports the stream.deleted and the stop reports the same
7. a soft delete in another namespace is not this namespace's stream.deleted

The 24 other scenarios, including both refusals (NAMESPACE_INVALID, ALL_READ_DENIED, FAULT_UNSUPPORTED) and the reset
and settle scenarios, are unchanged.

### Size: S

About 20 lines in `src/index.ts`, the probe's `lastPayloads` and `meta` step, README. Integration tier only (a
KurrentDB container). One package release, then flmnt pins it.

---

## F3 — `observes`: a spec declares the services it observes

### Domain delta

- Grammar: optional header line `observes <service>[, <service>]...`; IR top-level `observes` in written order. No
  line = every configured service, IR unchanged.
- Parse refusals: UNKNOWN_SERVICE_KEY (declared key not configured); UNOBSERVED_SERVICE (new: a prediction, seed,
  deliver, fault or capture reference names a configured service the spec does not declare); INCOMPLETE_PREDICTION
  (an observed service omitted); MALFORMED_SYNTAX (bare, duplicate, empty item, two lines).
- Derive (SPEC-DRV-002): success and error resolve the observed services; a rejection resolves every configured
  service, the unobserved ones as a synthesised `has []`; a query keeps its synthesised `has []` on every service;
  UNKNOWN_SERVICE_KEY when the derive config does not configure an observed key (a tier mismatch), never a silent drop.
- Unchanged: the harness, the emitted file, the adapter interface, `feat 1.0`.
- Where things live: grammar reference `docs/grammar-reference.md` (§2, §5.3 INV-6); the INV-6 check is
  `INCOMPLETE_PREDICTION` in `packages/feat-core/src/parse.ts` (the closed-space check beside it is
  UNKNOWN_SERVICE_KEY); the generator's per-service resolution is `resolvePrediction` in
  `packages/feat-derive/src/index.ts`; the harness diffs `prediction.services` in `packages/feat-runtime/src/harness.ts`.

### Scenarios (one line each)

SPEC-CORE-001 (amended, +6 scenarios, 13 new fixture rows):
1. parses the observed-services exemplar (spec-observes, ADR-0033)
2. a command that observes two of three services predicts those two and records them in written order
3. a query that observes one service may read it with contains
4. REFUSAL: refuses an observes declaration that is not well formed or names an unconfigured service (outline:
   UNKNOWN_SERVICE_KEY; MALFORMED_SYNTAX for duplicate, bare, trailing comma, two lines)
5. REFUSAL UNOBSERVED_SERVICE: a service the spec uses but does not observe, naming it and the observed ones (outline:
   prediction, contains, seed, fault, capture reference, deliver)
6. REFUSAL INCOMPLETE_PREDICTION: a prediction that omits an observed service

SPEC-DRV-002 (new):
1. a spec with no observes resolves every configured service
2. a spec that observes two services: a success and an error resolve those two, a rejection every service
3. a query that observes one service still writes to no configured service
4. REFUSAL UNKNOWN_SERVICE_KEY: an observes the derive config does not configure is refused, never dropped

### Size: M (on the recommended F3-a); L on F3-b

Four layers in one change (grammar reference, corpus #20, parser + IR schema + types, corpus re-validated), derive,
the TextMate grammar, ADR-0033. On F3-b add a harness spec and an emitter change. Then flmnt reverts the three
mechanical `files has []` additions and adds `observes` to Import, PauseWrites and ResumeWrites.

---

## Already answered (settled ground, cited)

- A Feature adapter predicts the archive's members (EXP-q4, 16268202), as an extension of `@mmmnt/feat-adapter-fs`,
  SPEC-ADPFS-002, options `archives: [glob]` and `clearOnReset`; flmnt's service key stays `files` (N4, f2f873a8).
- clearOnReset is opt-in and empties the scope at reset (N2, f2f873a8); this settles the adapter writing to the tree
  against its observe-only README.
- The Kurrent adapter reports a deletion as `stream.deleted {streamId}` (WSP-q1, 415d6541); flmnt purges by soft
  delete plus a later scavenge (WSP-q5, 415d6541); a purge is not a tombstone (1912f83d, cited in 5bb82041).
- The server's `$tb` record after a soft delete is dropped (Kurrent $tb A, 2026-11-09, in SPEC-ADPKUR-001's header).
- A spec declares the subset of configured services it observes (N3, f2f873a8); flmnt's mechanical `files has []` lines
  are reverted.
- flmnt's archive writer is tar 0.4 + ruzstd 0.9 (76841c7b); a stream's file maps `::` to `/` (N5, f2f873a8).
- Order: the Feature adapter work is released and pinned before flmnt's batch 2 builds (2ce1cf5f).

## Genuinely open (each drafted on its recommendation)

Each was searched by name in flmnt (zstd / Node version, clearOnReset, INV-6, tombstone, the codes) and has no ruling.

**F1-a. Node range for zstd.** `zlib.zstdDecompressSync` exists from Node 22.15 (and 23.8); the repo's engines say
`>=22`, the fs adapter declares none and its README says "Node 20 or later". Trade-off: a package-wide floor is honest
but drops users of an adapter that does not need zstd; feature detection keeps them and refuses loudly only where the
option is used.
- (a) **Recommended, drafted:** keep the range; `archives` on a Node without zstd is ZSTD_UNSUPPORTED at setup.
- (b) Raise the fs adapter's engines to `>=22.15` and the README with it.
- (c) Add a pure-JS zstd decoder (a new dependency, against the brief).

**F1-b. One bad member.** Trade-off: per-member errors show more, but a partly reported archive can let a prediction
over the good members pass while the archive is corrupt.
- (a) **Recommended, drafted:** the whole record is ARCHIVE_UNREADABLE naming the member.
- (b) Report every member, the bad one as `{ name, error }`.

**F1-c. Tar entries that are not regular files or directories** (symlinks, hard links, devices). flmnt's writer emits
none.
- (a) **Recommended, drafted:** ARCHIVE_UNREADABLE reason `tar` naming the entry (never skipped).
- (b) Skip them. (c) Report them as members `{ name, link }`.

**F1-d. `.jsonl` lines parsed or raw.** "into `lines`" in N4 does not say which. Trade-off: parsed lines compare as JSON
(key order and spacing do not matter) and a non-JSON line is a violation; raw strings pin the writer's exact bytes.
- (a) **Recommended, drafted:** each line parsed; a line that does not parse is ARCHIVE_UNREADABLE reason `json`.
- (b) Each line a string.

**F1-e. The clear guard.** clearOnReset with `scope: "."` would delete the project. Trade-off: the guard refuses a
configuration someone might want for a throwaway root; without it one option deletes a checkout.
- (a) **Recommended, drafted:** CLEAR_SCOPE_UNSAFE unless the scope is strictly inside the project root, and the
  excluded names (node_modules, .git, ...) are never cleared.
- (b) No guard; document it.
- (c) The guard, and the excluded names cleared too.

**F2-a. Which `$metadata` is a soft delete.** Trade-off: "`$tb` is the Int64 maximum, whatever other keys" catches a
delete of a stream that has `$maxAge` or an ACL; "exactly `{ $tb: max }`" is narrower and reports such a delete as a
plain `$metadata`.
- (a) **Recommended, drafted:** `$tb` equal to the maximum, other keys ignored.
- (b) Exactly `{ $tb: max }`.

**F2-b. A hard delete (tombstone, `$streamDeleted`).** WSP-q1 names a deletion; flmnt soft-deletes only.
- (a) **Recommended, drafted:** unchanged, still captured as `$streamDeleted` (it cannot be predicted, which is a
  defect only for a system that tombstones).
- (b) Also `stream.deleted { streamId }`. (c) `stream.deleted { streamId, hard: true }`.

**F3-a. What a rejection asserts on a service the spec does not observe.** Trade-off: the language says a rejection has
zero effects on every configured service; keeping that means every configured service is still set up and captured for
every file (no saving in products to run), while dropping it lets a file run without products it does not touch but
weakens a non-negotiable law to "every observed service".
- (a) **Recommended, drafted:** `observes` narrows success and error predictions only; a rejection still proves zero
  effects on every configured service (derive synthesises `has []` on the unobserved ones), a query still writes to
  none; harness and emitter unchanged.
- (b) Only observed services are set up, captured and asserted, rejections included (a harness spec, SPEC-RT-015, and
  an emitter change; the rejection law is amended).
- (c) As (a), and also for `predict error`.

**F3-b. The new code's name.** UNOBSERVED_SERVICE (drafted; a parse error, exit 1). Alternatives:
SERVICE_NOT_OBSERVED, UNDECLARED_SERVICE (close to UNDECLARED_SCHEMA, which is about the contract block).
- (a) **Recommended, drafted:** UNOBSERVED_SERVICE. (b) SERVICE_NOT_OBSERVED. (c) UNDECLARED_SERVICE.
