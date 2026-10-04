// DP16 / DP17 / DP19: publication is an external side effect. Drift stops it, a timeout after success is reconciled instead of repeated,
// and a documentation-only change is published without any claim about detectors, tests or benchmarks.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DetectorFinding, ExperimentSpec, PrPublication } from "@cie/schema";
import { prBody, type DraftForge, type FixProposal } from "../src/defect-workflow.ts";
import { trustedCheckoutHash } from "../src/defect-local.ts";
import { artifactHash } from "../src/defect-schedule.ts";
import { ctx, setup } from "./helpers.ts";

const FIX = realpathSync(resolve(import.meta.dirname, "../../../fixtures/defect-repo"));
let n = 0; const key = () => `p${++n}-${Math.random()}`;
const stressAdapter = { adapterId: "node.async-stress.local", adapterVersion: process.version, kind: "STRESS" as const };

class FakeForge implements DraftForge {
  prs: { number: number; url: string; headHash: string; draft: boolean; body: string; branch: string }[] = [];
  base = new Map<string, string>(); heads = new Map<string, string>();
  timeoutAfterCreate = false; creates = 0;
  async resolve(repo: string, base: string, head: string) { return { baseHash: this.base.get(`${repo}#${base}`) ?? "0".repeat(64), headHash: this.heads.get(head) ?? null }; }
  async find(p: PrPublication) { const pr = this.prs.find((x) => x.branch === p.headBranch); return pr ? { number: pr.number, url: pr.url, headHash: pr.headHash, draft: pr.draft } : null; }
  async createDraft(p: PrPublication, body: string) {
    this.creates++;
    const pr = { number: this.prs.length + 1, url: `https://forge.example/pr/${this.prs.length + 1}`, headHash: p.headHash, draft: true, body, branch: p.headBranch };
    this.prs.push(pr);
    if (this.timeoutAfterCreate) throw new Error("forge timed out after creating the pull request");
    return pr;
  }
}

