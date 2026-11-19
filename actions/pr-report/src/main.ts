// The Action's entry (ADR-0032): read the run's context, wire the real ports, run the report. GitHub calls use the
// run's token through fetch. Attestations are the consumer's own cosign attestations, stored as OCI referrers in GHCR
// and verified with the pinned cosign against the repository's public key; nothing reads or writes a transparency
// log (decision 13). Main's evidence is pushed to GHCR as a digest-pinned OCI artifact, and the merge-linking
// statement is signed with the consumer's key (secrets passed as inputs, written to a 0600 file, never logged).
import { createHash, createPublicKey } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { attestArgs, ensureCosign, verifyArgs, writeSigningConfig } from "./cosign.js";
import { input as readInput, readStatementFile, signingSecrets } from "./inputs.js";
import {
  runReport,
  DEPENDABOT,
  forkRunOf,
  ReportError,
  type Api,
  type Context,
  type Evidence,
  type Ports,
  type Required,
  type Subject,
  type Verification,
} from "./report.js";

const input = (name: string, fallback = ""): string => readInput(process.env, name, fallback);
const lines = (v: string) => v.split("\n").map((s) => s.trim()).filter(Boolean);
const sha256 = (buf: Buffer | string) => "sha256:" + createHash("sha256").update(buf).digest("hex");
const PROVENANCE = "https://slsa.dev/provenance/v1";
const BUNDLE = "application/vnd.dev.sigstore.bundle.v0.3+json";
const INDEX = "application/vnd.oci.image.index.v1+json";
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";

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

// ── registry (GHCR) ──

function splitRepo(repository: string): { host: string; name: string } {
  const [host = "", ...rest] = repository.toLowerCase().split("/");
  return { host, name: rest.join("/") };
}

const bearers = new Map<string, string>();
async function registryAuth(repository: string, scope: "pull" | "pull,push", token: string): Promise<Record<string, string>> {
  const { host, name } = splitRepo(repository);
  const key = `${host}/${name}:${scope}`;
  if (!bearers.has(key)) {
    const actor = process.env.GITHUB_ACTOR ?? "x";
    const res = await fetch(`https://${host}/token?scope=repository:${name}:${scope}&service=${host}`, {
      headers: { authorization: "Basic " + Buffer.from(`${actor}:${token}`).toString("base64") },
    });
    if (!res.ok) throw new Error(`registry token for ${host}/${name}: ${res.status}`);
    bearers.set(key, ((await res.json()) as any).token as string);
  }
  return { authorization: `Bearer ${bearers.get(key)}` };
}

async function registryGet(repository: string, p: string, accept: string, token: string): Promise<Response> {
  const { host, name } = splitRepo(repository);
  return fetch(`https://${host}/v2/${name}/${p}`, { headers: { ...(await registryAuth(repository, "pull", token)), accept } });
}

// The subject's manifest digest at a tag (the commit the run built), or null when it was not produced. GHCR answers
// 403 DENIED both for a package that does not exist and for one the token cannot read, so a 403 is settled by the
// packages API: no such package is "not produced"; an existing one the registry refused is an error, never hidden.
async function resolveTag(api: Api, repository: string, tag: string, token: string): Promise<string | null> {
  const res = await registryGet(repository, `manifests/${tag}`, `${MANIFEST}, ${INDEX}`, token);
  if (res.status === 404) return null;
  if (res.status === 403) {
    const { name } = splitRepo(repository);
    const [org = "", ...pkg] = name.split("/");
    const p = encodeURIComponent(pkg.join("/"));
    const known =
      (await api.get(`/orgs/${org}/packages/container/${p}`)) ?? (await api.get(`/users/${org}/packages/container/${p}`));
    if (known === null) return null;
    throw new Error(`${repository} exists but the registry refused the token (403); grant the report job packages: read`);
  }
  if (!res.ok) throw new Error(`${repository}:${tag} answered ${res.status}`);
  return res.headers.get("docker-content-digest") ?? sha256(Buffer.from(await res.arrayBuffer()));
}

// The attestations stored as OCI referrers of a digest, as cosign 3 attaches its Sigstore bundles: the referrers API,
// else the referrers tag schema (`sha256-<hex>`), where GHCR, which has no referrers API, keeps them.
async function listReferrers(repository: string, digest: string, token: string): Promise<any[]> {
  let res = await registryGet(repository, `referrers/${digest}`, INDEX, token);
  if (!res.ok) res = await registryGet(repository, `manifests/${digest.replace(":", "-")}`, INDEX, token);
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`referrers of ${repository}@${digest} answered ${res.status}`);
  return (((await res.json()) as any).manifests ?? []).filter((m: any) => m.artifactType === BUNDLE);
}

