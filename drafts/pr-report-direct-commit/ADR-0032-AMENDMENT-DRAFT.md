# DRAFT: SPEC-PRR-001 / ADR-0032, direct commits and the pr-merge/v2 statement

Status: draft, revision 2. It waits for the founder's flip; nothing here is agreed. The amended spec is
`drafts/pr-report-direct-commit/actions/pr-report/report.feat` (its `status` line is left as it is, as the repository's
amendment drafts do) with `report.contract.json`. When agreed, both are promoted over `actions/pr-report/`, and the
decision below joins `docs/adr/ADR-0032-pr-report-action.md`.

## Why

Founder ruling 2026-11-20, "Direct-commit mode" (flmnt 720367d8; context 55d6ee20). flmnt's roadmap App lands built /
verified flips on main as one App-signed `createCommitOnBranch` commit, which has no pull request (3e87faa8,
95c2f463). Merge mode refused that commit with `NO_PR_FOR_MERGE`. The Action reports and attests it instead of
flmnt skipping the statement. The work ships as v0.1.74, and flmnt#298 then re-pins and drops
`cargo xtask roadmap flip-commit`.

Revision 2 applies the founder's rulings on the first draft (flmnt 143df84e):

- **Q1 "Any push with no PR".** Every push to main whose head has no merged pull request is a direct commit. It is
  reported and signed. There is no allow-list input, and `NO_PR_FOR_MERGE` is gone. The push's sender and each
  commit's GitHub verification are still recorded as facts. Q2 and Q5 fall away with this ruling.
- **Q3 "pr-merge/v2".** One predicate type, `https://feature.mmmnt.dev/attestation/pr-merge/v2`, covers merges and
  direct commits. Its `pullRequest` may be null. Statements signed under v1 stay verifiable.
- **Q4 "Attest head, list all".** The statement attests the head commit and lists every commit in `before..head`.

## Settled ground (cited, not asked)

- **Where the mode lives and when it ships:** in the Action, as an amendment of SPEC-PRR-001 / ADR-0032, released as
  v0.1.74 (720367d8).
- **Which pushes qualify, the predicate type, and what is listed:** decided by 143df84e (Q1, Q3, Q4), as above.
- **The two-run split** (ADR-0032 decision 13 amendment; flmnt 99075bb2):
  - The report run holds no key.
  - Sign mode alone signs exactly the statement whose digest main's check recorded, for the run's main commit.
  - Any other statement is refused `STATEMENT_MISMATCH` with no effect.
- **The evidence store** (decision 12; flmnt 41d77efc (6)): main's evidence is stored in GHCR by digest before
  anything is signed. A failed store is `EVIDENCE_STORE_FAILED`.
- **Signing** (decision 13; f1530c7d): the consumer's own key, and no transparency log.
- **The predicate namespace** (41d77efc (7a)): `https://feature.mmmnt.dev/attestation/`.
- **Main runs queue** (217133a8), so the flip commit's own run always reports.

## Domain delta

**Report run on a push to main (main mode).**

1. It looks up the merged pull request of the head, as today.
2. Then, for every push, merge or direct, it reads `GET /repos/{o}/{r}/compare/{before}...{sha}`. The compare
   gives a status and the commits, each with its parents and `commit.verification` (verified, reason).
3. If the status is not `ahead`, the push's `before` is not an ancestor of the head (a force push). The run rejects
   `NOT_FAST_FORWARD`: nothing is stored, written, signed or posted.
4. The commit list is paged until GitHub has returned every commit. None is left out.
5. **With a merged pull request** the run continues as today. The statement gains the `push` block and is typed
   v2.
6. **With none, it is a direct commit:**
   - It verifies main's attestations. The main-provenance link and the required subjects work as for a merge.
   - It stores the evidence.
   - It writes the statement with `pullRequest: null` and `prRun: null`.
   - It posts main's check with `external_id` set to the statement's digest. The header reads "Direct commit `<sha>`
     · no pull request · pushed by `<sender>` · N commit(s) since `<before>`". The Chain section has one row per
     listed commit with its signature verification, plus "Merge statement `<digest>` · signature pending (job
     sign-merge)".
   - It posts to **no** pull request.

