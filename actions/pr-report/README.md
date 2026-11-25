# feat pr report

A GitHub Action that turns a workflow run's feat evidence bundles, its jobs and its build attestations into one
updating pull request comment and one check run (`feat report`), with an auditable chain of evidence from the pull
request head to signed provenance and the repository's own signing key. On a push to `main` it re-attests the
merged (or directly pushed) commit.

Attestations are the consumer's own cosign attestations, stored as OCI referrers in GHCR beside their subjects and
verified with a pinned cosign (v3.1.4, SHA-256-checked) against the committed public key. Nothing reads or writes a
transparency log (ADR-0032 decision 13).

Spec: [`report.feat`](report.feat) (SPEC-PRR-001). Decision:
[ADR-0032](../../docs/adr/ADR-0032-pr-report-action.md). Report format: [`MOCK-REPORT.md`](MOCK-REPORT.md).

## Installation

The Action lives in this repository at `actions/pr-report`; it is not on the Marketplace. Pin it by full commit SHA:

```yaml
- uses: mmmnt/feature/actions/pr-report@<full commit sha>
```

It runs on `node24`, from the committed bundle `dist/main.js` (`pnpm --filter @mmmnt/feat-pr-report build`).

## Modes

The mode follows from the event. Anything else fails with `NO_PR_CONTEXT`.

| Event | Mode | What it does |
| --- | --- | --- |
| `pull_request` | report | Reads the evidence, jobs and subjects' attestations; upserts the comment and posts the check. A pull request is verified with the public key on its **base** branch, so one that swaps the key file breaks the chain at the key link. |
| `workflow_run` of a `pull_request` run | fork follow-up | For a fork's pull request: downloads that run's evidence artifacts only (never its code), finds the pull request by `<head owner>:<head branch>` at the run's head commit, and reports attestations as not attested. A run from this repository itself is refused `TRUSTED_RUN`. |
| `push` to `refs/heads/main`, no `sign-statement` | merge | Stores main's evidence in GHCR by digest, writes the unsigned merge statement (`https://feature.mmmnt.dev/attestation/pr-merge/v2`) and returns it as outputs, posts main's check, and points the merged pull request's comment at it. A head with no merged pull request is a direct commit: attested the same way, with a null `pullRequest`, on main's check alone. |
| `push` to `refs/heads/main`, with `sign-statement` | sign | Signs the statement the merge run wrote, only for this main commit and only with the digest main's check recorded (`STATEMENT_MISMATCH` otherwise), with `signing-key`. |

Every statement lists the push's sender and every commit since its `before`. A force push is refused
`NOT_FAST_FORWARD`, and a range GitHub cannot list in full `PUSH_RANGE_INCOMPLETE`. Main commits attested before
pr-merge/v2 carry `https://feature.mmmnt.dev/attestation/pr-merge/v1` and verify with that type.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `token` | `${{ github.token }}` | Needs `pull-requests: write`, `checks: write`, `actions: read`, `packages: read`; merge and sign mode `packages: write`. |
| `evidence-dir` | `evidence` | Directory of the downloaded evidence artifacts, one subdirectory per tier named `<evidence-prefix><tier>`. |
| `evidence-prefix` | `feat-evidence-` | Prefix of the evidence artifact names; the rest is the tier (`feat-evidence-unit` is `unit`). |
| `subjects` | empty | Newline-separated `<label>: <OCI repository>` lines. Each repository holds the signed artifact tagged with the commit the run built. |
| `required-subjects` | empty | Newline-separated `<label> from <job>` lines. A required subject the run did not produce makes the report incomplete and names the job (decision 14). |
| `public-key` | `cosign.pub` | Path of the repository's committed cosign public key. |
| `signer-workflows` | `.github/workflows/ci.yml` | Newline-separated workflow paths allowed to have produced the provenance. |
| `check-name` | `feat report` | Name of the check run. |
| `report-job` | `report` | Name of the job running the Action, left out of the job tally. |
| `evidence-repository` | `ghcr.io/<owner>/<repo>-evidence` | Merge mode: the GHCR repository main's evidence is stored in. |
| `sign-statement` | empty | Sign mode: the statement file the merge run wrote (its `statement` output). Setting it selects sign mode. |
| `signing-key` | empty | Sign mode: the cosign private key (pass a secret). Written to a `0600` file and removed. |
| `signing-password` | empty | Sign mode: the private key's password (pass a secret). |

## Outputs

