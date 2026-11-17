// The probe behind `ProbePrReport` (SPEC-PRR-001): run the report core with a recorded GitHub API, recorded
// verification results, a fake evidence store and a fake signer. No network. Test fixture, not shipped.
// Steps: see the header of ../report.feat.
import { runReport, ReportError, MARKER } from "../src/report.ts";

const HEAD = "9f2c41d8a07e5b3c6d1f0e2a4b8c7d9e1f3a5b6c";
const BASE = "4e1a9c3b7d2f6e0a8c5b1d9f3e7a2c6b0d4f8e1a";
const BUILT = "c0ffee12a3b4c5d6e7f8091a2b3c4d5e6f708192";
const OTHER = "0badc0de1a2b3c4d5e6f708192a3b4c5d6e7f809";
const MAIN = "5e8d1f2a3b4c5d6e7f8091a2b3c4d5e6f7081a2b";
const PR_SUBJECT = { name: "flmnt-sbom.cdx.json", digest: "sha256:3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b" };
const MAIN_SUBJECT = { name: "flmnt-sbom.cdx.json", digest: "sha256:9b74c9897bac770ffc029102a200c5de2a4c2a6c2d1e3f4a5b6c7d8e9f0a1b2c" };
const BUNDLES = {
  unit: "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
  integration: "sha256:fcde2b2edba56bf408601fb721fe9b5c338d10ee429ea04fae5511b68fbf8fb9",
};
const PR_RUN = 44153523061;
const ISSUER = "https://token.actions.githubusercontent.com";

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
    else if (k === "merge") s.merge = v;
    else if (k === "evidence") {
      const [tier, fixture] = v.split(":");
      s.evidence.push({ tier, digest: BUNDLES[tier], bundle: bundle(fixture) });
    } else if (k === "jobs") s.jobs = v;
    else if (k === "attest") s.attest = v;
    else if (k === "comment") s.comment = v === "none" ? null : Number(v);
    else if (k === "token") s.writable = v === "full";
    else if (k === "prlookup") s.prlookup = v;
    else if (k === "prattest") s.prattest = v;
    else if (k === "mainattest") s.mainattest = v;
    else if (k === "ghcr") s.ghcr = v;
    else if (k !== "go") throw new Error(`unknown probe step '${step}'`);
  }

  const trace = [];
  const jobs = [
    { name: "install", conclusion: "success" },
    { name: "lint", conclusion: "success" },
    { name: "unit", conclusion: "success" },
    { name: "harness", conclusion: s.jobs === "red" ? "failure" : "success" },
    { name: "report", conclusion: null },
  ];
  const api = {
    async get(path) {
      trace.push(`GET ${path}`);
      if (path.endsWith("/jobs")) return { jobs };
      if (path.endsWith(`/commits/${BUILT}`))
        return { parents: s.merge === "badparents" ? [{ sha: OTHER }, { sha: HEAD }] : [{ sha: BASE }, { sha: HEAD }] };
      if (path.endsWith(`/commits/${s.main}/pulls`))
        return s.prlookup === "found" ? [{ number: 7, merged_at: "2026-11-17T22:40:00Z", head: { sha: HEAD }, merge_ref_sha: BUILT }] : [];
      if (path.endsWith(`/runs/${PR_RUN}/artifacts`))
        return { artifacts: s.prattest === "missing" ? [] : [{ name: PR_SUBJECT.name, digest: PR_SUBJECT.digest }] };
      if (path.endsWith("/runs/1/artifacts")) return { artifacts: s.evidence.map((e) => ({ name: `feat-evidence-${e.tier}` })) };
      if (path.includes("/attestations/")) return { attestations: [{ bundle: { digest: path.split("/").pop() } }] };
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
    subjects: s.mode === "main" ? [MAIN_SUBJECT] : s.attest === "none" ? [] : [PR_SUBJECT],
    async verify(subject) {
      if (s.mode === "main") {
        if (subject.digest === PR_SUBJECT.digest)
          return { signature: true, sourceCommit: BUILT, signer: pathOf("refs/pull/7/merge"), issuer: ISSUER, rekorIndex: 871204553 };
        return {
          signature: true,
          sourceCommit: s.mainattest === "wrongsource" ? OTHER : s.main,
          signer: pathOf("refs/heads/main"),
          issuer: ISSUER,
          rekorIndex: 871322019,
        };
      }
      const good = { signature: true, sourceCommit: BUILT, signer: pathOf("refs/pull/7/merge"), issuer: ISSUER, rekorIndex: 871204553 };
      if (s.attest === "unverified") return { ...good, signature: false };
      if (s.attest === "wrongsource") return { ...good, sourceCommit: OTHER };
      if (s.attest === "foreignsigner") return { ...good, signer: "https://github.com/someone-else/fork/.github/workflows/build.yml@refs/heads/x" };
      if (s.attest === "nolog") return { ...good, rekorIndex: null };
      return good;
    },
    async findPrRun() {
      return PR_RUN;
    },
    async store(evidence) {
      if (s.ghcr === "fail") throw new Error("push refused");
      const ref = `ghcr.io/o/r-evidence@${evidence[0].digest}`;
      trace.push(`PUT ${ref}`);
      return ref;
    },
    async attest(_subjects, predicateType) {
      trace.push(`ATTEST ${predicateType}`);
      return { digest: "sha256:e3b98a4da31a127d4bde6e43033f66ba274cab0eb7eb1c70ec41402bf6273dd8", rekorIndex: 871322019 };
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
    pr: s.mode === "pr" || s.mode === "fork" ? { number: s.pr, headSha: HEAD, baseSha: BASE, builtRef: `refs/pull/${s.pr}/merge`, builtSha: BUILT } : undefined,
    mainSha: s.main,
    forkRunId: s.mode === "fork" ? 1 : undefined,
    forkPr: s.mode === "fork" ? s.pr : undefined,
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
