# ADR-0032 — a pull request build report, published as a GitHub Action

Status: Accepted (founder flip 2026-11-17, "Agree as drafted (Recommended)"). Amended 2026-11-17 by decisions 13–14
(founder flip "Agree as drafted (Recommended)"; the missing-SBOM check conclusion "Neutral (Recommended)"). Requested by the founder on 2026-11-17 for flmnt: "I review all PRs, but
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
7. The report shows a chain of evidence an auditor can follow without trusting the Action: PR → head → base → built
   ref → built commit (parents = base, head) → run → provenance source commit → signer identity → artifact digest →
   transparency-log entry, every digest and SHA in full, each link checked, the first broken one named, and a
   filled-in `gh attestation verify` command per artifact (founder feedback 2026-11-17).
8. Main re-attests (founder 2026-11-17: "main will have to re-attest", "Attestation + main check + PR pointer"): on
   a push to main the Action signs a merge-linking attestation (predicate `https://feature.mmmnt.dev/attestation/pr-merge/v1`,
   Sigstore-signed via `actions/attest`, Rekor-logged) naming the PR, its head, the tested merge-ref commit, the PR
   run and its attestation digests, the main commit and main's artifact digests; posts a check run on the main
   commit in the same format; and points the closed PR's report comment at it.
9. Publication (founder rulings 2026-11-17, flmnt 8a754eb9): the Action lives in `mmmnt/feature` at
   `actions/pr-report`, public, not listed on the Marketplace, versioned with Feature's release tags; consumers pin
   it by full commit SHA.
10. Fork pull requests: a trusted `workflow_run` follow-up reports from the results the fork's `pull_request` run
    uploaded. It never checks out or runs the fork's code. Attestations show as "not attested (fork PR); attested
    on merge".
11. The `feat report` check is required to merge into `main`, once the report has been proven on a few pull requests.
12. Main's evidence bundles are stored durably in GHCR as digest-pinned OCI artifacts before the merge-linking
    attestation is signed, and that digest is named in it. A failed store is refused (`EVIDENCE_STORE_FAILED`):
    nothing is signed or posted.
13. **Signing uses the consumer's own key** (founder ruling f1530c7d, "Sign with our own key"). GitHub artifact
    attestations are not available to a private Team-plan repository. The consumer signs with cosign using a key
    pair it controls: the private key and its password are repository secrets, the public key is committed (flmnt:
    `ci/signing/flmnt.pub`). Signed SLSA provenance and the merge-linking statement are stored as OCI referrers in
    GHCR beside their subjects. There is no public transparency log; the key link replaces the log link in the chain
    of evidence, and the report shows the signature digest and key fingerprint instead of a log index. Verification
    is `cosign verify-attestation --key <public key> --insecure-ignore-tlog`, which an auditor runs with the committed
    public key alone; the flag tells cosign not to require a log entry that by design does not exist (founder ruling
    2026-11-17, "Add the flag").
    Decision 8's "Sigstore-signed via `actions/attest`, Rekor-logged" is replaced by this. Revisit on going public
    (flmnt#278): a public repository has artifact attestations, and keyless signing with a public log becomes an option.
    *Amended 2026-11-18 (founder ruling "Action reads .att too (Recommended)"):* cosign 2's classic key signing
    stores no OCI referrer; it keeps the attestations as the layers of the subject's `sha256-<hex>.att` tag. With no
    referrer, the Action reads that tag, each layer one DSSE envelope whose blob digest is the signature digest shown.
14. **A required subject that was not produced is incomplete** (founder ruling, "Add the scenario"): the consumer
    names its required attestation subjects; when the run produced none of one, the verdict is `incomplete`, the
    header names the subject and the job that should have produced it, and the report is still posted.

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
- **Keyless Sigstore signing without GitHub's attestations API** (Fulcio + public Rekor). Would publish entries for
  a private repository's builds to a public log.
- **Upgrading the plan for artifact attestations** (GitHub Enterprise Cloud). Rejected by the founder's choice of
  own-key signing (f1530c7d); revisit on going public (flmnt#278).
- **Failing the report job on a missing SBOM.** Leaves the reviewer with no report.

## Consequences

- Consumers grant `pull-requests: write`, `checks: write`, `actions: read` and `packages: read` to the report job
  only (decision 13: the referrers are read from GHCR; no `attestations: read`).
- Fork pull requests are reported by the `workflow_run` follow-up, from uploaded results only.
- Merge mode also needs `packages: write` (GHCR) and the signing key's secrets (decision 13); no `id-token: write`
  and no `attestations: write`.
- The report is as good as the bundles: a job that uploads no bundle shows as "no evidence" rather than as passing.