// cosign 2's classic key signing keeps its DSSE envelopes as the layers of the `sha256-<hex>.att` tag; each layer is
// one attestation, named by its blob's digest.
async function listClassic(repository: string, digest: string, token: string): Promise<any[]> {
  const att = await registryGet(repository, `manifests/${digest.replace(":", "-")}.att`, MANIFEST, token);
  if (att.status === 404) return [];
  if (!att.ok) throw new Error(`the .att tag of ${repository}@${digest} answered ${att.status}`);
  return (((await att.json()) as any).layers ?? []).map((layer: any) => ({ digest: layer.digest, classic: true }));
}

// The DSSE envelope of one attestation: a classic layer's blob is the envelope itself; a bundle referrer's layer
// holds a Sigstore bundle carrying it.
async function bundleOf(repository: string, descriptor: any, token: string): Promise<any | null> {
  if (descriptor.classic) {
    const b = await registryGet(repository, `blobs/${descriptor.digest}`, "application/vnd.dsse.envelope.v1+json", token);
    return b.ok ? { dsseEnvelope: await b.json() } : null;
  }
  const m = await registryGet(repository, `manifests/${descriptor.digest}`, MANIFEST, token);
  if (!m.ok) return null;
  const layer = ((await m.json()) as any).layers?.[0];
  if (!layer) return null;
  const b = await registryGet(repository, `blobs/${layer.digest}`, BUNDLE, token);
  return b.ok ? b.json() : null;
}

// ── cosign ──

function dockerConfig(dir: string, token: string): string {
  const d = path.join(dir, "docker");
  mkdirSync(d, { recursive: true });
  const auth = Buffer.from(`${process.env.GITHUB_ACTOR ?? "x"}:${token}`).toString("base64");
  writeFileSync(path.join(d, "config.json"), JSON.stringify({ auths: { "ghcr.io": { auth } } }), { mode: 0o600 });
  return d;
}

function runCosign(bin: string, args: string[], env: Record<string, string>): { ok: boolean; out: string } {
  const r = spawnSync(bin, args, { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

const fingerprint = (pem: string) => sha256(createPublicKey(pem).export({ type: "spki", format: "der" }) as Buffer);

function statements(out: string): { envelope: any; statement: any }[] {
  const res: { envelope: any; statement: any }[] = [];
  for (const l of out.split("\n").filter((x) => x.trim().startsWith("{"))) {
    try {
      const envelope = JSON.parse(l);
      res.push({ envelope, statement: JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) });
    } catch {
      // not an envelope line
    }
  }
  return res;
}

function signerOf(predicate: any): string | null {
  const w = predicate?.buildDefinition?.externalParameters?.workflow;
  if (!w?.path || !w?.ref || !w?.repository) return null;
  const repo = String(w.repository).replace(/^https:\/\/github\.com\//, "");
  return `https://github.com/${repo}/${w.path}@${w.ref}`;
}

// ── evidence ──

function evidenceFiles(dir: string, prefix: string): { tier: string; package?: string; bytes: Buffer }[] {
  const out: { tier: string; package?: string; bytes: Buffer }[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const sub of entries.sort()) {
    const full = path.join(dir, sub);
    if (!statSync(full).isDirectory() || !sub.startsWith(prefix)) continue;
    const files = readdirSync(full).filter((x) => x.endsWith(".json")).sort();
    // A tier with one bundle per package: each bundle is named by its package (its file name).
    for (const f of files)
      out.push({
        tier: sub.slice(prefix.length),
        ...(files.length > 1 ? { package: f.replace(/\.json$/, "") } : {}),
        bytes: readFileSync(path.join(full, f)),
      });
  }
  return out;
}

const readEvidence = (dir: string, prefix: string): Evidence[] =>
  evidenceFiles(dir, prefix).map((f) => ({
    tier: f.tier,
    ...(f.package ? { package: f.package } : {}),
    digest: sha256(f.bytes),
    bundle: JSON.parse(f.bytes.toString("utf8")),
  }));

async function pushEvidence(repoRef: string, evidence: Evidence[], files: Buffer[], tag: string, token: string): Promise<string> {
  const { host, name } = splitRepo(repoRef);
  const auth = await registryAuth(repoRef, "pull,push", token);
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
  const cfg = await upload(Buffer.from("{}"));
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
      mediaType: MANIFEST,
      artifactType: "application/vnd.feat.evidence.v2+json",
      config: { mediaType: "application/vnd.oci.empty.v1+json", digest: cfg.digest, size: cfg.size },
      layers,
    }),
  );
  const put = await fetch(`https://${host}/v2/${name}/manifests/${tag}`, {
    method: "PUT",
    headers: { ...auth, "content-type": MANIFEST },
    body: manifest,
  });
  if (put.status !== 201) throw new Error(`manifest: ${put.status}`);
  return `${host}/${name}@${sha256(manifest)}`;
}

