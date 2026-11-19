// SPEC-PRR-001 — the pull request build report (ADR-0032). The core is a function of its context and its ports:
// every GitHub call goes through `api`, the GHCR referrers listing through `referrers`, cosign verification through
// `verify`, evidence storage through `store` and signing through `sign`, so the spec drives it with recorded fakes and
// the Action wires real ones (main.ts). Signing is the consumer's own cosign key; there is no transparency log
// (ADR-0032 decision 13).

export const MARKER = "<!-- feat-pr-report -->";
export const MERGE_PREDICATE = "https://feature.mmmnt.dev/attestation/pr-merge/v1";

export type Mode = "pr" | "fork" | "main" | "sign-merge" | "none";
export type Verdict = "pass" | "fail" | "incomplete";
export type Link = "built-commit" | "signature" | "provenance" | "signer" | "key" | "main-provenance";

export interface Evidence {
  tier: string;
  package?: string; // the package the bundle covers, when a tier has one bundle per package
  digest: string; // sha256:<hex> of the bundle file
  bundle: {
    verify?: { status: string };
    run?: { status: string; tests: number; failures: number; errors: number };
    specs?: unknown[];
    runs?: { spec_id: string | null; status: string }[];
  };
}

export interface Subject {
  name: string; // label, e.g. SBOM
  digest: string; // sha256:<hex> of the subject's OCI manifest
  repository: string; // e.g. ghcr.io/<owner>/<repo>-sbom
}

// A subject the consumer requires (input `required-subjects`, e.g. "SBOM from build"), ADR-0032 decision 14.
export interface Required {
  label: string;
  job: string;
}

export interface Verification {
  signature: boolean; // cosign verified the attestation's signature with a key it was given
  key: boolean; // ...and that key is the repository's public key
  keyFingerprint: string | null; // sha256:<hex> of the verifying key's DER SubjectPublicKeyInfo
  signatureDigest: string | null; // digest of the referrer manifest carrying the verified attestation
  sourceCommit: string | null; // provenance source commit
  signer: string | null; // the provenance's workflow, https://github.com/<o>/<r>/<path>@<ref>
}

export interface Context {
  owner: string;
  repo: string;
  mode: Mode;
  runId: number;
  runAttempt: number;
  reportJob: string;
  checkName: string;
  signerWorkflows: string[]; // e.g. ".github/workflows/ci.yml"
  pr?: { number: number; headSha: string; baseSha: string; baseRef: string; builtRef: string; builtSha: string };
  mainSha?: string;
  forkRun?: ForkRun; // fork mode: the pull_request run whose uploads are reported
  evidencePrefix?: string; // evidence artifact name prefix (default feat-evidence-)
  publicKey: string; // the repository's public key path, e.g. ci/signing/flmnt.pub
  required?: Required[];
}

// A fork's run holds no repository secrets (founder 2026-11-19, flmnt f60f6956): it cannot sign, so it is not
// attested before merge. Every run from this repository holds them, Dependabot's included (flmnt 6fcbe41f).
const NOT_ATTESTED = "not attested (fork PR); attested on merge";

// The `workflow_run` event's run, in the fields of GitHub's payload the follow-up reads.
export interface ForkRun {
  id: number;
  headSha: string;
  headBranch: string;
  headOwner: string; // head_repository.owner.login
  headRepository: string; // head_repository.full_name
  pullRequests: { number: number; baseSha: string; baseRef: string }[]; // empty for a fork's run
}

export interface Api {
  get(path: string): Promise<any>;
  post(path: string, body: unknown): Promise<any>;
  patch(path: string, body: unknown): Promise<any>;
}

