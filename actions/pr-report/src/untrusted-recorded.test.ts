// The fork follow-up (founder 2026-11-19, flmnt f60f6956) against GitHub's recorded responses (fixtures/recorded,
// trimmed to the fields read): a pull request run from this repository on flmnt (run 44513162056, #289) and its open
// pull request, and a merged pull request a person opened. Hand-written fixtures invented API fields twice before;
// these are what GitHub answered.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { forkPullRequest, forkRunOf, isForkPull, isForkRun, ReportError, type Api, type Context } from "./report.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const recorded = (name: string) => JSON.parse(readFileSync(path.join(here, "../fixtures/recorded", name), "utf8"));
const ctx = { owner: "mmmnt", repo: "flmnt" } as Context;
const api = (answers: Record<string, unknown>): Api => ({
  async get(p) {
    if (!(p in answers)) throw new Error(`unrecorded GET ${p}`);
    return answers[p];
  },
  async post() {
    throw new Error("no write");
  },
  async patch() {
    throw new Error("no write");
  },
});

describe("a workflow_run's run, as GitHub sends it", () => {
  const run = forkRunOf(recorded("samerepo-workflow-run.json"));

  it("reads the head, its repository and owner and the listed pull request", () => {
    expect(run).toEqual({
      id: 44513162056,
      headSha: "2d78d09f693a4e6b68913668692a9161342bace9",
      headBranch: "dependabot/github_actions/oras-project/setup-oras-2.0.3",
      headOwner: "mmmnt",
      headRepository: "mmmnt/flmnt",
      pullRequests: [{ number: 289, baseSha: "2c25fa5a3b1937babebd1b2ffeed0ead52a8ae09", baseRef: "main" }],
    });
  });

  it("is a fork's only when its head repository is another", () => {
    expect(isForkRun(ctx, run)).toBe(false);
    expect(isForkRun(ctx, { ...run, headRepository: "contributor/flmnt" })).toBe(true);
  });

  it("with no listed pull request (a fork's run), finds it among the open pull requests of its head branch at its head", async () => {
    const pulls = recorded("samerepo-open-pulls.json");
    const head = encodeURIComponent(`${run.headOwner}:${run.headBranch}`);
    const at = `/repos/mmmnt/flmnt/pulls?head=${head}&state=open`;
    const pr = await forkPullRequest(ctx, api({ [at]: pulls }), { ...run, pullRequests: [] });
    expect(pr).toMatchObject({ number: 289, headSha: run.headSha, baseSha: "2c25fa5a3b1937babebd1b2ffeed0ead52a8ae09", baseRef: "main" });
    await expect(forkPullRequest(ctx, api({ [at]: pulls }), { ...run, pullRequests: [], headSha: "0".repeat(40) })).rejects.toBeInstanceOf(
      ReportError,
    );
  });

  it("its open pull request, from this repository, is not a fork's to merge mode", () => {
    expect(isForkPull(ctx, recorded("samerepo-open-pulls.json")[0])).toBe(false);
  });
});

describe("a merged pull request a person opened from this repository", () => {
  it("is not a fork's: its run held the key", () => {
    expect(isForkPull(ctx, recorded("merged-pr-pulls.json")[0])).toBe(false);
  });
  it("a pull request whose head repository is gone or another is a fork's", () => {
    const pr = recorded("merged-pr-pulls.json")[0];
    expect(isForkPull(ctx, { ...pr, head: { sha: pr.head.sha, repo: null } })).toBe(true);
    expect(isForkPull(ctx, { ...pr, head: { sha: pr.head.sha, repo: { full_name: "contributor/flmnt" } } })).toBe(true);
  });
});