**The pr-merge/v2 statement** (merges and direct commits):

```json
{ "pullRequest": { "number": 7, "headSha": "…", "mergeRefSha": "…" } | null,
  "prRun": { "id": 44153523061, "attestations": ["sha256:…"] } | null,
  "push": { "sender": "<login>", "before": "<sha>",
            "commits": [ { "sha": "<sha>", "parents": ["<sha>"],
                           "verification": { "verified": true, "reason": "valid" } } ] },
  "main": { "sha": "<head>", "run": { "id": 1, "attempt": 1 }, "artifacts": ["sha256:…"] },
  "evidence": { "bundles": ["sha256:…"], "store": "ghcr.io/…@sha256:…" } }
```

Only `main.sha` (the head) is attested: `main.artifacts` are its subjects. `push.commits` lists the range as facts. An
unsigned or unverified commit in the range is recorded as it is, and it neither breaks the chain nor refuses the push.

**Sign mode.** Its checks are unchanged (the statement names the run's main commit, and its digest is the one main's
check recorded). It signs every statement under `…/pr-merge/v2`. It appends the signature to main's check, and to the
pull request's comment only when `pullRequest` is not null.

**Refusals.**

- Removed: `NO_PR_FOR_MERGE`, which no longer refuses anything.
- New: `NOT_FAST_FORWARD`, for a force push.
- Unchanged: `PR_EVIDENCE_MISSING`, `EVIDENCE_STORE_FAILED`, `STATEMENT_MISMATCH`, `NO_EVIDENCE` and
  `INSUFFICIENT_PERMISSIONS`. `DIRECT_COMMIT_REFUSED` from revision 1 is dropped.

**Probe steps.**

- `pusher:<login>`: the push's sender.
- `range:one|many|forced`: the compare's fixture.
- `sign:direct`: a statement with a null `pullRequest`.

**Permissions.** None new. The compare needs `contents: read`, which the report job already holds.

### Migration from pr-merge/v1 to pr-merge/v2

- **Up to v0.1.73:** main mode writes, and sign-merge signs, statements of type `…/pr-merge/v1`. These have no
  `push` block, and `pullRequest` is always present. A push with no pull request is refused `NO_PR_FOR_MERGE`.
- **From v0.1.74 on:** main mode writes a v2 statement for every push to main, merge or direct. sign-merge signs it
  under `--type https://feature.mmmnt.dev/attestation/pr-merge/v2`. Nothing new is signed under v1. The Verify block
  on main's check renders the v2 command.
- **Verifying:**
  - A main commit attested by v0.1.74 or later:
    `cosign verify-attestation --key <public key> --insecure-ignore-tlog --type https://feature.mmmnt.dev/attestation/pr-merge/v2 <repository>@<digest>`.
  - A main commit attested before it: the same command with `--type …/pr-merge/v1`. These attestations stay in GHCR
    as OCI referrers, so v1 stays verifiable for history.
  - An auditor who does not know a commit's release tries v2, then v1. A commit attested under both cannot happen,
    since each main commit is signed once.
- **Consumer changes (flmnt):** re-pin `report-main` and `sign-merge` to v0.1.74, and remove `flip-commit` and the
  `flip != 'true'` guards. No new input. Any place that names the predicate type (an allow-list, a verify script,
  docs) adds v2 and keeps v1.

### Scenarios (revision 2)

New:

1. A push with no pull request is a direct commit. Its statement has no pull request, and main is checked.
2. A push carrying several commits attests the head and lists every commit since `before`, unsigned ones as they
   are.
3. A force push is refused `NOT_FAST_FORWARD`. Nothing is stored, signed or posted.
4. A merge pushed as a force push is refused `NOT_FAST_FORWARD`.
5. A direct commit whose build attested another commit breaks the chain at main-provenance and writes no statement.
6. A direct commit whose evidence cannot be stored is refused `EVIDENCE_STORE_FAILED`.
7. sign-merge signs a direct commit's statement under pr-merge/v2 and posts to no pull request.
8. Main's verify block names the pr-merge/v2 type.