export interface Ports {
  api: Api;
  writable: boolean;
  evidence(): Promise<Evidence[]>;
  forkEvidence?(runId: number): Promise<Evidence[]>;
  subjects: Subject[];
  referrers(subject: Subject): Promise<unknown[]>; // the attestations stored as OCI referrers of the subject
  classic(subject: Subject): Promise<unknown[]>; // cosign's classic key signing: the layers of its `sha256-<hex>.att` tag
  verify(subject: Subject, referrers: unknown[]): Promise<Verification>;
  findPrRun(pr: { number: number; headSha: string }): Promise<number | null>;
  prSubjects(artifacts: unknown[], mergeRefSha: string): Promise<Subject[]>; // the PR run's signed subjects
  store(evidence: Evidence[]): Promise<string>; // digest-pinned reference
  sign(subjects: Subject[], predicateType: string, predicate: unknown): Promise<{ digest: string }>;
  // the two-run merge mode (ruling 2026-11-18, "Two-run merge mode (Recommended)"): the report run writes the
  // unsigned merge statement; the sign run reads it back and alone signs it
  writeStatement(statement: unknown): Promise<{ digest: string }>;
  readStatement(): Promise<{ statement: any; digest: string }>;
}

export class ReportError extends Error {
  constructor(public code: string, detail: string) {
    super(detail);
  }
}

export interface Outcome {
  verdict: Verdict;
  chain: "ok" | "not-attested" | `broken:${Link}`;
  sections: string[];
  body: string;
  check: "success" | "failure" | "neutral";
}

interface Row {
  subject: Subject;
  v: Verification | null;
}

const repoPath = (c: Context) => `/repos/${c.owner}/${c.repo}`;

function signerOk(c: Context, signer: string | null, ref: string): boolean {
  if (!signer) return false;
  return c.signerWorkflows.some((w) => signer === `https://github.com/${c.owner}/${c.repo}/${w}@${ref}`);
}

// The first broken link of one verified attestation, in the chain's order.
function attestationBreak(c: Context, row: Row, builtSha: string, ref: string): Link | null {
  const v = row.v;
  if (!v || !v.signature) return "signature";
  if (v.sourceCommit !== builtSha) return "provenance";
  if (!signerOk(c, v.signer, ref)) return "signer";
  if (!v.key) return "key";
  return null;
}

async function jobsOf(c: Context, api: Api, runId: number, attempt: number) {
  const res = await api.get(`${repoPath(c)}/actions/runs/${runId}/attempts/${attempt}/jobs`);
  const jobs: { name: string; status?: string; conclusion: string | null; html_url?: string }[] = res?.jobs ?? [];
  // Jobs still running when the report runs are the ones that wait on it (an aggregate such as `CI green`); the
  // report's own check run is listed among the jobs too. Neither is a job the report can judge.
  return jobs.filter(
    (j) => j.name !== c.reportJob && j.name !== c.checkName && (j.status === undefined || j.status === "completed"),
  );
}

async function verifySubjects(c: Context, ports: Ports, subjects: Subject[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const s of subjects) {
    // OCI referrers first; with none, cosign's classic `.att` tag (ruling 2026-11-18, "Action reads .att too
    // (Recommended)")
    let refs = await ports.referrers(s);
    if (refs.length === 0) refs = await ports.classic(s);
    rows.push({ subject: s, v: refs.length === 0 ? null : await ports.verify(s, refs) });
  }
  return rows;
}

function testsVerdict(evidence: Evidence[]): { failed: boolean; incomplete: boolean } {
  let failed = false;
  let incomplete = false;
  for (const e of evidence) {
    if (e.bundle.verify?.status && e.bundle.verify.status !== "pass") failed = true;
    if (!e.bundle.run) incomplete = true;
    else if (e.bundle.run.status !== "pass") failed = true;
  }
  return { failed, incomplete };
}

async function upsertComment(c: Context, api: Api, pr: number, body: string, append: boolean) {
  const comments: { id: number; body: string }[] = (await api.get(`${repoPath(c)}/issues/${pr}/comments`)) ?? [];
  const mine = comments.find((x) => typeof x.body === "string" && x.body.includes(MARKER));
  if (mine) {
    await api.patch(`${repoPath(c)}/issues/comments/${mine.id}`, { body: append ? `${mine.body}\n\n${body}` : body });
  } else {
    await api.post(`${repoPath(c)}/issues/${pr}/comments`, { body: append ? `${MARKER}\n${body}` : body });
  }
}

const missingOf = (c: Context, subjects: Subject[]): Required[] =>
  (c.required ?? []).filter((r) => !subjects.some((s) => s.name === r.label));

const conclusion = (v: Verdict) => (v === "pass" ? "success" : v === "fail" ? "failure" : "neutral");

