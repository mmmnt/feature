// The probe behind `ProbePrReport` (SPEC-PRR-001): run the report core with a recorded GitHub API, a recorded GHCR
// referrers listing, recorded cosign results, a fake evidence store and a fake signer. No network, no cosign binary.
// Test fixture, not shipped.
// Steps: see the header of ../report.feat.
import { createHash } from "node:crypto";
import { runReport, ReportError, MARKER } from "../src/report.ts";

const HEAD = "9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c";
const BASE = "4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a";
const BUILT = "c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192";
const OTHER = "0badc0de1a2b3c4d5e6f708192a3b4c5d6e7f809";
const NEWER_BASE = "1f2e3d4c5b6a79880a1b2c3d4e5f60718293a4b5";
const MAIN = "5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b";
const SUBJECT_REPO = "ghcr.io/o/r-sbom";
const PR_SUBJECT = { name: "SBOM", digest: "sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b", repository: SUBJECT_REPO };
const MAIN_SUBJECT = { name: "SBOM", digest: "sha256:9b74c9897bac770ffc029102a200c5de2a4c2a6c2d1e3f4a5b6c7d8e9f0a1b2c", repository: SUBJECT_REPO };
const REPO_KEY = "sha256:18a0c88f7df4a69a62bd0da7af6b6a4c6e882a86cc0b1f634068e57cb7ce98f7";
const OTHER_KEY = "sha256:6b3f0e1d9c2a4b5e8f7a6c5d4e3b2a1f0e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b";
const CLASSIC_LAYER = "sha256:4c6cc238681fcaf230c2a643479538ace0bc675f0eb2b24b083dbccce260956c";
const SIGNATURE = "sha256:29356bdc46d0ab18535ed914ea4fd7e31dd87fab2b18fbc1138a2185883aaf90";
const BUNDLES = {
  unit: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  integration: "sha256:fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9",
};
const PR_RUN = 44153523061;
const sha = (text) => "sha256:" + createHash("sha256").update(text).digest("hex");
// the merge statement report-main wrote for MAIN (sign:good), one for another commit (sign:othermain), and one whose
// bytes differ from what main's check recorded (sign:tampered)
const STATEMENT = (mainSha) => ({ pullRequest: { number: 7, headSha: "9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c" }, main: { sha: mainSha } });

function bundle(fixture) {
  if (fixture === "pass") return { verify: { status: "pass" }, run: { status: "pass", tests: 12, failures: 0, errors: 0 }, specs: [{}, {}] };
  if (fixture === "fail")
    return { verify: { status: "pass" }, run: { status: "fail", tests: 12, failures: 1, errors: 0 }, specs: [{}, {}], runs: [{ spec_id: "SPEC-X", status: "fail" }] };
  if (fixture === "noruns") return { verify: { status: "pass" }, specs: [{}] };
  throw new Error(`unknown evidence fixture '${fixture}'`);
}

