# PR build report Action — design notes (DRAFT)

Scope entry: "SPEC-PRR-001 — the pull request build report Action", requested 2026-11-17 (flmnt record af370225).
Feature tracks scope in its local working ledger; a GitHub project issue follows once the project is set up.

## Inputs (Action `with:`)

| Input | Default | Meaning |
|---|---|---|
| `evidence` | `feat-evidence-*` | Artifact name glob for the uploaded `feat-evidence/2` bundles, one per tier |
| `attest-subjects` | empty | Artifact names whose attestations to verify (digests read from the run's artifacts) |
| `token` | `${{ github.token }}` | Needs `pull-requests: write`, `checks: write`, `actions: read`, `attestations: read` |
| `check-name` | `feat report` | Name of the check run carrying the summary |

## What it reads

- Evidence: `feat report --evidence` per tier → `verify.status`, `run.{status,tests,failures,errors}`, `runs[]`
  (per-scenario `spec_id`, `status`, `time`, `violations[]`), `specs[]` (id, lifecycle status, digest),
  `project.bindings` (what the tier ran against), `producer` (toolchain versions). Per-spec grouping comes from
  `runs[].spec_id`; no JUnit parsing.
- Jobs: `GET /repos/{o}/{r}/actions/runs/{run_id}/attempts/{n}/jobs` — `name`, `conclusion`, `started_at`,
  `completed_at`, `html_url`. The report job excludes itself.
- Attestations: `GET /repos/{o}/{r}/attestations/{subject_digest}` → Sigstore bundles, verified offline against the
  expected signer workflow (`@sigstore/verify`, pinned), the same check as `gh attestation verify`.
- PR context: `github.event.pull_request.number` / `head.sha`; absent → `NO_PR_CONTEXT`.

## What it writes

- One comment carrying `<!-- feat-pr-report -->`: list issue comments, PATCH the marked one, else POST.
- One check run `feat report` (`POST /repos/{o}/{r}/check-runs`), conclusion = verdict
  (`success` / `failure` / `neutral` for incomplete), `output.summary` = the same markdown.
- Also `$GITHUB_STEP_SUMMARY` (free, no permission).

## The comment (founder 2026-11-17: "keep it evidential and focus on the attestation + testing involved … be direct + concise")

Compact, no prose sentences. Sections, in order (see MOCK-REPORT.md):

| Section | Content |
|---|---|
| Header | `✅`/`❌` PR #N, the verdict or the first failed check; head commit, built ref @ built commit, run link |
| Tests | per tier: specs, scenarios passed / total, evidence bundle digest; CI jobs passed / total |
| Attestations | per artifact: name, full digest, signer `workflow@ref`, source commit, Rekor log index, ✅/❌ |
| Chain | one row per check: built commit parents = base + head; each source commit = built commit; signer = this repository's workflow, issuer GitHub Actions; pinned images = pin file |
| Verify | collapsed: the `gh attestation verify` command for the PR's artifact |

On failure only the header and the failing row change. After merge, one line is appended (merged as · merge
attestation digest · Rekor index · link to the main report). Certificate identity, builder, log entry UUID,
integrated time and the full provenance are not in the comment; they are in the evidence bundle and the
attestations, which the Verify command reaches. Digests and SHAs are never shortened.

## Chain of evidence (what is checked, link by link)

Digests and commit SHAs are always shown in full. Each link is checked against the one before it; the first
mismatch is reported as the broken link, and the verdict is fail.

| # | Link | Source | Check |
|---|---|---|---|
| 1 | Pull request | `github.event.pull_request.number` | present, else `NO_PR_CONTEXT` |
| 2 | Head commit | `pull_request.head.sha` | — |
| 3 | Base commit | `pull_request.base.sha` | — |
| 4 | Built ref | `github.ref` (`refs/pull/<n>/merge` on `pull_request`) | names this PR |
| 5 | Built commit | `github.sha`, the merge preview (≠ head) | `GET /repos/{o}/{r}/commits/{sha}` parents = [base, head] |
| 6 | Run | `run_id`, `run_attempt`, workflow path | the run's commit = built commit |
| 7 | Provenance source | in-toto statement: `predicate.buildDefinition.resolvedDependencies[0]` (`uri`, `digest.gitCommit`) and `externalParameters.workflow.{repository,path,ref}` | gitCommit = built commit; repository = this repo |
| 8 | Signer | Fulcio certificate: SAN `https://github.com/<o>/<r>/<workflow path>@<ref>`, issuer `https://token.actions.githubusercontent.com`, and its GitHub extensions (source repository, source digest, run invocation URI) | SAN is one of the consumer's allowed workflows at the built ref; issuer is GitHub's; certificate source digest = built commit; invocation URI = this run |
| 9 | Artifact | in-toto `subject[].digest.sha256` | = the digest of the artifact the run uploaded |
| 10 | Transparency log | the bundle's Rekor entry: log index, log ID, entry UUID, integrated time, inclusion proof | the proof verifies against the log; integrated time falls within the certificate's validity |

Verification uses `@sigstore/verify` (pinned) against the Sigstore public-good trust root: the same checks as
`gh attestation verify --repo --signer-workflow --source-ref --source-digest --cert-oidc-issuer`. The report prints
that command per artifact, filled in, so an auditor can reproduce every link without the Action.

An artifact attested by another run (for example the gate image, built on `main`) is shown with its own source ref
and commit, and is also checked against the consumer's pin file (`ci/images.lock.json`).

### After merge: main re-attests (founder 2026-11-17: "main will have to re-attest"; "Attestation + main check + PR pointer")

The squash or merge commit on `main` differs from both the head and the tested merge preview, so `main`'s CI builds
and attests the merged commit itself, and the Action runs in merge mode on that push:

1. Find the merged pull request for the main commit: `GET /repos/{o}/{r}/commits/{main sha}/pulls`. None →
   `NO_PR_FOR_MERGE`, nothing signed or posted.
2. Find the PR run (the last successful `pull_request` run on the PR's head) and its attestation digests:
   `GET /repos/{o}/{r}/actions/runs/{pr run}/artifacts` and `GET /repos/{o}/{r}/attestations/{digest}`. Missing →
   `PR_EVIDENCE_MISSING`, nothing signed or posted.
3. Check main's own build attestations: source commit = main sha, signer = this repository's workflow at
   `refs/heads/main`. Mismatch → chain broken at `main-provenance`.
4. Sign one merge-linking attestation with `actions/attest` (pinned; Sigstore-signed, Rekor-logged), subject = each
   main artifact digest, predicate type `https://feature.mmmnt.dev/attestation/pr-merge/v1`:

   ```json
   {
     "pullRequest": { "number": 7, "headSha": "<full>", "baseSha": "<full>", "mergeRefSha": "<full, tested>" },
     "prRun": { "id": 44153523061, "attempt": 1, "attestations": ["sha256:<full>", "…"] },
     "main": { "sha": "<full>", "run": { "id": 44160000001, "attempt": 1 }, "artifacts": ["sha256:<full>", "…"] },
     "evidence": { "bundles": ["sha256:<full>", "…"], "store": "ghcr.io/<o>/<r>-evidence@sha256:<full>" }
   }
   ```
5. Post a check run on the main commit in the same report format (verdict, merge chain, attestations, specs, jobs).
6. Append to the closed PR's report comment: "merged as `<main sha>` → main attestation `<full digest>` ✅" with a link.

The merge chain the report shows: main commit → merged PR #N → tested merge-ref commit → PR run → PR attestation
digests → main run → main artifact digests → merge-linking attestation → Rekor entry.

### Auditor walk

From a main commit:

```sh
# 1. which PR it came from, and the merge-linking attestation for main's artifact
gh attestation verify <main artifact> --repo mmmnt/flmnt \
  --signer-workflow mmmnt/flmnt/.github/workflows/ci.yml --source-ref refs/heads/main --source-digest <main sha> \
  --predicate-type https://feature.mmmnt.dev/attestation/pr-merge/v1 --format json   # predicate names PR, head, merge-ref, PR run
# 2. main's build provenance for the same artifact
gh attestation verify <main artifact> --repo mmmnt/flmnt \
  --signer-workflow mmmnt/flmnt/.github/workflows/ci.yml --source-ref refs/heads/main --source-digest <main sha>
# 3. the PR run's provenance, for each digest the merge attestation lists
gh attestation verify <pr artifact> --repo mmmnt/flmnt \
  --signer-workflow mmmnt/flmnt/.github/workflows/ci.yml --source-ref refs/pull/<n>/merge --source-digest <merge-ref sha>
```

From a PR: step 3 first (the PR report prints it), then steps 1–2 using the "merged as" pointer on the PR comment.

### Evidence retention (ruled 2026-11-17)

Workflow artifacts expire after 90 days; attestations and Rekor entries persist. Main's evidence bundles are pushed to
GHCR as a digest-pinned OCI artifact (`ghcr.io/<o>/<r>-evidence@sha256:<full>`, pinned `oras`) before the
merge-linking attestation is signed, and the attestation's `evidence.store` names that digest. A failed push is
`EVIDENCE_STORE_FAILED`: nothing is signed or posted.

### Fork pull requests (ruled 2026-11-17)

A fork's `pull_request` run has a read-only token and uploads its evidence bundles and job results as artifacts. A
separate trusted workflow (`on: workflow_run` of that CI workflow) runs the Action in follow-up mode: it downloads
only those artifacts, never checks out or runs the fork's code, renders the same report, and shows Attestations as
"not attested (fork PR); attested on merge". The merge-linking attestation on `main` then covers the merged code.

### Publication and enforcement (ruled 2026-11-17)

Public, in `mmmnt/feature` at `actions/pr-report`, not on the Marketplace; versioned with Feature's release tags;
consumers pin by full SHA. The `feat report` check becomes a required status for `main` once proven on a few PRs.

## Consumer wiring (flmnt)

Each job that runs specs uploads its bundle (`actions/upload-artifact`, pinned by SHA) as `feat-evidence-<tier>`;
the build job attests its artifacts (`actions/attest-build-provenance`, pinned); a final job
`needs: [all jobs]`, `if: always()`, runs `mmmnt/feature/actions/pr-report@<sha>` with the four permissions above.

## Known limits

- The report is only as complete as the bundles: a tier that uploads nothing shows as missing, and the verdict is
  `incomplete`, never `pass`.
