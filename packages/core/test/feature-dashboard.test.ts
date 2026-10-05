import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { materializeCandidate } from "../src/feature/candidate.ts";
import { rawHash } from "../src/feature/canon.ts";
import { deliverView, validationDashboard } from "../src/feature/dashboard.ts";
import { importsModule } from "../src/feature/test-links.ts";
import { defaultValidationPlan, runFeatureValidation } from "../src/feature/validation.ts";
import type { AcceptanceCriterion } from "../src/feature/types.ts";
import { boot, createEdit, none } from "./feature-boot.ts";
import { validationFixture } from "./feature-validation-fixtures.ts";

const crit = (id: string, requirementIds: string[]): AcceptanceCriterion => ({ id, requirementIds, scenario: "s", expectedOutcome: `expected ${id}`, mandatory: true, oracleSourceRefs: [], oracleOrigin: "USER_EXAMPLE", validationKinds: ["UNIT"] });
async function world() {
  const b = await boot({ acceptance: [crit("ac1", ["r1"])], edits: (repo) => {
    const text = readFileSync(join(repo, "src/payments/fraud.ts"), "utf8"); const first = text.split("\n")[0]!;
    return [createEdit("src/export/csv.ts", "export const toCsv = () => '';\n"), createEdit("tests/csv.test.ts", "import { toCsv } from \"../src/export/csv\";\nimport assert from \"node:assert/strict\";\nimport test from \"node:test\";\ntest(\"exports csv\", () => { assert.strictEqual(toCsv(), ''); });\n"),
      { op: "REPLACE_SPAN", file: "src/payments/fraud.ts", baseHash: rawHash(text), start: 0, end: Buffer.byteLength(first), expected: first, newText: `${first} // touched`, why: "touch", requirementIds: ["r1"] }];
  } });
  return b;
}

test("PF-074/AT-72 related tests carry their basis: explicit for attributed tests, static for existing tests that import a changed file, never observed coverage", async () => {
  assert.ok(importsModule('import { a } from "../src/export/csv";', "src/export/csv.ts")); assert.ok(importsModule("const x = require('./csv.js')", "src/export/csv.ts")); assert.ok(!importsModule('import { a } from "../src/export/other";', "src/export/csv.ts"));
  const w = await world();
  try {
    const q = (extra: Record<string, unknown> = {}, who = "arun") => w.h["C23/queryRelatedTests"](w.as(who), { candidateHash: w.cand.bindingHash, ...extra });
    const r = q(); assert.equal(r.ok, true, JSON.stringify(r.error)); assert.equal(r.value.status, "PARTIAL");
    const by = Object.fromEntries(r.value.value.associations.map((a: any) => [a.testId, a]));
    assert.deepEqual([by["tests/csv.test.ts"].sourceStatus, by["tests/csv.test.ts"].basis, by["tests/csv.test.ts"].acceptanceIds, by["tests/csv.test.ts"].fileIds], ["ADDED", "EXPLICIT", ["ac1"], ["src/export/csv.ts"]]);
    assert.deepEqual([by["tests/payment-service.test.ts"].sourceStatus, by["tests/payment-service.test.ts"].basis, by["tests/payment-service.test.ts"].fileIds], ["EXISTING", "STATIC_DEPENDENCY", ["src/payments/fraud.ts"]]);
    assert.ok(r.value.value.associations.every((a: any) => a.basis !== "OBSERVED_COVERAGE"));
    assert.equal(r.value.value.coverage[0].state, "PARTIAL"); assert.deepEqual(r.value.value.coverage[0].unsupported, ["observed (runtime) coverage"]); assert.ok(r.value.value.gaps.some((g: string) => /runtime coverage was not observed/.test(g)));
    assert.deepEqual(q({ fileId: "src/payments/fraud.ts" }).value.value.associations.map((a: any) => a.testId), ["tests/payment-service.test.ts"]);
    assert.deepEqual(q({ acceptanceId: "ac1" }).value.value.associations.map((a: any) => a.testId), ["tests/csv.test.ts"]);
    assert.equal(q({ cursor: "stale|0" }).error.code, "STALE_REVISION"); assert.equal(q({}, "mallory").error.code, "NOT_FOUND");
  } finally { w.close(); }
});