/** A validated fix, produced by real runs: two reproductions of the failure on the base, a passing run on the candidate, a regression run. */
async function validated() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cie-base-"))); cpSync(FIX, base, { recursive: true });
  const cand = realpathSync(mkdtempSync(join(tmpdir(), "cie-cand-"))); cpSync(FIX, cand, { recursive: true });
  const f = join(cand, "async-race.ts");
  writeFileSync(f, readFileSync(f, "utf8").replace("const before = account.balance;\n  await boundary();\n  account.balance = before + 1;", "await boundary();\n  account.balance = account.balance + 1;"));
  const { svc, worker, revision } = await setup(undefined, base);
  const wf = svc.defects; wf.trustCheckout(base); wf.trustCheckout(cand);
  const entity = svc.store.entities(revision).find((e) => e.kind === "function")!.entityId;
  const finding: DetectorFinding = { id: "finding:" + artifactHash([revision, "pub"]), version: 1, kind: "LOGICAL_RACE", revision, entityIds: [entity], spans: [], ruleId: "test", ruleVersion: 1, evidenceIds: [], coverageGaps: [], severity: "HIGH", evidenceLevel: "STATIC_CANDIDATE", safetyObligations: [] };
  wf.recordFinding(ctx(key()), finding);
  const oracleValue = { schemaId: "defect.oracle.v1", description: "three completed increments leave three", reviewedBy: "reviewer" };
  const oracle = wf.putArtifact(ctx(key()), revision, "oracle", oracleValue);
  const run = async (root: string, fn: string) => {
    const harness = wf.putArtifact(ctx(key()), revision, "harness", { schemaId: "defect.source-harness.v1", adapterId: stressAdapter.adapterId, checkoutRoot: root, checkoutHash: trustedCheckoutHash(root), path: "async-race.ts", args: [fn, "300", "7"] });
    const grantId = "grant:" + key();
    const spec: ExperimentSpec = { id: "spec:" + key(), findingId: finding.id, baselineRevision: revision, candidateHead: null, ...stressAdapter, harnessHandle: harness.handle, harnessHash: harness.hash, oracleSchemaId: oracle.handle, fixtureHandles: [], fixtureHashes: [], inputs: { schemaId: "defect.inputs.v1", schemaVersion: 1, value: {} }, bounds: { schemaId: "defect.bounds.v1", schemaVersion: 1, value: {} }, budget: { wallTimeMs: 60_000, cpuTimeMs: 60_000, memoryBytes: 2 ** 30, processes: 16, readBytes: 2 ** 28, outputBytes: 2 ** 20, cost: "0" }, environmentProfileId: "local", executionGrantId: grantId };
    const c = ctx(key());
    wf.provisionGrant({ id: grantId, revision, principalId: c.actor.principalId, specHash: artifactHash(spec), expiresAt: Date.now() + 600_000, operation: "RUN" });
    wf.prepareExperiment(c, spec);
    return wf.runExperiment(ctx(key()), spec.id, 1);
  };
  const b1 = await run(base, "lostIncrement"), b2 = await run(base, "lostIncrement");
  const c1 = await run(cand, "lostIncrement"), r1 = await run(cand, "incrementAfterAwait");
  const diff = wf.putArtifact(ctx(key()), revision, "diff", "-  const before = account.balance;\n-  await boundary();\n-  account.balance = before + 1;\n+  await boundary();\n+  account.balance = account.balance + 1;\n");
  const proposal: FixProposal = { id: "proposal:" + key(), findingId: finding.id, revision, baseHash: trustedCheckoutHash(base), headHash: trustedCheckoutHash(cand), diffHash: diff.hash, diffHandle: diff.handle, obligationIds: [], harnessHash: artifactHash("h"), oracleHash: artifactHash(oracleValue), title: "Read after the await", explanation: "the increment reads the balance after the boundary" };
  wf.proposeFix(ctx(key()), proposal);
  const validation = wf.validateFix(ctx(key()), { proposalId: proposal.id, expectedHeadHash: proposal.headHash, baselineRunIds: [b1.id, b2.id], candidateRunIds: [c1.id], regressionRunIds: [r1.id] });
  return { svc, worker, revision, wf, finding, proposal, validation, base, cand, diff, oracleValue, runs: { b1, b2, c1, r1 } };
}
const grant = (w: Awaited<ReturnType<typeof validated>>, pub: PrPublication, over: Record<string, unknown> = {}) => {
  const c = ctx(key()); const id = "pubgrant:" + key();
  w.wf.provisionGrant({ id, revision: w.revision, principalId: c.actor.principalId, repository: pub.repository, baseBranch: pub.baseBranch, baseHash: pub.baseHash, headHash: pub.headHash, diffHash: w.proposal.diffHash, expiresAt: Date.now() + 600_000, operation: "PUBLISH_DRAFT", ...over } as any);
  return { id, c };
};
const forgeFor = (w: Awaited<ReturnType<typeof validated>>, pub: PrPublication) => { const f = new FakeForge(); f.base.set(`${pub.repository}#${pub.baseBranch}`, pub.baseHash); f.heads.set(pub.headBranch, pub.headHash); return f; };

