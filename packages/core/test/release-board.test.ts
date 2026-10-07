// The Release Board's listing (release-board.ts): scoped by release, not by owner — a different principal can see
// another's request, which is the whole point (QA needs to see what a dev built).
import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseBoardHandlers } from "../src/feature/release-board.ts";
import { fresh } from "./feature-fixtures.ts";
import { ctx } from "./helpers.ts";
import type { Service } from "../src/service.ts";
import type { CandidateRecord } from "../src/feature/types.ts";

const binding = { repositoryId: "repo", baseCommitHash: "h", baseContentHash: "h", candidateContentHash: "h", diffHash: "h", contractHash: "h", originalOracleHash: "h", candidateOracleHash: "h", runManifestIds: [], mutationInventoryHash: "h", generationProvenanceHash: "h" };
let n = 0;
function candidate(requestId: string, bindingHash: string): CandidateRecord {
  return { schemaVersion: 1, id: `cand:${n++}`, requestId, ordinal: n, binding, bindingHash, mutations: [], invocationIds: [], status: "MATERIALIZED", createdAt: "2026-10-06T00:00:00Z" };
}

test("lists only the requests scoped to the given release, regardless of who created them", async () => {
  const { fs, make } = fresh();
  const a = make({ createdBy: "dev_bob", workspace: { requestId: "x", stage: "DESCRIBE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: "release:v1" } });
  make({ createdBy: "dev_bob", workspace: { requestId: "x", stage: "VALIDATE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: "release:v2" } });
  const handlers = releaseBoardHandlers({} as Service, fs);
  const r = await handlers["C02/listFeatureRequestsByRelease"]!(ctx(), { releaseId: "release:v1" });
  assert.equal(r.ok, true);
  const items = r.ok ? r.value as any[] : [];
  assert.equal(items.length, 1);
  assert.equal(items[0].requestId, a.requestId);
  assert.equal(items[0].createdBy, "dev_bob");
  assert.equal(items[0].stage, "DESCRIBE");
  assert.equal(items[0].candidateStatus, undefined, "no candidate materialized yet");
  assert.equal(items[0].secondApproved, false);
});

test("secondApproved is true only when an approval exists for the LATEST candidate's exact bindingHash", async () => {
  const { fs, make } = fresh();
  const rec = make({ createdBy: "dev_bob", workspace: { requestId: "x", stage: "VALIDATE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: "release:v1" } });
  const c1 = candidate(rec.requestId, "sha256:first");
  fs.putCandidate(c1);
  fs.recordDecisionApproval(rec.requestId, "qa_alice", c1.bindingHash, "reviewed v1");
  const handlers = releaseBoardHandlers({} as Service, fs);

  const before = await handlers["C02/listFeatureRequestsByRelease"]!(ctx(), { releaseId: "release:v1" });
  assert.equal(before.ok && (before.value as any[])[0].secondApproved, true);

  // A new candidate supersedes the approved one: the old sign-off no longer covers it.
  fs.putCandidate(candidate(rec.requestId, "sha256:second"));
  const after = await handlers["C02/listFeatureRequestsByRelease"]!(ctx(), { releaseId: "release:v1" });
  assert.equal(after.ok && (after.value as any[])[0].secondApproved, false, "approval bound to a superseded candidate does not carry over");
});

test("an unknown release returns an empty list, not an error", async () => {
  const { fs } = fresh();
  const handlers = releaseBoardHandlers({} as Service, fs);
  const r = await handlers["C02/listFeatureRequestsByRelease"]!(ctx(), { releaseId: "release:does-not-exist" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok ? r.value : null, []);
});
