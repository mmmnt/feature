// The Action's entry (ADR-0032): read the run's context, wire the real ports, run the report. GitHub calls use the
// run's token through fetch; attestations are verified with sigstore against the public-good trust root; main's
// evidence is pushed to GHCR as a digest-pinned OCI artifact; the merge-linking attestation is signed with
// @actions/attest (Sigstore, Rekor-logged, stored in the repository's attestations).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verify as sigstoreVerify } from "sigstore";
import { attest } from "@actions/attest";
import { runReport, ReportError, type Api, type Context, type Evidence, type Ports, type Subject, type Verification } from "./report.js";

const input = (name: string, fallback = ""): string => (process.env[`INPUT_${name.toUpperCase()}`] ?? fallback).trim();
const sha256 = (buf: Buffer | string) => "sha256:" + createHash("sha256").update(buf).digest("hex");
const ISSUER = "https://token.actions.githubusercontent.com";

function makeApi(token: string): Api {
  const base = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const call = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(base + p + (method === "GET" && !p.includes("?") ? "?per_page=100" : ""), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404 && method === "GET") return null;
    if (res.status === 403 && method !== "GET")
      throw new ReportError("INSUFFICIENT_PERMISSIONS", `${method} ${p} answered 403`);
    if (!res.ok) throw new Error(`${method} ${p} answered ${res.status}: ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  return { get: (p) => call("GET", p), post: (p, b) => call("POST", p, b), patch: (p, b) => call("PATCH", p, b) };
}

function readEvidence(dir: string, prefix: string): Evidence[] {
  const out: Evidence[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const sub of entries.sort()) {
    const full = path.join(dir, sub);
    if (!statSync(full).isDirectory() || !sub.startsWith(prefix)) continue;
    for (const f of readdirSync(full).filter((x) => x.endsWith(".json")).sort()) {
      const bytes = readFileSync(path.join(full, f));
      out.push({ tier: sub.slice(prefix.length), digest: sha256(bytes), bundle: JSON.parse(bytes.toString("utf8")) });
    }
  }
  return out;
}

async function verifyOne(subject: Subject, bundles: unknown[]): Promise<Verification> {
  let best: Verification = { signature: false, sourceCommit: null, signer: null, issuer: null, rekorIndex: null };
  for (const b of bundles as any[]) {
    try {
      const statement = JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString("utf8"));
      const matches = (statement.subject ?? []).some((s: any) => `sha256:${s.digest?.sha256}` === subject.digest);
      if (!matches) continue;
      const signer: any = await sigstoreVerify(b);
      const dep = statement.predicate?.buildDefinition?.resolvedDependencies?.[0];
      const entry = b.verificationMaterial?.tlogEntries?.[0];
      return {
        signature: true,
        sourceCommit: dep?.digest?.gitCommit ?? null,
        signer: signer?.identity?.subjectAlternativeName ?? null,
        issuer: signer?.identity?.extensions?.issuer ?? null,
        rekorIndex: entry?.logIndex !== undefined ? Number(entry.logIndex) : null,
      };
    } catch {
      best = { ...best, signature: false };
    }
  }
  return best;
}

async function pushEvidence(repoRef: string, evidence: Evidence[], files: Buffer[], tag: string, token: string): Promise<string> {
  // repoRef: ghcr.io/<owner>/<name>
  const [host, ...rest] = repoRef.split("/");
  const name = rest.join("/");
  const actor = process.env.GITHUB_ACTOR ?? "x";
  const tokRes = await fetch(`https://${host}/token?scope=repository:${name}:pull,push&service=${host}`, {
    headers: { authorization: "Basic " + Buffer.from(`${actor}:${token}`).toString("base64") },
  });
  if (!tokRes.ok) throw new Error(`registry token: ${tokRes.status}`);
  const bearer = ((await tokRes.json()) as any).token as string;
  const auth = { authorization: `Bearer ${bearer}` };
  const upload = async (bytes: Buffer) => {
    const digest = sha256(bytes);
    const start = await fetch(`https://${host}/v2/${name}/blobs/uploads/`, { method: "POST", headers: auth });
    if (start.status !== 202) throw new Error(`blob upload start: ${start.status}`);
    const loc = new URL(start.headers.get("location")!, `https://${host}`);
    loc.searchParams.set("digest", digest);
    const put = await fetch(loc, { method: "PUT", headers: { ...auth, "content-type": "application/octet-stream" }, body: bytes });
    if (put.status !== 201) throw new Error(`blob upload: ${put.status}`);
    return { digest, size: bytes.length };
  };
  const config = Buffer.from("{}");
  const cfg = await upload(config);
  const layers = [];
  for (let i = 0; i < files.length; i++) {
    const l = await upload(files[i]!);
    layers.push({
      mediaType: "application/vnd.feat.evidence.v2+json",
      digest: l.digest,
      size: l.size,
      annotations: { "org.opencontainers.image.title": `feat-evidence-${evidence[i]?.tier ?? i}.json` },
    });
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      artifactType: "application/vnd.feat.evidence.v2+json",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: cfg.digest, size: cfg.size },
      layers,
    }),
  );
  const put = await fetch(`https://${host}/v2/${name}/manifests/${tag}`, {
    method: "PUT",
    headers: { ...auth, "content-type": "application/vnd.oci.image.manifest.v1+json" },
    body: manifest,
  });
  if (put.status !== 201) throw new Error(`manifest: ${put.status}`);
  return `${repoRef}@${sha256(manifest)}`;
}