test("DP12/16: a fix with two reproductions, a passing candidate on its exact source and a regression run passes its gates; any drift afterwards stops publication before anything is created", async () => {
  const w = await validated();
  assert.equal(w.validation.state, "PASSED_DEFINED_GATES", w.validation.unresolved.join("; "));
  assert.ok(w.runs.b1.status === "PROPERTY_FAILED" && w.runs.b2.status === "PROPERTY_FAILED" && w.runs.c1.status === "SUCCEEDED");
  assert.equal(w.runs.c1.sourceHash, w.proposal.headHash, "the candidate result is for the candidate's exact source");
  assert.equal(w.runs.b1.sourceHash, w.proposal.baseHash);
  assert.equal(w.runs.b1.oracleHash, w.runs.c1.oracleHash, "the property that judged the base is the one that judged the fix");
  const pub = w.wf.preparePullRequest(ctx(key()), { proposalId: w.proposal.id, validationId: w.validation.id, repository: "acme/payments", baseBranch: "main" });
  const g = grant(w, pub);
  // (a) The base branch moved on the forge after validation.
  const moved = forgeFor(w, pub); moved.base.set("acme/payments#main", "f".repeat(64));
  await assert.rejects(w.wf.publishPullRequest(g.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: g.id }, moved), /Forge base or candidate head changed/);
  assert.equal(moved.creates, 0, "nothing was created");
  // (b) Someone pushed to the candidate branch.
  const pushed = forgeFor(w, pub); pushed.heads.set(pub.headBranch, "e".repeat(64));
  await assert.rejects(w.wf.publishPullRequest(g.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: g.id }, pushed), /Forge base or candidate head changed/);
  assert.equal(pushed.creates, 0);
  // (c) The caller expects a different head than the one validated.
  await assert.rejects(w.wf.publishPullRequest(g.c, { publicationId: pub.id, expectedHeadHash: "d".repeat(64), authorizationId: g.id }, forgeFor(w, pub)), /does not bind this exact repository, base and patch/);
  // (d) A grant for another head, a revoked grant, an expired grant, another principal.
  const other = grant(w, pub, { headHash: "c".repeat(64) });
  await assert.rejects(w.wf.publishPullRequest(other.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: other.id }, forgeFor(w, pub)), /does not bind this exact/);
  const revoked = grant(w, pub); w.wf.revokeGrant(revoked.id);
  await assert.rejects(w.wf.publishPullRequest(revoked.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: revoked.id }, forgeFor(w, pub)), /absent or revoked/);
  const stranger = grant(w, pub);
  await assert.rejects(w.wf.publishPullRequest({ ...ctx(key()), actor: { principalId: "mallory", tenantId: "t", sessionId: "s" } }, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: stranger.id }, forgeFor(w, pub)), /does not authorize this actor/);
  // (e) Validation that did not pass cannot be published, whatever the grant says.
  const weak = w.wf.validateFix(ctx(key()), { proposalId: w.proposal.id, expectedHeadHash: w.proposal.headHash, baselineRunIds: [w.runs.b1.id], candidateRunIds: [w.runs.c1.id], regressionRunIds: [w.runs.r1.id] });
  assert.equal(weak.state, "REVIEWABLE_WITH_LIMITS");
  assert.ok(weak.unresolved.some((u) => /reproduced twice/.test(u)));
  // (f) A validation requested for a head that has since changed is stale.
  assert.throws(() => w.wf.validateFix(ctx(key()), { proposalId: w.proposal.id, expectedHeadHash: "0".repeat(64), baselineRunIds: [w.runs.b1.id, w.runs.b2.id], candidateRunIds: [w.runs.c1.id], regressionRunIds: [w.runs.r1.id] }), /Candidate changed after validation was requested/);
  // With everything in order, the same publication goes through, as a draft, once.
  const ok = forgeFor(w, pub);
  const done = await w.wf.publishPullRequest(g.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: g.id }, ok);
  assert.equal(done.status, "PUBLISHED"); assert.ok(ok.prs.length === 1 && ok.prs[0].draft === true);
  assert.match(ok.prs[0].body, /Recorded checks: 4/);
  w.worker.close();
});