export async function runReport(c: Context, ports: Ports): Promise<Outcome> {
  if (c.mode === "none") throw new ReportError("NO_PR_CONTEXT", "this run is neither a pull request nor a push to main");
  if (!ports.writable)
    throw new ReportError("INSUFFICIENT_PERMISSIONS", "the token cannot write pull request comments or check runs");
  if (c.mode === "main") return mergeMode(c, ports);
  if (c.mode === "sign-merge") return signMode(c, ports);

  const fork = c.mode === "fork";
  let pr = c.pr!;
  if (fork) {
    const run = c.forkRun!;
    if (!isForkRun(c, run))
      throw new ReportError(
        "TRUSTED_RUN",
        `run ${run.id} is from ${run.headRepository}: it holds the repository's secrets and reports itself`,
      );
    pr = await forkPullRequest(c, ports.api, run);
  }
  const prNumber = pr.number;
  const runId = fork ? c.forkRun!.id : c.runId;
  const evidence = fork ? await ports.forkEvidence!(runId) : await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");

  const jobs = await jobsOf(c, ports.api, runId, fork ? 1 : c.runAttempt);
  let broken: Link | null = null;
  let base = pr.baseSha;
  if (!fork) {
    const commit = await ports.api.get(`${repoPath(c)}/commits/${c.pr!.builtSha}`);
    const parents: string[] = (commit?.parents ?? []).map((p: any) => p.sha);
    // The event's base is a snapshot; GitHub builds the merge ref on the base branch's tip at that time. A first
    // parent the compare finds on the base branch (identical to, or behind, it) is the base (ruling "Accept a newer
    // base (Recommended)").
    if (parents.length === 2 && parents[1] === c.pr!.headSha && parents[0] !== base) {
      const cmp = await ports.api.get(`${repoPath(c)}/compare/${encodeURIComponent(c.pr!.baseRef)}...${parents[0]}`);
      if (cmp?.status === "identical" || cmp?.status === "behind") base = parents[0]!;
    }
    if (!(parents.length === 2 && parents[0] === base && parents[1] === c.pr!.headSha)) broken = "built-commit";
  }
  // a fork's run holds no secrets and signed nothing: no subject is verified, and none is required of it
  const rows = fork ? [] : await verifySubjects(c, ports, ports.subjects);
  if (!broken) for (const r of rows) broken ??= attestationBreak(c, r, pr.builtSha, pr.builtRef);

  const missing = fork ? [] : missingOf(c, ports.subjects);
  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");
  const verdict: Verdict =
    t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = broken ? (`broken:${broken}` as const) : fork ? "not-attested" : "ok";
  const sections = ["header", "tests"];
  if (fork || rows.length > 0 || missing.length > 0) sections.push("attestations");
  sections.push("chain");
  if (!fork && rows.length > 0) sections.push("verify");

  const body = renderPr(c, { pr, prNumber, runId, evidence, jobs, rows, broken, verdict, fork, missing, base });
  await upsertComment(c, ports.api, prNumber, body, false);
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: pr.headSha,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: headline(verdict, prNumber, broken, missing), summary: body },
    // the commit this run built and tested, which the merge run reads back
    ...(!fork && pr.builtSha ? { external_id: pr.builtSha } : {}),
  });
  return { verdict, chain, sections, body, check: conclusion(verdict) };
}

// The follow-up's run from the `workflow_run` event payload (fields as GitHub sends them, fixtures/recorded).
export function forkRunOf(wr: any): ForkRun {
  return {
    id: Number(wr.id),
    headSha: String(wr.head_sha ?? ""),
    headBranch: String(wr.head_branch ?? ""),
    headOwner: String(wr.head_repository?.owner?.login ?? ""),
    headRepository: String(wr.head_repository?.full_name ?? ""),
    pullRequests: (wr.pull_requests ?? []).map((p: any) => ({
      number: Number(p.number),
      baseSha: String(p.base?.sha ?? ""),
      baseRef: String(p.base?.ref ?? ""),
    })),
  };
}

// Whether a follow-up's run came from a fork. A run from this repository held the repository's secrets and reported
// itself, whoever started it.
export function isForkRun(c: Context, run: ForkRun): boolean {
  return run.headRepository !== `${c.owner}/${c.repo}`;
}

