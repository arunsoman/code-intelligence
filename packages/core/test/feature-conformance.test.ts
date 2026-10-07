// Scenarios from Prompt-to-feature.md §24/§41/§47 that had no test of their own (plan 4.2). Each title cites its scenario so
// scripts/conformance.ts finds it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { materializeCandidate } from "../src/feature/candidate.ts";
import { BANNER, deliverView } from "../src/feature/dashboard.ts";
import { EXPORT_POLICY, exportPolicyHash } from "../src/feature/patch-export.ts";
import { computeEligibility, runFeatureValidation, defaultValidationPlan, type ValidationCheck } from "../src/feature/validation.ts";
import type { AcceptanceCriterion, RunRequest, RunResult } from "../src/feature/types.ts";
import { boot, createEdit, none } from "./feature-boot.ts";
import { validationFixture } from "./feature-validation-fixtures.ts";

const crit = (id: string): AcceptanceCriterion => ({ id, requirementIds: ["r1"], scenario: "s", expectedOutcome: `expected ${id}`, mandatory: true, oracleSourceRefs: [], oracleOrigin: "USER_EXAMPLE", validationKinds: ["UNIT"] });
const SYN = { kind: "SYNTHETIC" as const, fixtureHash: "f", generatorHash: "g", seed: "1" };
const run = (f: ReturnType<typeof validationFixture>, wallMs = 30_000) => runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs });
const verdict = (f: ReturnType<typeof validationFixture>) => computeEligibility({ request: f.fs.getRequest(f.request.requestId)!, candidate: f.fs.getCandidate(f.candidate.id)!, plan: f.fs.getRequest(f.request.requestId)!.validationPlan!, evidence: f.fs.listEvidence(f.candidate.id) });
const check = (id: string, kind: ValidationCheck["kind"], phase: ValidationCheck["phase"], over: Partial<ValidationCheck> = {}): ValidationCheck => ({ id, kind, phase, target: ".", acceptanceIds: ["a1"], mandatory: true, argv: ["node", `${id}.js`], fullSuiteArgv: ["node", `${id}.js`], expectedTests: [], report: "EXIT", applicability: "APPLICABLE", baseline: false, ...over });

test("AT-10 another principal reading, exporting, validating or graphing a candidate by id gets 'not found', with no path, prompt or request detail in the answer", async () => {
  const w = await boot({ text: "SECRET-PROMPT-WORDING export please", edits: () => [createEdit("src/export/csv.ts", "export const toCsv = () => '';\n")] });
  try {
    const hash = w.cand.bindingHash; const m = (op: string, body: Record<string, unknown>) => w.h[op](w.as("mallory"), body);
    const calls = [m("C28/readCandidateFile", { candidateHash: hash, path: "src/export/csv.ts", representation: "CANDIDATE" }), m("C28/exportFeaturePatch", { candidateHash: hash, decisionId: "d", format: "GIT_PATCH", exportPolicyHash: exportPolicyHash() }),
      m("C27/queryValidationResults", { candidateHash: hash, contractHash: "c" }), m("C16/verifyFeature", { contractHash: "c", patchBindingHash: hash, validationIds: [], performanceAssessmentIds: [], unresolvedFindingIds: [], purpose: "REVIEW" }),
      m("C19/compileChangeGraph", { requestId: w.rid, candidateHash: hash, budget: { nodes: 10 } }), m("C23/queryRelatedTests", { candidateHash: hash }), m("C01/openFeatureWorkspace", { requestId: w.rid }), m("C23/assessRetirement", { requestId: w.rid, candidateHash: hash }), m("C32/assessOperationalReadiness", { contractHash: "c", patchBindingHash: hash, planHash: "p" })];
    for (const r of calls) { assert.equal(r.ok, false); assert.equal(r.error.code, "NOT_FOUND"); }
    const text = JSON.stringify(calls); assert.doesNotMatch(text, /src\/export|csv|SECRET-PROMPT/, "an error answer carries no protected detail");
    // a request that does not exist answers in the same words as one that belongs to someone else, so existence cannot be probed
    const ghost = m("C01/openFeatureWorkspace", { requestId: "req:does-not-exist" }); assert.equal(ghost.error.message.replace("req:does-not-exist", "ID"), calls[6]!.error.message.replace(w.rid, "ID"));
    // and the owner still can
    assert.equal(w.h["C28/readCandidateFile"](w.as("arun"), { candidateHash: hash, path: "src/export/csv.ts", representation: "CANDIDATE" }).ok, true);
  } finally { w.close(); }
});

