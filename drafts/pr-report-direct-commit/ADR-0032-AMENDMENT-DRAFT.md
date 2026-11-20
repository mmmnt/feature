# DRAFT: SPEC-PRR-001 / ADR-0032, direct-commit mode

Status: draft. It waits for the founder's flip and nothing here is agreed. The amended spec is
`drafts/pr-report-direct-commit/actions/pr-report/report.feat` (its `status` line is left as it is, as the repository's
amendment drafts do) with `report.contract.json`. When agreed, both are promoted over `actions/pr-report/`, and the
decision below joins `docs/adr/ADR-0032-pr-report-action.md`.

## Why

Founder ruling 2026-11-20, "Direct-commit mode" (flmnt 720367d8, chosen over the recommended bot-commit skip; context
55d6ee20). flmnt's roadmap App `mmmnt-flmnt-roadmap[bot]` is a bypass actor on main's ruleset (3e87faa8). After main's
CI is green, it lands the built / verified flips as one App-signed commit through GraphQL `createCommitOnBranch` with
`expectedHeadOid` (95c2f463, 3e87faa8). That commit has no pull request. flmnt's `report-main` (merge mode) and
`sign-merge` (sign mode) run this Action on every push to main, and merge mode refuses that commit with
`NO_PR_FOR_MERGE`. The ruling rejects skipping the statement in flmnt (`cargo xtask roadmap flip-commit`, PR #298). The
Action reports and attests the commit itself. The work ships as v0.1.74, and #298 then re-pins and drops flip-commit.

## Settled ground (cited, not asked)

- **The mode exists and lives in the Action.** It is an amendment of SPEC-PRR-001 / ADR-0032, released as v0.1.74.
  flmnt does not skip the statement (720367d8).
- **The work is split across two runs.** The report run holds no key and writes the statement unsigned. Sign mode
  alone signs exactly the statement whose digest main's check recorded, for the run's main commit. Otherwise it
  refuses `STATEMENT_MISMATCH` with no effect (ADR-0032 decision 13 amendment, "Two-run merge mode (Recommended)";
  flmnt 99075bb2). The direct mode follows this split, with no new job and no new secret.
- **Main's evidence is stored in GHCR by digest before anything is signed, and the statement names that digest.** A
  failed store is `EVIDENCE_STORE_FAILED` with no effect (decision 12; flmnt 41d77efc (6)).
- **The consumer signs with its own key and no transparency log.** Verification uses
  `cosign verify-attestation --key … --insecure-ignore-tlog` (decision 13; flmnt f1530c7d).
- **Predicate types live under `https://feature.mmmnt.dev/attestation/`** (flmnt 41d77efc (7a)). Only the name of a
  new type is open (Q3).
- **The flip commit is one App-signed commit on the previous head.** `createCommitOnBranch` refuses when main has moved
  (3e87faa8). The commit has one parent, the push's `before`, which is the rule in Q4.
- **Main runs queue and are never cancelled,** so the flip commit's own run always reports (flmnt 217133a8).
- **Merge mode is unchanged when the commit has a merged pull request.** This is the brief's scope. The draft adds a
  scenario proving it holds even when an allowed actor pushed the commit.

## Domain delta

- **Command:** the report run on a push to main (merge mode). It gains a branch for a commit with no merged pull
  request. Sign mode gains a statement kind.
- **New input:** `direct-commit-actors`, a newline-separated list of logins, for example `mmmnt-flmnt-roadmap[bot]`.
  The default is empty, so no consumer's behaviour changes until it opts in.
- **What qualifies as a direct commit:** a push to main whose commit has no merged pull request
  (`GET /commits/<sha>/pulls` finds none), with the push's sender (event `sender.login`, which GitHub also gives as
  `GITHUB_ACTOR`) named in `direct-commit-actors`.
- **The shape a direct commit must have:** the Action reads `GET /repos/o/r/commits/<sha>`. The commit has exactly one
  parent, and that parent is the push event's `before`.