// Whether a merged pull request came from a fork, read from the pulls API: its head repository is another, or none
// when the fork is gone.
export function isForkPull(c: Context, pull: any): boolean {
  return pull?.head?.repo?.full_name !== `${c.owner}/${c.repo}`;
}

// The pull request a follow-up's run belongs to. GitHub lists it on the run, except for a fork's run, whose
// `pull_requests` is empty: then it is the open pull request of `<head owner>:<head branch>` whose head is the run's
// head commit, and no other.
export async function forkPullRequest(c: Context, api: Api, run: ForkRun) {
  const listed = run.pullRequests[0];
  let found = listed;
  if (!found) {
    const head = encodeURIComponent(`${run.headOwner}:${run.headBranch}`);
    const open: any[] = (await api.get(`${repoPath(c)}/pulls?head=${head}&state=open`)) ?? [];
    const hit = open.find((p) => p?.head?.sha === run.headSha);
    if (!hit)
      throw new ReportError(
        "NO_PR_CONTEXT",
        `no open pull request of ${run.headOwner}:${run.headBranch} has head ${run.headSha} (run ${run.id})`,
      );
    found = { number: hit.number, baseSha: hit.base?.sha ?? "", baseRef: hit.base?.ref ?? "" };
  }
  return {
    number: found.number,
    headSha: run.headSha,
    baseSha: found.baseSha,
    baseRef: found.baseRef,
    builtRef: `refs/pull/${found.number}/merge`,
    builtSha: "",
  };
}

