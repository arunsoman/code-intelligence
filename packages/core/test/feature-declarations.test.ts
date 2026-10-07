import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyDeclarations, declarationGaps, declarationStatus } from "../src/feature/declarations.ts";
import { FeatureModelAdapter } from "../src/feature/model.ts";
import { runFeaturePipeline, type PipelineDeps } from "../src/feature/pipeline.ts";
import { deliverView, validationDashboard } from "../src/feature/dashboard.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { AUTH, demo, exportEdits, FakeRunner, PROMPT, Script } from "./feature-pipeline-fixtures.ts";
import { setup } from "./helpers.ts";

const DECL = { fidelity: "REPRESENTATIVE" as const, dependencies: "AVAILABLE" as const, environmentLabel: "test-double", testData: { kind: "SYNTHETIC" as const }, performanceApplicable: false };
async function world(auth: { bindings: readonly object[] }) {
  const repo = demo(auth); const { svc, worker } = await setup(undefined, repo); const fs = new SqliteFeatureStore(svc.store); const router = new Script();
  const deps: PipelineDeps = { fs, store: svc.store, auth: auth as never, runner: new FakeRunner(), adapter: (rid) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }), generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }) };
  const { gateDriverFor } = await import("../src/feature/security-handlers.ts"); deps.runCheck = gateDriverFor({}, fs);
  const run = (over: Record<string, unknown> = {}) => runFeaturePipeline(deps, "arun", { repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", idempotencyKey: "k", confirm: { criteria: "ALL", rationale: "right" }, releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the PR" }, validation: DECL, validationRationale: "demo environment", ...over });
  return { repo, svc, fs, deps, run, close: () => worker.close() };
}

test("D001 with no bindings the requester can declare only what is theirs (synthetic data, weaker claims): every stronger claim is refused, named, and the result is review-only", async () => {
  const w = await world({ bindings: [] });
  try {
    const r = await w.run(); assert.equal(r.stop, "COMPLETE", JSON.stringify(r.steps)); assert.equal(r.decision!.eligibility, "REVIEW_ONLY_INCOMPLETE");
    const step = r.steps.find((s) => s.step === "DECLARE")!; assert.equal(step.status, "PARTIAL"); assert.match(step.detail, /1 declaration\(s\) recorded/);
    for (const kind of ["ENVIRONMENT", "DEPENDENCIES", "PERFORMANCE_NOT_APPLICABLE"]) assert.match(step.detail, new RegExp(`${kind} — `)); assert.match(step.detail, /no authority binding names anyone for validation decisions/);
    const reasons = r.decision!.reasons.join("; "); assert.match(reasons, /environment fidelity or dependencies are incomplete/); assert.match(reasons, /performance/); assert.match(reasons, /operational: INCOMPLETE/);
    const ops = w.fs.listEvidence(r.candidate!.id).flatMap((e) => e.results).find((x) => x.kind === "OPERATIONAL")!; assert.match(ops.gaps.join(), /is a draft: no principal with release authority has confirmed it/);
    const rec = w.fs.getRequest(r.requestId)!; assert.equal(rec.contract!.releasePlan!.draftedBy, "arun"); assert.equal(rec.contract!.releasePlan!.confirmedBy, undefined);
    assert.equal(rec.validationPlan!.environment.fidelity, "PARTIAL"); assert.equal(rec.validationPlan!.environment.dependencies, "UNKNOWN");
    const refusals = w.fs.listEvents(r.requestId).filter((e) => e.result === "BLOCKED" && /refused declaration/.test(e.rationale)); assert.equal(refusals.length, 3, "each refusal is on the audit trail");
  } finally { w.close(); }
});