test("PF-073/076 the Validate dashboard: per-target baseline vs candidate, per-test origin and status, gates, diagnostics with guidance, stale banner", async () => {
  const f = validationFixture();
  try {
    const run = () => runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs: 30000 });
    const req = () => f.fs.getRequest(f.request.requestId)!, cand = () => f.fs.getCandidate(f.candidate.id)!;
    let d = validationDashboard(f.fs, req(), cand()); assert.ok(d.diagnostics.length > 0 && d.diagnostics.every((x) => x.status === "NOT_RUN" && x.guidance)); assert.deepEqual(d.targets.map((t) => [t.target, t.candidate]), [["backend", "NOT_RUN"], ["frontend", "NOT_RUN"]]);
    await run(); d = validationDashboard(f.fs, req(), cand());
    assert.deepEqual(d.targets.map((t) => [t.target, t.baseline, t.candidate]), [["backend", "HEALTHY", "PASS"], ["frontend", "HEALTHY", "PASS"]]); assert.equal(d.diagnostics.length, 0); assert.equal(d.stale.stale, false);
    assert.ok(d.tests.length >= 1 && d.tests.every((t) => t.origin === "NOT_IN_CHANGED_FILES" && t.status === "PASS")); assert.ok(d.gates.every((g) => g.status === "PASS"));
    // the same test name inside a test file the candidate ADDED is attributed to the candidate
    const name = d.tests[0]!.name; const withTest = { ...cand(), contents: { ...cand().contents, "tests/new.test.ts": `test("${name}", () => {})` }, mutations: [...cand().mutations, { kind: "ADDED" as const, newPath: "tests/new.test.ts", requirementIds: [], taskIds: [], actionIds: [], attribution: "COMPLETE" as const }] };
    assert.equal(validationDashboard(f.fs, req(), withTest).tests[0]!.origin, "ADDED");
    // a failing frontend build is its own row with guidance that forbids weakening the check
    f.runner.response = (r) => r.argv.includes("frontend.js") ? { status: "FAILED", exitCode: 1 } : {}; await run(); d = validationDashboard(f.fs, req(), cand());
    assert.equal(d.targets.find((t) => t.target === "frontend")!.candidate, "FAIL"); assert.match(d.diagnostics.find((x) => x.checkId === "frontend")!.guidance, /Do not edit, skip or loosen a test/);
    // after the candidate is replaced, everything recorded is shown as stale rather than current
    f.fs.putCandidate({ ...cand(), status: "STALE" }); d = validationDashboard(f.fs, req(), cand()); assert.equal(d.stale.stale, true); assert.ok(d.stale.reasons.some((r) => /stale/.test(r))); assert.ok(d.targets.every((t) => t.candidate === "STALE" || t.candidate === "NOT_RUN"));
    assert.equal(d.banner.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.doesNotMatch(d.banner.text, /^Verified/);
  } finally { f.close(); }
});