// The merge commit a pull request's run built and tested, as that run's feat report check on the pull request head
// records it: its external_id, or, for a check that predates it, the "built `<ref>` @ `<sha>`" of its summary.
export async function testedMergeRef(c: Context, api: Api, head: string): Promise<string | null> {
  const res = await api.get(`${repoPath(c)}/commits/${head}/check-runs?check_name=${encodeURIComponent(c.checkName)}`);
  for (const run of res?.check_runs ?? []) {
    if (typeof run.external_id === "string" && /^[0-9a-f]{40}$/.test(run.external_id)) return run.external_id;
    const built = /built `[^`]+` @ `([0-9a-f]{40})`/.exec(run.output?.summary ?? "");
    if (built) return built[1]!;
  }
  return null;
}

async function mergeMode(c: Context, ports: Ports): Promise<Outcome> {
  const evidence = await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");
  const jobs = await jobsOf(c, ports.api, c.runId, c.runAttempt);
  const main = c.mainSha!;
  const pulls: any[] = (await ports.api.get(`${repoPath(c)}/commits/${main}/pulls`)) ?? [];
  const pr = pulls.find((p) => p.merged_at);
  if (!pr) throw new ReportError("NO_PR_FOR_MERGE", `no merged pull request is associated with ${main}`);
  // the pulls API names the head and the commit that landed on main, not the merge commit the pull request's run
  // tested: that one is recorded by the pull request run's own feat report check
  // a fork's pull request ran without the key: its run attested nothing, and is recorded so
  const fork = isForkPull(c, pr);
  const mergeRefSha = await testedMergeRef(c, ports.api, pr.head.sha as string);
  if (!mergeRefSha && !fork)
    throw new ReportError("PR_EVIDENCE_MISSING", `no ${c.checkName} check on #${pr.number}'s head records the commit its run tested`);
  const prInfo = { number: pr.number as number, headSha: pr.head.sha as string, mergeRefSha };
  const prRun = await ports.findPrRun({ number: prInfo.number, headSha: prInfo.headSha });
  if (prRun === null && !fork) throw new ReportError("PR_EVIDENCE_MISSING", `no pull request run found for #${prInfo.number}`);
  const arts = prRun === null ? null : await ports.api.get(`${repoPath(c)}/actions/runs/${prRun}/artifacts`);
  const prSubjects = prRun === null || !mergeRefSha ? [] : await ports.prSubjects(arts?.artifacts ?? [], mergeRefSha);
  if (prSubjects.length === 0 && !fork) throw new ReportError("PR_EVIDENCE_MISSING", `run ${prRun} has no attested artifacts`);
  const unattested = prSubjects.length === 0 && fork;
  const prRows = await verifySubjects(c, ports, prSubjects);
  if (prRows.some((r) => r.v === null))
    throw new ReportError("PR_EVIDENCE_MISSING", `run ${prRun}'s attestations cannot be retrieved`);
  const mainRows = await verifySubjects(c, ports, ports.subjects);

  let broken: Link | null = null;
  for (const r of mainRows) {
    const b = attestationBreak(c, r, main, "refs/heads/main");
    if (b === "provenance") broken ??= "main-provenance";
    else broken ??= b;
  }
  const missing = missingOf(c, ports.subjects);
  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");

  let merge: { statement: string; store: string } | null = null;
  if (!broken && missing.length === 0 && ports.subjects.length > 0) {
    let store: string;
    try {
      store = await ports.store(evidence);
    } catch (e) {
      throw new ReportError("EVIDENCE_STORE_FAILED", `evidence bundles could not be stored: ${(e as Error).message}`);
    }
    const predicate = {
      pullRequest: unattested
        ? { number: prInfo.number, headSha: prInfo.headSha, mergeRefSha: prInfo.mergeRefSha, attested: false, origin: "fork" }
        : { number: prInfo.number, headSha: prInfo.headSha, mergeRefSha: prInfo.mergeRefSha },
      prRun: { id: prRun, attestations: prRows.map((r) => r.subject.digest) },
      main: { sha: main, run: { id: c.runId, attempt: c.runAttempt }, artifacts: ports.subjects.map((s) => s.digest) },
      evidence: { bundles: evidence.map((e) => e.digest), store },
    };
    // written, never signed here: the sign run alone holds the key
    const written = await ports.writeStatement(predicate);
    merge = { statement: written.digest, store };
  }
  const verdict: Verdict =
    t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = broken ? (`broken:${broken}` as const) : "ok";
  const sections = ["header", "tests", "attestations", "chain", "verify"];
  const body = renderMain(c, { main, prInfo, prRun, evidence, jobs, prRows, mainRows, broken, verdict, merge, missing, unattested });
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: main,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: `main ${main}: ${missing.length > 0 ? `incomplete: ${missingText(missing)}` : verdict}`, summary: body },
    ...(merge ? { external_id: merge.statement } : {}),
  });
  const why = broken
    ? `merge chain broken at ${broken}`
    : missing.length > 0
      ? `merge not signed: ${missingText(missing)}`
      : `merge not signed: ${verdict}`;
  const line = merge
    ? `**Merged** as \`${main}\` · merge statement \`${merge.statement}\` · signature pending (job sign-merge)`
    : `**Merged** as \`${main}\` · ❌ ${why}`;
  await upsertComment(c, ports.api, prInfo.number, line, true);
  return { verdict, chain, sections, body, check: conclusion(verdict) };
}

// The sign run: the statement the report run wrote, for this main commit and with the digest main's check recorded,
// is signed and the check and the pull request pointed at its signature; anything else is refused with no effect.
async function signMode(c: Context, ports: Ports): Promise<Outcome> {
  const main = c.mainSha!;
  const { statement, digest } = await ports.readStatement();
  if (statement?.main?.sha !== main)
    throw new ReportError("STATEMENT_MISMATCH", `the statement names main ${statement?.main?.sha ?? "none"}, not ${main}`);
  const runs = await ports.api.get(
    `${repoPath(c)}/commits/${main}/check-runs?check_name=${encodeURIComponent(c.checkName)}`,
  );
  const check = (runs?.check_runs ?? []).find((r: any) => r.external_id === digest);
  if (!check)
    throw new ReportError("STATEMENT_MISMATCH", `no ${c.checkName} check on ${main} recorded the statement ${digest}`);
  const signed = await ports.sign(ports.subjects, MERGE_PREDICATE, statement);
  const line = `**Signed** merge statement \`${digest}\` · signature \`${signed.digest}\` ✅`;
  await ports.api.patch(`${repoPath(c)}/check-runs/${check.id}`, {
    output: { title: check.output?.title ?? `main ${main}`, summary: `${check.output?.summary ?? ""}\n\n${line}` },
  });
  await upsertComment(c, ports.api, statement.pullRequest.number, line, true);
  return { verdict: "pass", chain: "ok", sections: [], body: line, check: "success" };
}