test("AT-11 permission withdrawn after approval: reading, exporting, publishing and checking a destination are refused, and the refusal does not name the path", async () => {
  const e = await boot({ edits: () => [createEdit("src/export/csv.ts", "export const toCsv = () => '';\n")] });
  try {
    const rec = e.fs.getRequest(e.rid)!; e.fs.updateRequest(e.rid, rec.version, { ...rec, validationPlan: { ...defaultValidationPlan(rec, e.cand), testData: SYN } });
    const dec = () => e.h["C16/verifyFeature"](e.as("arun"), { contractHash: rec.contract!.hash, patchBindingHash: e.cand.bindingHash, validationIds: [], performanceAssessmentIds: [], unresolvedFindingIds: [], purpose: "EXPORT_PATCH" }).value.id;
    const ex = () => e.h["C28/exportFeaturePatch"](e.as("arun"), { candidateHash: e.cand.bindingHash, decisionId: dec(), format: "GIT_PATCH", exportPolicyHash: exportPolicyHash() });
    assert.equal(ex().ok, true); const exportId = e.fs.getCandidate(e.cand.id)!.exports![0]!.id;
    // the permission is withdrawn
    e.svc.store.db.prepare("insert into access_deny(repo_root, prefix) values (?, ?)").run(e.repo, "src/export");
    const read = e.h["C28/readCandidateFile"](e.as("arun"), { candidateHash: e.cand.bindingHash, path: "src/export/csv.ts", representation: "CANDIDATE", download: true }); assert.equal(read.ok, false); assert.equal(read.error.code, "NOT_FOUND");
    const again = ex(); assert.equal(again.ok, false, "a new export of withdrawn content is refused"); assert.doesNotMatch(JSON.stringify(again), /src\/export|csv/);
    const dest = e.h["C28/checkPatchDestination"](e.as("arun"), { exportId, destinationSnapshot: { repositoryId: e.repo }, dirtyState: [] }); assert.equal(dest.ok, false, "an earlier export cannot be checked or applied after the permission is gone"); assert.doesNotMatch(JSON.stringify(dest), /src\/export|csv/);
    const pub = await e.h["C30/publishFeaturePR"](e.as("arun", "p1"), { proposalId: e.cand.id, decisionId: dec(), expectedHeadHash: e.cand.binding.candidateContentHash, destination: "acme/x:main" }); assert.equal(pub.ok, false); assert.match(pub.error.message, /access to part of this candidate was withdrawn/); assert.doesNotMatch(JSON.stringify(pub), /src\/export|csv/);
    const ws = e.h["C01/openFeatureWorkspace"](e.as("arun"), { requestId: e.rid }); assert.ok(!JSON.stringify(ws.value.value.review.files).includes("src/export"), "the review no longer lists the file");
  } finally { e.close(); }
});

test("AT-15 a mock-only run cannot satisfy a criterion that needs the real provider: the missing or unavailable real check is a named gap", async () => {
  const f = validationFixture();
  try {
    const req = f.fs.getRequest(f.request.requestId)!; req.contract!.acceptance[0]!.validationKinds = ["UNIT", "REAL_PROVIDER"]; f.fs.updateRequest(req.requestId, req.version, req);
    await run(f); const before = verdict(f); assert.notEqual(before.eligibility, "VERIFIED_WITHIN_SCOPE"); assert.ok(before.reasons.some((r) => /a1: REAL_PROVIDER is not mapped to a check/.test(r)), before.reasons.join("; "));
    // a REAL_PROVIDER check exists but no adapter can reach the provider: INCOMPLETE, never a pass
    const cur = f.fs.getRequest(f.request.requestId)!; const plan = { ...cur.validationPlan!, checks: [...cur.validationPlan!.checks, check("real-provider", "REAL_PROVIDER", "TARGETED", { argv: undefined, fullSuiteArgv: undefined })] };
    f.fs.updateRequest(cur.requestId, cur.version, { ...cur, validationPlan: plan }); await runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan, actor: "u", wallMs: 30_000 });
    const after = verdict(f); assert.notEqual(after.eligibility, "VERIFIED_WITHIN_SCOPE"); const r = f.fs.listEvidence(f.candidate.id).flatMap((e) => e.results).filter((x) => x.kind === "REAL_PROVIDER").at(-1)!; assert.equal(r.status, "INCOMPLETE"); assert.match(r.gaps.join(), /adapter unavailable/);
  } finally { f.close(); }
});

test("AT-16 a migration that fails on historical records fails its criterion, blocks, and the diagnostics say to fix the data path, not the check", async () => {
  const f = validationFixture();
  try {
    const cur = f.fs.getRequest(f.request.requestId)!; const plan = { ...cur.validationPlan!, checks: [...cur.validationPlan!.checks, check("migration", "MIGRATION", "TARGETED")] };
    f.fs.updateRequest(cur.requestId, cur.version, { ...cur, validationPlan: plan }); f.runner.response = (r: RunRequest): Partial<RunResult> => r.argv.includes("migration.js") ? { status: "FAILED", exitCode: 1, stdout: "migrating 3 historical rows\nrow 2: constraint violated\n" } : {};
    await runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan, actor: "u", wallMs: 30_000 });
    const v = verdict(f); assert.equal(v.eligibility, "BLOCKED"); assert.ok(v.reasons.some((r) => /migration: FAIL/.test(r)), v.reasons.join("; "));
    const { validationDashboard } = await import("../src/feature/dashboard.ts"); const d = validationDashboard(f.fs, f.fs.getRequest(f.request.requestId)!, f.fs.getCandidate(f.candidate.id)!, v);
    const diag = d.diagnostics.find((x) => x.checkId === "migration")!; assert.equal(diag.status, "FAIL"); assert.match(diag.guidance, /Change the code so the check passes/);
  } finally { f.close(); }
});

