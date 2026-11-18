// SPEC-PRR-001 — the pull request build report (ADR-0032). The core is a function of its context and its ports:
// every GitHub call goes through `api`, the GHCR referrers listing through `referrers`, cosign verification through
// `verify`, evidence storage through `store` and signing through `sign`, so the spec drives it with recorded fakes and
// the Action wires real ones (main.ts). Signing is the consumer's own cosign key; there is no transparency log
// (ADR-0032 decision 13).

export const MARKER = "<!-- feat-pr-report -->";
export const MERGE_PREDICATE = "https://feature.mmmnt.dev/attestation/pr-merge/v1";

export type Mode = "pr" | "fork" | "main" | "none";
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
  forkRunId?: number; // fork mode: the pull_request run whose uploads are reported
  forkPr?: number;
  evidencePrefix?: string; // evidence artifact name prefix (default feat-evidence-)
  publicKey: string; // the repository's public key path, e.g. ci/signing/flmnt.pub
  required?: Required[];
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

  const fork = c.mode === "fork";
  const prNumber = fork ? c.forkPr! : c.pr!.number;
  const runId = fork ? c.forkRunId! : c.runId;
  const evidence = fork ? await ports.forkEvidence!(runId) : await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");

  const jobs = await jobsOf(c, ports.api, runId, fork ? 1 : c.runAttempt);
  let broken: Link | null = null;
  let base = c.pr!.baseSha;
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
  const rows = fork ? [] : await verifySubjects(c, ports, ports.subjects);
  if (!broken) for (const r of rows) broken ??= attestationBreak(c, r, c.pr!.builtSha, c.pr!.builtRef);

  const missing = fork ? [] : missingOf(c, ports.subjects);
  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");
  const verdict: Verdict =
    t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = fork ? "not-attested" : broken ? (`broken:${broken}` as const) : "ok";
  const sections = ["header", "tests"];
  if (fork || rows.length > 0 || missing.length > 0) sections.push("attestations");
  sections.push("chain");
  if (!fork && rows.length > 0) sections.push("verify");

  const body = renderPr(c, { prNumber, runId, evidence, jobs, rows, broken, verdict, fork, missing, base });
  await upsertComment(c, ports.api, prNumber, body, false);
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: c.pr!.headSha,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: headline(verdict, prNumber, broken, missing), summary: body },
  });
  return { verdict, chain, sections, body, check: conclusion(verdict) };
}

