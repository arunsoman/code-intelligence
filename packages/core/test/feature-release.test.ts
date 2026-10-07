// Phase 5: a feature request can be scoped to a release (release-scope.ts's Release, a milestone bundle — distinct
// from contract.releasePlan's deployment-safety plan, which is a different, pre-existing "release" concept). Covers:
//   (a) release-scoped listing is a real indexed filter, not a load-then-filter;
//   (b) a release-scoped request cannot be decided by its own author, even one with release authority
//       (end to end, through the real pipeline driver — this is the one two-actor shape the architecture supports:
//       the SAME single-owner driver, with the self-authorship check firing regardless of the actor's own authority);
//   (c) the gate's logic in isolation: a genuinely different, release-authorized approver is NOT blocked by it.
//   (d) the real two-actor flow: a SEPARATE principal (never running this pipeline — handlers.ts's `owned()` still
//       means a request that is not yours reads as absent everywhere else) records an approval through
//       C30/approveFeatureDecision, bound to the exact candidate's bindingHash. The pipeline's own actor is
//       unchanged (still the request's creator), but releaseSecondApprover() now reads that additive record —
//       mirroring F08's campaign_approvals — instead of comparing the (always-the-owner) deciding actor to the
//       author. This is the mechanism that makes (c) real rather than hypothetical.
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeEligibility, runFeatureValidation } from "../src/feature/validation.ts";
import { releaseSecondApprover, runFeaturePipeline, type PipelineDeps } from "../src/feature/pipeline.ts";
import { approvalHandlers } from "../src/feature/approval-handlers.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { fresh, record } from "./feature-fixtures.ts";
import { validationFixture } from "./feature-validation-fixtures.ts";
import { FeatureModelAdapter } from "../src/feature/model.ts";
import { gateDriverFor } from "../src/feature/security-handlers.ts";
import { AUTH, demo, exportEdits, FakeRunner, PROMPT, Script } from "./feature-pipeline-fixtures.ts";
import { ctx, setup } from "./helpers.ts";
import type { Service } from "../src/service.ts";
import type { CallContext } from "@cie/schema";

const as = (principal: string): CallContext => { const c = ctx(); return { ...c, actor: { ...c.actor, principalId: principal } }; };

// ------------------------------------------------------------------ (a) release-scoped listing