test("AT-25 an exhausted runner budget leaves the remaining mandatory checks INCOMPLETE with that reason; none is dropped and nothing is verified", async () => {
  const f = validationFixture(); const slow = f.runner; const orig = slow.run.bind(slow); slow.run = async (req) => { await new Promise((r) => setTimeout(r, 120)); return orig(req); };
  try {
    const evidence = await run(f, 200); assert.equal(evidence.length, f.plan.checks.length, "every mandatory check has a record, run or not");
    const gaps = evidence.flatMap((e) => e.results).filter((r) => r.status === "INCOMPLETE"); assert.ok(gaps.length >= 1); assert.ok(gaps.every((r) => r.gaps.some((g) => /budget exhausted/.test(g))));
    assert.notEqual(verdict(f).eligibility, "VERIFIED_WITHIN_SCOPE"); assert.ok(verdict(f).reasons.some((r) => /INCOMPLETE|NOT_RUN/.test(r)));
  } finally { f.close(); }
});

test("AT-28 only the eligibility function's VERIFIED_WITHIN_SCOPE may carry the word 'verified': every other banner, label and export caption is a different sentence", async () => {
  for (const [k, text] of Object.entries(BANNER)) assert.equal(/verified/i.test(text), k === "VERIFIED_WITHIN_SCOPE", `${k}: ${text}`);
  assert.doesNotMatch(EXPORT_POLICY.incompleteLabel, /verified/i); assert.match(BANNER.VERIFIED_WITHIN_SCOPE, /not a claim that the change is bug-free/);
  const w = await boot({ edits: () => [createEdit("src/e.ts", "export {};\n")] });
  try { const v = deliverView(w.fs, w.fs.getRequest(w.rid)!, w.fs.getCandidate(w.cand.id)!); assert.notEqual(v.eligibility, "VERIFIED_WITHIN_SCOPE"); assert.doesNotMatch(v.label, /^Verified/); assert.ok(v.label.length > 0); } finally { w.close(); }
});

test("AT-29 an optional refactor outside the agreed scope is refused unless the scope is widened on purpose, and a file-count cap holds", async () => {
  const w = await boot({});
  try {
    const d = { fs: w.fs, store: w.svc.store, auth: none }; const snap = () => w.fs.getRequest(w.rid)!.source;
    const edits = [createEdit("src/export/csv.ts", "export const toCsv = () => '';\n"), createEdit("src/unrelated/tidy.ts", "export const tidy = 1;\n")];
    assert.throws(() => materializeCandidate(d, "arun", { requestId: w.rid, snapshot: snap(), edits, scope: { allowedPaths: ["src/export/"] }, idempotencyKey: "a" }), (e: any) => e.code === "FORBIDDEN" && /src\/unrelated\/tidy\.ts/.test(e.message));
    assert.throws(() => materializeCandidate(d, "arun", { requestId: w.rid, snapshot: snap(), edits, scope: { maxFilesChanged: 1 }, idempotencyKey: "b" }), (e: any) => e.code === "FORBIDDEN" && /more than|files/i.test(e.message));
    const ok = materializeCandidate(d, "arun", { requestId: w.rid, snapshot: snap(), edits: edits.slice(0, 1), scope: { allowedPaths: ["src/export/"] }, idempotencyKey: "c" }); assert.equal(ok.candidate.mutations.length, 1);
    const widened = materializeCandidate(d, "arun", { requestId: w.rid, snapshot: snap(), edits, scope: { allowedPaths: ["src/export/", "src/unrelated/"] }, idempotencyKey: "d" }); assert.equal(widened.candidate.mutations.length, 2);
  } finally { w.close(); }
});

test("AT-31 the feature slice depends on no general simulation, twin or campaign framework", () => {
  const dir = join(import.meta.dirname, "../src/feature"); const bad: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) for (const m of readFileSync(join(dir, f), "utf8").matchAll(/from\s+["']([^"']+)["']/g)) if (/(^|\/)(twin|campaign|simulat|counterfactual|workflow-twin)[^/]*$/i.test(m[1]!)) bad.push(`${f} imports ${m[1]}`);
  assert.deepEqual(bad, []);
});

test("AT-45 a file nobody asked for (no requirement behind it) keeps the result from being verified, while every other gate passes", async () => {
  const f = validationFixture();
  try {
    await run(f); assert.equal(verdict(f).eligibility, "VERIFIED_WITHIN_SCOPE", verdict(f).reasons.join("; "));
    const c = f.fs.getCandidate(f.candidate.id)!; f.fs.putCandidate({ ...c, mutations: [...c.mutations, { kind: "ADDED", newPath: "src/surprise.ts", afterHash: "x", requirementIds: [], taskIds: [], actionIds: [], attribution: "UNATTRIBUTED" }] });
    const v = verdict(f); assert.equal(v.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.deepEqual(v.reasons, ["mutation attribution is incomplete"]);
  } finally { f.close(); }
});