async function mergeMode(c: Context, ports: Ports): Promise<Outcome> {
  const evidence = await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");
  const jobs = await jobsOf(c, ports.api, c.runId, c.runAttempt);
  const main = c.mainSha!;
  const pulls: any[] = (await ports.api.get(`${repoPath(c)}/commits/${main}/pulls`)) ?? [];
  const pr = pulls.find((p) => p.merged_at);
  if (!pr) throw new ReportError("NO_PR_FOR_MERGE", `no merged pull request is associated with ${main}`);
  const prInfo = { number: pr.number as number, headSha: pr.head.sha as string, mergeRefSha: pr.merge_ref_sha as string };
  const prRun = await ports.findPrRun({ number: prInfo.number, headSha: prInfo.headSha });
  if (prRun === null) throw new ReportError("PR_EVIDENCE_MISSING", `no pull request run found for #${prInfo.number}`);
  const arts = await ports.api.get(`${repoPath(c)}/actions/runs/${prRun}/artifacts`);
  const prSubjects = await ports.prSubjects(arts?.artifacts ?? [], prInfo.mergeRefSha);
  if (prSubjects.length === 0) throw new ReportError("PR_EVIDENCE_MISSING", `run ${prRun} has no attested artifacts`);
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

  let merge: { digest: string; store: string } | null = null;
  if (!broken && missing.length === 0 && ports.subjects.length > 0) {
    let store: string;
    try {
      store = await ports.store(evidence);
    } catch (e) {
      throw new ReportError("EVIDENCE_STORE_FAILED", `evidence bundles could not be stored: ${(e as Error).message}`);
    }
    const predicate = {
      pullRequest: { number: prInfo.number, headSha: prInfo.headSha, mergeRefSha: prInfo.mergeRefSha },
      prRun: { id: prRun, attestations: prRows.map((r) => r.subject.digest) },
      main: { sha: main, run: { id: c.runId, attempt: c.runAttempt }, artifacts: ports.subjects.map((s) => s.digest) },
      evidence: { bundles: evidence.map((e) => e.digest), store },
    };
    const a = await ports.sign(ports.subjects, MERGE_PREDICATE, predicate);
    merge = { ...a, store };
  }
  const verdict: Verdict =
    t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = broken ? (`broken:${broken}` as const) : "ok";
  const sections = ["header", "tests", "attestations", "chain", "verify"];
  const body = renderMain(c, { main, prInfo, prRun, evidence, jobs, prRows, mainRows, broken, verdict, merge, missing });
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: main,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: `main ${main}: ${missing.length > 0 ? `incomplete: ${missingText(missing)}` : verdict}`, summary: body },
  });
  const why = broken
    ? `merge chain broken at ${broken}`
    : missing.length > 0
      ? `merge not signed: ${missingText(missing)}`
      : `merge not signed: ${verdict}`;
  const line = merge
    ? `**Merged** as \`${main}\` · merge statement signature \`${merge.digest}\` ✅`
    : `**Merged** as \`${main}\` · ❌ ${why}`;
  await upsertComment(c, ports.api, prInfo.number, line, true);
  return { verdict, chain, sections, body, check: conclusion(verdict) };
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
  if (x.fork) out.push(`Fork pull request · run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId})`);
  else
    out.push(
      `Head \`${c.pr!.headSha}\` · built \`${c.pr!.builtRef}\` @ \`${c.pr!.builtSha}\` · run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId}/attempts/${c.runAttempt})`,
    );
  out.push("", ...testsTable(x.evidence, x.jobs), "");
  if (x.fork) {
    out.push("### Attestations", "", "not attested (fork PR); attested on merge", "");
  } else if (x.rows.length > 0 || x.missing.length > 0) out.push(...attestationRows(x.rows, x.missing), "");
  out.push("### Chain", "", "| Check | |", "|---|---|");
  if (x.fork) out.push("| Attestations | not attested (fork PR); attested on merge |");
  else {
    out.push(
      `| Built commit's parents = base \`${x.base}\` + head \`${c.pr!.headSha}\` | ${mark(x.broken !== "built-commit")} |`,
    );
    for (const r of x.rows) {
      out.push(
        `| \`${r.subject.name}\` signature verifies | ${mark(!!r.v && r.v.signature)} |`,
        `| \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "—"}\` = built commit \`${c.pr!.builtSha}\` | ${mark(!!r.v && r.v.sourceCommit === c.pr!.builtSha)} |`,
        `| \`${r.subject.name}\` signer = this repository's workflow at \`${c.pr!.builtRef}\` | ${mark(!!r.v && signerOk(c, r.v.signer, c.pr!.builtRef))} |`,
        keyRow(r),
      );
    }
  }
  if (!x.fork && x.rows.length > 0) out.push(...verifyBlock(x.rows.map((r) => verifyCommand(c, r.subject, "slsaprovenance1"))));
  return out.join("\n");
}

function renderMain(
  c: Context,
  x: {
    main: string;
    prInfo: { number: number; headSha: string; mergeRefSha: string };
    prRun: number;
    evidence: Evidence[];
    jobs: any[];
    prRows: Row[];
    mainRows: Row[];
    broken: Link | null;
    verdict: Verdict;
    merge: { digest: string; store: string } | null;
    missing: Required[];
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
    `Merged PR #${x.prInfo.number} · head \`${x.prInfo.headSha}\` · tested \`${x.prInfo.mergeRefSha}\` · PR run [${x.prRun}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.prRun}) · main run [${c.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${c.runId}/attempts/${c.runAttempt})`,
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
    out.push(`| Evidence stored \`${x.merge.store}\` | ✅ |`, `| Merge statement signature \`${x.merge.digest}\` | ✅ |`);
  if (x.mainRows.length > 0)
    out.push(
      ...verifyBlock(
        x.mainRows.flatMap((r) => [verifyCommand(c, r.subject, "slsaprovenance1"), verifyCommand(c, r.subject, MERGE_PREDICATE)]),
      ),
    );
  return out.join("\n");
}
