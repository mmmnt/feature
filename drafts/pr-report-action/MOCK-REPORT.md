<!-- feat-pr-report -->
## ✅ Build report — ready for review

**PR #7** `feat/rebuild-progress` → `main` · run [44153523061 attempt 1](https://github.com/mmmnt/flmnt/actions/runs/44153523061/attempts/1) · 14 min 2 s · *sample data*

| | Result |
|---|---|
| Chain of evidence | ✅ **unbroken**: PR head → built commit → run → artifacts → signatures → transparency log |
| Specs | ✅ **48 / 48 scenarios passed** across 2 tiers · generated tests match specs |
| CI jobs | ✅ **9 / 9 succeeded** |
| Attestations | ✅ **2 / 2 verified** (SLSA provenance v1, signed by this repository's workflows) |

### Chain of evidence

Each link is checked against the one before it. A mismatch anywhere marks the report ❌ and names the broken link.

| # | Link | Value | Check |
|---|---|---|---|
| 1 | Pull request | **#7** `feat/rebuild-progress` → `main` | — |
| 2 | PR head commit | `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` | = `pull_request.head.sha` ✅ |
| 3 | PR base commit | `4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a` | = `pull_request.base.sha` ✅ |
| 4 | Built ref | `refs/pull/7/merge` | the ref a `pull_request` run checks out ✅ |
| 5 | Built commit (merge preview) | `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | parents = base `4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a` and head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` ✅ |
| 6 | Workflow run | [44153523061 attempt 1](https://github.com/mmmnt/flmnt/actions/runs/44153523061/attempts/1) · `.github/workflows/ci.yml` · event `pull_request` | the run's commit = built commit ✅ |
| 7 | Provenance source | `git+https://github.com/mmmnt/flmnt@refs/pull/7/merge` · commit `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | = built commit (link 5) ✅ |
| 8 | Signer | `https://github.com/mmmnt/flmnt/.github/workflows/ci.yml@refs/pull/7/merge` · issuer `https://token.actions.githubusercontent.com` | this repository's `ci.yml`, at the built ref ✅ |
| 9 | Artifacts | 2 subjects (below) | each subject digest = the uploaded artifact's digest ✅ |
| 10 | Transparency log | 2 Rekor entries, integrated during the run | inclusion proofs verified ✅ |

### Attestations

#### `flmnt-sbom.cdx.json`

| Field | Value |
|---|---|
| Subject digest | `sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b` |
| Predicate type | `https://slsa.dev/provenance/v1` |
| Certificate identity (SAN) | `https://github.com/mmmnt/flmnt/.github/workflows/ci.yml@refs/pull/7/merge` |
| Certificate issuer | `https://token.actions.githubusercontent.com` |
| Builder | `https://github.com/actions/runner/github-hosted` |
| Provenance source | repo `https://github.com/mmmnt/flmnt` · ref `refs/pull/7/merge` · commit `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` |
| Run | [44153523061 attempt 1](https://github.com/mmmnt/flmnt/actions/runs/44153523061/attempts/1) |
| Transparency log | Rekor log index `871204553` · entry UUID `108e9186e8c5677a3c41f2a7f2e3e2f1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6` · integrated `2026-11-17T21:14:08Z` |
| Verified | ✅ signature · certificate chain to the Sigstore root · log inclusion · signer identity · source commit |

Verify it yourself:

```sh
gh run download 44153523061 -R mmmnt/flmnt -n flmnt-sbom
gh attestation verify flmnt-sbom.cdx.json \
  --repo mmmnt/flmnt \
  --signer-workflow mmmnt/flmnt/.github/workflows/ci.yml \
  --source-ref refs/pull/7/merge \
  --source-digest c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192 \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --deny-self-hosted-runners
```

Offline, with the Sigstore bundle this run uploads beside the artifact:
`gh attestation verify flmnt-sbom.cdx.json --bundle flmnt-sbom.sigstore.json --repo mmmnt/flmnt --signer-workflow mmmnt/flmnt/.github/workflows/ci.yml`

#### `ghcr.io/mmmnt/flmnt-gate` (the gate image this run used)

| Field | Value |
|---|---|
| Subject digest | `sha256:7c5d2b0e9a41f6e3c8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f602` |
| Predicate type | `https://slsa.dev/provenance/v1` |
| Certificate identity (SAN) | `https://github.com/mmmnt/flmnt/.github/workflows/gate-image.yml@refs/heads/main` |
| Certificate issuer | `https://token.actions.githubusercontent.com` |
| Builder | `https://github.com/actions/runner/github-hosted` |
| Provenance source | repo `https://github.com/mmmnt/flmnt` · ref `refs/heads/main` · commit `4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a` (the PR's base; pinned in `ci/images.lock.json`) |
| Run | [44150010442 attempt 1](https://github.com/mmmnt/flmnt/actions/runs/44150010442/attempts/1) |
| Transparency log | Rekor log index `871190127` · entry UUID `108e9186e8c5677a9b2e4c6d8f0a1b3c5d7e9f1a2b4c6d8e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b` · integrated `2026-11-17T19:02:51Z` |
| Verified | ✅ signature · certificate chain · log inclusion · signer identity · source commit · digest = `ci/images.lock.json` |

```sh
gh attestation verify oci://ghcr.io/mmmnt/flmnt-gate@sha256:7c5d2b0e9a41f6e3c8b7d6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f602 \
  --repo mmmnt/flmnt \
  --signer-workflow mmmnt/flmnt/.github/workflows/gate-image.yml \
  --source-ref refs/heads/main \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --deny-self-hosted-runners
```

<details><summary><b>Specs — unit tier</b>: 36 passed · 0 failed · 12 specs</summary>

| Spec | Status | Content digest | Scenarios | Time |
|---|---|---|---|---|
| SPEC-MEM-022 SearchEvents | agreed | `sha256:5d41402abc4b2a76b9719d911017c592ae0f4c1e8b2a7d6c3f9e0b1a2c3d4e5f` | 9 / 9 ✅ | 1.2 s |
| SPEC-PRJ-004 Rebuild | agreed | `sha256:e4d909c290d0fb1ca068ffaddf22cbd0b9a8c7d6e5f4a3b2c1d0e9f8a7b6c5d4` | 4 / 4 ✅ | 0.9 s |
| … | | | | |

Evidence bundle `feat-evidence-unit`: `sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae`

</details>

<details><summary><b>Specs — integration tier</b>: 12 passed · 0 failed · bound to real stores (eventstore, graph, cache)</summary>

| Spec | Status | Content digest | Scenarios | Time |
|---|---|---|---|---|
| SPEC-MEM-022 SearchEvents | agreed | `sha256:5d41402abc4b2a76b9719d911017c592ae0f4c1e8b2a7d6c3f9e0b1a2c3d4e5f` | 3 / 3 ✅ | 4.8 s |
| … | | | | |

Evidence bundle `feat-evidence-integration`: `sha256:fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9`

</details>

<details><summary><b>CI jobs</b>: 9 succeeded</summary>

| Job | Result | Duration |
|---|---|---|
| [install](https://github.com/mmmnt/flmnt/actions/runs/44153523061/job/1) | ✅ | 1 m 52 s |
| [unit](https://github.com/mmmnt/flmnt/actions/runs/44153523061/job/2) | ✅ | 9 m 19 s |
| [harness](https://github.com/mmmnt/flmnt/actions/runs/44153523061/job/3) | ✅ | 13 m 45 s |
| … | | |

</details>

<sub>Toolchain: @mmmnt/feature 0.10.0 · feat-runtime 0.6.0 · evidence feat-evidence/2. Digests are never shortened. This comment is replaced on every run, never duplicated. Sample data.</sub>

---

### After merge: the line appended to this PR's comment

> **Merged** as `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` → main attestation `sha256:e3b98a4da31a127d4bde6e43033f66ba274cab0eb7eb1c70ec41402bf6273dd8` ✅ · Rekor log index `871322019` · [main build report](https://github.com/mmmnt/flmnt/commit/5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b/checks)

### The check run on the main commit (same format)

<!-- feat-pr-report -->
## ✅ Main build report — `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b`

| # | Merge chain link | Value | Check |
|---|---|---|---|
| 1 | Main commit | `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` | — |
| 2 | Merged pull request | **#7** `feat/rebuild-progress` · head `9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c` | found for this commit ✅ |
| 3 | Tested merge ref | `refs/pull/7/merge` · commit `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | = the PR run's built commit ✅ |
| 4 | PR run | [44153523061 attempt 1](https://github.com/mmmnt/flmnt/actions/runs/44153523061/attempts/1) | chain unbroken on the PR ✅ |
| 5 | PR attestations | `sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b`, `sha256:9b74c9897bac770ffc029102a200c5de2a4c2a6c2d1e3f4a5b6c7d8e9f0a1b2c` | retrieved and verified ✅ |
| 6 | Main run | [44160000001 attempt 1](https://github.com/mmmnt/flmnt/actions/runs/44160000001/attempts/1) · event `push` · `refs/heads/main` | — |
| 7 | Main build provenance | source commit `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` · signer `https://github.com/mmmnt/flmnt/.github/workflows/ci.yml@refs/heads/main` | = main commit ✅ |
| 8 | Main artifacts | `sha256:aa0d3f5b8c1e4f7a2d6b9c0e3f6a8b1d4e7f0a2c5b8d1e4f7a0b3c6d9e2f5a8b` | — |
| 9 | Merge-linking attestation | `sha256:e3b98a4da31a127d4bde6e43033f66ba274cab0eb7eb1c70ec41402bf6273dd8` · predicate `https://feat.dev/attestation/pr-merge/v1` | signed ✅ |
| 10 | Transparency log | Rekor log index `871322019` · entry UUID `108e9186e8c5677a4f6e8d0c2b4a6f8e0d2c4b6a8f0e2d4c6b8a0f2e4d6c8b0a2f4e6d8c0b2a4f6e8` · integrated `2026-11-17T22:41:37Z` | inclusion verified ✅ |

Verify from this main commit:

```sh
gh attestation verify flmnt-sbom.cdx.json --repo mmmnt/flmnt \
  --signer-workflow mmmnt/flmnt/.github/workflows/ci.yml \
  --source-ref refs/heads/main --source-digest 5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b \
  --predicate-type https://feat.dev/attestation/pr-merge/v1 --format json
```

---

### What a broken chain looks like (the same comment, replaced)

<!-- feat-pr-report -->
## ❌ Build report — chain of evidence broken at link 7

| # | Link | Value | Check |
|---|---|---|---|
| 5 | Built commit (merge preview) | `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192` | ✅ |
| 7 | Provenance source | commit `0badc0de1a2b3c4d5e6f708192a3b4c5d6e7f809` | ❌ **≠ built commit `c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192`**: the attestation was made for a commit this run did not build |
| 8 | Signer | `https://github.com/mmmnt/flmnt/.github/workflows/ci.yml@refs/pull/7/merge` | ✅ |
| 10 | Transparency log | Rekor log index `871204553` | ✅ |

The other broken-link messages:
- **Link 5:** the built commit's parents are not [base, head], so the run did not build this PR's merge.
- **Link 8:** signer `https://github.com/someone-else/fork/.github/workflows/build.yml@refs/heads/x` is not this repository's `ci.yml`.
- **Main, link 7:** main's build was attested for commit `0badc0de1a2b3c4d5e6f708192a3b4c5d6e7f809`, not main `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b`.
- **Main, refused:** no merged pull request is associated with `5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b` (`NO_PR_FOR_MERGE`), or the PR run's attestations can no longer be retrieved (`PR_EVIDENCE_MISSING`); nothing is signed.
- **Link 10:** no transparency-log entry for `sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b`, so the signature cannot be shown to have existed at build time.

<sub>The check `feat report` is marked failed with the same summary.</sub>