// ── rendering: compact, evidential, no prose; digests and SHAs always in full ──

const missingText = (m: Required[]) => m.map((r) => `${r.label} not produced (job ${r.job})`).join(", ");

function headline(v: Verdict, pr: number, broken: Link | null, missing: Required[]): string {
  if (broken) return `PR #${pr}: chain broken at ${broken}`;
  if (v === "incomplete" && missing.length > 0) return `PR #${pr}: incomplete: ${missingText(missing)}`;
  return v === "pass" ? `PR #${pr}: verified` : v === "fail" ? `PR #${pr}: failed` : `PR #${pr}: incomplete`;
}

const mark = (ok: boolean) => (ok ? "✅" : "❌");

function testsTable(evidence: Evidence[], jobs: { conclusion: string | null }[]): string[] {
  const out = ["### Tests", "", "| Tier | Specs | Scenarios | Evidence bundle |", "|---|---|---|---|"];
  for (const e of evidence) {
    const r = e.bundle.run;
    const scen = r ? `${mark(r.status === "pass")} ${r.tests - r.failures - r.errors} / ${r.tests}` : "— no run";
    out.push(`| ${e.package ? `${e.tier} · ${e.package}` : e.tier} | ${(e.bundle.specs ?? []).length} | ${scen} | \`${e.digest}\` |`);
  }
  const ok = jobs.filter((j) => j.conclusion === "success").length;
  out.push(`| CI jobs | — | ${mark(ok === jobs.length)} ${ok} / ${jobs.length} | — |`);
  return out;
}

function attestationRows(rows: Row[], missing: Required[] = []): string[] {
  const out = [
    "### Attestations",
    "",
    "| Artifact | Subject digest | Signature | Key | Signer | Source commit | |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    const v = r.v;
    const signer = v?.signer ? v.signer.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/\.github\/workflows\//, "") : "—";
    out.push(
      `| \`${r.subject.name}\` | \`${r.subject.digest}\` | \`${v?.signatureDigest ?? "—"}\` | \`${v?.keyFingerprint ?? "—"}\` | \`${signer}\` | \`${v?.sourceCommit ?? "—"}\` | ${mark(!!v && v.signature && v.key)} |`,
    );
  }
  for (const m of missing) out.push(`| \`${m.label}\` | not produced (job ${m.job}) | — | — | — | — | ❌ |`);
  return out;
}

// The command an auditor runs with the committed public key alone (ADR-0032 decision 13). There is no transparency
// log, so cosign must be told not to require an entry in one (founder ruling 2026-11-17, "Add the flag").
export const verifyCommand = (c: Context, s: Subject, type: string) =>
  `cosign verify-attestation --key ${c.publicKey} --insecure-ignore-tlog --type ${type} ${s.repository}@${s.digest}`;

function verifyBlock(lines: string[]): string[] {
  return ["", "<details><summary>Verify</summary>", "", "```sh", ...lines, "```", "", "</details>"];
}

function keyRow(r: Row): string {
  return `| \`${r.subject.name}\` signed by the repository's key \`${r.v?.keyFingerprint ?? "—"}\` | ${mark(!!r.v && r.v.signature && r.v.key)} |`;
}

