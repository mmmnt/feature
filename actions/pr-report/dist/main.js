import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);

// src/main.ts
import { createHash as createHash2, createPublicKey } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, mkdtempSync, readdirSync, readFileSync as readFileSync2, rmSync, statSync, writeFileSync as writeFileSync2 } from "node:fs";
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

// src/report.ts
var MARKER = "<!-- feat-pr-report -->";
var MERGE_PREDICATE = "https://feature.mmmnt.dev/attestation/pr-merge/v1";
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
    const refs = await ports.referrers(s);
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
  const fork = c.mode === "fork";
  const prNumber = fork ? c.forkPr : c.pr.number;
  const runId = fork ? c.forkRunId : c.runId;
  const evidence = fork ? await ports.forkEvidence(runId) : await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");
  const jobs = await jobsOf(c, ports.api, runId, fork ? 1 : c.runAttempt);
  let broken = null;
  if (!fork) {
    const commit = await ports.api.get(`${repoPath(c)}/commits/${c.pr.builtSha}`);
    const parents = (commit?.parents ?? []).map((p) => p.sha);
    if (!(parents.length === 2 && parents[0] === c.pr.baseSha && parents[1] === c.pr.headSha)) broken = "built-commit";
  }
  const rows = fork ? [] : await verifySubjects(c, ports, ports.subjects);
  if (!broken) for (const r of rows) broken ??= attestationBreak(c, r, c.pr.builtSha, c.pr.builtRef);
  const missing = fork ? [] : missingOf(c, ports.subjects);
  const t = testsVerdict(evidence);
  const jobsFailed = jobs.some((j) => j.conclusion !== "success");
  const verdict = t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = fork ? "not-attested" : broken ? `broken:${broken}` : "ok";
  const sections = ["header", "tests"];
  if (fork || rows.length > 0 || missing.length > 0) sections.push("attestations");
  sections.push("chain");
  if (!fork && rows.length > 0) sections.push("verify");
  const body = renderPr(c, { prNumber, runId, evidence, jobs, rows, broken, verdict, fork, missing });
  await upsertComment(c, ports.api, prNumber, body, false);
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: c.pr.headSha,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: headline(verdict, prNumber, broken, missing), summary: body }
  });
  return { verdict, chain, sections, body, check: conclusion(verdict) };
}
async function mergeMode(c, ports) {
  const evidence = await ports.evidence();
  if (evidence.length === 0) throw new ReportError("NO_EVIDENCE", "no feat evidence bundle was uploaded");
  const jobs = await jobsOf(c, ports.api, c.runId, c.runAttempt);
  const main2 = c.mainSha;
  const pulls = await ports.api.get(`${repoPath(c)}/commits/${main2}/pulls`) ?? [];
  const pr = pulls.find((p) => p.merged_at);
  if (!pr) throw new ReportError("NO_PR_FOR_MERGE", `no merged pull request is associated with ${main2}`);
  const prInfo = { number: pr.number, headSha: pr.head.sha, mergeRefSha: pr.merge_ref_sha };
  const prRun = await ports.findPrRun({ number: prInfo.number, headSha: prInfo.headSha });
  if (prRun === null) throw new ReportError("PR_EVIDENCE_MISSING", `no pull request run found for #${prInfo.number}`);
  const arts = await ports.api.get(`${repoPath(c)}/actions/runs/${prRun}/artifacts`);
  const prSubjects = await ports.prSubjects(arts?.artifacts ?? [], prInfo.mergeRefSha);
  if (prSubjects.length === 0) throw new ReportError("PR_EVIDENCE_MISSING", `run ${prRun} has no attested artifacts`);
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
      pullRequest: { number: prInfo.number, headSha: prInfo.headSha, mergeRefSha: prInfo.mergeRefSha },
      prRun: { id: prRun, attestations: prRows.map((r) => r.subject.digest) },
      main: { sha: main2, run: { id: c.runId, attempt: c.runAttempt }, artifacts: ports.subjects.map((s) => s.digest) },
      evidence: { bundles: evidence.map((e) => e.digest), store }
    };
    const a = await ports.sign(ports.subjects, MERGE_PREDICATE, predicate);
    merge = { ...a, store };
  }
  const verdict = t.failed || jobsFailed || broken ? "fail" : t.incomplete || missing.length > 0 ? "incomplete" : "pass";
  const chain = broken ? `broken:${broken}` : "ok";
  const sections = ["header", "tests", "attestations", "chain", "verify"];
  const body = renderMain(c, { main: main2, prInfo, prRun, evidence, jobs, prRows, mainRows, broken, verdict, merge, missing });
  await ports.api.post(`${repoPath(c)}/check-runs`, {
    name: c.checkName,
    head_sha: main2,
    status: "completed",
    conclusion: conclusion(verdict),
    output: { title: `main ${main2}: ${missing.length > 0 ? `incomplete: ${missingText(missing)}` : verdict}`, summary: body }
  });
  const why = broken ? `merge chain broken at ${broken}` : missing.length > 0 ? `merge not signed: ${missingText(missing)}` : `merge not signed: ${verdict}`;
  const line = merge ? `**Merged** as \`${main2}\` \xB7 merge statement signature \`${merge.digest}\` \u2705` : `**Merged** as \`${main2}\` \xB7 \u274C ${why}`;
  await upsertComment(c, ports.api, prInfo.number, line, true);
  return { verdict, chain, sections, body, check: conclusion(verdict) };
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
    out.push(`| ${e.tier} | ${(e.bundle.specs ?? []).length} | ${scen} | \`${e.digest}\` |`);
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
  if (x.fork) out.push(`Fork pull request \xB7 run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId})`);
  else
    out.push(
      `Head \`${c.pr.headSha}\` \xB7 built \`${c.pr.builtRef}\` @ \`${c.pr.builtSha}\` \xB7 run [${x.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.runId}/attempts/${c.runAttempt})`
    );
  out.push("", ...testsTable(x.evidence, x.jobs), "");
  if (x.fork) {
    out.push("### Attestations", "", "not attested (fork PR); attested on merge", "");
  } else if (x.rows.length > 0 || x.missing.length > 0) out.push(...attestationRows(x.rows, x.missing), "");
  out.push("### Chain", "", "| Check | |", "|---|---|");
  if (x.fork) out.push("| Attestations | not attested (fork PR); attested on merge |");
  else {
    out.push(
      `| Built commit's parents = base \`${c.pr.baseSha}\` + head \`${c.pr.headSha}\` | ${mark(x.broken !== "built-commit")} |`
    );
    for (const r of x.rows) {
      out.push(
        `| \`${r.subject.name}\` signature verifies | ${mark(!!r.v && r.v.signature)} |`,
        `| \`${r.subject.name}\` source commit \`${r.v?.sourceCommit ?? "\u2014"}\` = built commit \`${c.pr.builtSha}\` | ${mark(!!r.v && r.v.sourceCommit === c.pr.builtSha)} |`,
        `| \`${r.subject.name}\` signer = this repository's workflow at \`${c.pr.builtRef}\` | ${mark(!!r.v && signerOk(c, r.v.signer, c.pr.builtRef))} |`,
        keyRow(r)
      );
    }
  }
  if (!x.fork && x.rows.length > 0) out.push(...verifyBlock(x.rows.map((r) => verifyCommand(c, r.subject, "slsaprovenance1"))));
  return out.join("\n");
}
function renderMain(c, x) {
  const short = x.verdict === "incomplete" && x.missing.length > 0;
  const icon = x.verdict === "pass" ? "\u2705" : x.verdict === "fail" || short ? "\u274C" : "\u26AA";
  const title = x.broken ? `chain broken at ${x.broken}` : short ? `incomplete: ${missingText(x.missing)}` : x.verdict === "pass" ? "verified" : x.verdict;
  const out = [MARKER, `## ${icon} main \`${x.main}\` \u2014 ${title}`, ""];
  out.push(
    `Merged PR #${x.prInfo.number} \xB7 head \`${x.prInfo.headSha}\` \xB7 tested \`${x.prInfo.mergeRefSha}\` \xB7 PR run [${x.prRun}](https://github.com/${c.owner}/${c.repo}/actions/runs/${x.prRun}) \xB7 main run [${c.runId}](https://github.com/${c.owner}/${c.repo}/actions/runs/${c.runId}/attempts/${c.runAttempt})`,
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
    out.push(`| Evidence stored \`${x.merge.store}\` | \u2705 |`, `| Merge statement signature \`${x.merge.digest}\` | \u2705 |`);
  if (x.mainRows.length > 0)
    out.push(
      ...verifyBlock(
        x.mainRows.flatMap((r) => [verifyCommand(c, r.subject, "slsaprovenance1"), verifyCommand(c, r.subject, MERGE_PREDICATE)])
      )
    );
  return out.join("\n");
}

// src/main.ts
var input = (name, fallback = "") => (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
var lines = (v) => v.split("\n").map((s) => s.trim()).filter(Boolean);
var sha256 = (buf) => "sha256:" + createHash2("sha256").update(buf).digest("hex");
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
  const index = await res.json();
  return (index.manifests ?? []).filter((m) => m.artifactType === BUNDLE);
}
async function bundleOf(repository, descriptor, token) {
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
        tier: files.length > 1 ? `${sub.slice(prefix.length)} \xB7 ${f.replace(/\.json$/, "")}` : sub.slice(prefix.length),
        bytes: readFileSync2(path2.join(full, f))
      });
  }
  return out;
}
var readEvidence = (dir, prefix) => evidenceFiles(dir, prefix).map((f) => ({ tier: f.tier, digest: sha256(f.bytes), bundle: JSON.parse(f.bytes.toString("utf8")) }));
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
  const token = input("token");
  const event = JSON.parse(readFileSync2(process.env.GITHUB_EVENT_PATH, "utf8"));
  const [owner = "", repo = ""] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
  const eventName = process.env.GITHUB_EVENT_NAME;
  const api = makeApi(token);
  const ctx = {
    owner,
    repo,
    mode: "none",
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    reportJob: input("report-job", "report"),
    evidencePrefix: input("evidence-prefix", "feat-evidence-"),
    checkName: input("check-name", "feat report"),
    signerWorkflows: lines(input("signer-workflows", ".github/workflows/ci.yml")),
    publicKey: input("public-key", "cosign.pub"),
    required: parseRequired(input("required-subjects"))
  };
  let writable = true;
  if (eventName === "pull_request") {
    const pr = event.pull_request;
    ctx.mode = "pr";
    ctx.pr = { number: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha, builtRef: process.env.GITHUB_REF, builtSha: process.env.GITHUB_SHA };
    writable = pr.head.repo?.full_name === `${owner}/${repo}`;
    const built = await api.get(`/repos/${owner}/${repo}/commits/${ctx.pr.builtSha}`);
    const first = built?.parents?.[0]?.sha;
    if (first && first !== ctx.pr.baseSha) {
      const cmp = await api.get(`/repos/${owner}/${repo}/compare/${encodeURIComponent(pr.base.ref)}...${first}`);
      if (cmp && (cmp.status === "identical" || cmp.status === "behind")) ctx.pr.baseSha = first;
    }
  } else if (eventName === "workflow_run" && event.workflow_run?.event === "pull_request") {
    const wr = event.workflow_run;
    const pr = wr.pull_requests?.[0];
    ctx.mode = pr ? "fork" : "none";
    ctx.forkRunId = wr.id;
    ctx.forkPr = pr?.number;
    if (pr) ctx.pr = { number: pr.number, headSha: wr.head_sha, baseSha: pr.base?.sha ?? "", builtRef: `refs/pull/${pr.number}/merge`, builtSha: "" };
  } else if (eventName === "push" && process.env.GITHUB_REF === "refs/heads/main") {
    ctx.mode = "main";
    ctx.mainSha = process.env.GITHUB_SHA ?? "";
  }
  const evidenceDir = input("evidence-dir", "evidence");
  const prefix = input("evidence-prefix", "feat-evidence-");
  const declared = parseSubjects(input("subjects"));
  const resolve = async (tag) => {
    const out = [];
    for (const d of declared) {
      const digest = await resolveTag(api, d.repository, tag, token);
      if (digest) out.push({ name: d.label, digest, repository: d.repository });
    }
    return out;
  };
  const builtTag = ctx.mode === "main" ? ctx.mainSha : ctx.mode === "pr" ? ctx.pr.builtSha : "";
  const subjects = ctx.mode === "pr" || ctx.mode === "main" ? await resolve(builtTag) : [];
  const work = mkdtempSync(path2.join(tmpdir(), "feat-pr-report-"));
  const needsCosign = subjects.length > 0 || ctx.mode === "main";
  const cosign = needsCosign ? await ensureCosign(path2.join(process.env.RUNNER_TOOL_CACHE ?? work, "cosign")) : "";
  const cosignEnv = { DOCKER_CONFIG: dockerConfig(work, token) };
  const builtKey = existsSync2(ctx.publicKey) ? readFileSync2(ctx.publicKey, "utf8") : null;
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
          const bytes = readFileSync2(path2.join(dir, f));
          out.push({ tier: String(a.name).slice(prefix.length), digest: sha256(bytes), bundle: JSON.parse(bytes.toString("utf8")) });
        }
      }
      return out;
    },
    subjects,
    async referrers(subject) {
      return listReferrers(subject.repository, subject.digest, token);
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
      const repoRef = input("evidence-repository") || `ghcr.io/${owner}/${repo}-evidence`;
      return pushEvidence(repoRef, evidence, evidenceFiles(evidenceDir, prefix).map((f) => f.bytes), ctx.mainSha, token);
    },
    async sign(subjs, predicateType, predicate) {
      const privateKey = process.env.INPUT_SIGNING_KEY ?? "";
      if (!privateKey.trim()) throw new Error("merge mode needs the signing-key input (the repository's cosign private key)");
      const keyPath = path2.join(work, "signing.key");
      writeFileSync2(keyPath, privateKey, { mode: 384 });
      const predPath = path2.join(work, "merge-predicate.json");
      writeFileSync2(predPath, JSON.stringify(predicate));
      const cfg = writeSigningConfig(work);
      const env = { ...cosignEnv, COSIGN_PASSWORD: process.env.INPUT_SIGNING_PASSWORD ?? "" };
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
