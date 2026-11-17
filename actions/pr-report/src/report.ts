// SPEC-PRR-001 — the pull request build report (ADR-0032). The core is a function of its context and its ports:
// every GitHub call goes through `api`, verification through `verify`, evidence storage through `store` and signing
// through `attest`, so the spec drives it with recorded fakes and the Action wires real ones (main.ts).

export const MARKER = "<!-- feat-pr-report -->";
export const MERGE_PREDICATE = "https://feature.mmmnt.dev/attestation/pr-merge/v1";

export type Mode = "pr" | "fork" | "main" | "none";
export type Verdict = "pass" | "fail" | "incomplete";
export type Link = "built-commit" | "signature" | "provenance" | "signer" | "log" | "main-provenance";

export interface Evidence {
  tier: string;
  digest: string; // sha256:<hex> of the bundle file
  bundle: {
    verify?: { status: string };
    run?: { status: string; tests: number; failures: number; errors: number };
    specs?: unknown[];
    runs?: { spec_id: string | null; status: string }[];
  };
}

export interface Subject {
  name: string;
  digest: string; // sha256:<hex>
}

export interface Verification {
  signature: boolean; // signature and certificate chain to the trust root
  sourceCommit: string | null; // provenance source commit
  signer: string | null; // certificate SAN
  issuer: string | null;
  rekorIndex: number | null;
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
  pr?: { number: number; headSha: string; baseSha: string; builtRef: string; builtSha: string };
  mainSha?: string;
  forkRunId?: number; // fork mode: the pull_request run whose uploads are reported
  forkPr?: number;
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
  verify(subject: Subject, bundles: unknown[]): Promise<Verification>;
  findPrRun(pr: { number: number; headSha: string }): Promise<number | null>;
  store(evidence: Evidence[]): Promise<string>; // digest-pinned reference
  attest(subjects: Subject[], predicateType: string, predicate: unknown): Promise<{ digest: string; rekorIndex: number | null }>;
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
  if (!signerOk(c, v.signer, ref) || v.issuer !== "https://token.actions.githubusercontent.com") return "signer";
  if (v.rekorIndex === null) return "log";
  return null;
}

async function jobsOf(c: Context, api: Api, runId: number, attempt: number) {
  const res = await api.get(`${repoPath(c)}/actions/runs/${runId}/attempts/${attempt}/jobs`);
  const jobs: { name: string; conclusion: string | null; html_url?: string }[] = res?.jobs ?? [];
  return jobs.filter((j) => j.name !== c.reportJob);
}

async function verifySubjects(c: Context, ports: Ports, subjects: Subject[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const s of subjects) {
    const res = await ports.api.get(`${repoPath(c)}/attestations/${s.digest}`);
    const bundles: unknown[] = (res?.attestations ?? []).map((a: any) => a.bundle ?? a);
    rows.push({ subject: s, v: bundles.length === 0 ? null : await ports.verify(s, bundles) });
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
  if (!fork) {
    const commit = await ports.api.get(`${repoPath(c)}/commits/${c.pr!.builtSha}`);
    const parents: string[] = (commit?.parents ?? []).map((p: any) => p.sha);
    if (!(parents.length === 2 && parents[0] === c.pr!.baseSha && parents[1] === c.pr!.headSha)) broken = "built-commit";
  }
  const rows = fork ? [] : await verifySubjects(c, ports, ports.subjects);
  if (!broken) for (const r of rows) broken ??= attestationBreak(c, r, c.pr!.builtSha, c.pr!.builtRef);

  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");
  const verdict: Verdict = t.failed || jobsFailed || broken ? "fail" : t.incomplete ? "incomplete" : "pass";
  const chain = fork ? "not-attested" : broken ? (`broken:${broken}` as const) : "ok";
  const sections = ["header", "tests"];
  if (fork || rows.length > 0) sections.push("attestations");
  sections.push("chain");
  if (!fork && rows.length > 0) sections.push("verify");

  const body = renderPr(c, { prNumber, runId, evidence, jobs, rows, broken, verdict, fork });
  await upsertComment(c, ports.api, prNumber, body, false);
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: c.pr!.headSha,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: headline(verdict, prNumber, broken), summary: body },
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
  const prSubjects: Subject[] = (arts?.artifacts ?? [])
    .filter((a: any) => typeof a.digest === "string" && !String(a.name).startsWith("feat-evidence-"))
    .map((a: any) => ({ name: a.name, digest: a.digest }));
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
  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");

  let merge: { digest: string; rekorIndex: number | null; store: string } | null = null;
  if (!broken) {
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
    const a = await ports.attest(ports.subjects, MERGE_PREDICATE, predicate);
    merge = { ...a, store };
  }
  const verdict: Verdict = t.failed || jobsFailed || broken ? "fail" : t.incomplete ? "incomplete" : "pass";
  const chain = broken ? (`broken:${broken}` as const) : "ok";
  const sections = ["header", "tests", "attestations", "chain", "verify"];
  const body = renderMain(c, { main, prInfo, prRun, evidence, jobs, prRows, mainRows, broken, verdict, merge });
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: main,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: `main ${main}: ${verdict}`, summary: body },
  });
  const line = merge
    ? `**Merged** as \`${main}\` · merge attestation \`${merge.digest}\` · Rekor \`${merge.rekorIndex ?? "—"}\` ✅`
    : `**Merged** as \`${main}\` · ❌ merge chain broken at ${broken ?? verdict}`;
  await upsertComment(c, ports.api, prInfo.number, line, true);
  return { verdict, chain, sections, body, check: conclusion(verdict) };
}

