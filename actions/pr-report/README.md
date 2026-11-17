# feat pr report

A GitHub Action that posts one updating pull request comment and a `feat report` check run from the feat evidence
bundles, the workflow run's jobs and the run's build attestations, with an auditable chain of evidence from the PR
head to signed provenance and the transparency log. On a push to `main` it re-attests: it stores the evidence in
GHCR by digest, signs a merge-linking attestation (`https://feature.mmmnt.dev/attestation/pr-merge/v1`) and points
the merged pull request's comment at it. Fork pull requests are reported by a trusted `workflow_run` follow-up from
the uploaded results only.

Spec: `report.feat` (SPEC-PRR-001). Decision: `docs/adr/ADR-0032-pr-report-action.md`. Design: `DESIGN.md`.
Format: `MOCK-REPORT.md`.

```yaml
report:
  needs: [build, unit, harness]   # every other job
  if: always()
  runs-on: ubuntu-24.04
  permissions: { contents: read, pull-requests: write, checks: write, actions: read, attestations: read }
  steps:
    - uses: actions/download-artifact@<sha>
      with: { pattern: feat-evidence-*, path: evidence }
    - uses: mmmnt/feature/actions/pr-report@<full sha>
      with: { subjects: dist/sbom.cdx.json }
```

Pin it by full commit SHA. `dist/main.js` is the committed bundle (`pnpm --filter @mmmnt/feat-pr-report build`).