test("PF-076 a repair that weakens a test the previous candidate added is a property change and blocks verification", async () => {
  const w = await boot({ edits: () => [createEdit("src/export/csv.ts", "export const toCsv = () => 1;\n"), createEdit("tests/csv.test.ts", "import assert from \"node:assert/strict\";\nimport test from \"node:test\";\ntest(\"exports csv\", () => { assert.strictEqual(1, 1); });\n")] });
  try {
    assert.equal(w.cand.oracleState, "ORIGINAL_PRESERVED"); // the repository already has tests and none was touched
    const redo = (test: string) => materializeCandidate({ fs: w.fs, store: w.svc.store, auth: none }, "arun", { requestId: w.rid, snapshot: w.fs.getRequest(w.rid)!.source, edits: [createEdit("src/export/csv.ts", "export const toCsv = () => 2;\n"), createEdit("tests/csv.test.ts", test)], idempotencyKey: `m-${test.length}` }).candidate;
    const same = redo("import assert from \"node:assert/strict\";\nimport test from \"node:test\";\ntest(\"exports csv\", () => { assert.strictEqual(1, 1); });\n// still strict\n");
    assert.deepEqual((same.oracleChanges ?? []).filter((c) => c.kind.startsWith("REPAIR_")), []);
    const weak = redo("import assert from \"node:assert/strict\";\nimport test from \"node:test\";\ntest(\"exports csv\", () => { assert.ok(1); });\n");
    assert.ok((weak.oracleChanges ?? []).some((c) => c.kind === "REPAIR_LOOSENED_MATCHER"), JSON.stringify(weak.oracleChanges)); assert.equal(weak.oracleState, "PROPERTY_CHANGE_PENDING_REVIEW");
    const gone = redo("export {};\n"); assert.ok((gone.oracleChanges ?? []).some((c) => c.kind.startsWith("REPAIR_REMOVED") || c.kind.startsWith("REPAIR_DELETED")), JSON.stringify(gone.oracleChanges));
    const rec = w.fs.getRequest(w.rid)!; const d = validationDashboard(w.fs, rec, w.fs.getCandidate(weak.id)!); assert.equal(d.repair.blocksVerification, true); assert.ok(d.repair.weakened.length >= 1);
  } finally { w.close(); }
});

test("PF-073/079 the Deliver view enables each effectful action only when its own preconditions hold, and gives the reason when not", async () => {
  const w = await world();
  try {
    const rec = () => w.fs.getRequest(w.rid)!; const cand = () => w.fs.getCandidate(w.cand.id)!;
    let v = deliverView(w.fs, rec(), cand()); assert.equal(v.eligibility, "BLOCKED"); assert.equal(v.actions[0]!.enabled, false); assert.match(v.actions[0]!.reason, /blocked candidate/); assert.match(v.label, /^BLOCKED/);
    const r = rec(); w.fs.updateRequest(w.rid, r.version, { ...r, validationPlan: { ...defaultValidationPlan(r, cand()), testData: { kind: "SYNTHETIC", fixtureHash: "f", generatorHash: "g", seed: "1" } } });
    v = deliverView(w.fs, rec(), cand()); assert.equal(v.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.match(v.label, /REVIEW ONLY/); assert.doesNotMatch(v.label, /^Verified/);
    const act = (n: string) => v.actions.find((a) => a.action === n)!;
    assert.equal(act("Export patch").enabled, true); assert.equal(act("Check destination").enabled, false); assert.match(act("Check destination").reason, /export a patch first/);
    assert.equal(act("Create draft PR").enabled, false); assert.match(act("Create draft PR").reason, /BUILD_PREVIEW mode/);
    assert.ok(v.decisionIds.export.startsWith("pf-canon-v1/") && v.decisionIds.publish.startsWith("pf-canon-v1/") && v.decisionIds.export !== v.decisionIds.publish);
    const ex = w.h["C28/exportFeaturePatch"](w.as("arun"), { candidateHash: w.cand.bindingHash, decisionId: v.decisionIds.export, format: "GIT_PATCH", exportPolicyHash: v.exportPolicyHash }); assert.equal(ex.ok, true, JSON.stringify(ex.error));
    v = deliverView(w.fs, rec(), cand()); assert.equal(v.exports.length, 1); assert.equal(v.actions.find((a) => a.action === "Check destination")!.enabled, true); assert.match(v.exports[0]!.label!, /REVIEW ONLY/);
    w.fs.putCandidate({ ...cand(), status: "STALE" }); v = deliverView(w.fs, rec(), cand()); assert.ok(v.actions.every((a) => !a.enabled));
    assert.equal(deliverView(w.fs, rec(), null).eligibility, "NO_CANDIDATE");
    const ws = w.h["C01/openFeatureWorkspace"](w.as("arun"), { requestId: w.rid }); assert.ok(ws.value.value.review.dashboard && ws.value.value.review.deliver);
  } finally { w.close(); }
});