function downloadArtifact(url: string, token: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "feat-evidence-"));
  const zip = path.join(dir, "a.zip");
  execFileSync("curl", ["-sSfL", "-H", `Authorization: Bearer ${token}`, "-o", zip, url]);
  execFileSync("unzip", ["-q", zip, "-d", dir]);
  return dir;
}

// `SBOM: ghcr.io/<o>/<r>-sbom` → label and repository; `SBOM from build` → a required subject.
const parseSubjects = (v: string) =>
  lines(v).map((l) => {
    const i = l.indexOf(":");
    if (i < 1) throw new Error(`subjects line '${l}' is not '<label>: <OCI repository>'`);
    return { label: l.slice(0, i).trim(), repository: l.slice(i + 1).trim().toLowerCase() };
  });
const parseRequired = (v: string): Required[] =>
  lines(v).map((l) => {
    const m = /^(.+?)\s+from\s+(\S+)$/.exec(l);
    if (!m) throw new Error(`required-subjects line '${l}' is not '<label> from <job>'`);
    return { label: m[1]!, job: m[2]! };
  });

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
    signerWorkflows: lines(input("signer-workflows", ".github/workflows/ci.yml")),
    publicKey: input("public-key", "cosign.pub"),
    required: parseRequired(input("required-subjects")),
  };
  let writable = true;
  ctx.actor = process.env.GITHUB_ACTOR ?? "";
  if (eventName === "pull_request") {
    const pr = event.pull_request;
    ctx.mode = "pr";
    ctx.pr = { number: pr.number, headSha: pr.head.sha, baseSha: pr.base.sha, baseRef: pr.base.ref, builtRef: process.env.GITHUB_REF!, builtSha: process.env.GITHUB_SHA! };
    writable = pr.head.repo?.full_name === `${owner}/${repo}`;
  } else if (eventName === "workflow_run" && event.workflow_run?.event === "pull_request") {
    // the run the follow-up reports; its pull request is resolved by the core (a fork's run lists none)
    const wr = event.workflow_run;
    ctx.mode = "fork";
    ctx.forkRun = forkRunOf(wr);
  } else if (eventName === "push" && process.env.GITHUB_REF === "refs/heads/main") {
    // the sign run is the one handed the statement the report run wrote
    ctx.mode = input("sign-statement") ? "sign-merge" : "main";
    ctx.mainSha = process.env.GITHUB_SHA ?? "";
  }

  const evidenceDir = input("evidence-dir", "evidence");
  const prefix = input("evidence-prefix", "feat-evidence-");
  // Each declared subject is the OCI artifact its producer pushed, tagged with the commit the run built.
  const declared = parseSubjects(input("subjects"));
  const resolve = async (tag: string): Promise<Subject[]> => {
    const out: Subject[] = [];
    for (const d of declared) {
      const digest = await resolveTag(api, d.repository, tag, token);
      if (digest) out.push({ name: d.label, digest, repository: d.repository });
    }
    return out;
  };
  const builtTag = ctx.mode === "main" || ctx.mode === "sign-merge" ? ctx.mainSha! : ctx.mode === "pr" ? ctx.pr!.builtSha : "";
  // a Dependabot run signed nothing (it holds no secrets), so it has no subject to resolve
  const signedPr = ctx.mode === "pr" && ctx.actor !== DEPENDABOT;
  const subjects = signedPr || ctx.mode === "main" || ctx.mode === "sign-merge" ? await resolve(builtTag) : [];

  const work = mkdtempSync(path.join(tmpdir(), "feat-pr-report-"));
  const needsCosign = subjects.length > 0 || ctx.mode === "main" || ctx.mode === "sign-merge";
  const cosign = needsCosign ? await ensureCosign(path.join(process.env.RUNNER_TOOL_CACHE ?? work, "cosign")) : "";
  const cosignEnv = { DOCKER_CONFIG: dockerConfig(work, token) };

  // The trusted key is the one on the base branch for a pull request, so a pull request that swaps the key file is
  // verified with its own key and the key link breaks; on main it is the checkout's.
  const builtKey = existsSync(ctx.publicKey) ? readFileSync(ctx.publicKey, "utf8") : null;
  let trustedKey = builtKey;
  if (ctx.mode === "pr") {
    const res = await api.get(`/repos/${owner}/${repo}/contents/${ctx.publicKey}?ref=${ctx.pr!.baseSha}`);
    trustedKey = res?.content ? Buffer.from(res.content, "base64").toString("utf8") : null;
  }

  async function verifyWith(pem: string, n: string, subject: Subject, refs: any[]) {
    const keyPath = path.join(work, `${n}.pub`);
    writeFileSync(keyPath, pem);
    const r = runCosign(cosign, verifyArgs({ key: keyPath, type: "slsaprovenance1", ref: `${subject.repository}@${subject.digest}` }), cosignEnv);
    if (!r.ok) return null;
    const hit = statements(r.out).find(
      (s) =>
        s.statement.predicateType === PROVENANCE &&
        (s.statement.subject ?? []).some((x: any) => `sha256:${x.digest?.sha256}` === subject.digest),
    );
    if (!hit) return null;
    let signatureDigest: string | null = null;
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
      signer: signerOf(hit.statement.predicate),
    };
  }

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
    async referrers(subject) {
      return listReferrers(subject.repository, subject.digest, token);
    },
    async classic(subject) {
      return listClassic(subject.repository, subject.digest, token);
    },
    async verify(subject, refs): Promise<Verification> {
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
      const hit = (runs?.workflow_runs ?? []).find((r: any) => ctx.signerWorkflows.includes(r.path));
      return hit ? Number(hit.id) : null;
    },
    // The PR run's subjects: the declared repositories at the tested merge commit's tag.
    async prSubjects(_artifacts, mergeRefSha) {
      return resolve(mergeRefSha);
    },
    async store(evidence) {
      const repoRef = input("evidence-repository") || `ghcr.io/${owner}/${repo}-evidence`;
      return pushEvidence(repoRef, evidence, evidenceFiles(evidenceDir, prefix).map((f) => f.bytes), ctx.mainSha!, token);
    },
    // the statement's bytes are the digest's: written once, read back unchanged, signed as they are
    async writeStatement(statement) {
      const bytes = Buffer.from(JSON.stringify(statement));
      const file = path.join(process.env.RUNNER_TEMP ?? work, "merge-statement.json");
      writeFileSync(file, bytes);
      const digest = sha256(bytes);
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `statement=${file}\nstatement-digest=${digest}\n`);
      return { digest };
    },
    async readStatement() {
      return readStatementFile(input("sign-statement"));
    },
    async sign(subjs, predicateType, predicate) {
      const { key: privateKey, password } = signingSecrets(process.env);
      if (!privateKey.trim()) throw new Error("merge mode needs the signing-key input (the repository's cosign private key)");
      const keyPath = path.join(work, "signing.key");
      writeFileSync(keyPath, privateKey, { mode: 0o600 });
      const predPath = path.join(work, "merge-predicate.json");
      writeFileSync(predPath, JSON.stringify(predicate));
      const cfg = writeSigningConfig(work);
      const env = { ...cosignEnv, COSIGN_PASSWORD: password };
      try {
        for (const s of subjs) {
          const ref = `${s.repository}@${s.digest}`;
          const r = runCosign(cosign, attestArgs({ key: keyPath, signingConfig: cfg, type: predicateType, predicate: predPath, ref }), env);
          if (!r.ok) throw new Error(`signing the merge statement for ${s.name} failed`);
        }
      } finally {
        rmSync(keyPath, { force: true });
      }
      const s = subjs[0]!;
      for (const d of await listReferrers(s.repository, s.digest, token)) {
        if (d.annotations?.["dev.sigstore.bundle.predicateType"] !== predicateType) continue;
        const b = await bundleOf(s.repository, d, token);
        const st = b?.dsseEnvelope?.payload ? JSON.parse(Buffer.from(b.dsseEnvelope.payload, "base64").toString("utf8")) : null;
        if (st?.predicate?.main?.sha === ctx.mainSha) return { digest: d.digest as string };
      }
      throw new Error("the signed merge statement is not among the subject's referrers");
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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.log(`::error::${(e as Error).message}`);
  process.exit(1);
});
