import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/main.ts
import { createHash as createHash3, createPublicKey } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, mkdtempSync, readdirSync, readFileSync as readFileSync3, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
import { tmpdir } from "node:os";
import path2 from "node:path";

// src/cosign.ts
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
var COSIGN_VERSION = "v3.1.4";
var COSIGN_SHA256 = {
  "linux-amd64": "424e2c97d0b45fd7a6b608a87f090f35633f4c23ece5f092d48bba11aaf4bbfa",
  "linux-arm64": "ade83b7aac62e131cacfe96d958948b2150cc9efec46a570a2649b8e27dedad2",
  "darwin-amd64": "9d1e4abe2b6be279ed0d2ff706fde1ccd738747c834e3e6d44039c238867334f",
  "darwin-arm64": "9f9b8cd557cf2e5b3df3373a00baa005a86b02391e3e06dd0ce37b3a1533d3a4"
};
var OFFLINE_SIGNING_CONFIG = {
  mediaType: "application/vnd.dev.sigstore.signingconfig.v0.2+json",
  rekorTlogConfig: {},
  tsaConfig: {}
};
var SERVICE_KEYS = ["caUrls", "oidcUrls", "rekorTlogUrls", "tsaUrls"];
function assertOffline(config) {
  for (const k of SERVICE_KEYS) {
    const v = config[k];
    if (Array.isArray(v) ? v.length > 0 : v !== void 0)
      throw new Error(`signing config names ${k}: signing must not reach a transparency log or any other service`);
  }
}
function writeSigningConfig(dir) {
  assertOffline(OFFLINE_SIGNING_CONFIG);
  const p = path.join(dir, "signing-config.json");
  writeFileSync(p, JSON.stringify(OFFLINE_SIGNING_CONFIG));
  return p;
}
function attestArgs(o) {
  assertOffline(JSON.parse(readFileSync(o.signingConfig, "utf8")));
  return ["attest", "--key", o.key, "--signing-config", o.signingConfig, "--type", o.type, "--predicate", o.predicate, "--yes", o.ref];
}
function verifyArgs(o) {
  return ["verify-attestation", "--key", o.key, "--insecure-ignore-tlog", "--type", o.type, "--output", "json", o.ref];
}
function platform() {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  return `${os}-${arch}`;
}
async function ensureCosign(dir) {
  const p = platform();
  const want = COSIGN_SHA256[p];
  if (!want) throw new Error(`no pinned cosign for ${p}`);
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, `cosign-${COSIGN_VERSION}-${p}`);
  if (!existsSync(bin) || createHash("sha256").update(readFileSync(bin)).digest("hex") !== want) {
    const res = await fetch(`https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-${p}`);
    if (!res.ok) throw new Error(`cosign download answered ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== want) throw new Error(`cosign ${COSIGN_VERSION} ${p} digest ${got} is not the pinned ${want}`);
    writeFileSync(bin, bytes);
  }
  chmodSync(bin, 493);
  return bin;
}

// src/inputs.ts
import { createHash as createHash2 } from "node:crypto";
import { readFileSync as readFileSync2 } from "node:fs";
var inputName = (name) => `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
function input(env, name, fallback = "") {
  return (env[inputName(name)] ?? fallback).trim();
}
function rawInput(env, name) {
  return env[inputName(name)] ?? "";
}
function signingSecrets(env) {
  return { key: rawInput(env, "signing-key"), password: rawInput(env, "signing-password") };
}
function readStatementFile(file) {
  const bytes = readFileSync2(file);
  return {
    statement: JSON.parse(bytes.toString("utf8")),
    digest: "sha256:" + createHash2("sha256").update(bytes).digest("hex")
  };
}

// src/report.ts
var MARKER = "<!-- feat-pr-report -->";
var MERGE_PREDICATE = "https://feature.mmmnt.dev/attestation/pr-merge/v1";
var DEPENDABOT = "dependabot[bot]";
var originLabel = (o) => o === "fork" ? "fork" : "Dependabot";
var notAttested = (o) => `not attested (${originLabel(o)} PR); attested on merge`;
var ReportError = class extends Error {
  constructor(code, detail) {
    super(detail);
    this.code = code;
  }
  code;
};
var repoPath = (c) => `/repos/${c.owner}/${c.repo}`;
function signerOk(c, signer, ref) {
  if (!signer) return false;
  return c.signerWorkflows.some((w) => signer === `https://github.com/${c.owner}/${c.repo}/${w}@${ref}`);
}
function attestationBreak(c, row, builtSha, ref) {
  const v = row.v;
  if (!v || !v.signature) return "signature";
  if (v.sourceCommit !== builtSha) return "provenance";
  if (!signerOk(c, v.signer, ref)) return "signer";
  if (!v.key) return "key";
  return null;
}
async function jobsOf(c, api, runId, attempt) {
  const res = await api.get(`${repoPath(c)}/actions/runs/${runId}/attempts/${attempt}/jobs`);
  const jobs = res?.jobs ?? [];
  return jobs.filter(
    (j) => j.name !== c.reportJob && j.name !== c.checkName && (j.status === void 0 || j.status === "completed")
  );
}
async function verifySubjects(c, ports, subjects) {
  const rows = [];
  for (const s of subjects) {
    let refs = await ports.referrers(s);
    if (refs.length === 0) refs = await ports.classic(s);
    rows.push({ subject: s, v: refs.length === 0 ? null : await ports.verify(s, refs) });
  }
  return rows;
}
function testsVerdict(evidence) {
  let failed = false;
  let incomplete = false;
  for (const e of evidence) {
    if (e.bundle.verify?.status && e.bundle.verify.status !== "pass") failed = true;
    if (!e.bundle.run) incomplete = true;
    else if (e.bundle.run.status !== "pass") failed = true;
  }
  return { failed, incomplete };
}
async function upsertComment(c, api, pr, body, append) {
  const comments = await api.get(`${repoPath(c)}/issues/${pr}/comments`) ?? [];
  const mine = comments.find((x) => typeof x.body === "string" && x.body.includes(MARKER));
  if (mine) {
    await api.patch(`${repoPath(c)}/issues/comments/${mine.id}`, { body: append ? `${mine.body}

${body}` : body });
  } else {
    await api.post(`${repoPath(c)}/issues/${pr}/comments`, { body: append ? `${MARKER}
${body}` : body });
  }
}
var missingOf = (c, subjects) => (c.required ?? []).filter((r) => !subjects.some((s) => s.name === r.label));
var conclusion = (v) => v === "pass" ? "success" : v === "fail" ? "failure" : "neutral";
async function runReport(c, ports) {
  if (c.mode === "none") throw new ReportError("NO_PR_CONTEXT", "this run is neither a pull request nor a push to main");
  if (!ports.writable)
    throw new ReportError("INSUFFICIENT_PERMISSIONS", "the token cannot write pull request comments or check runs");
  if (c.mode === "main") return mergeMode(c, ports);
  if (c.mode === "sign-merge") return signMode(c, ports);
  const fork = c.mode === "fork";
  let origin = null;
  let pr = c.pr;
  if (fork) {
    const run = c.forkRun;
    origin = runOrigin(c, run);
    if (!origin)
      throw new ReportError(
        "TRUSTED_RUN",
        `run ${run.id} is from ${run.headRepository}, started by ${run.actor}: it holds the repository's secrets and reports itself`
      );
    pr = await forkPullRequest(c, ports.api, run);
  } else if (c.actor === DEPENDABOT) origin = "dependabot";
  const unattested = origin !== null;
  const prNumber = pr.number;
  const runId = fork ? c.forkRun.id : c.runId;
  const evidence = fork ? await ports.forkEvidence(runId) : await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");
  const jobs = await jobsOf(c, ports.api, runId, fork ? 1 : c.runAttempt);
  let broken = null;
  let base = pr.baseSha;
  if (!fork) {
    const commit = await ports.api.get(`${repoPath(c)}/commits/${c.pr.builtSha}`);
    const parents = (commit?.parents ?? []).map((p) => p.sha);
    if (parents.length === 2 && parents[1] === c.pr.headSha && parents[0] !== base) {
      const cmp = await ports.api.get(`${repoPath(c)}/compare/${encodeURIComponent(c.pr.baseRef)}...${parents[0]}`);
      if (cmp?.status === "identical" || cmp?.status === "behind") base = parents[0];
    }
    if (!(parents.length === 2 && parents[0] === base && parents[1] === c.pr.headSha)) broken = "built-commit";
  }
  const rows = unattested ? [] : await verifySubjects(c, ports, ports.subjects);
  if (!broken) for (const r of rows) broken ??= attestationBreak(c, r, pr.builtSha, pr.builtRef);
  const missing = unattested ? [] : missingOf(c, ports.subjects);
  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");
  const verdict = t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = broken ? `broken:${broken}` : unattested ? "not-attested" : "ok";
  const sections = ["header", "tests"];
  if (unattested || rows.length > 0 || missing.length > 0) sections.push("attestations");
  sections.push("chain");
  if (!unattested && rows.length > 0) sections.push("verify");
  const body = renderPr(c, { pr, prNumber, runId, evidence, jobs, rows, broken, verdict, fork, origin, missing, base });
  await upsertComment(c, ports.api, prNumber, body, false);
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: pr.headSha,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: headline(verdict, prNumber, broken, missing), summary: body },
    // the commit this run built and tested, which the merge run reads back
    ...!fork && pr.builtSha ? { external_id: pr.builtSha } : {}
  });
  return { verdict, chain, sections, body, check: conclusion(verdict) };
}
function forkRunOf(wr) {
  return {
    id: Number(wr.id),
    headSha: String(wr.head_sha ?? ""),
    headBranch: String(wr.head_branch ?? ""),
    headOwner: String(wr.head_repository?.owner?.login ?? ""),
    headRepository: String(wr.head_repository?.full_name ?? ""),
    actor: String(wr.actor?.login ?? ""),
    pullRequests: (wr.pull_requests ?? []).map((p) => ({
      number: Number(p.number),
      baseSha: String(p.base?.sha ?? ""),
      baseRef: String(p.base?.ref ?? "")
    }))
  };
}
function runOrigin(c, run) {
  if (run.headRepository !== `${c.owner}/${c.repo}`) return "fork";
  return run.actor === DEPENDABOT ? "dependabot" : null;
}
function pullOrigin(c, pull) {
  if (pull?.head?.repo?.full_name !== `${c.owner}/${c.repo}`) return "fork";
  return pull?.user?.login === DEPENDABOT ? "dependabot" : null;
}
async function forkPullRequest(c, api, run) {
  const listed = run.pullRequests[0];
  let found = listed;
  if (!found) {
    const head = encodeURIComponent(`${run.headOwner}:${run.headBranch}`);
    const open = await api.get(`${repoPath(c)}/pulls?head=${head}&state=open`) ?? [];
    const hit = open.find((p) => p?.head?.sha === run.headSha);
    if (!hit)
      throw new ReportError(
        "NO_PR_CONTEXT",
        `no open pull request of ${run.headOwner}:${run.headBranch} has head ${run.headSha} (run ${run.id})`
      );
    found = { number: hit.number, baseSha: hit.base?.sha ?? "", baseRef: hit.base?.ref ?? "" };
  }
  return {
    number: found.number,
    headSha: run.headSha,
    baseSha: found.baseSha,
    baseRef: found.baseRef,
    builtRef: `refs/pull/${found.number}/merge`,
    builtSha: ""
  };
}
async function testedMergeRef(c, api, head) {
  const res = await api.get(`${repoPath(c)}/commits/${head}/check-runs?check_name=${encodeURIComponent(c.checkName)}`);
  for (const run of res?.check_runs ?? []) {
    if (typeof run.external_id === "string" && /^[0-9a-f]{40}$/.test(run.external_id)) return run.external_id;
    const built = /built `[^`]+` @ `([0-9a-f]{40})`/.exec(run.output?.summary ?? "");
    if (built) return built[1];
  }
  return null;
}
async function mergeMode(c, ports) {
  const evidence = await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");
  const jobs = await jobsOf(c, ports.api, c.runId, c.runAttempt);
  const main2 = c.mainSha;
  const pulls = await ports.api.get(`${repoPath(c)}/commits/${main2}/pulls`) ?? [];
  const pr = pulls.find((p) => p.merged_at);
  if (!pr) throw new ReportError("NO_PR_FOR_MERGE", `no merged pull request is associated with ${main2}`);
  const origin = pullOrigin(c, pr);
  const mergeRefSha = await testedMergeRef(c, ports.api, pr.head.sha);
  if (!mergeRefSha && !origin)
    throw new ReportError("PR_EVIDENCE_MISSING", `no ${c.checkName} check on #${pr.number}'s head records the commit its run tested`);
  const prInfo = { number: pr.number, headSha: pr.head.sha, mergeRefSha };
  const prRun = await ports.findPrRun({ number: prInfo.number, headSha: prInfo.headSha });
  if (prRun === null && !origin) throw new ReportError("PR_EVIDENCE_MISSING", `no pull request run found for #${prInfo.number}`);
  const arts = prRun === null ? null : await ports.api.get(`${repoPath(c)}/actions/runs/${prRun}/artifacts`);
  const prSubjects = prRun === null || !mergeRefSha ? [] : await ports.prSubjects(arts?.artifacts ?? [], mergeRefSha);
  if (prSubjects.length === 0 && !origin) throw new ReportError("PR_EVIDENCE_MISSING", `run ${prRun} has no attested artifacts`);
  const unattested = prSubjects.length === 0 ? origin : null;
  const prRows = await verifySubjects(c, ports, prSubjects);
  if (prRows.some((r) => r.v === null))
    throw new ReportError("PR_EVIDENCE_MISSING", `run ${prRun}'s attestations cannot be retrieved`);
  const mainRows = await verifySubjects(c, ports, ports.subjects);
  let broken = null;
  for (const r of mainRows) {
    const b = attestationBreak(c, r, main2, "refs/heads/main");
    if (b === "provenance") broken ??= "main-provenance";
    else broken ??= b;
  }
  const missing = missingOf(c, ports.subjects);
  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");
  let merge = null;
  if (!broken && missing.length === 0 && ports.subjects.length > 0) {
    let store;
    try {
      store = await ports.store(evidence);
    } catch (e) {
      throw new ReportError("EVIDENCE_STORE_FAILED", `evidence bundles could not be stored: ${e.message}`);
    }
    const predicate = {
      pullRequest: unattested ? { number: prInfo.number, headSha: prInfo.headSha, mergeRefSha: prInfo.mergeRefSha, attested: false, origin: unattested } : { number: prInfo.number, headSha: prInfo.headSha, mergeRefSha: prInfo.mergeRefSha },
      prRun: { id: prRun, attestations: prRows.map((r) => r.subject.digest) },
      main: { sha: main2, run: { id: c.runId, attempt: c.runAttempt }, artifacts: ports.subjects.map((s) => s.digest) },
      evidence: { bundles: evidence.map((e) => e.digest), store }
    };
    const written = await ports.writeStatement(predicate);
    merge = { statement: written.digest, store };
  }
  const verdict = t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = broken ? `broken:${broken}` : "ok";
  const sections = ["header", "tests", "attestations", "chain", "verify"];
  const body = renderMain(c, { main: main2, prInfo, prRun, evidence, jobs, prRows, mainRows, broken, verdict, merge, missing, unattested });
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: main2,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: `main ${main2}: ${missing.length > 0 ? `incomplete: ${missingText(missing)}` : verdict}`, summary: body },
    ...merge ? { external_id: merge.statement } : {}
  });
  const why = broken ? `merge chain broken at ${broken}` : missing.length > 0 ? `merge not signed: ${missingText(missing)}` : `merge not signed: ${verdict}`;
  const line = merge ? `**Merged** as \`${main2}\` \xB7 merge statement \`${merge.statement}\` \xB7 signature pending (job sign-merge)` : `**Merged** as \`${main2}\` \xB7 \u274C ${why}`;
  await upsertComment(c, ports.api, prInfo.number, line, true);
  return { verdict, chain, sections, body, check: conclusion(verdict) };
}
async function signMode(c, ports) {
  const main2 = c.mainSha;
  const { statement, digest } = await ports.readStatement();
  if (statement?.main?.sha !== main2)
    throw new ReportError("STATEMENT_MISMATCH", `the statement names main ${statement?.main?.sha ?? "none"}, not ${main2}`);
  const runs = await ports.api.get(
    `${repoPath(c)}/commits/${main2}/check-runs?check_name=${encodeURIComponent(c.checkName)}`
  );
  const check = (runs?.check_runs ?? []).find((r) => r.external_id === digest);
  if (!check)
    throw new ReportError("STATEMENT_MISMATCH", `no ${c.checkName} check on ${main2} recorded the statement ${digest}`);
  const signed = await ports.sign(ports.subjects, MERGE_PREDICATE, statement);
  const line = `**Signed** merge statement \`${digest}\` \xB7 signature \`${signed.digest}\` \u2705`;
  await ports.api.patch(`${repoPath(c)}/check-runs/${check.id}`, {
    output: { title: check.output?.title ?? `main ${main2}`, summary: `${check.output?.summary ?? ""}

${line}` }
  });
  await upsertComment(c, ports.api, statement.pullRequest.number, line, true);
  return { verdict: "pass", chain: "ok", sections: [], body: line, check: "success" };
}
var missingText = (m) => m.map((r) => `${r.label} not produced (job ${r.job})`).join(", ");
function headline(v, pr, broken, missing) {
  if (broken) return `PR #${pr}: chain broken at ${broken}`;
  if (v === "incomplete" && missing.length > 0) return `PR #${pr}: incomplete: ${missingText(missing)}`;
  return v === "pass" ? `PR #${pr}: verified` : v === "fail" ? `PR #${pr}: failed` : `PR #${pr}: incomplete`;
}
var mark = (ok) => ok ? "\u2705" : "\u274C";
function testsTable(evidence, jobs) {
  const out = ["### Tests", "", "| Tier | Specs | Scenarios | Evidence bundle |", "|---|---|---|---|"];
  for (const e of evidence) {
    const r = e.bundle.run;
    const scen = r ? `${mark(r.status === "pass")} ${r.tests - r.failures - r.errors} / ${r.tests}` : "\u2014 no run";
    out.push(`| ${e.package ? `${e.tier} \xB7 ${e.package}` : e.tier} | ${(e.bundle.specs ?? []).length} | ${scen} | \`${e.digest}\` |`);
  }
  const ok = jobs.filter((j) => j.conclusion === "success").length;
  out.push(`| CI jobs | \u2014 | ${mark(ok === jobs.length)} ${ok} / ${jobs.length} | \u2014 |`);
  return out;
}
function attestationRows(rows, missing = []) {
  const out = [
    "### Attestations",
    "",
    "| Artifact | Subject digest | Signature | Key | Signer | Source commit | |",
    "|---|---|---|---|---|---|---|"
  ];
  for (const r of rows) {
    const v = r.v;
    const signer = v?.signer ? v.signer.replace(/^https:\/\/github\.com\/[^/]+\/[^/]+\/\.github\/workflows\//, "") : "\u2014";
    out.push(
      `| \`${r.subject.name}\` | \`${r.subject.digest}\` | \`${v?.signatureDigest ?? "\u2014"}\` | \`${v?.keyFingerprint ?? "\u2014"}\` | \`${signer}\` | \`${v?.sourceCommit ?? "\u2014"}\` | ${mark(!!v && v.signature && v.key)} |`
    );
  }
  for (const m of missing) out.push(`| \`${m.label}\` | not produced (job ${m.job}) | \u2014 | \u2014 | \u2014 | \u2014 | \u274C |`);
  return out;
}
var verifyCommand = (c, s, type) => `cosign verify-attestation --key ${c.publicKey} --insecure-ignore-tlog --type ${type} ${s.repository}@${s.digest}`;
function verifyBlock(lines2) {
  return ["", "<details><summary>Verify</summary>", "", "```sh", ...lines2, "```", "", "</details>"];
}
function keyRow(r) {
  return `| \`${r.subject.name}\` signed by the repository's key \`${r.v?.keyFingerprint ?? "\u2014"}\` | ${mark(!!r.v && r.v.signature && r.v.key)} |`;
}
function renderPr(c, x) {
  const short = x.verdict === "incomplete" && x.missing.length > 0;
  const icon = x.verdict === "pass" ? "\u2705" : x.verdict === "fail" || short ? "\u274C" : "\u26AA";
  const title = x.broken ? `chain broken at ${x.broken}` : short ? `incomplete: ${missingText(x.missing)}` : x.verdict === "pass" ? "verified" : x.verdict;
  const out = [MARKER, `## ${icon} PR #${x.prNumber} \u2014 ${title}`, ""];
  const p = x.pr;
  if (x.fork)
    out.push(
      `${x.origin === "fork" ? "Fork" : "Dependabot"} pull request \xB7 head \`${p.headSha}\` \xB7 run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId})`
    );
  else
    out.push(
      `Head \`${p.headSha}\` \xB7 built \`${p.builtRef}\` @ \`${p.builtSha}\` \xB7 run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId}/attempts/${c.runAttempt})`
    );
  out.push("", ...testsTable(x.evidence, x.jobs), "");
  if (x.origin) {
    out.push("### Attestations", "", notAttested(x.origin), "");
  } else if (x.rows.length > 0 || x.missing.length > 0) out.push(...attestationRows(x.rows, x.missing), "");
  out.push("### Chain", "", "| Check | |", "|---|---|");
  if (!x.fork)
    out.push(`| Built commit's parents = base \`${x.base}\` + head \`${p.headSha}\` | ${mark(x.broken !== "built-commit")} |`);
  if (x.origin) out.push(`| Attestations | ${notAttested(x.origin)} |`);
  else
    for (const r of x.rows) {
      out.push(
        `| \`${r.subject.name}\` signature verifies | ${mark(!!r.v && r.v.signature)} |`,
        `| \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "\u2014"}\` = built commit \`${p.builtSha}\` | ${mark(!!r.v && r.v.sourceCommit === p.builtSha)} |`,
        `| \`${r.subject.name}\` signer = this repository's workflow at \`${p.builtRef}\` | ${mark(!!r.v && signerOk(c, r.v.signer, p.builtRef))} |`,
        keyRow(r)
      );
    }
  if (!x.origin && x.rows.length > 0) out.push(...verifyBlock(x.rows.map((r) => verifyCommand(c, r.subject, "slsaprovenance1"))));
  return out.join("\n");
}
function renderMain(c, x) {
  const short = x.verdict === "incomplete" && x.missing.length > 0;
  const icon = x.verdict === "pass" ? "\u2705" : x.verdict === "fail" || short ? "\u274C" : "\u26AA";
  const title = x.broken ? `chain broken at ${x.broken}` : short ? `incomplete: ${missingText(x.missing)}` : x.verdict === "pass" ? "verified" : x.verdict;
  const out = [MARKER, `## ${icon} main \`${x.main}\` \u2014 ${title}`, ""];
  out.push(
    `Merged PR #${x.prInfo.number} \xB7 head \`${x.prInfo.headSha}\` \xB7 tested \`${x.prInfo.mergeRefSha ?? "\u2014"}\` \xB7 PR run ${x.prRun === null ? "\u2014" : `[${x.prRun}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.prRun})`} \xB7 main run [${c.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${c.runId}/attempts/${c.runAttempt})`,
    "",
    ...testsTable(x.evidence, x.jobs),
    "",
    ...attestationRows([...x.prRows, ...x.mainRows], x.missing),
    "",
    "### Chain",
    "",
    "| Check | |",
    "|---|---|"
  );
  if (x.unattested) out.push(`| PR attestations | ${notAttested(x.unattested)} |`);
  for (const r of x.prRows)
    out.push(
      `| PR \`${r.subject.name}\` source commit = tested \`${x.prInfo.mergeRefSha}\` | ${mark(!!r.v && r.v.sourceCommit === x.prInfo.mergeRefSha)} |`
    );
  for (const r of x.mainRows)
    out.push(
      `| main \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "\u2014"}\` = main \`${x.main}\` | ${mark(!!r.v && r.v.sourceCommit === x.main)} |`,
      keyRow(r)
    );
  if (x.merge)
    out.push(
      `| Evidence stored \`${x.merge.store}\` | \u2705 |`,
      `| Merge statement \`${x.merge.statement}\` \xB7 signature pending (job sign-merge) | \u23F3 |`
    );
  if (x.mainRows.length > 0)
    out.push(
      ...verifyBlock(
        x.mainRows.flatMap((r) => [verifyCommand(c, r.subject, "slsaprovenance1"), verifyCommand(c, r.subject, MERGE_PREDICATE)])
      )
    );
  return out.join("\n");
}