function downloadArtifact(url: string, token: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feat-evidence-"));
  const zip = path.join(dir, "a.zip");
  execFileSync("curl", ["-sSfL", "-H", `Authorization: Bearer ${token}`, "-o", zip, url]);
  execFileSync("unzip", ["-q", zip, "-d", dir]);
  return dir;
}

async function main() {
  const token = input("token");
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH!, "utf8"));
  const [owner = "", repo = ""] = (process.env.GITHUB_REPOSITORY ?? "/").split("/");
  const eventName = process.env.GITHUB_EVENT_NAME;
  const api = makeApi(token);
  const ctx: Context = {
    owner,
    repo,
    mode: "none",
    runId: Number(process.env.GITHUB_RUN_ID),
    runAttempt: Number(process.env.GITHUB_RUN_ATTEMPT ?? 1),
    reportJob: input("report-job", "report"),
    evidencePrefix: input("evidence-prefix", "feat-evidence-"),
    checkName: input("check-name", "feat report"),
    signerWorkflows: input("signer-workflows", ".github/workflows/ci.yml").split("\n").map((s) => s.trim()).filter(Boolean),
  };
  let writable = true;
  if (eventName === "pull_request") {
    const pr = event.pull_request;
    ctx.mode = "pr";
    ctx.pr = { number: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha, builtRef: process.env.GITHUB_REF!, builtSha: process.env.GITHUB_SHA! };
    writable = pr.head.repo?.full_name === `${owner}/${repo}`;
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
  const subjects: Subject[] = input("subjects")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => ({ name: path.basename(p), digest: sha256(readFileSync(p)) }));

  const ports: Ports = {
    api,
    writable,
    async evidence() {
      return readEvidence(evidenceDir, prefix);
    },
    async forkEvidence(runId) {
      const arts = await api.get(`/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`);
      const out: Evidence[] = [];
      for (const a of (arts?.artifacts ?? []).filter((x: any) => String(x.name).startsWith(prefix))) {
        const dir = downloadArtifact(a.archive_download_url, token);
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
          const bytes = readFileSync(path.join(dir, f));
          out.push({ tier: String(a.name).slice(prefix.length), digest: sha256(bytes), bundle: JSON.parse(bytes.toString("utf8")) });
        }
      }
      return out;
    },
    subjects,
    verify: verifyOne,
    async findPrRun(pr) {
      const runs = await api.get(`/repos/${owner}/${repo}/actions/runs?head_sha=${pr.headSha}&event=pull_request&status=success&per_page=50`);
      const hit = (runs?.workflow_runs ?? []).find((r: any) => ctx.signerWorkflows.includes(r.path));
      return hit ? Number(hit.id) : null;
    },
    async store(evidence) {
      const repoRef = input("evidence-repository") || `ghcr.io/${owner}/${repo}-evidence`;
      const files = readEvidenceFiles(evidenceDir, prefix);
      return pushEvidence(repoRef.toLowerCase(), evidence, files, ctx.mainSha!, token);
    },
    async attest(subjs, predicateType, predicate) {
      const res: any = await attest({
        subjects: subjs.map((s) => ({ name: s.name, digest: { sha256: s.digest.replace(/^sha256:/, "") } })),
        predicateType,
        predicate: predicate as Record<string, unknown>,
        token,
      });
      const entry = res.bundle?.verificationMaterial?.tlogEntries?.[0];
      return { digest: sha256(JSON.stringify(res.bundle)), rekorIndex: entry?.logIndex !== undefined ? Number(entry.logIndex) : null };
    },
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
  }
}

function readEvidenceFiles(dir: string, prefix: string): Buffer[] {
  const out: Buffer[] = [];
  for (const sub of readdirSync(dir).sort()) {
    const full = path.join(dir, sub);
    if (!statSync(full).isDirectory() || !sub.startsWith(prefix)) continue;
    for (const f of readdirSync(full).filter((x) => x.endsWith(".json")).sort()) out.push(readFileSync(path.join(full, f)));
  }
  return out;
}

main().catch((e) => {
  console.log(`::error::${(e as Error).message}`);
  process.exit(1);
});