test("listRequestsByRelease returns only requests scoped to that release", () => {
  const { fs, make } = fresh();
  const a = make({ workspace: { requestId: "x", stage: "DESCRIBE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: "release:v1" } });
  const b = make({ workspace: { requestId: "x", stage: "DESCRIBE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: "release:v1" } });
  const c = make({ workspace: { requestId: "x", stage: "DESCRIBE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: "release:v2" } });
  const unscoped = make({});

  const v1 = fs.listRequestsByRelease("release:v1");
  assert.deepEqual(v1.map((r) => r.requestId).sort(), [a.requestId, b.requestId].sort());
  assert.ok(!v1.some((r) => r.requestId === c.requestId), "a different release's request is excluded");
  assert.ok(!v1.some((r) => r.requestId === unscoped.requestId), "an unscoped request is excluded");

  const v2 = fs.listRequestsByRelease("release:v2");
  assert.deepEqual(v2.map((r) => r.requestId), [c.requestId]);

  assert.equal(fs.listRequestsByRelease("release:does-not-exist").length, 0);
});

test("releaseId survives an updateRequest round trip (the promoted column tracks the json)", () => {
  const { fs, make } = fresh();
  const r = make({});
  assert.equal(fs.listRequestsByRelease("release:v3").length, 0);
  const updated = fs.updateRequest(r.requestId, r.version, { ...r, workspace: { ...r.workspace, releaseId: "release:v3" } });
  assert.deepEqual(fs.listRequestsByRelease("release:v3").map((x) => x.requestId), [r.requestId]);
  assert.equal(updated.workspace.releaseId, "release:v3");
});

// ------------------------------------------------------------------ (b) self-approval is blocked end to end

test("a release-scoped request's own author cannot decide it, even when bound for release authority", async () => {
  const repo = demo(AUTH); const { svc, worker } = await setup(undefined, repo);
  try {
    const fs = new SqliteFeatureStore(svc.store); const router = new Script();
    const deps: PipelineDeps = {
      fs, store: svc.store, auth: AUTH as never, runner: new FakeRunner(),
      adapter: (rid) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }),
      generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }), runCheck: gateDriverFor({}, fs),
    };
    // "arun" is the only principal AUTH binds for the release scope (feature-pipeline-fixtures.ts), and is also the
    // actor creating and running this request — the self-authorship half of the gate must fire regardless.
    const r = await runFeaturePipeline(deps, "arun", {
      repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", idempotencyKey: "release-self", releaseId: "release:v1",
      confirm: { criteria: "ALL", rationale: "these are the outcomes I want" },
      releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the draft PR" },
      validation: { fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE", environmentLabel: "test-double", testData: { kind: "SYNTHETIC" }, performanceApplicable: false },
    });
    assert.equal(r.stop, "BLOCKED");
    assert.equal(r.decision?.eligibility, "BLOCKED");
    assert.ok(r.decision?.reasons.some((x) => /second person with release authority/.test(x)), r.decision?.reasons.join("; "));
  } finally { worker.close(); }
});

test("without a releaseId, the same single-actor flow is unaffected (no regression for ordinary requests)", async () => {
  const repo = demo(AUTH); const { svc, worker } = await setup(undefined, repo);
  try {
    const fs = new SqliteFeatureStore(svc.store); const router = new Script();
    const deps: PipelineDeps = {
      fs, store: svc.store, auth: AUTH as never, runner: new FakeRunner(),
      adapter: (rid) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }),
      generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }), runCheck: gateDriverFor({}, fs),
    };
    const r = await runFeaturePipeline(deps, "arun", {
      repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", idempotencyKey: "release-none",
      confirm: { criteria: "ALL", rationale: "these are the outcomes I want" },
      releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the draft PR" },
      validation: { fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE", environmentLabel: "test-double", testData: { kind: "SYNTHETIC" }, performanceApplicable: false },
    });
    assert.equal(r.stop, "COMPLETE");
    assert.equal(r.decision?.eligibility, "VERIFIED_WITHIN_SCOPE");
  } finally { worker.close(); }
});

// ------------------------------------------------------------------ (c) the gate's own logic, direct

test("computeEligibility: secondApprover.ok === false blocks with a stated reason", async () => {
  const f = validationFixture();
  try {
    const evidence = await runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs: 30000 });
    const request = f.fs.getRequest(f.request.requestId)!;
    const blocked = computeEligibility({ request, candidate: f.fs.getCandidate(f.candidate.id)!, plan: f.plan, evidence, secondApprover: { ok: false, reason: "the deciding actor is this request's own author" } });
    assert.equal(blocked.eligibility, "BLOCKED");
    assert.ok(blocked.reasons.some((x) => x.includes("the deciding actor is this request's own author")), blocked.reasons.join("; "));
  } finally { f.close(); }
});

test("computeEligibility: secondApprover.ok === true does not block (a real second approver is not penalised)", async () => {
  const f = validationFixture();
  try {
    const evidence = await runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs: 30000 });
    const request = f.fs.getRequest(f.request.requestId)!;
    const allowed = computeEligibility({ request, candidate: f.fs.getCandidate(f.candidate.id)!, plan: f.plan, evidence, secondApprover: { ok: true, reason: "binding rel names arun for release" } });
    assert.equal(allowed.eligibility, "VERIFIED_WITHIN_SCOPE");
  } finally { f.close(); }
});

test("computeEligibility: no secondApprover input (an unscoped request) behaves exactly as before", async () => {
  const f = validationFixture();
  try {
    const evidence = await runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs: 30000 });
    const request = f.fs.getRequest(f.request.requestId)!;
    const result = computeEligibility({ request, candidate: f.fs.getCandidate(f.candidate.id)!, plan: f.plan, evidence });
    assert.equal(result.eligibility, "VERIFIED_WITHIN_SCOPE");
  } finally { f.close(); }
});

// ------------------------------------------------------------------ (d) the real two-actor flow, end to end

/** AUTH plus a second principal bound for release scope — a local variant, not a mutation of the shared AUTH
 * fixture other tests rely on (test (b) explicitly depends on "arun" being the ONLY release-bound principal). */
const TWO_ACTOR_AUTH = { bindings: AUTH.bindings.map((b) => (b.id === "rel" ? { ...b, principals: ["arun", "qa_alice"] } : b)) };

test("qa_alice — never the owner, never running the pipeline — approves via C30/approveFeatureDecision, and releaseSecondApprover then passes for that exact candidate", async () => {
  const repo = demo(TWO_ACTOR_AUTH); const { svc, worker } = await setup(undefined, repo);
  try {
    const fs = new SqliteFeatureStore(svc.store); const router = new Script();
    const deps: PipelineDeps = {
      fs, store: svc.store, auth: TWO_ACTOR_AUTH as never, runner: new FakeRunner(),
      adapter: (rid) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }),
      generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }), runCheck: gateDriverFor({}, fs),
    };
    const r = await runFeaturePipeline(deps, "arun", {
      repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", idempotencyKey: "release-two-actor", releaseId: "release:v1",
      confirm: { criteria: "ALL", rationale: "these are the outcomes I want" },
      releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the draft PR" },
      validation: { fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE", environmentLabel: "test-double", testData: { kind: "SYNTHETIC" }, performanceApplicable: false },
    });
    assert.equal(r.stop, "BLOCKED", "arun alone still cannot decide it, even bound for release authority himself");
    const requestId = r.candidate!.requestId; const bindingHash = r.candidate!.bindingHash;

    const before = releaseSecondApprover(fs, TWO_ACTOR_AUTH as never, fs.getRequest(requestId)!, bindingHash);
    assert.equal(before.ok, false, "no approval recorded yet");

    const handlers = approvalHandlers({} as Service, fs, () => TWO_ACTOR_AUTH as never);
    const approved = await handlers["C30/approveFeatureDecision"]!(as("qa_alice"), { requestId, explanation: "reviewed the diff, looks right" });
    assert.equal(approved.ok, true, JSON.stringify(approved));

    const after = releaseSecondApprover(fs, TWO_ACTOR_AUTH as never, fs.getRequest(requestId)!, bindingHash);
    assert.equal(after.ok, true);
    assert.match(after.reason, /qa_alice/);
  } finally { worker.close(); }
});

