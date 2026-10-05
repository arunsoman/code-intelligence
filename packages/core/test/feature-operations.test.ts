import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyPatchCandidate, checkPatchDestination, exportFeaturePatch, exportPolicyHash } from "../src/feature/patch-export.ts";
import { snapshotOf } from "../src/feature/intake.ts";
import { anomalyChecklist, executablePart, operationalReadiness, planRevert, releasePlanProblems, suggestReleasePlan, validatePostDeployEvidence } from "../src/feature/operations.ts";
import { defaultValidationPlan, validationPlanHash } from "../src/feature/validation.ts";
import { boot, createEdit } from "./feature-boot.ts";

const ROUTE = `import { app } from "./app.ts";\napp.get("/export", (req, res) => res.send("csv"));\n`;
async function world(files: Record<string, string>) {
  const b = await boot({ edits: () => Object.entries(files).map(([f, c]) => createEdit(f, c)) });
  const rec = b.fs.getRequest(b.rid)!;
  return { ...b, rec, report: (r = rec) => operationalReadiness(b.fs.getCandidate(b.cand.id)!, r) };
}
const state = (r: ReturnType<typeof operationalReadiness>, id: string) => r.checks.find((c) => c.id === id)!.state;

test("PF-048 documentation-only changes are NOT_APPLICABLE with a rationale; code is applicable", async () => {
  const w = await world({ "docs/export.md": "# Export\n" });
  try { const r = w.report(); assert.equal(r.status, "NOT_APPLICABLE"); assert.match(r.rationale!, /documentation-only/); } finally { w.close(); }
  const c = await world({ "src/util/a.ts": "export const a = 1;\n" });
  try { const r = c.report(); assert.equal(r.applicability, "APPLICABLE"); assert.equal(state(r, "SURFACE"), "PASS"); assert.equal(state(r, "METRICS"), "NOT_APPLICABLE"); } finally { c.close(); }
});

test("PF-048 a new endpoint without a signal, a limit or a release note is a gap list, never a pass; adding them clears it", async () => {
  const w = await world({ "src/api/export.ts": ROUTE });
  try {
    const r = w.report(); assert.equal(r.status, "INCOMPLETE");
    assert.deepEqual(["METRICS", "ABUSE_LIMITS", "RELEASE_PLAN"].map((id) => state(r, id)), ["GAP", "GAP", "GAP"]);
    assert.ok(r.checks.every((c) => c.basis !== undefined)); assert.equal(r.checks.find((c) => c.id === "ABUSE_LIMITS")!.basis, "STATIC_PATTERN");
  } finally { w.close(); }
  const ok = await world({ "src/api/export.ts": `import { app } from "./app.ts";\napp.get("/export", (req, res) => { const limit = 1000; logger.info("export"); res.send("csv"); });\n` });
  try {
    const rec = ok.rec; const withPlan = { ...rec, contract: { ...rec.contract!, releasePlan: { applicability: "APPLICABLE" as const, revertRunbook: "revert PR" } } };
    const r = ok.report(withPlan); assert.equal(r.status, "PASS", JSON.stringify(r.gaps));
  } finally { ok.close(); }
});

test("PF-048 logging a sensitive field BLOCKS; the word inside a string literal does not", async () => {
  assert.equal(executablePart('log.info("token expired", user)'), 'log.info( , user)');
  assert.match(executablePart("log.info(`id ${token}`)"), /token/); assert.doesNotMatch(executablePart("log.info(`token expired`)"), /token/);
  const w = await world({ "src/svc/a.ts": 'export const f = (token: string) => { logger.info(`got ${token}`); logger.info("token expired"); };\n' });
  try { const r = w.report(); assert.equal(r.status, "BLOCKED"); assert.equal(state(r, "LOG_REDACTION"), "BLOCKING"); assert.equal(r.checks.find((c) => c.id === "LOG_REDACTION")!.paths.length, 1); } finally { w.close(); }
  const ok = await world({ "src/svc/a.ts": 'export const f = () => { logger.info("token expired"); };\n' });
  try { assert.equal(state(ok.report(), "LOG_REDACTION"), "PASS"); } finally { ok.close(); }
});