- **What the report run does for a direct commit:**
  1. It verifies main's attestations. The main-provenance link and the required subjects work as in merge mode.
  2. It stores the evidence in GHCR.
  3. It writes the unsigned **direct-commit statement**, `WRITE direct-commit-statement`, with this shape:
     ```json
     { "directCommit": { "sha": "<main>", "parent": "<parent>", "sender": "<login>" },
       "main": { "sha": "<main>", "run": { "id": 1, "attempt": 1 }, "artifacts": ["sha256:…"] },
       "evidence": { "bundles": ["sha256:…"], "store": "ghcr.io/…@sha256:…" } }
     ```
     It has no `pullRequest` and no `prRun`. The outputs `statement` and `statement-digest` are as in merge mode.
  4. It posts main's check with `external_id` = the statement's digest. The header line reads "Direct commit `<sha>` ·
     parent `<parent>` · pushed by `<login>` · main run …", and the Chain section gets the row "Direct-commit statement
     `<digest>` · signature pending (job sign-merge)".
  5. It posts **no** pull request comment.

  When the chain is broken or a required subject is missing, it writes no statement and the check fails, as merge mode
  does.
- **Sign mode:** the checks on the main commit and the digest are unchanged. A statement carrying `directCommit` is
  signed under the predicate type `https://feature.mmmnt.dev/attestation/direct-commit/v1`, and a merge statement
  under `…/pr-merge/v1`, never the other way. The signature is appended to main's check only, with no pull request
  comment.
- **Refusals:**
  - `NO_PR_FOR_MERGE` keeps its code. Its condition narrows to "no merged pull request **and** the sender is not
    allowed".
  - The new `DIRECT_COMMIT_REFUSED` covers an allowed sender's commit that has more than one parent, or whose parent
    is not `before`. Nothing is stored, written, signed or posted.
  - `EVIDENCE_STORE_FAILED`, `NO_EVIDENCE` and `INSUFFICIENT_PERMISSIONS` apply to the direct mode unchanged.
- **Probe steps:**
  - `pusher:<login>`
  - `direct-actors:<login>`
  - `direct:single|multi|mergecommit`
  - `sign:direct`
- **Permissions:** no new ones. `GET /commits/<sha>` needs `contents: read`, which the report job already holds.

### Scenarios (draft, 8 new; 33 unchanged)

1. A direct commit by an allowed actor writes a direct-commit statement and checks main. The signature is left to
   sign-merge.
2. A commit with no pull request, pushed by an actor who is not allowed, is refused `NO_PR_FOR_MERGE`. Nothing is
   signed or posted.
3. An allowed actor's push that carried more than one commit is refused `DIRECT_COMMIT_REFUSED`.
4. An allowed actor's merge commit with no pull request is refused `DIRECT_COMMIT_REFUSED`.
5. A direct commit whose build attested another commit breaks the chain at main-provenance and writes no statement.
6. A direct commit whose evidence cannot be stored in GHCR is refused `EVIDENCE_STORE_FAILED`.
7. An allowed actor's commit that has a merged pull request is reported as that pull request's merge. Merge mode is
   unchanged.
8. sign-merge signs a direct-commit statement under the direct-commit predicate and posts to no pull request.

The existing "a main commit with no merged pull request is refused" scenario (no allow-list) stays as it is, and it
proves the default is off.

## Decision (proposed text for ADR-0032, decision 15)

15. **Direct-commit mode** (founder ruling 2026-11-20, "Direct-commit mode", flmnt 720367d8).

    **What a direct commit is.** It is a push to main whose commit has no merged pull request, pushed by a sender the
    consumer names in `direct-commit-actors` (empty by default). It must be one commit whose single parent is the
    push's `before`. Anything else is refused `DIRECT_COMMIT_REFUSED` with no effect. A push with no pull request by
    any other sender is still `NO_PR_FOR_MERGE`.

    **What the report run does.** It attests the commit the way merge mode attests a merge, with the same evidence
    store, the same main-provenance link and the same two runs. It writes a direct-commit statement that names the
    commit, its parent, the sender, the run, main's artifact digests and the evidence, and no pull request. It reports
    on main's check alone.

    **What sign mode does.** It signs that statement under its own predicate type,
    `https://feature.mmmnt.dev/attestation/direct-commit/v1`. An auditor who asks for `pr-merge/v1` is never answered
    by a commit that no pull request reviewed.

    **When there is a pull request.** A commit with a merged pull request is a merge, whoever pushed it.

### Rejected alternatives

