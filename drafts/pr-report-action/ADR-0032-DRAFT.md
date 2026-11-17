# ADR-0032 — a pull request build report, published as a GitHub Action

Status: DRAFT — awaiting the founder's flip. Requested by the founder on 2026-11-17 for flmnt: "I review all PRs, but
I won't go through the code. let's experiment with Feature reporting that captures run and attestation records of
the PR builds. let's get it into a friendly format, into the PR." Form ruled: "GitHub Action in Feature
(Recommended)".

## Context

- A reviewer who approves pull requests without reading code needs one place that says what the build proved: which
  specs ran at which tier and passed, what failed and why, which CI jobs ran, and which artifacts carry a verified
  build provenance.
- `feat report --evidence` already writes a `feat-evidence/2` bundle (docs/evidence-bundle.md,
  schemas/evidence.schema.json): the spec inventory with each spec's lifecycle status and content digest, `verify`
  (committed generated tests match the specs), `run` (counts and the JUnit digest), `runs[]` (per-scenario results
  with `spec_id`, `status`, `time` and parsed `violations`), the producer versions, and `project.bindings` (what each
  tier ran against). A repository with several configs (a unit tier and an integration tier) writes one bundle per
  config, slugged by config name.
- The GitHub REST API exposes what the report needs with a minimal token:
  - the run's jobs, with conclusion, start and end times and links: `GET /repos/{o}/{r}/actions/runs/{run_id}/attempts/{n}/jobs`
    (`actions: read`);
  - build attestations by subject digest: `GET /repos/{o}/{r}/attestations/{subject_digest}` (`attestations: read`),
    returning Sigstore bundles that are verified offline (the same check `gh attestation verify` performs);
  - one updating pull request comment: list the PR's issue comments, find the one carrying a fixed HTML marker,
    `PATCH` it, else `POST` (`pull-requests: write`);
  - a check run with a markdown summary: `POST /repos/{o}/{r}/check-runs` (`checks: write`).
- A pull request from a fork receives a read-only token on `pull_request`; the report cannot post from there.

## Decision

1. Feature publishes a JavaScript GitHub Action, `actions/pr-report` in this repository, versioned with the
   toolchain's release tags. Consumers pin it by full commit SHA.
2. It runs as the consumer's last CI job, after every other job (`needs:` all, `if: always()`), downloads the
   evidence bundles the earlier jobs uploaded as artifacts, reads the run's jobs and the attestations of the
   artifacts the run produced, and renders one report.
3. It posts the report as ONE pull request comment, found again by its marker and updated in place on every run, and
   as the summary of a check run named `feat report`. The check's conclusion is the report's verdict.
4. Rendering is a pure function of its inputs (bundles, jobs, attestations, the PR context); all GitHub calls go
   through one client, so the spec drives it with recorded API responses and no network.
5. It never fails silently: no pull request context, no evidence bundle, or a token without the permissions it needs
   is a named refusal, and nothing is posted.
6. The report states facts only. It does not approve, request changes, or merge.

## Rejected alternatives

- **A GitHub App.** Richer (it could follow runs across repositories and react to events), but it needs hosting, a
  webhook endpoint and app credentials, and would make the report depend on a service being up. An Action needs
  nothing beyond the run's own token.
- **A script in each consumer repository.** Fastest to start, but every repository would grow its own copy and its
  own format; the report belongs beside the evidence format that produces its input.
- **The job summary only (`$GITHUB_STEP_SUMMARY`).** Needs no permission, but lives on the run page, not the pull
  request; the reviewer would have to go looking for it.
- **Parsing JUnit directly.** The evidence bundle already carries per-scenario results and violations, digest-anchored;
  reading JUnit again would duplicate the parser and lose the bundle's guarantees.

## Consequences

- Consumers grant `pull-requests: write`, `checks: write`, `actions: read` and `attestations: read` to the report job
  only.
- Fork pull requests get no report until a `workflow_run` variant exists (open question).
- The report is as good as the bundles: a job that uploads no bundle shows as "no evidence" rather than as passing.