// ── rendering: compact, evidential, no prose; digests and SHAs always in full ──

function headline(v: Verdict, pr: number, broken: Link | null): string {
  if (broken) return `PR #${pr}: chain broken at ${broken}`;
  return v === "pass" ? `PR #${pr}: verified` : v === "fail" ? `PR #${pr}: failed` : `PR #${pr}: incomplete`;
}

const mark = (ok: boolean) => (ok ? "✅" : "❌");

function testsTable(evidence: Evidence[], jobs: { conclusion: string | null }[]): string[] {
  const out = ["### Tests", "", "| Tier | Specs | Scenarios | Evidence bundle |", "|---|---|---|---|"];
  for (const e of evidence) {
    const r = e.bundle.run;
    const scen = r ? `${mark(r.status === "pass")} ${r.tests - r.failures - r.errors} / ${r.tests}` : "— no run";
    out.push(`| ${e.tier} | ${(e.bundle.specs ?? []).length} | ${scen} | \`${e.digest}\` |`);
  }
  const ok = jobs.filter((j) => j.conclusion === "success").length;
  out.push(`| CI jobs | — | ${mark(ok === jobs.length)} ${ok} / ${jobs.length} | — |`);
  return out;
}

function attestationRows(rows: Row[]): string[] {
  const out = ["### Attestations", "", "| Artifact | Digest | Signer | Source commit | Rekor | |", "|---|---|---|---|---|---|"];
  for (const r of rows) {
    const v = r.v;
    const signer = v?.signer ? v.signer.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/\.github\/workflows\//, "") : "—";
    out.push(
      `| \`${r.subject.name}\` | \`${r.subject.digest}\` | \`${signer}\` | \`${v?.sourceCommit ?? "—"}\` | \`${v?.rekorIndex ?? "—"}\` | ${mark(!!v && v.signature)} |`,
    );
  }
  return out;
}

