// Sign mode against what main's first two-run merge really produced (flmnt run 44467992168 at 422960a): the merge
// statement report-main wrote (the merge-statement artifact, as uploaded) and main's feat report check, which recorded
// its digest. Sign mode runs only on a push to main, so these recorded inputs are its only run before main. From
// v0.1.74 sign mode signs every statement under pr-merge/v2 (founder rulings 143df84e, 36125703).
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readStatementFile } from "./inputs.js";
import { runReport, ReportError, type Context, type Ports } from "./report.js";
import { readFileSync } from "node:fs";

const here = path.dirname(new URL(import.meta.url).pathname);
const statementFile = path.join(here, "../fixtures/recorded/main-merge-statement.json");
const checks = JSON.parse(readFileSync(path.join(here, "../fixtures/recorded/main-check-runs.json"), "utf8"));
const MAIN = "422960a047e749062dbab1585685323753a5bad3";

function harness(mainSha: string) {
  const trace: string[] = [];
  const ctx = {
    owner: "mmmnt",
    repo: "flmnt",
    mode: "sign-merge",
    runId: 1,
    runAttempt: 1,
    reportJob: "sign-merge",
    checkName: "feat report",
    signerWorkflows: [".github/workflows/ci.yml"],
    publicKey: "ci/signing/flmnt.pub",
    mainSha,
  } as Context;
  const ports = {
    api: {
      async get(p: string) {
        trace.push(`GET ${p}`);
        if (p === `/repos/mmmnt/flmnt/commits/${mainSha}/check-runs?check_name=feat%20report`) return checks;
        if (p.endsWith("/comments")) return [];
        throw new Error(`unrecorded GET ${p}`);
      },
      async post(p: string) {
        trace.push(`POST ${p}`);
        return {};
      },
      async patch(p: string) {
        trace.push(`PATCH ${p}`);
        return {};
      },
    },
    writable: true,
    subjects: [{ name: "SBOM", digest: "sha256:5be1a64763227a1376bb4108478228a80cdabc23e026fd8b826033c48fda9ffe", repository: "ghcr.io/mmmnt/flmnt-sbom" }],
    async readStatement() {
      return readStatementFile(statementFile);
    },
    async sign(_s: unknown, type: string) {
      trace.push(`SIGN ${type}`);
      return { digest: "sha256:" + "0".repeat(64) };
    },
  } as unknown as Ports;
  return { ctx, ports, trace };
}

describe("sign mode on the statement and check main really produced", () => {
  it("the uploaded statement's digest is the external_id main's check recorded", () => {
    expect(readStatementFile(statementFile).digest).toBe(checks.check_runs[0].external_id);
  });

  it("signs it, then patches main's check and appends to pull request 284's comment", async () => {
    const { ctx, ports, trace } = harness(MAIN);
    const out = await runReport(ctx, ports);
    expect(out.verdict).toBe("pass");
    expect(trace).toEqual([
      `GET /repos/mmmnt/flmnt/commits/${MAIN}/check-runs?check_name=feat%20report`,
      "SIGN https://feature.mmmnt.dev/attestation/pr-merge/v2",
      `PATCH /repos/mmmnt/flmnt/check-runs/${checks.check_runs[0].id}`,
      "GET /repos/mmmnt/flmnt/issues/284/comments",
      "POST /repos/mmmnt/flmnt/issues/284/comments",
    ]);
  });

  it("refuses the same statement for another main commit, signing nothing", async () => {
    const { ctx, ports, trace } = harness("0".repeat(40));
    await expect(runReport(ctx, ports)).rejects.toThrow(ReportError);
    expect(trace.filter((t) => !t.startsWith("GET "))).toEqual([]);
  });
});