test("D001 bound principals make the same declarations count: each is a recorded decision with who, which binding and why, and the result can be verified", async () => {
  const w = await world(AUTH);
  try {
    const r = await w.run(); assert.equal(r.decision!.eligibility, "VERIFIED_WITHIN_SCOPE", r.decision!.reasons.join("; ")); assert.equal(r.steps.find((s) => s.step === "DECLARE")!.status, "DONE");
    const ds = w.fs.listDecisions(r.requestId).filter((d) => d.questionId?.startsWith("declaration:")); assert.deepEqual(ds.map((d) => d.questionId).sort(), ["declaration:DEPENDENCIES", "declaration:ENVIRONMENT", "declaration:PERFORMANCE_NOT_APPLICABLE", "declaration:TEST_DATA"]);
    const env = ds.find((d) => d.questionId === "declaration:ENVIRONMENT")!; assert.equal(env.authorityBindingId, "val"); assert.equal(env.actorId, "arun"); assert.equal(env.rationale, "demo environment"); assert.equal(ds.find((d) => d.questionId === "declaration:TEST_DATA")!.authorityBindingId, undefined, "synthetic data is the requester's to declare: no binding");
    assert.equal(w.fs.getRequest(r.requestId)!.contract!.releasePlan!.confirmedBy, "arun");
    const st = declarationStatus(w.fs, w.fs.getRequest(r.requestId)!, w.deps.auth); assert.deepEqual(Object.values(st).map((x) => x.state), ["DECLARED", "DECLARED", "DECLARED", "DECLARED"]);
    // a repeat records nothing new
    await w.run(); assert.equal(w.fs.listDecisions(r.requestId).filter((d) => d.questionId?.startsWith("declaration:")).length, 4);
  } finally { w.close(); }
});