- **The bot-commit skip in the consumer** (`cargo xtask roadmap flip-commit`, PR #298). The founder's ruling rejected
  it. Main would carry commits with no statement, and the skip would sit outside the Action that the chain of
  evidence is built around.
- **Accepting a red main after each flip** (55d6ee20). Every flip would leave main red, and a real failure would hide
  among them.
- **Any push without a pull request qualifies** (no allow-list). An admin or ruleset-bypass push that skipped review
  would be attested as a matter of course. The Action could not tell an automated, expected commit from an
  unreviewed human one.
- **The Action judging the diff** (flmnt's "pure flip" rule moved into the Action). That rule is flmnt's domain (spec
  status lines and FEATURES rows). Feature would have to learn one consumer's file formats. The consumer can keep the
  check as its own gate.
- **The pr-merge predicate with an empty pull request.** A verifier checking `--type …/pr-merge/v1` would accept a
  commit no pull request reviewed. The predicate type is the auditor's question, and it should say "no PR".
- **Attesting only the head of a multi-commit push.** The commits in between would reach main unattested behind an
  attested head.

### Consequences

- flmnt adds `direct-commit-actors: mmmnt-flmnt-roadmap[bot]` to `report-main` (sign-merge needs no new input). It
  re-pins both jobs to v0.1.74 and removes `flip-commit` together with the `flip != 'true'` conditions.
- An auditor verifies a flip commit with
  `cosign verify-attestation --key ci/signing/flmnt.pub --insecure-ignore-tlog --type https://feature.mmmnt.dev/attestation/direct-commit/v1 ghcr.io/mmmnt/flmnt-sbom@<digest>`.
- If flmnt allow-lists predicate types anywhere (the 2026-11-17 keyframe 3a8c418a says the pr-merge type is
  "allow-listed"), the direct-commit type joins that list.

## Open questions for the founder

Each question gives the trade-off, the recommendation, and the options. The draft is written at each recommendation.

**Q1: What qualifies a commit as direct?**
Trade-off: an allow-list adds one consumer input. It keeps a ruleset-bypass push by a person from being attested as if
it were expected.
- (a) **Recommended:** an allow-listed sender, through the input `direct-commit-actors`, default empty.
- (b) Any push to main with no merged pull request.
- (c) An allow-listed sender, plus an Action-side check that the diff touches only paths the consumer names (for
  example `**/*.feat`, `FEATURES.md`).

**Q2: Which code refuses a direct commit by a sender who is not allowed?**
Trade-off: a new code is more explicit in the log. Keeping the old one means the existing scenario and every
consumer's handling stay as they are.
- (a) **Recommended:** keep `NO_PR_FOR_MERGE`, with a detail that names the sender and the allow-list.
- (b) A new `DIRECT_ACTOR_NOT_ALLOWED`.

**Q3: Which predicate type is used?**
Trade-off: a new type needs a new verify command and allow-list entry. It also means an auditor's
`--type pr-merge/v1` never matches an unreviewed commit.
- (a) **Recommended:** a new type, `https://feature.mmmnt.dev/attestation/direct-commit/v1`.
- (b) `pr-merge/v1` with a `kind: "direct"` field and no pull request fields.
- (c) A new version, `pr-merge/v2`, whose `pullRequest` may be null.

**Q4: What shape must the commit have?**
Trade-off: being strict refuses a direct push that carries several commits, or a merge commit. Being loose lets
commits behind the head reach main without a statement.
- (a) **Recommended:** exactly one parent, equal to the push's `before`; anything else is `DIRECT_COMMIT_REFUSED`.
- (b) Attest the head and list every commit in `before..sha` in the statement.
- (c) No shape check.

**Q5: Which identity is matched against the allow-list?**
Trade-off: commit author fields can be forged. The push's sender is GitHub's record of who pushed. GitHub's signature
verification is extra evidence, but it would refuse unsigned pushes from bots that are otherwise allowed.
- (a) **Recommended:** the push's sender (`sender.login` / `GITHUB_ACTOR`), with the commit's GitHub `verification`
  (verified and reason) recorded in the statement as a fact, not used as a gate.
- (b) The sender, plus a required `verification.verified == true`, and a refusal otherwise.
- (c) The commit's author login.

The draft records the sender only. If (a) is chosen, `directCommit.verification` is added to the statement.