test("PF-048 job and external-call code needs retry/timeout handling", async () => {
  const w = await world({ "src/jobs/sync.ts": 'export const start = () => setInterval(async () => { await fetch("https://x.test"); logger.info("tick"); }, 1000);\n' });
  try { const r = w.report(); assert.equal(state(r, "QUEUE_SIGNALS"), "GAP"); assert.equal(state(r, "EXTERNAL_TIMEOUT"), "GAP"); } finally { w.close(); }
  const ok = await world({ "src/jobs/sync.ts": 'export const start = () => setInterval(async () => { await fetch("https://x.test", { signal: AbortSignal.timeout(5000) }); logger.info("tick"); }, 1000); // retry with backoff\n' });
  try { const r = ok.report(); assert.equal(state(r, "QUEUE_SIGNALS"), "PASS"); assert.equal(state(r, "EXTERNAL_TIMEOUT"), "PASS"); } finally { ok.close(); }
});

test("PF-049 release plan fields are required by tier and never defaulted; the suggestion carries only facts", async () => {
  assert.deepEqual(releasePlanProblems(undefined, "T0"), []);
  assert.match(releasePlanProblems(undefined, "T1")[0]!, /operational note/);
  assert.deepEqual(releasePlanProblems({ applicability: "NOT_APPLICABLE", rationale: "internal" }, "T1"), []);
  assert.match(releasePlanProblems({ applicability: "NOT_APPLICABLE", rationale: "internal" }, "T2")[0]!, /cannot declare/);
  const t2 = releasePlanProblems({ applicability: "APPLICABLE", revertRunbook: "r" }, "T2"); assert.equal(t2.length, 4); assert.ok(t2.some((x) => /stop criteria/.test(x)) && t2.some((x) => /flag strategy or kill switch/.test(x)));
  assert.deepEqual(releasePlanProblems({ applicability: "APPLICABLE", revertRunbook: "r", stopCriteria: ["5xx>1%"], observationWindow: "1h", operator: "ops", killSwitch: "flag" }, "T2"), []);
  const w = await world({ "src/api/export.ts": ROUTE });
  try { const s = suggestReleasePlan(w.fs.getCandidate(w.cand.id)!); assert.equal(s.stopCriteria, undefined); assert.equal(s.operator, undefined); assert.match(s.dataRecoveryLimits!, /no schema/); assert.ok(releasePlanProblems(s, "T2").length >= 3); } finally { w.close(); }
});

test("PF-048 the OPERATIONAL gate feeds validation, and the operation refuses a stale plan or contract", async () => {
  const w = await world({ "src/api/export.ts": ROUTE });
  try {
    const rec = w.fs.getRequest(w.rid)!; const cand = w.fs.getCandidate(w.cand.id)!;
    const planHash = validationPlanHash(rec.validationPlan ?? defaultValidationPlan(rec, cand));
    const ok = w.h["C32/assessOperationalReadiness"](w.as("arun"), { contractHash: rec.contract!.hash, patchBindingHash: cand.bindingHash, planHash });
    assert.equal(ok.ok, true, JSON.stringify(ok.error)); assert.equal(ok.value.status, "PARTIAL"); assert.equal(ok.value.value.status, "INCOMPLETE"); assert.ok(ok.value.value.gaps.some((g: string) => /ABUSE_LIMITS/.test(g)));
    assert.equal(w.h["C32/assessOperationalReadiness"](w.as("arun"), { contractHash: rec.contract!.hash, patchBindingHash: cand.bindingHash, planHash: "x" }).error.code, "STALE_REVISION");
    assert.equal(w.h["C32/assessOperationalReadiness"](w.as("arun"), { contractHash: "x", patchBindingHash: cand.bindingHash, planHash }).error.code, "STALE_REVISION");
    assert.equal(w.h["C32/assessOperationalReadiness"](w.as("mallory"), { contractHash: rec.contract!.hash, patchBindingHash: cand.bindingHash, planHash }).error.code, "NOT_FOUND");
    // as a validation driver
    const { operationalRunCheck } = await import("../src/feature/operations.ts");
    const res = await operationalRunCheck(cand, rec)({ id: "operational", kind: "OPERATIONAL" } as any, w.repo);
    assert.equal(res!.status, "INFRA_ERROR"); assert.equal(await operationalRunCheck(cand, rec)({ id: "x", kind: "UNIT" } as any, w.repo), undefined);
  } finally { w.close(); }
});

