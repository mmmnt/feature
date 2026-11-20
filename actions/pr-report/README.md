# feat pr report

A GitHub Action that posts one updating pull request comment and a `feat report` check run from the feat evidence
bundles, the workflow run's jobs and the run's build attestations, with an auditable chain of evidence from the PR
head to signed provenance and the repository's own signing key. Attestations are the consumer's own cosign
attestations, stored as OCI referrers in GHCR beside their subjects and verified with the pinned cosign (v3.1.4,
SHA-256-checked) against the committed public key; nothing reads or writes a transparency log (ADR-0032 decision 13). On a push to `main` it re-attests: it stores the evidence in
GHCR by digest, writes a merge-linking statement (`https://feature.mmmnt.dev/attestation/pr-merge/v2`) that a
separate sign run signs, and points the merged pull request's comment at it. A push to `main` whose head has no merged
pull request is a direct commit: it is attested the same way, with a null `pullRequest`, and reported on main's check
alone. Every statement lists the push's sender and every commit since its `before`; a force push is refused
`NOT_FAST_FORWARD` and a range GitHub cannot list in full `PUSH_RANGE_INCOMPLETE`. Main commits attested before
v0.1.74 carry `pr-merge/v1` and verify with that type. Fork pull requests are reported by a trusted `workflow_run` follow-up from
the uploaded results only; it finds the pull request by `<head owner>:<head branch>` at the run's head commit, since
GitHub lists none on a fork's run, and merge mode records a fork's pull request whose run left no attestation as not
attested.

Spec: `report.feat` (SPEC-PRR-001). Decision: `docs/adr/ADR-0032-pr-report-action.md`. Design: `DESIGN.md`.
Format: `MOCK-REPORT.md`.

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
    - uses: mmmnt/feature/actions/pr-report@<full sha>
      with:
        subjects: "SBOM: ghcr.io/<owner>/<repo>-sbom"   # the signed artifact, tagged with the commit the run built
        required-subjects: SBOM from build              # not produced → incomplete, naming the job
        public-key: ci/signing/cosign.pub
        # merge mode (push to main) also: packages: write, and
        # signing-key: ${{ secrets.SIGNING_KEY }}, signing-password: ${{ secrets.SIGNING_PASSWORD }}
```

The producer signs each subject with `cosign attest --key … --signing-config <a config with no services>
--type slsaprovenance1`; an auditor checks it with `cosign verify-attestation --key <public key>
--insecure-ignore-tlog --type slsaprovenance1 <repository>@<digest>`. A pull request is verified with the key on its
base branch, so one that swaps the key file breaks the chain at the key link.

Pin it by full commit SHA. `dist/main.js` is the committed bundle (`pnpm --filter @mmmnt/feat-pr-report build`).