export async function probe(input) {
  const s = { mode: "none", evidence: [], jobs: "green", attest: "none", comment: null, writable: true, merge: "good" };
  for (const step of String(input.script).split(" ")) {
    const [k, ...rest] = step.split(":");
    const v = rest.join(":");
    if (k === "pr") Object.assign(s, { mode: "pr", pr: Number(v) });
    else if (k === "push") s.mode = "none";
    else if (k === "main") Object.assign(s, { mode: "main", main: v });
    else if (k === "fork") Object.assign(s, { mode: "fork", pr: Number(v) });
    else if (k === "prs") s.prs = v;
    else if (k === "from") s.from = v;
    else if (k === "actor") s.actor = v === "dependabot" ? "dependabot[bot]" : v;
    else if (k === "prfrom") s.prfrom = v;
    else if (k === "merge") s.merge = v;
    else if (k === "evidence") {
      const [tier, fixture, pkg] = v.split(":");
      s.evidence.push({ tier, ...(pkg ? { package: pkg } : {}), digest: BUNDLES[tier], bundle: bundle(fixture) });
    } else if (k === "jobs") s.jobs = v;
    else if (k === "attest") s.attest = v;
    else if (k === "comment") s.comment = v === "none" ? null : Number(v);
    else if (k === "token") s.writable = v === "full";
    else if (k === "prlookup") s.prlookup = v;
    else if (k === "prattest") s.prattest = v;
    else if (k === "mainattest") s.mainattest = v;
    else if (k === "ghcr") s.ghcr = v;
    else if (k === "sbom") s.sbom = v;
    else if (k === "prcheck") s.prcheck = v;
    else if (k === "sign") Object.assign(s, { mode: "sign-merge", sign: v, main: "5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b" });
    else if (k !== "go") throw new Error(`unknown probe step '${step}'`);
  }

  const trace = [];
  const jobs = [
    { name: "install", conclusion: "success" },
    { name: "lint", conclusion: "success" },
    { name: "unit", conclusion: "success" },
    { name: "harness", conclusion: s.jobs === "red" ? "failure" : "success" },
    { name: "report", conclusion: null },
    ...(s.jobs === "aggregate"
      ? [
          { name: "CI green", status: "in_progress", conclusion: null },
          { name: "feat report", status: "completed", conclusion: "failure" },
        ]
      : []),
  ];
  const api = {
    async get(path) {
      trace.push(`GET ${path}`);
      if (path.endsWith("/jobs")) return { jobs };
      if (path.endsWith(`/commits/${BUILT}`)) {
        if (s.merge === "badparents") return { parents: [{ sha: OTHER }, { sha: HEAD }] };
        if (s.merge === "basemoved" || s.merge === "offbranch") return { parents: [{ sha: NEWER_BASE }, { sha: HEAD }] };
        return { parents: [{ sha: BASE }, { sha: HEAD }] };
      }
      if (path.endsWith(`/compare/main...${NEWER_BASE}`)) return { status: s.merge === "basemoved" ? "behind" : "diverged" };
      if (path.endsWith(`/compare/main...${OTHER}`)) return { status: "diverged" };
      if (path.endsWith(`/commits/${s.main}/pulls`))
        // the pulls API's real shape (recorded from a merged pull request): merge_commit_sha is the commit on main,
        // and no field names the merge commit the pull request's run tested
        // (and, as recorded from flmnt's pull requests, the head repository and the author)
        return s.prlookup === "found"
          ? [
              {
                number: 7,
                merged_at: "2026-11-17T22:40:00Z",
                user: { login: s.prfrom === "dependabot" ? "dependabot[bot]" : "a-person" },
                head: { sha: HEAD, repo: { full_name: s.prfrom === "fork" ? "contributor/r" : "o/r" } },
                merge_commit_sha: s.main,
              },
            ]
          : [];
      // the open pull requests of the fork's head branch, in the pulls API's shape (head.sha, base.sha, base.ref)
      if (path === "/repos/o/r/pulls?head=contributor%3Afeature&state=open")
        return [{ number: s.pr, head: { sha: s.prs === "stale" ? OTHER : HEAD }, base: { sha: BASE, ref: "main" } }];
      if (path.endsWith(`/commits/${HEAD}/check-runs?check_name=feat%20report`))
        return {
          check_runs: [
            s.prcheck === "summary"
              ? { id: 55, external_id: "", output: { summary: `${MARKER}\n## ✅ PR #7 — verified\n\nHead \`${HEAD}\` · built \`refs/pull/7/merge\` @ \`${BUILT}\` · run [44153523061](x)` } }
              : { id: 55, external_id: BUILT, output: { summary: "report" } },
          ],
        };
      if (path.endsWith(`/runs/${PR_RUN}/artifacts`))
        return { artifacts: s.prattest === "missing" ? [] : [{ name: PR_SUBJECT.name, digest: PR_SUBJECT.digest }] };
      if (path.endsWith("/runs/1/artifacts")) return { artifacts: s.evidence.map((e) => ({ name: `feat-evidence-${e.tier}` })) };
      if (path.endsWith(`/commits/${s.main}/check-runs?check_name=feat%20report`)) {
        const recorded = sha(JSON.stringify(STATEMENT(s.main)));
        return { check_runs: [{ id: 77, name: "feat report", external_id: recorded, output: { title: `main ${s.main}: pass`, summary: "report" } }] };
      }
      if (path.endsWith("/comments")) return s.comment ? [{ id: s.comment, body: `${MARKER}\nold` }] : [];
      throw new Error(`unrecorded GET ${path}`);
    },
    async post(path) {
      trace.push(`POST ${path}`);
      return {};
    },
    async patch(path) {
      trace.push(`PATCH ${path}`);
      return {};
    },
  };

  const pathOf = (ref) => `https://github.com/o/r/.github/workflows/ci.yml@${ref}`;
  const ports = {
    api,
    writable: s.writable,
    async evidence() {
      return s.evidence;
    },
    async forkEvidence(runId) {
      await api.get(`/repos/o/r/actions/runs/${runId}/artifacts`);
      return s.evidence;
    },
    subjects: s.mode === "main" || s.mode === "sign-merge" ? [MAIN_SUBJECT] : s.attest === "none" || s.sbom === "missing" ? [] : [PR_SUBJECT],
    async referrers(subject) {
      trace.push(`GET ghcr.io/o/r/referrers/${subject.digest}`);
      if (s.attest === "classic") return [];
      return [{ digest: SIGNATURE, artifactType: "application/vnd.dev.sigstore.bundle.v0.3+json" }];
    },
    async classic(subject) {
      trace.push(`GET ghcr.io/o/r/manifests/${subject.digest.replace(":", "-")}.att`);
      return s.attest === "classic" ? [{ digest: CLASSIC_LAYER, classic: true }] : [];
    },
    async verify(subject) {
      const signed = { signature: true, key: true, keyFingerprint: REPO_KEY, signatureDigest: SIGNATURE };
      if (s.mode === "main") {
        if (subject.digest === PR_SUBJECT.digest) return { ...signed, sourceCommit: BUILT, signer: pathOf("refs/pull/7/merge") };
        return { ...signed, sourceCommit: s.mainattest === "wrongsource" ? OTHER : s.main, signer: pathOf("refs/heads/main") };
      }
      const good = { ...signed, sourceCommit: BUILT, signer: pathOf("refs/pull/7/merge") };
      if (s.attest === "unverified") return { ...good, signature: false, key: false, keyFingerprint: null, signatureDigest: null };
      if (s.attest === "wrongsource") return { ...good, sourceCommit: OTHER };
      if (s.attest === "foreignsigner") return { ...good, signer: "https://github.com/someone-else/fork/.github/workflows/build.yml@refs/heads/x" };
      if (s.attest === "otherkey") return { ...good, key: false, keyFingerprint: OTHER_KEY };
      if (s.attest === "classic") return { ...good, signatureDigest: CLASSIC_LAYER };
      return good;
    },
    async findPrRun() {
      return PR_RUN;
    },
    // as production does: the pull request's subjects are found at the tag of the commit its run tested, and at no other
    async prSubjects(artifacts, mergeRefSha) {
      if (mergeRefSha !== BUILT) return [];
      return artifacts.filter((a) => typeof a.digest === "string").map((a) => ({ name: "SBOM", digest: a.digest, repository: SUBJECT_REPO }));
    },
    async store(evidence) {
      if (s.ghcr === "fail") throw new Error("push refused");
      const ref = `ghcr.io/o/r-evidence@${evidence[0].digest}`;
      trace.push(`PUT ${ref}`);
      return ref;
    },
    async writeStatement(statement) {
      trace.push("WRITE merge-statement");
      return { digest: sha(JSON.stringify(statement)) };
    },
    async readStatement() {
      const statement = STATEMENT(s.sign === "othermain" ? OTHER : s.main);
      const bytes = JSON.stringify(statement) + (s.sign === "tampered" ? " " : "");
      return { statement, digest: sha(bytes) };
    },
    async sign(_subjects, predicateType) {
      trace.push(`SIGN ${predicateType}`);
      return { digest: "sha256:e3b98a4da31a127d4bde6e43033f66ba274cab0eb7eb1c70ec41402bf6273dd8" };
    },
  };

  const ctx = {
    owner: "o",
    repo: "r",
    mode: s.mode,
    runId: 1,
    runAttempt: 1,
    reportJob: "report",
    checkName: "feat report",
    signerWorkflows: [".github/workflows/ci.yml"],
    publicKey: "ci/signing/flmnt.pub",
    required: s.sbom === "missing" ? [{ label: "SBOM", job: "build" }] : [],
    pr: s.mode === "pr" ? { number: s.pr, headSha: HEAD, baseSha: BASE, baseRef: "main", builtRef: `refs/pull/${s.pr}/merge`, builtSha: BUILT } : undefined,
    mainSha: s.main,
    actor: s.actor ?? "a-person",
    // the workflow_run payload's fields: id, head_sha, head_branch, head_repository.{owner.login,full_name},
    // actor.login, pull_requests (empty for a fork's run)
    forkRun:
      s.mode === "fork"
        ? {
            id: 1,
            headSha: HEAD,
            headBranch: s.from === "fork" || !s.from ? "feature" : "dependabot/npm/x-1.2.3",
            headOwner: s.from === "fork" || !s.from ? "contributor" : "o",
            headRepository: s.from === "fork" || !s.from ? "contributor/r" : "o/r",
            actor: s.from === "dependabot" ? "dependabot[bot]" : "a-person",
            pullRequests: s.prs ? [] : [{ number: s.pr, baseSha: BASE, baseRef: "main" }],
          }
        : undefined,
  };

  try {
    const out = await runReport(ctx, ports);
    trace.push(`verdict=${out.verdict}`, `chain=${out.chain}`, `sections=${out.sections.join(",")}`);
    return { status: "OK", body: { trace: trace.join(" "), check: out.check, body: out.body } };
  } catch (e) {
    if (e instanceof ReportError) return { status: "ERR", body: { code: e.code, detail: e.message } };
    throw e;
  }
}