test("D001 revoking a binding after the fact makes the same candidate review-only again, naming the declaration and who lost the authority", async () => {
  const w = await world(AUTH);
  try {
    const r = await w.run(); assert.equal(r.decision!.eligibility, "VERIFIED_WITHIN_SCOPE"); const rec = () => w.fs.getRequest(r.requestId)!;
    assert.deepEqual(declarationGaps(w.fs, rec(), AUTH as never), []);
    const revoked = { bindings: AUTH.bindings.filter((b) => b.scope !== "validation") }; const gaps = declarationGaps(w.fs, rec(), revoked as never);
    assert.equal(gaps.length, 2); assert.ok(gaps.every((g) => /declared by arun, who no longer has the authority/.test(g))); assert.ok(gaps.some((g) => /REPRESENTATIVE environment/.test(g)) && gaps.some((g) => /AVAILABLE dependencies/.test(g)));
    // the repository's authority file is what every later check reads
    writeFileSync(join(w.repo, ".cie/authority.json"), JSON.stringify(revoked));
    const view = deliverView(w.fs, rec(), w.fs.getCandidate(r.candidate!.id)!); assert.equal(view.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.ok(view.reasons.some((x) => /no longer has the authority/.test(x)));
    const dash = validationDashboard(w.fs, rec(), w.fs.getCandidate(r.candidate!.id)!); const row = (id: string) => dash.declarations.find((x) => x.id === id)!;
    assert.equal(row("ENVIRONMENT").state, "NO_LONGER_AUTHORISED"); assert.match(row("ENVIRONMENT").detail, /no longer has the authority/); assert.equal(row("TEST_DATA").state, "DECLARED"); assert.equal(row("PERFORMANCE_NOT_APPLICABLE").declarer, "arun"); assert.equal(row("PERFORMANCE_NOT_APPLICABLE").bindingId, "perf");
    assert.equal(row("EXPECTED_OUTCOMES").state, "CONFIRMED");
  } finally { w.close(); }
});

test("D001 a plan that claims more than anyone recorded is a gap: no declaration, no strong claim", async () => {
  const w = await world({ bindings: [] });
  try {
    const r = await w.run({ validation: { testData: { kind: "SYNTHETIC" } } }); const rec = w.fs.getRequest(r.requestId)!;
    // someone edits the stored plan to claim a representative environment without a decision behind it
    w.fs.updateRequest(rec.requestId, rec.version, { ...rec, validationPlan: { ...rec.validationPlan!, environment: { ...rec.validationPlan!.environment, fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE" } } });
    const gaps = declarationGaps(w.fs, w.fs.getRequest(rec.requestId)!, { bindings: [] }); assert.deepEqual(gaps, ["the REPRESENTATIVE environment has no recorded declaration", "the AVAILABLE dependencies has no recorded declaration"]);
    assert.ok(deliverView(w.fs, w.fs.getRequest(rec.requestId)!, w.fs.getCandidate(r.candidate!.id)!).reasons.some((x) => /no recorded declaration/.test(x)));
  } finally { w.close(); }
});

test("D001 redacted real data needs a data binding, and a refused one leaves the data unauthorised so nothing runs against it", async () => {
  const w = await world({ bindings: [] });
  try {
    const rec = (await w.run({ validation: { testData: { kind: "SYNTHETIC" } } })).requestId; const out = applyDeclarations(w.fs, { bindings: [] }, "arun", rec, { testData: { kind: "AUTHORIZED_REDACTED", authorizationRef: "ticket-1" } });
    assert.equal(out.effective.testData, undefined); assert.match(out.refused[0]!.reason, /AUTHORIZED_REDACTED was not accepted/);
    const bound = applyDeclarations(w.fs, { bindings: [{ id: "d", scope: "data", principals: ["arun"] }] }, "arun", rec, { testData: { kind: "AUTHORIZED_REDACTED", authorizationRef: "ticket-1" } });
    assert.equal(bound.refused.length, 0); assert.equal(bound.accepted[0]!.authorityBindingId, "d"); assert.match(bound.accepted[0]!.answer, /ticket-1/);
    assert.throws(() => applyDeclarations(w.fs, { bindings: [] }, "mallory", rec, {}), (e: any) => e.code === "NOT_FOUND");
  } finally { w.close(); }
});

test("D001 the release plan or operational note: the requester drafts, only a principal bound for release confirms, a new draft clears the confirmation, and a plan cannot confirm itself", async () => {
  const w = await world({ bindings: [] });
  try {
    const { featureHandlers } = await import("../src/feature/handlers.ts"); const { ctx } = await import("./helpers.ts");
    const h = featureHandlers(w.svc) as Record<string, (c: any, b: any) => any>; const as = (p: string, k: string) => { const c = ctx(k); return { ...c, actor: { ...c.actor, principalId: p } }; };
    const r = await w.run({ releasePlan: undefined }); const cid = `contract:${r.requestId}`;
    assert.equal(h["C15/draftReleasePlan"](as("arun", "d1"), { contractId: cid, plan: { applicability: "APPLICABLE", revertRunbook: "revert" , confirmedBy: "arun" } }).error.code, "INVALID_SCHEMA");
    const draft = h["C15/draftReleasePlan"](as("arun", "d2"), { contractId: cid, plan: { applicability: "APPLICABLE", revertRunbook: "revert" } }); assert.equal(draft.ok, true); assert.equal(draft.value.draftedBy, "arun"); assert.equal(draft.value.confirmedBy, undefined);
    const refused = h["C15/confirmReleasePlan"](as("arun", "c1"), { contractId: cid }); assert.equal(refused.error.code, "FORBIDDEN"); assert.match(refused.error.message, /no authority binding names anyone for release/);
    assert.ok(w.fs.listEvents(r.requestId).some((e) => e.result === "BLOCKED" && /refused: no authority binding/.test(e.rationale)));
    // bind release authority for arun (the authority file is read at each confirmation)
    writeFileSync(join(w.repo, ".cie/authority.json"), JSON.stringify({ bindings: [{ id: "rel", scope: "release", principals: ["arun"] }] }));
    const ok = h["C15/confirmReleasePlan"](as("arun", "c2"), { contractId: cid }); assert.equal(ok.ok, true, JSON.stringify(ok.error)); assert.equal(ok.value.confirmedBy, "arun");
    assert.equal(w.fs.listDecisions(r.requestId).filter((d) => d.questionId === "release-plan-confirmation").length, 1);
    const again = h["C15/draftReleasePlan"](as("arun", "d3"), { contractId: cid, plan: { applicability: "APPLICABLE", revertRunbook: "revert differently" } }); assert.equal(again.value.confirmedBy, undefined, "the confirmation was of the old text");
    assert.equal(h["C15/confirmReleasePlan"](as("mallory", "c3"), { contractId: cid }).error.code, "NOT_FOUND");
    mkdirSync(join(w.repo, ".cie"), { recursive: true });
  } finally { w.close(); }
});