Amended:

- The four main-mode merge scenarios (merge, check-summary merge ref, main-provenance, fork merge) gain the compare
  GET after the pulls lookup.
- The sign-merge scenario signs under v2.

Removed:

- "A main commit with no merged pull request is refused" (`NO_PR_FOR_MERGE`).

Totals: 40 scenarios, against 33 on main. Revision 1's allow-list and `DIRECT_COMMIT_REFUSED` scenarios are gone.

## Decision (proposed text for ADR-0032)

Decision 8's predicate is replaced by v2, and this becomes decision 15.

15. **Every push to main is attested, merge or direct; the statement is pr-merge/v2** (founder rulings 720367d8,
    143df84e).

    **Which pushes and what is listed.** A push to main whose head has a merged pull request is that pull request's
    merge. One whose head has none is a direct commit, whoever pushed it. For both, the Action reads the compare of
    the push's `before` with its head and refuses a push whose `before` is not an ancestor (`NOT_FAST_FORWARD`). The
    statement attests the head and lists every commit in the range, each with its parents and GitHub's verification,
    together with the push's sender.

    **The predicate type.** It is `https://feature.mmmnt.dev/attestation/pr-merge/v2` for both. `pullRequest` and
    `prRun` are null for a direct commit. Statements signed under v1 stay verifiable with that type, and nothing new
    is signed under it.

    **Where it is reported.** A direct commit is reported on main's check alone.

### Rejected alternatives

- **The bot-commit skip in the consumer** (PR #298). Rejected by 720367d8.
- **An allow-list of senders** (revision 1's `direct-commit-actors`). Rejected by 143df84e, "Any push with no PR". A
  sender's identity is recorded, not gated.
- **A separate `direct-commit/v1` predicate type.** Rejected by 143df84e, "pr-merge/v2". One type covers every push to
  main, with a nullable pull request.
- **Refusing a multi-commit or merge-commit direct push** (revision 1's `DIRECT_COMMIT_REFUSED`). Rejected by
  143df84e, "Attest head, list all".
- **Attesting a force push from the merge base.** The commits it removed from main would vanish without a record.
  This is open question A below.

### Consequences

- Main's check on a direct commit is the only place it is reported. No pull request comment exists for it.
- An auditor reads the range from the signed statement. Commits in it are not attested themselves; only the head's
  artifacts are.
- A ruleset-bypass push by a person, with no pull request, is now attested too. It is visible in the statement as its
  sender and its commits' verification, not refused.

## Open questions for the founder

The draft is written at each recommendation.

**A. Is a force push refused?**
Trade-off: refusing leaves main's run red with no check, which is loud. That is right if force pushes to main should
never happen, but it makes a deliberate rewrite unattestable. Attesting it keeps main green and records the rewrite as
a fact.
- (a) **Recommended:** refuse `NOT_FAST_FORWARD`, with no effect.
- (b) Attest the head. Record `push.forced: true` and list the commits from the merge base of `before` and the head,
  plus the `before` that was replaced.
- (c) Attest the head and list nothing, with `forced: true`.

**B. What if the range cannot be listed in full?**
For example, GitHub's compare stops paging (it serves at most a few hundred commits per request and caps very large
comparisons), or `before` is all zeros on a branch's first push. Trade-off: "list all" promises no commit is left out.
A partial list would break that silently, but a refusal turns main red on a rare event.
- (a) **Recommended:** refuse it with a new code, `PUSH_RANGE_INCOMPLETE`, with no effect. A first push of a default
  branch (`before` all zeros) is listed from its root commit instead.
- (b) List what GitHub returns and record `push.complete: false`.
- (c) Fall back to `git log before..sha` in the checkout. This needs full history (`fetch-depth: 0`) in the report
  job.

**C. Does the `push` block go in merge statements too?**
The draft puts it in both, so v2 has one shape. Trade-off: for a squash merge the range is just the merge commit,
which is redundant but uniform. Leaving it out of merges keeps their statements smaller and gives v2 two shapes.
- (a) **Recommended:** both.
- (b) Direct commits only.