test("DP17: a timeout after the forge created the pull request is reconciled by finding it, not by creating another", async () => {
  const w = await validated();
  const pub = w.wf.preparePullRequest(ctx(key()), { proposalId: w.proposal.id, validationId: w.validation.id, repository: "acme/payments", baseBranch: "main" });
  const g = grant(w, pub);
  const forge = forgeFor(w, pub); forge.timeoutAfterCreate = true;
  await assert.rejects(w.wf.publishPullRequest(g.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: g.id }, forge), /timed out after creating/);
  assert.equal(forge.prs.length, 1, "the forge did create it");
  assert.equal(w.wf.get<PrPublication>(pub.id, "publication").value.status, "PUBLISHING", "the intent is recorded; the outcome is not yet known to us");
  forge.timeoutAfterCreate = false;
  const retry = await w.wf.publishPullRequest(g.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: g.id }, forge);
  assert.equal(retry.status, "PUBLISHED");
  assert.equal(retry.prNumber, 1);
  assert.equal(forge.prs.length, 1, "no duplicate pull request");
  assert.equal(forge.creates, 1, "the forge was asked to create exactly once");
  // A third attempt is a no-op and does not even call the forge.
  const calls = forge.creates;
  assert.equal((await w.wf.publishPullRequest(g.c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: g.id }, forge)).status, "PUBLISHED");
  assert.equal(forge.creates, calls);
  // A receipt that is not a draft for the validated head is refused rather than recorded as ours.
  const w2 = await validated();
  const pub2 = w2.wf.preparePullRequest(ctx(key()), { proposalId: w2.proposal.id, validationId: w2.validation.id, repository: "acme/payments", baseBranch: "main" });
  const g2 = grant(w2, pub2); const bad = forgeFor(w2, pub2);
  bad.prs.push({ number: 9, url: "https://forge.example/pr/9", headHash: "a".repeat(64), draft: true, body: "someone else's", branch: pub2.headBranch });
  await assert.rejects(w2.wf.publishPullRequest(g2.c, { publicationId: pub2.id, expectedHeadHash: pub2.headHash, authorizationId: g2.id }, bad), /not a draft for the validated head/);
  w.worker.close(); w2.worker.close();
});

test("DP19: a documentation-only change is published as a draft with no claim of detection, validation or measurement; the body says what it is not", async () => {
  const w = await validated();
  const docs = realpathSync(mkdtempSync(join(tmpdir(), "cie-docs-"))); cpSync(FIX, docs, { recursive: true });
  writeFileSync(join(docs, "DESIGN.md"), "# Design\nA proposal for lock-order detection. Nothing here is implemented.\n");
  const diff = w.wf.putArtifact(ctx(key()), w.revision, "diff", "+ DESIGN.md\n");
  const proposal: FixProposal = { kind: "DOCUMENTATION", id: "proposal:" + key(), findingId: w.finding.id, revision: w.revision, baseHash: trustedCheckoutHash(w.base), headHash: trustedCheckoutHash(docs), diffHash: diff.hash, diffHandle: diff.handle, obligationIds: [], harnessHash: artifactHash("none"), oracleHash: artifactHash("none"), title: "Lock-order detection design", explanation: "adds a design" };
  w.wf.proposeFix(ctx(key()), proposal);
  const pub = w.wf.preparePullRequest(ctx(key()), { proposalId: proposal.id, validationId: "none", repository: "acme/payments", baseBranch: "main" });
  assert.equal(pub.validationId, "none");
  const c = ctx(key()); const gid = "pubgrant:" + key();
  w.wf.provisionGrant({ id: gid, revision: w.revision, principalId: c.actor.principalId, repository: pub.repository, baseBranch: pub.baseBranch, baseHash: pub.baseHash, headHash: pub.headHash, diffHash: proposal.diffHash, expiresAt: Date.now() + 600_000, operation: "PUBLISH_DRAFT" });
  const forge = forgeFor(w, pub);
  // It still needs a grant bound to this head.
  await assert.rejects(w.wf.publishPullRequest(ctx(key()), { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: "grant:none" }, forge), /absent or revoked/);
  const done = await w.wf.publishPullRequest(c, { publicationId: pub.id, expectedHeadHash: pub.headHash, authorizationId: gid }, forge);
  assert.equal(done.status, "PUBLISHED");
  const body = forge.prs[0].body;
  assert.match(body, /Documentation only: this change adds a written design/);
  assert.match(body, /implements no detector and changes no behaviour/);
  assert.match(body, /None applies\. No test, replay or benchmark is claimed\./);
  assert.match(body, /has not been validated against code/);
  assert.ok(!/Recorded checks|Validation:|improved|p9\d|speed-?up|faster|reproduc(ed|tion) |passes|fixes the/i.test(body.replace("No test, replay or benchmark is claimed", "")), `no behavioural claim in: ${body}`);
  assert.ok(forge.prs[0].draft);
  // The fix body, for contrast, does report its checks.
  assert.match(prBody({ findingId: "f", headHash: "h", baseHash: "b", validationId: "v", checks: 4 }), /Recorded checks: 4/);
  w.worker.close();
});