test("C30/approveFeatureDecision refuses self-approval", async () => {
  const repo = demo(TWO_ACTOR_AUTH); const { svc, worker } = await setup(undefined, repo);
  try {
    const fs = new SqliteFeatureStore(svc.store); const router = new Script();
    const deps: PipelineDeps = {
      fs, store: svc.store, auth: TWO_ACTOR_AUTH as never, runner: new FakeRunner(),
      adapter: (rid) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }),
      generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }), runCheck: gateDriverFor({}, fs),
    };
    const r = await runFeaturePipeline(deps, "arun", {
      repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", idempotencyKey: "release-self-approve", releaseId: "release:v1",
      confirm: { criteria: "ALL", rationale: "these are the outcomes I want" },
      releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the draft PR" },
      validation: { fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE", environmentLabel: "test-double", testData: { kind: "SYNTHETIC" }, performanceApplicable: false },
    });
    const handlers = approvalHandlers({} as Service, fs, () => TWO_ACTOR_AUTH as never);
    const result = await handlers["C30/approveFeatureDecision"]!(as("arun"), { requestId: r.candidate!.requestId });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error.message, /own author/);
  } finally { worker.close(); }
});

test("C30/approveFeatureDecision refuses a principal with no release authority", async () => {
  const repo = demo(TWO_ACTOR_AUTH); const { svc, worker } = await setup(undefined, repo);
  try {
    const fs = new SqliteFeatureStore(svc.store); const router = new Script();
    const deps: PipelineDeps = {
      fs, store: svc.store, auth: TWO_ACTOR_AUTH as never, runner: new FakeRunner(),
      adapter: (rid) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }),
      generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }), runCheck: gateDriverFor({}, fs),
    };
    const r = await runFeaturePipeline(deps, "arun", {
      repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", idempotencyKey: "release-unauthorized", releaseId: "release:v1",
      confirm: { criteria: "ALL", rationale: "these are the outcomes I want" },
      releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the draft PR" },
      validation: { fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE", environmentLabel: "test-double", testData: { kind: "SYNTHETIC" }, performanceApplicable: false },
    });
    const handlers = approvalHandlers({} as Service, fs, () => TWO_ACTOR_AUTH as never);
    const result = await handlers["C30/approveFeatureDecision"]!(as("random_bystander"), { requestId: r.candidate!.requestId });
    assert.equal(result.ok, false);
    assert.match(result.ok ? "" : result.error.message, /not named for release/);
  } finally { worker.close(); }
});

test("C30/approveFeatureDecision refuses a request with no releaseId", async () => {
  const { fs, make } = fresh();
  const rec = make({});
  const handlers = approvalHandlers({} as Service, fs, () => TWO_ACTOR_AUTH as never);
  const result = await handlers["C30/approveFeatureDecision"]!(as("qa_alice"), { requestId: rec.requestId });
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error.message, /release-scoped/);
});

test("C30/listDecisionApprovals returns what was recorded, 404 for an unknown request", async () => {
  const { fs, make } = fresh();
  const rec = make({ workspace: { requestId: "x", stage: "DESCRIBE", blockers: [], runningJobIds: [], workspaceVersion: 0, releaseId: "release:v1" } });
  fs.recordDecisionApproval(rec.requestId, "qa_alice", "sha256:abc", "looks good");
  const handlers = approvalHandlers({} as Service, fs, () => TWO_ACTOR_AUTH as never);
  const listed = await handlers["C30/listDecisionApprovals"]!(as("qa_alice"), { requestId: rec.requestId });
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.ok ? listed.value : null, [{ principal: "qa_alice", bindingHash: "sha256:abc", explanation: "looks good", createdAt: (listed.ok ? (listed.value as any[])[0].createdAt : "") }]);
  const missing = await handlers["C30/listDecisionApprovals"]!(as("qa_alice"), { requestId: "no-such-request" });
  assert.equal(missing.ok, false);
});