| Output | Meaning |
| --- | --- |
| `statement` | Merge mode: the path of the unsigned merge statement, for the sign run. |
| `statement-digest` | Merge mode: the statement's sha256 digest, also recorded as main's check `external_id`. |

## Example

```yaml
report:
  needs: [build, unit, harness]   # every other job
  if: always()
  runs-on: ubuntu-24.04
  permissions: { contents: read, pull-requests: write, checks: write, actions: read, packages: read }
  steps:
    - uses: actions/checkout@<sha>
    - uses: actions/download-artifact@<sha>
      with: { pattern: feat-evidence-*, path: evidence }
    - id: report
      uses: mmmnt/feature/actions/pr-report@<full sha>
      with:
        subjects: "SBOM: ghcr.io/<owner>/<repo>-sbom"   # the signed artifact, tagged with the commit the run built
        required-subjects: SBOM from build              # not produced: incomplete, naming the job
        public-key: ci/signing/cosign.pub
```

On a push to `main` the job also needs `packages: write`, and a second step (or job) signs what the first wrote:

```yaml
    - if: github.event_name == 'push'
      uses: mmmnt/feature/actions/pr-report@<full sha>
      with:
        public-key: ci/signing/cosign.pub
        subjects: "SBOM: ghcr.io/<owner>/<repo>-sbom"
        sign-statement: ${{ steps.report.outputs.statement }}
        signing-key: ${{ secrets.SIGNING_KEY }}
        signing-password: ${{ secrets.SIGNING_PASSWORD }}
```

A fork's pull request gets a read-only token on `pull_request`, so its own report job is refused
`INSUFFICIENT_PERMISSIONS`. A separate workflow reports it from the results that run uploaded, without checking out or
running the fork's code (ADR-0032 decision 10). The Action downloads the run's `feat-evidence-*` artifacts itself:

```yaml
# .github/workflows/fork-report.yml
on:
  workflow_run:
    workflows: [ci]                 # the name of the workflow that uploads the evidence
    types: [completed]
jobs:
  report:
    if: >-
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.head_repository.full_name != github.repository
    runs-on: ubuntu-24.04
    permissions: { pull-requests: write, checks: write, actions: read }
    steps:
      - uses: mmmnt/feature/actions/pr-report@<full sha>
```

Attestations show as "not attested (fork PR); attested on merge": a fork's run holds no secrets, so it signed nothing.
A run from this repository itself is refused `TRUSTED_RUN`, which the `if:` above avoids.

The producer signs each subject with `cosign attest --key … --signing-config <a config with no services>
--type slsaprovenance1`; an auditor checks it with `cosign verify-attestation --key <public key>
--insecure-ignore-tlog --type slsaprovenance1 <repository>@<digest>`.

## Verdicts and refusals

The verdict is `pass` (check `success`), `fail` (`failure`: a bundle whose verify or run did not pass, a job that
did not succeed, or a broken chain link) or `incomplete` (`neutral`: a bundle with no run block, or a required
subject missing). The report is also written to the step summary. The sign step signs every `subjects` entry, so
give it the same `subjects` as the merge step.

A refusal fails the step with `::error title=<CODE>::`: `NO_PR_CONTEXT`, `INSUFFICIENT_PERMISSIONS` (the token
cannot write comments or checks, as on a fork's own run), `NO_EVIDENCE`, `TRUSTED_RUN`, `PR_EVIDENCE_MISSING`,
`EVIDENCE_STORE_FAILED`, `NOT_FAST_FORWARD`, `PUSH_RANGE_INCOMPLETE`, `STATEMENT_MISMATCH`.

## Changelog

The action is pinned by commit SHA (see Installation); what changed is in the repository's [GitHub Releases](https://github.com/mmmnt/feature/releases) and commit history.

## Contributing

This package is part of the [Feature monorepo](https://github.com/mmmnt/feature). See
[CONTRIBUTING.md](../../CONTRIBUTING.md) for the development setup, the spec-driven rules and the
local gate.

```bash
git clone https://github.com/mmmnt/feature.git
cd feature
pnpm install
pnpm --filter @mmmnt/feat-pr-report build && pnpm --filter @mmmnt/feat-pr-report test
```

The package is a pnpm workspace member (`@mmmnt/feat-pr-report`, private), so run it through pnpm from the
repository root: its `workspace:*` dependency does not install with npm. Commit `dist/main.js` after a build that
changes it.

## License

BSD-3-Clause. See [LICENSE](LICENSE).

Part of [Feature](../../README.md), the .feat execution specification toolchain.