function renderPr(
  c: Context,
  x: { prNumber: number; runId: number; evidence: Evidence[]; jobs: any[]; rows: Row[]; broken: Link | null; verdict: Verdict; fork: boolean },
): string {
  const icon = x.verdict === "pass" ? "✅" : x.verdict === "fail" ? "❌" : "⚪";
  const title = x.broken ? `chain broken at ${x.broken}` : x.verdict === "pass" ? "verified" : x.verdict;
  const out = [MARKER, `## ${icon} PR #${x.prNumber} — ${title}`, ""];
  if (x.fork) out.push(`Fork pull request · run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId})`);
  else
    out.push(
      `Head \`${c.pr!.headSha}\` · built \`${c.pr!.builtRef}\` @ \`${c.pr!.builtSha}\` · run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId}/attempts/${c.runAttempt})`,
    );
  out.push("", ...testsTable(x.evidence, x.jobs), "");
  if (x.fork) {
    out.push("### Attestations", "", "not attested (fork PR); attested on merge", "");
  } else if (x.rows.length > 0) out.push(...attestationRows(x.rows), "");
  out.push("### Chain", "", "| Check | |", "|---|---|");
  if (x.fork) out.push("| Attestations | not attested (fork PR); attested on merge |");
  else {
    out.push(
      `| Built commit's parents = base \`${c.pr!.baseSha}\` + head \`${c.pr!.headSha}\` | ${mark(x.broken !== "built-commit")} |`,
    );
    for (const r of x.rows) {
      out.push(`| \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "—"}\` = built commit \`${c.pr!.builtSha}\` | ${mark(!!r.v && r.v.sourceCommit === c.pr!.builtSha)} |`);
      out.push(`| \`${r.subject.name}\` signer = this repository's workflow, issuer GitHub Actions | ${mark(!!r.v && signerOk(c, r.v.signer, c.pr!.builtRef) && r.v.issuer === "https://token.actions.githubusercontent.com")} |`);
      out.push(`| \`${r.subject.name}\` transparency-log entry | ${mark(!!r.v && r.v.rekorIndex !== null)} |`);
    }
  }
  if (!x.fork && x.rows.length > 0) {
    const s = x.rows[0]!.subject;
    out.push(
      "",
      "<details><summary>Verify</summary>",
      "",
      "```sh",
      `gh run download ${x.runId} -R ${c.owner}/${c.repo} -n ${s.name}`,
      `gh attestation verify ${s.name} -R ${c.owner}/${c.repo} \\`,
      `  --signer-workflow ${c.owner}/${c.repo}/${c.signerWorkflows[0]} \\`,
      `  --source-digest ${c.pr!.builtSha}`,
      "```",
      "",
      "</details>",
    );
  }
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
    merge: { digest: string; rekorIndex: number | null; store: string } | null;
  },
): string {
  const icon = x.verdict === "pass" ? "✅" : x.verdict === "fail" ? "❌" : "⚪";
  const out = [MARKER, `## ${icon} main \`${x.main}\` — ${x.broken ? `chain broken at ${x.broken}` : x.verdict === "pass" ? "verified" : x.verdict}`, ""];
  out.push(
    `Merged PR #${x.prInfo.number} · head \`${x.prInfo.headSha}\` · tested \`${x.prInfo.mergeRefSha}\` · PR run [${x.prRun}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.prRun}) · main run [${c.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${c.runId}/attempts/${c.runAttempt})`,
    "",
    ...testsTable(x.evidence, x.jobs),
    "",
    ...attestationRows([...x.prRows, ...x.mainRows]),
    "",
    "### Chain",
    "",
    "| Check | |",
    "|---|---|",
  );
  for (const r of x.prRows) out.push(`| PR \`${r.subject.name}\` source commit = tested \`${x.prInfo.mergeRefSha}\` | ${mark(!!r.v && r.v.sourceCommit === x.prInfo.mergeRefSha)} |`);
  for (const r of x.mainRows) out.push(`| main \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "—"}\` = main \`${x.main}\` | ${mark(!!r.v && r.v.sourceCommit === x.main)} |`);
  if (x.merge)
    out.push(
      `| Evidence stored \`${x.merge.store}\` | ✅ |`,
      `| Merge attestation \`${x.merge.digest}\` · Rekor \`${x.merge.rekorIndex ?? "—"}\` | ✅ |`,
    );
  const s = x.mainRows[0]?.subject;
  if (s)
    out.push(
      "",
      "<details><summary>Verify</summary>",
      "",
      "```sh",
      `gh attestation verify ${s.name} -R ${c.owner}/${c.repo} \\`,
      `  --signer-workflow ${c.owner}/${c.repo}/${c.signerWorkflows[0]} \\`,
      `  --source-ref refs/heads/main --source-digest ${x.main} \\`,
      `  --predicate-type ${MERGE_PREDICATE}`,
      "```",
      "",
      "</details>",
    );
  return out.join("\n");
}
