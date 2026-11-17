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
  (`success` / `failure` / `neutral` for incomplete), `output.summary` = the same markdown, truncated to the API's
  65 535-character limit with a link to the run.
- Also `$GITHUB_STEP_SUMMARY` (free, no permission).

## Consumer wiring (flmnt)

Each job that runs specs uploads its bundle (`actions/upload-artifact`, pinned by SHA) as `feat-evidence-<tier>`;
the build job attests its artifacts (`actions/attest-build-provenance`, pinned); a final job
`needs: [all jobs]`, `if: always()`, runs `mmmnt/feature/actions/pr-report@<sha>` with the four permissions above.

## Known limits

- Fork pull requests get a read-only token → `INSUFFICIENT_PERMISSIONS`; a `workflow_run`-triggered variant would
  cover them (not in this draft).
- The report is only as complete as the bundles: a tier that uploads nothing shows as missing, and the verdict is
  `incomplete`, never `pass`.