// src/main.ts
var input2 = (name, fallback = "") => input(process.env, name, fallback);
var lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
var sha256 = (buf) => "sha256:" + createHash3("sha256").update(buf).digest("hex");
var PROVENANCE = "https://slsa.dev/provenance/v1";
var BUNDLE = "application/vnd.dev.sigstore.bundle.v0.3+json";
var INDEX = "application/vnd.oci.image.index.v1+json";
var MANIFEST = "application/vnd.oci.image.manifest.v1+json";
function makeApi(token) {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const call = async (method, p, body) => {
    const res = await fetch(base + p + (method === "GET" && !p.includes("?") ? "?per_page=100" : ""), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...body ? { "content-type": "application/json" } : {}
      },
      ...body ? { body: JSON.stringify(body) } : {}
    });
    if (res.status === 404 && method === "GET") return null;
    if (res.status === 403 && method !== "GET")
      throw new ReportError("INSUFFICIENT_PERMISSIONS", `${method} ${p} answered 403`);
    if (!res.ok) throw new Error(`${method} ${p} answered ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b), patch: (p, b) => call("PATCH", p, b) };
}
function splitRepo(repository) {
  const [host = "", ...rest] = repository.toLowerCase().split("/");
  return { host, name: rest.join("/") };
}
var bearers = /* @__PURE__ */ new Map();
async function registryAuth(repository, scope, token) {
  const { host, name } = splitRepo(repository);
  const key = `${host}/${name}:${scope}`;
  if (!bearers.has(key)) {
    const actor = process.env.GITHUB_ACTOR ?? "x";
    const res = await fetch(`https://${host}/token?scope=repository:${name}:${scope}&service=${host}`, {
      headers: { authorization: "Basic " + Buffer.from(`${actor}:${token}`).toString("base64") }
    });
    if (!res.ok) throw new Error(`registry token for ${host}/${name}: ${res.status}`);
    bearers.set(key, (await res.json()).token);
  }
  return { authorization: `Bearer ${bearers.get(key)}` };
}
async function registryGet(repository, p, accept, token) {
  const { host, name } = splitRepo(repository);
  return fetch(`https://${host}/v2/${name}/${p}`, { headers: { ...await registryAuth(repository, "pull", token), accept } });
}
async function resolveTag(api, repository, tag, token) {
  const res = await registryGet(repository, `manifests/${tag}`, `${MANIFEST}, ${INDEX}`, token);
  if (res.status === 404) return null;
  if (res.status === 403) {
    const { name } = splitRepo(repository);
    const [org = "", ...pkg] = name.split("/");
    const p = encodeURIComponent(pkg.join("/"));
    const known = await api.get(`/orgs/${org}/packages/container/${p}`) ?? await api.get(`/users/${org}/packages/container/${p}`);
    if (known === null) return null;
    throw new Error(`${repository} exists but the registry refused the token (403); grant the report job packages: read`);
  }
  if (!res.ok) throw new Error(`${repository}:${tag} answered ${res.status}`);
  return res.headers.get("docker-content-digest") ?? sha256(Buffer.from(await res.arrayBuffer()));
}
async function listReferrers(repository, digest, token) {
  let res = await registryGet(repository, `referrers/${digest}`, INDEX, token);
  if (!res.ok) res = await registryGet(repository, `manifests/${digest.replace(":", "-")}`, INDEX, token);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`referrers of ${repository}@${digest} answered ${res.status}`);
  return ((await res.json()).manifests ?? []).filter((m) => m.artifactType === BUNDLE);
}
async function listClassic(repository, digest, token) {
  const att = await registryGet(repository, `manifests/${digest.replace(":", "-")}.att`, MANIFEST, token);
  if (att.status === 404) return [];
  if (!att.ok) throw new Error(`the .att tag of ${repository}@${digest} answered ${att.status}`);
  return ((await att.json()).layers ?? []).map((layer) => ({ digest: layer.digest, classic: true }));
}
async function bundleOf(repository, descriptor, token) {
  if (descriptor.classic) {
    const b2 = await registryGet(repository, `blobs/${descriptor.digest}`, "application/vnd.dsse.envelope.v1+json", token);
    return b2.ok ? { dsseEnvelope: await b2.json() } : null;
  }
  const m = await registryGet(repository, `manifests/${descriptor.digest}`, MANIFEST, token);
  if (!m.ok) return null;
  const layer = (await m.json()).layers?.[0];
  if (!layer) return null;
  const b = await registryGet(repository, `blobs/${layer.digest}`, BUNDLE, token);
  return b.ok ? b.json() : null;
}
function dockerConfig(dir, token) {
  const d = path2.join(dir, "docker");
  mkdirSync2(d, { recursive: true });
  const auth = Buffer.from(`${process.env.GITHUB_ACTOR ?? "x"}:${token}`).toString("base64");
  writeFileSync2(path2.join(d, "config.json"), JSON.stringify({ auths: { "ghcr.io": { auth } } }), { mode: 384 });
  return d;
}
function runCosign(bin, args, env) {
  const r = spawnSync(bin, args, { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}
var fingerprint = (pem) => sha256(createPublicKey(pem).export({ type: "spki", format: "der" }));
function statements(out) {
  const res = [];
  for (const l of out.split("\n").filter((x) => x.trim().startsWith("{"))) {
    try {
      const envelope = JSON.parse(l);
      res.push({ envelope, statement: JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) });
    } catch {
    }
  }
  return res;
}
function signerOf(predicate) {
  const w = predicate?.buildDefinition?.externalParameters?.workflow;
  if (!w?.path || !w?.ref || !w?.repository) return null;
  const repo = String(w.repository).replace(/^https:\/\/github\.com\//, "");
  return `https://github.com/${repo}/${w.path}@${w.ref}`;
}
function evidenceFiles(dir, prefix) {
  const out = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const sub of entries.sort()) {
    const full = path2.join(dir, sub);
    if (!statSync(full).isDirectory() || !sub.startsWith(prefix)) continue;
    const files = readdirSync(full).filter((x) => x.endsWith(".json")).sort();
    for (const f of files)
      out.push({
        tier: sub.slice(prefix.length),
        ...files.length > 1 ? { package: f.replace(/\.json$/, "") } : {},
        bytes: readFileSync3(path2.join(full, f))
      });
  }
  return out;
}
var readEvidence = (dir, prefix) => evidenceFiles(dir, prefix).map((f) => ({
  tier: f.tier,
  ...f.package ? { package: f.package } : {},
  digest: sha256(f.bytes),
  bundle: JSON.parse(f.bytes.toString("utf8"))
}));
async function pushEvidence(repoRef, evidence, files, tag, token) {
  const { host, name } = splitRepo(repoRef);
  const auth = await registryAuth(repoRef, "pull,push", token);
  const upload = async (bytes) => {
    const digest = sha256(bytes);
    const start = await fetch(`https://${host}/v2/${name}/blobs/uploads/`, { method: "POST", headers: auth });
    if (start.status !== 202) throw new Error(`blob upload start: ${start.status}`);
    const loc = new URL(start.headers.get("location"), `https://${host}`);
    loc.searchParams.set("digest", digest);
    const put2 = await fetch(loc, { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream" }, body: bytes });
    if (put2.status !== 201) throw new Error(`blob upload: ${put2.status}`);
    return { digest, size: bytes.length };
  };
  const cfg = await upload(Buffer.from("{}"));
  const layers = [];
  for (let i = 0; i < files.length; i++) {
    const l = await upload(files[i]);
    layers.push({
      mediaType: "application/vnd.feat.evidence.v2+json",
      digest: l.digest,
      size: l.size,
      annotations: { "org.opencontainers.image.title": `feat-evidence-${evidence[i]?.tier ?? i}.json` }
    });
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST,
      artifactType: "application/vnd.feat.evidence.v2+json",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: cfg.digest, size: cfg.size },
      layers
    })
  );
  const put = await fetch(`https://${host}/v2/${name}/manifests/${tag}`, {
    method: "PUT",
    headers: { ...auth, "content-type": MANIFEST },
    body: manifest
  });
  if (put.status !== 201) throw new Error(`manifest: ${put.status}`);
  return `${host}/${name}@${sha256(manifest)}`;
}
function downloadArtifact(url, token) {
  const dir = mkdtempSync(path2.join(tmpdir(), "feat-evidence-"));
  const zip = path2.join(dir, "a.zip");
  execFileSync("curl", ["-sSfL", "-H", `Authorization: Bearer ${token}`, "-o", zip, url]);
  execFileSync("unzip", ["-q", zip, "-d", dir]);
  return dir;
}
var parseSubjects = (v) => lines(v).map((l) => {
  const i = l.indexOf(":");
  if (i < 1) throw new Error(`subjects line '${l}' is not '<label>: <OCI repository>'`);
  return { label: l.slice(0, i).trim(), repository: l.slice(i + 1).trim().toLowerCase() };
});
var parseRequired = (v) => lines(v).map((l) => {
  const m = /^(.+?)\s+from\s+(\S+)$/.exec(l);
  if (!m) throw new Error(`required-subjects line '${l}' is not '<label> from <job>'`);
  return { label: m[1], job: m[2] };
});
async function main() {
  const token = input2("token");
  const event = JSON.parse(readFileSync3(process.env.GITHUB_EVENT_PATH, "utf8"));
  const [owner = "", repo = ""] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
  const eventName = process.env.GITHUB_EVENT_NAME;
  const api = makeApi(token);
  const ctx = {
    owner,
    repo,
    mode: "none",
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    reportJob: input2("report-job", "report"),
    evidencePrefix: input2("evidence-prefix", "feat-evidence-"),
    checkName: input2("check-name", "feat report"),
    signerWorkflows: lines(input2("signer-workflows", ".github/workflows/ci.yml")),
    publicKey: input2("public-key", "cosign.pub"),
    required: parseRequired(input2("required-subjects"))
  };
  let writable = true;
  ctx.actor = process.env.GITHUB_ACTOR ?? "";
  if (eventName === "pull_request") {
    const pr = event.pull_request;
    ctx.mode = "pr";
    ctx.pr = { number: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha, baseRef: pr.base.ref, builtRef: process.env.GITHUB_REF, builtSha: process.env.GITHUB_SHA };
    writable = pr.head.repo?.full_name === `${owner}/${repo}`;
  } else if (eventName === "workflow_run" && event.workflow_run?.event === "pull_request") {
    const wr = event.workflow_run;
    ctx.mode = "fork";
    ctx.forkRun = forkRunOf(wr);
  } else if (eventName === "push" && process.env.GITHUB_REF === "refs/heads/main") {
    ctx.mode = input2("sign-statement") ? "sign-merge" : "main";
    ctx.mainSha = process.env.GITHUB_SHA ?? "";
  }
  const evidenceDir = input2("evidence-dir", "evidence");
  const prefix = input2("evidence-prefix", "feat-evidence-");
  const declared = parseSubjects(input2("subjects"));
  const resolve = async (tag) => {
    const out = [];
    for (const d of declared) {
      const digest = await resolveTag(api, d.repository, tag, token);
      if (digest) out.push({ name: d.label, digest, repository: d.repository });
    }
    return out;
  };
  const builtTag = ctx.mode === "main" || ctx.mode === "sign-merge" ? ctx.mainSha : ctx.mode === "pr" ? ctx.pr.builtSha : "";
  const signedPr = ctx.mode === "pr" && ctx.actor !== DEPENDABOT;
  const subjects = signedPr || ctx.mode === "main" || ctx.mode === "sign-merge" ? await resolve(builtTag) : [];
  const work = mkdtempSync(path2.join(tmpdir(), "feat-pr-report-"));
  const needsCosign = subjects.length > 0 || ctx.mode === "main" || ctx.mode === "sign-merge";
  const cosign = needsCosign ? await ensureCosign(path2.join(process.env.RUNNER_TOOL_CACHE ?? work, "cosign")) : "";
  const cosignEnv = { DOCKER_CONFIG: dockerConfig(work, token) };
  const builtKey = existsSync2(ctx.publicKey) ? readFileSync3(ctx.publicKey, "utf8") : null;
  let trustedKey = builtKey;
  if (ctx.mode === "pr") {
    const res = await api.get(`/repos/${owner}/${repo}/contents/${ctx.publicKey}?ref=${ctx.pr.baseSha}`);
    trustedKey = res?.content ? Buffer.from(res.content, "base64").toString("utf8") : null;
  }
  async function verifyWith(pem, n, subject, refs) {
    const keyPath = path2.join(work, `${n}.pub`);
    writeFileSync2(keyPath, pem);
    const r = runCosign(cosign, verifyArgs({ key: keyPath, type: "slsaprovenance1", ref: `${subject.repository}@${subject.digest}` }), cosignEnv);
    if (!r.ok) return null;
    const hit = statements(r.out).find(
      (s) => s.statement.predicateType === PROVENANCE && (s.statement.subject ?? []).some((x) => `sha256:${x.digest?.sha256}` === subject.digest)
    );
    if (!hit) return null;
    let signatureDigest = null;
    const sig = hit.envelope.signatures?.[0]?.sig;
    for (const d of refs) {
      const b = await bundleOf(subject.repository, d, token);
      if (b?.dsseEnvelope?.signatures?.[0]?.sig === sig) {
        signatureDigest = d.digest;
        break;
      }
    }
    return {
      keyFingerprint: fingerprint(pem),
      signatureDigest,
      sourceCommit: hit.statement.predicate?.buildDefinition?.resolvedDependencies?.[0]?.digest?.gitCommit ?? null,
      signer: signerOf(hit.statement.predicate)
    };
  }
  const ports = {
    api,
    writable,
    async evidence() {
      return readEvidence(evidenceDir, prefix);
    },
    async forkEvidence(runId) {
      const arts = await api.get(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
      const out = [];
      for (const a of (arts?.artifacts ?? []).filter((x) => String(x.name).startsWith(prefix))) {
        const dir = downloadArtifact(a.archive_download_url, token);
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
          const bytes = readFileSync3(path2.join(dir, f));
          out.push({ tier: String(a.name).slice(prefix.length), digest: sha256(bytes), bundle: JSON.parse(bytes.toString("utf8")) });
        }
      }
      return out;
    },
    subjects,
    async referrers(subject) {
      return listReferrers(subject.repository, subject.digest, token);
    },
    async classic(subject) {
      return listClassic(subject.repository, subject.digest, token);
    },
    async verify(subject, refs) {
      if (trustedKey) {
        const v = await verifyWith(trustedKey, "trusted", subject, refs);
        if (v) return { signature: true, key: true, ...v };
      }
      if (builtKey && builtKey !== trustedKey) {
        const v = await verifyWith(builtKey, "built", subject, refs);
        if (v) return { signature: true, key: false, ...v };
      }
      return { signature: false, key: false, keyFingerprint: null, signatureDigest: null, sourceCommit: null, signer: null };
    },
    async findPrRun(pr) {
      const runs = await api.get(`/repos/${owner}/${repo}/actions/runs?head_sha=${pr.headSha}&event=pull_request&status=success&per_page=50`);
      const hit = (runs?.workflow_runs ?? []).find((r) => ctx.signerWorkflows.includes(r.path));
      return hit ? Number(hit.id) : null;
    },
    // The PR run's subjects: the declared repositories at the tested merge commit's tag.
    async prSubjects(_artifacts, mergeRefSha) {
      return resolve(mergeRefSha);
    },
    async store(evidence) {
      const repoRef = input2("evidence-repository") || `ghcr.io/${owner}/${repo}-evidence`;
      return pushEvidence(repoRef, evidence, evidenceFiles(evidenceDir, prefix).map((f) => f.bytes), ctx.mainSha, token);
    },
    // the statement's bytes are the digest's: written once, read back unchanged, signed as they are
    async writeStatement(statement) {
      const bytes = Buffer.from(JSON.stringify(statement));
      const file = path2.join(process.env.RUNNER_TEMP ?? work, "merge-statement.json");
      writeFileSync2(file, bytes);
      const digest = sha256(bytes);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `statement=${file}
statement-digest=${digest}
`);
      return { digest };
    },
    async readStatement() {
      return readStatementFile(input2("sign-statement"));
    },
    async sign(subjs, predicateType, predicate) {
      const { key: privateKey, password } = signingSecrets(process.env);
      if (!privateKey.trim()) throw new Error("merge mode needs the signing-key input (the repository's cosign private key)");
      const keyPath = path2.join(work, "signing.key");
      writeFileSync2(keyPath, privateKey, { mode: 384 });
      const predPath = path2.join(work, "merge-predicate.json");
      writeFileSync2(predPath, JSON.stringify(predicate));
      const cfg = writeSigningConfig(work);
      const env = { ...cosignEnv, COSIGN_PASSWORD: password };
      try {
        for (const s2 of subjs) {
          const ref = `${s2.repository}@${s2.digest}`;
          const r = runCosign(cosign, attestArgs({ key: keyPath, signingConfig: cfg, type: predicateType, predicate: predPath, ref }), env);
          if (!r.ok) throw new Error(`signing the merge statement for ${s2.name} failed`);
        }
      } finally {
        rmSync(keyPath, { force: true });
      }
      const s = subjs[0];
      for (const d of await listReferrers(s.repository, s.digest, token)) {
        if (d.annotations?.["dev.sigstore.bundle.predicateType"] !== predicateType) continue;
        const b = await bundleOf(s.repository, d, token);
        const st = b?.dsseEnvelope?.payload ? JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString("utf8")) : null;
        if (st?.predicate?.main?.sha === ctx.mainSha) return { digest: d.digest };
      }
      throw new Error("the signed merge statement is not among the subject's referrers");
    }
  };
  try {
    const out = await runReport(ctx, ports);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.body + "\n");
    console.log(`feat report: verdict ${out.verdict}, chain ${out.chain}`);
  } catch (e) {
    if (e instanceof ReportError) {
      console.log(`::error title=${e.code}::${e.message}`);
      process.exit(1);
    }
    throw e;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
main().catch((e) => {
  console.log(`::error::${e.message}`);
  process.exit(1);
});