function renderPr(
  c: Context,
  x: {
    prNumber: number;
    runId: number;
    evidence: Evidence[];
    jobs: any[];
    rows: Row[];
    broken: Link | null;
    verdict: Verdict;
    fork: boolean;
    pr: NonNullable<Context["pr"]>;
    missing: Required[];
    base: string;
  },
): string {
  const short = x.verdict === "incomplete" && x.missing.length > 0;
  const icon = x.verdict === "pass" ? "✅" : x.verdict === "fail" || short ? "❌" : "⚪";
  const title = x.broken
    ? `chain broken at ${x.broken}`
    : short
      ? `incomplete: ${missingText(x.missing)}`
      : x.verdict === "pass"
        ? "verified"
        : x.verdict;
  const out = [MARKER, `## ${icon} PR #${x.prNumber} — ${title}`, ""];
  const p = x.pr;
  if (x.fork)
    out.push(
      `Fork pull request · head \`${p.headSha}\` · run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId})`,
    );
  else
    out.push(
      `Head \`${p.headSha}\` · built \`${p.builtRef}\` @ \`${p.builtSha}\` · run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId}/attempts/${c.runAttempt})`,
    );
  out.push("", ...testsTable(x.evidence, x.jobs), "");
  if (x.fork) {
    out.push("### Attestations", "", NOT_ATTESTED, "");
  } else if (x.rows.length > 0 || x.missing.length > 0) out.push(...attestationRows(x.rows, x.missing), "");
  out.push("### Chain", "", "| Check | |", "|---|---|");
  if (!x.fork)
    out.push(`| Built commit's parents = base \`${x.base}\` + head \`${p.headSha}\` | ${mark(x.broken !== "built-commit")} |`);
  if (x.fork) out.push(`| Attestations | ${NOT_ATTESTED} |`);
  else
    for (const r of x.rows) {
      out.push(
        `| \`${r.subject.name}\` signature verifies | ${mark(!!r.v && r.v.signature)} |`,
        `| \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "—"}\` = built commit \`${p.builtSha}\` | ${mark(!!r.v && r.v.sourceCommit === p.builtSha)} |`,
        `| \`${r.subject.name}\` signer = this repository's workflow at \`${p.builtRef}\` | ${mark(!!r.v && signerOk(c, r.v.signer, p.builtRef))} |`,
        keyRow(r),
      );
    }
  if (!x.fork && x.rows.length > 0) out.push(...verifyBlock(x.rows.map((r) => verifyCommand(c, r.subject, "slsaprovenance1"))));
  return out.join("\n");
}

function renderMain(
  c: Context,
  x: {
    main: string;
    prInfo: { number: number; headSha: string; mergeRefSha: string | null };
    prRun: number | null;
    evidence: Evidence[];
    jobs: any[];
    prRows: Row[];
    mainRows: Row[];
    broken: Link | null;
    verdict: Verdict;
    merge: { statement: string; store: string } | null;
    missing: Required[];
    unattested: boolean;
  },
): string {
  const short = x.verdict === "incomplete" && x.missing.length > 0;
  const icon = x.verdict === "pass" ? "✅" : x.verdict === "fail" || short ? "❌" : "⚪";
  const title = x.broken
    ? `chain broken at ${x.broken}`
    : short
      ? `incomplete: ${missingText(x.missing)}`
      : x.verdict === "pass"
        ? "verified"
        : x.verdict;
  const out = [MARKER, `## ${icon} main \`${x.main}\` — ${title}`, ""];
  out.push(
    `Merged PR #${x.prInfo.number} · head \`${x.prInfo.headSha}\` · tested \`${x.prInfo.mergeRefSha ?? "—"}\` · PR run ${x.prRun === null ? "—" : `[${x.prRun}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.prRun})`} · main run [${c.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${c.runId}/attempts/${c.runAttempt})`,
    "",
    ...testsTable(x.evidence, x.jobs),
    "",
    ...attestationRows([...x.prRows, ...x.mainRows], x.missing),
    "",
    "### Chain",
    "",
    "| Check | |",
    "|---|---|",
  );
  if (x.unattested) out.push(`| PR attestations | ${NOT_ATTESTED} |`);
  for (const r of x.prRows)
    out.push(
      `| PR \`${r.subject.name}\` source commit = tested \`${x.prInfo.mergeRefSha}\` | ${mark(!!r.v && r.v.sourceCommit === x.prInfo.mergeRefSha)} |`,
    );
  for (const r of x.mainRows)
    out.push(
      `| main \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "—"}\` = main \`${x.main}\` | ${mark(!!r.v && r.v.sourceCommit === x.main)} |`,
      keyRow(r),
    );
  if (x.merge)
    out.push(
      `| Evidence stored \`${x.merge.store}\` | ✅ |`,
      `| Merge statement \`${x.merge.statement}\` · signature pending (job sign-merge) | ⏳ |`,
    );
  if (x.mainRows.length > 0)
    out.push(
      ...verifyBlock(
        x.mainRows.flatMap((r) => [verifyCommand(c, r.subject, "slsaprovenance1"), verifyCommand(c, r.subject, MERGE_PREDICATE)]),
      ),
    );
  return out.join("\n");
}