test("PF-049/AT-39 a revert is planned as NEW edits against the current tree and refuses when the files moved", async () => {
  const w = await world({ "src/export/csv.ts": "export const toCsv = () => '';\n" });
  try {
    const rec = w.fs.getRequest(w.rid)!; const cand = w.fs.getCandidate(w.cand.id)!;
    w.fs.updateRequest(w.rid, rec.version, { ...rec, validationPlan: { ...defaultValidationPlan(rec, cand), testData: { kind: "SYNTHETIC", fixtureHash: "f", generatorHash: "g", seed: "1" } } });
    const dec = w.h["C16/verifyFeature"](w.as("arun"), { contractHash: rec.contract!.hash, patchBindingHash: cand.bindingHash, validationIds: [], performanceAssessmentIds: [], unresolvedFindingIds: [], purpose: "EXPORT_PATCH" }).value;
    const deps = { fs: w.fs, store: w.svc.store };
    const exp = exportFeaturePatch(deps, "arun", { candidateHash: cand.bindingHash, decisionId: dec.id, format: "GIT_PATCH", exportPolicyHash: exportPolicyHash() }).value!;
    const snap = snapshotOf(w.svc.store, w.repo); const a = checkPatchDestination(deps, "arun", { exportId: exp.id, destinationSnapshot: snap, dirtyState: [] }).value!;
    const applied = applyPatchCandidate(deps, "arun", { exportId: exp.id, destinationSnapshot: snap, assessmentId: a.id, capabilities: ["APPLY_TO_ISOLATED_WORKTREE"], idempotencyKey: "k" });
    const live = applied.worktree!;
    const plan = planRevert(cand, live); assert.deepEqual(plan.conflicts, []); assert.deepEqual(plan.edits.map((e) => e.op), ["DELETE_FILE"]);
    assert.equal(readFileSync(join(live, "src/export/csv.ts"), "utf8").length > 0, true);
    // not on the tree the candidate was applied to: the file is absent, so a clean revert is refused
    const none = planRevert(cand, w.repo); assert.equal(none.edits.length, 0); assert.match(none.conflicts[0]!, /changed or removed/);
  } finally { w.close(); }
});

test("PF-050 post-deploy evidence is schema-only: it validates, and the anomaly operation is an honest checklist", async () => {
  assert.deepEqual(validatePostDeployEvidence({ deploymentId: "d", observedAt: "2026-10-05T10:00:00Z", signal: "5xx", value: 0.2, unit: "%", window: "1h", source: "prom" }), []);
  assert.ok(validatePostDeployEvidence({ value: NaN, observedAt: "no" }).length >= 5);
  const w = await world({ "src/a.ts": "export const a = 1;\n" });
  try {
    const r = w.h["C22/investigateProductionAnomaly"](w.as("arun"), { requestId: w.rid, deploymentId: "d1", evidenceIds: [] });
    assert.equal(r.value.status, "PARTIAL"); assert.match(r.value.diagnostics[0], /no production telemetry/); assert.ok(r.value.value.steps.length >= 3);
    assert.equal(w.h["C22/investigateProductionAnomaly"](w.as("arun"), { requestId: w.rid }).error.code, "INVALID_SCHEMA");
    assert.equal(w.h["C22/investigateProductionAnomaly"](w.as("mallory"), { requestId: w.rid, deploymentId: "d" }).error.code, "NOT_FOUND");
    assert.equal(anomalyChecklist({ requestId: "r", deploymentId: "d", evidenceIds: [] }).value!.id, anomalyChecklist({ requestId: "r", deploymentId: "d", evidenceIds: [] }).value!.id);
  } finally { w.close(); }
});
