// Merge mode's lookup against a real merged pull request's recorded API responses (fixtures/recorded, trimmed to
// the fields read). The pull request path never runs merge mode, and a hand-written fixture once invented a pulls
// field (`merge_ref_sha`) that no GitHub response carries: main's first merge then failed with "run … has no attested
// artifacts". These responses are what GitHub answered for that merge.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testedMergeRef, type Api, type Context } from "./report.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const recorded = (name: string) => JSON.parse(readFileSync(path.join(here, "../fixtures/recorded", name), "utf8"));
const pulls = recorded("merged-pr-pulls.json");
const checks = recorded("merged-pr-head-check-runs.json");

const ctx = { owner: "mmmnt", repo: "flmnt", checkName: "feat report" } as Context;
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

describe("merge mode finds the commit a merged pull request's run tested", () => {
  const pr = pulls[0];
  const head = pr.head.sha;
  const checksPath = `/repos/mmmnt/flmnt/commits/${head}/check-runs?check_name=feat%20report`;

  it("the pulls response names no tested merge commit: merge_commit_sha is the commit on main", () => {
    expect(pr).not.toHaveProperty("merge_ref_sha");
    expect(pr.merge_commit_sha).toBe("8261fc31c3f46f74ff8a32f327981c80dd2bfaa8");
  });

  it("reads it from the pull request run's feat report check, here from an older check's summary", async () => {
    expect(checks.check_runs[0].external_id).toBe("");
    expect(await testedMergeRef(ctx, api({ [checksPath]: checks }), head)).toBe(
      "ede42990f670a886bf3447389d8a5e413d5ebb5a",
    );
  });

  it("prefers the check's external_id, which the Action now records", async () => {
    const withId = { check_runs: [{ ...checks.check_runs[0], external_id: "ede42990f670a886bf3447389d8a5e413d5ebb5a" }] };
    expect(await testedMergeRef(ctx, api({ [checksPath]: withId }), head)).toBe(
      "ede42990f670a886bf3447389d8a5e413d5ebb5a",
    );
  });

  it("finds none when the head has no feat report check", async () => {
    expect(await testedMergeRef(ctx, api({ [checksPath]: { check_runs: [] } }), head)).toBeNull();
  });
});
