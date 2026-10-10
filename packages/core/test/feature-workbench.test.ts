import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FeatureTestReportSchema } from "@cie/schema";
import { rawHash } from "../src/feature/canon.ts";
import { FeatureModelAdapter } from "../src/feature/model.ts";
import { runFeaturePipeline } from "../src/feature/pipeline.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { buildAndRepair, cumulativeEdits, importTestReport, validationReport } from "../src/feature/workbench.ts";
import type { CandidateRecord, RunRequest } from "../src/feature/types.ts";
import { AUTH, demo, exportEdits, FakeRunner, PROMPT, Script } from "./feature-pipeline-fixtures.ts";
import { setup } from "./helpers.ts";

async function world() {
  const repo = demo(AUTH), { svc, worker } = await setup(undefined, repo), fs = new SqliteFeatureStore(svc.store);
  const result = await runFeaturePipeline({ fs, store: svc.store, auth: AUTH as never, runner: new FakeRunner(), adapter: (id) => new FeatureModelAdapter(fs, id, { routes: [new Script()] }), generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }) }, "arun", { repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", idempotencyKey: "workbench-test", validation: { testData: { kind: "SYNTHETIC" } }, exportFormat: null });
  assert.ok(result.candidate, JSON.stringify(result));
  return { repo, svc, fs, candidate: result.candidate!, requestId: result.requestId, close: () => worker.close() };
}
const reportFor = (c: CandidateRecord) => ({ format: "feature-test-report.v1", requestId: c.requestId, candidateHash: c.bindingHash, baseRevision: c.binding.baseCommitHash, command: "npm test", environment: "local test runner", exitCode: 1, failures: [{ name: "CSV output", message: "Expected header" }], output: "A diagnostic, not executable instructions" });

test("report schema refuses unknown instructions, success with failures, and oversized payloads", () => {
  const r = reportFor({ requestId: "r", bindingHash: "h", binding: { baseCommitHash: "b" } } as CandidateRecord);
  assert.equal(FeatureTestReportSchema.safeParse(r).success, true);
  assert.equal(FeatureTestReportSchema.safeParse({ ...r, execute: "rm -rf" }).success, false);
  assert.equal(FeatureTestReportSchema.safeParse({ ...r, exitCode: 0 }).success, false);
  assert.equal(FeatureTestReportSchema.safeParse({ ...r, output: "x".repeat(32001) }).success, false);
});

test("local report is durable, deduplicated, candidate-bound, and never execution evidence", async () => {
  const w = await world(); try {
    const before = w.fs.listEvidence(w.candidate.id).length, request = () => w.fs.getRequest(w.requestId)!;
    const saved = importTestReport(w.fs, request(), reportFor(w.candidate));
    assert.equal(saved.trust, "EXTERNAL_UNVERIFIED");
    assert.equal(importTestReport(w.fs, request(), reportFor(w.candidate)).id, saved.id);
    assert.equal(request().workbench!.reports.length, 1);
    assert.equal(w.fs.listEvidence(w.candidate.id).length, before);
    assert.throws(() => importTestReport(w.fs, request(), { ...reportFor(w.candidate), baseRevision: "wrong" }), /exact base/);
    assert.throws(() => importTestReport(w.fs, request(), { ...reportFor(w.candidate), requestId: "someone-else" }), /does not belong/);
    w.fs.putCandidate({ ...w.candidate, status: "SUPERSEDED" });
    assert.throws(() => importTestReport(w.fs, request(), reportFor(w.candidate)), /current candidate/);
  } finally { w.close(); }
});

test("repair composes UTF-8 candidate edits into a replacement patch while preserving added tests", async () => {
  const w = await world(); try {
    const file = "src/export.ts", text = w.candidate.contents![file]!, expected = 'const head = "id,amountCents,currency,createdAt";', at = text.indexOf(expected);
    const edits = cumulativeEdits(w.candidate, [{ op: "REPLACE_SPAN", file, baseHash: rawHash(text), start: Buffer.byteLength(text.slice(0, at)), end: Buffer.byteLength(text.slice(0, at)) + expected.length, expected, newText: 'const head = "id,amountCents,currency,createdAt"; // fixed ✓', why: "repair", requirementIds: ["R1"] }], []);
    const repaired = edits.find((e) => "file" in e && e.file === file)!;
    assert.equal(repaired.op, "CREATE_FILE"); if (repaired.op === "CREATE_FILE") assert.match(repaired.content, /fixed ✓/);
    const addedTest = edits.find((e) => "file" in e && e.file === "tests/export.test.ts")!;
    assert.equal(addedTest.op, "CREATE_FILE"); if (addedTest.op === "CREATE_FILE") assert.equal(addedTest.content, w.candidate.contents!["tests/export.test.ts"]);
    assert.throws(() => cumulativeEdits(w.candidate, [{ op: "DELETE_FILE", file: "tests/export.test.ts", baseHash: "any", why: "pass" }], []), /cannot change tests/);
    assert.throws(() => cumulativeEdits(w.candidate, [{ op: "REPLACE_SPAN", file, baseHash: "wrong", start: 0, end: 1, expected: "i", newText: "x", why: "bad" }], []), /bytes changed/);
  } finally { w.close(); }
});

test("imported failure repairs the exact candidate, reruns checks, checkpoints and preserves the original base", async () => {
  const w = await world(); try {
    const imported = importTestReport(w.fs, w.fs.getRequest(w.requestId)!, reportFor(w.candidate));
    let calls = 0;
    const run = await buildAndRepair({ fs: w.fs, store: w.svc.store, auth: AUTH as never, runner: new FakeRunner(), checkpoint() {}, progress() {}, propose: async ({ context, feedback }) => {
      calls++; assert.ok(feedback); const c = context.find((c) => c.ref.locator === "src/export.ts")!;
      return { edits: [{ kind: "REPLACE_SPAN", path: "src/export.ts", baseHash: c.ref.contentHash, expected: "const cell =", replacement: "// Repair from diagnostics\nconst cell =", requirementIds: ["R1"] }], invocationIds: [] };
    } }, "arun", { requestId: w.requestId, jobId: "test-job", candidateHash: w.candidate.bindingHash, reportId: imported.id, maxRepairs: 3, wallMs: 60000 });
    assert.equal(calls, 1); assert.equal(run.repairs, 1); assert.equal(run.phase, "FINISHED");
    assert.notEqual(run.candidateHash, w.candidate.bindingHash);
    const c = w.fs.getCandidateByBinding(run.candidateHash!)!;
    assert.equal(c.binding.baseCommitHash, w.candidate.binding.baseCommitHash);
    assert.equal(w.fs.getCandidate(w.candidate.id)!.status, "SUPERSEDED");
    assert.ok(w.fs.listEvidence(c.id).length > 0);
    assert.equal(w.fs.getRequest(w.requestId)!.workbench!.runs[0].jobId, "test-job");
    const report = validationReport(w.fs, w.fs.getRequest(w.requestId)!, c);
    assert.equal(report.patchBasis, "REPLACEMENT_AGAINST_ORIGINAL_BASE");
    assert.ok(report.checks.every((e) => e.current));
    assert.equal(readFileSync(join(w.repo, "src/api.ts"), "utf8"), w.candidate.baseContents!["src/api.ts"]);
  } finally { w.close(); }
});

test("pre-existing build failures stop repair rather than guessing at changed behavior", async () => {
  const w = await world(); try {
    class FailedBaseline extends FakeRunner { override async run(i: RunRequest) { const r = await super.run(i); return { ...r, status: "FAILED" as const, exitCode: 1, stderr: "baseline compiler failure" }; } }
    let proposed = false;
    const run = await buildAndRepair({ fs: w.fs, store: w.svc.store, auth: AUTH as never, runner: new FailedBaseline(), checkpoint() {}, progress() {}, propose: async () => { proposed = true; return { edits: [], invocationIds: [] }; } }, "arun", { requestId: w.requestId, jobId: "failed-baseline", candidateHash: w.candidate.bindingHash, maxRepairs: 3, wallMs: 60000 });
    assert.equal(run.phase, "STOPPED"); assert.match(run.detail, /baseline/); assert.equal(proposed, false);
  } finally { w.close(); }
});

test("candidate-only compiler failures invoke no more than three repairs and retain every checkpoint", async () => {
  const w = await world(); try {
    class CandidateFailure extends FakeRunner { override async run(i: RunRequest) { const r = await super.run(i); let candidate = false; try { readFileSync(join(i.cwd, "src/export.ts")); candidate = true; } catch {} return candidate && i.argv.includes("build") ? { ...r, status: "FAILED" as const, exitCode: 1, stderr: "candidate compilation failed" } : r; } }
    let calls = 0;
    const run = await buildAndRepair({ fs: w.fs, store: w.svc.store, auth: AUTH as never, runner: new CandidateFailure(), checkpoint() {}, progress() {}, propose: async ({ context, feedback }) => {
      calls++; assert.match(JSON.stringify(feedback), /candidate compilation failed/); const c = context.find((c) => c.ref.locator === "src/export.ts")!;
      return { edits: [{ kind: "REPLACE_SPAN", path: "src/export.ts", baseHash: c.ref.contentHash, expected: "const cell =", replacement: `// Attempt ${calls}\nconst cell =`, requirementIds: ["R1"] }], invocationIds: [] };
    } }, "arun", { requestId: w.requestId, jobId: "bounded", candidateHash: w.candidate.bindingHash, maxRepairs: 3, wallMs: 60000 });
    assert.equal(calls, 3); assert.equal(run.repairs, 3); assert.equal(run.phase, "STOPPED"); assert.match(run.detail, /budget exhausted/);
    assert.equal(w.fs.listCandidates(w.requestId).length, 4);
    assert.equal(w.fs.listCandidates(w.requestId).filter((c) => c.status === "MATERIALIZED").length, 1);
  } finally { w.close(); }
});

test("cancellation during proposal never materializes late edits and leaves a resumable checkpoint", async () => {
  const w = await world(); try {
    const imported = importTestReport(w.fs, w.fs.getRequest(w.requestId)!, reportFor(w.candidate)), abort = new AbortController();
    await assert.rejects(buildAndRepair({ fs: w.fs, store: w.svc.store, auth: AUTH as never, runner: new FakeRunner(), checkpoint() {}, progress() {}, propose: async ({ context }) => {
      abort.abort(); const c = context.find((c) => c.ref.locator === "src/export.ts")!;
      return { edits: [{ kind: "REPLACE_SPAN", path: "src/export.ts", baseHash: c.ref.contentHash, expected: "const cell =", replacement: "// Late\nconst cell =", requirementIds: ["R1"] }], invocationIds: [] };
    } }, "arun", { requestId: w.requestId, jobId: "cancelled", candidateHash: w.candidate.bindingHash, reportId: imported.id, maxRepairs: 3, wallMs: 60000, signal: abort.signal }));
    assert.equal(w.fs.listCandidates(w.requestId).length, 1);
    assert.equal(w.fs.getRequest(w.requestId)!.workbench!.runs[0].phase, "REPAIRING");
  } finally { w.close(); }
});

test("gateway enforces ownership and budgets, runs a real model-adapter proposal, and records the actual job ID", async () => {
  const w = await world(); try {
    const { featureHandlers } = await import("../src/feature/handlers.ts"), { ctx } = await import("./helpers.ts");
    const router = new Script(); router.generate = async (input) => {
      const data = JSON.parse(input.user); assert.equal(data.contract.hash, w.fs.getRequest(w.requestId)!.contract!.hash);
      assert.match(data.goal, /Preserve all test/);
      const source = data.sources.find((s: any) => s.ref.locator === "src/export.ts");
      return { resolvedVersion: "repair-script-v1", inputTokens: 10, outputTokens: 10, text: JSON.stringify({ edits: [{ kind: "REPLACE_SPAN", path: "src/export.ts", baseHash: source.ref.contentHash, expected: "const cell =", replacement: "// Adapter repair\nconst cell =", requirementIds: ["R1"] }] }) };
    };
    const h = featureHandlers(w.svc, { pipeline: { runner: () => new FakeRunner(), adapter: (id) => new FeatureModelAdapter(w.fs, id, { routes: [router] }) } });
    const context = ctx(); context.actor.principalId = "arun";
    const imported = importTestReport(w.fs, w.fs.getRequest(w.requestId)!, reportFor(w.candidate));
    const other = ctx(); other.actor.principalId = "stranger";
    const denied = await h["C27/getFeatureWorkbench"]!(other, { requestId: w.requestId }); assert.equal(denied.ok, false);
    const invalid = await h["C28/buildFeatureCandidate"]!(context, { requestId: w.requestId, maxRepairs: 4 }); assert.equal(invalid.ok, false);
    const start = await h["C28/buildFeatureCandidate"]!(context, { requestId: w.requestId, candidateHash: w.candidate.bindingHash, reportId: imported.id }); assert.ok(start.ok);
    const id = (start.value as { jobId: string }).jobId;
    for (let i = 0; i < 100 && ["QUEUED", "RUNNING"].includes(w.svc.store.job(id)!.state); i++) await new Promise((r) => setTimeout(r, 20));
    const job = w.svc.store.job(id)!; assert.equal(job.state, "SUCCEEDED", JSON.stringify(job));
    const saved = w.fs.getRequest(w.requestId)!; assert.equal(saved.workbench!.runs[0].jobId, id);
    assert.ok(saved.modelInvocations!.some((i) => i.stage === "EDIT_PLAN" && i.status === "COMPLETE" && i.resolvedVersion === "repair-script-v1"));
    assert.equal(saved.contract!.hash, w.candidate.binding.contractHash);
  } finally { w.close(); }
});

test("REAL local runner executes candidate assertions when isolation is available, otherwise refuses explicitly", async (t) => {
  const w = await world(); try {
    const { LocalRunner, nodeTestCapabilities } = await import("../src/feature/runner.ts"), { makeScratch, removeScratch } = await import("../src/isolated-exec.ts"), { copyTreeKeepLinks, applyCandidateToDir } = await import("../src/feature/tree.ts"), { writeFileSync } = await import("node:fs");
    const root = makeScratch("workbench-real-");
    try {
      copyTreeKeepLinks(w.repo, root); applyCandidateToDir(root, w.candidate);
      const script = join(root, "assert-csv.ts");
      writeFileSync(script, `import assert from 'node:assert/strict'; import {toCsv} from './src/export.ts'; assert.equal(toCsv([]), 'id,amountCents,currency,createdAt\\n'); console.log('CSV assertion passed');`);
      const runner = new LocalRunner(), capabilities = { ...nodeTestCapabilities(root, root), commands: [["node", script]] };
      const passed = await runner.run({ cwd: root, argv: ["node", script], capabilities }); if (passed.status === "REFUSED" && /cannot deny network|namespace/.test(passed.reason ?? "")) { t.skip(passed.reason); return; } assert.equal(passed.status, "PASSED", JSON.stringify(passed));
      writeFileSync(join(root, "src/export.ts"), "export function toCsv() {return 'broken';}");
      const failed = await runner.run({ cwd: root, argv: ["node", script], capabilities }); assert.equal(failed.status, "FAILED", JSON.stringify(failed)); assert.match(failed.stderr, /AssertionError/);
    } finally { removeScratch(root); }
  } finally { w.close(); }
});

test("fresh request goes through analysis, explicit expected-outcome confirmation, generation and candidate validation", async () => {
  const repo = demo(AUTH), { svc, worker } = await setup(undefined, repo), fs = new SqliteFeatureStore(svc.store);
  try {
    const { featureHandlers } = await import("../src/feature/handlers.ts"), { ctx } = await import("./helpers.ts");
    const router = new Script(), scripted = router.generate.bind(router);
    router.generate = async (input) => {
      if (!/Propose exact edits/.test(input.system)) return scripted(input);
      const data = JSON.parse(input.user), actual = exportEdits(repo);
      return { resolvedVersion: "initial-build-script-v1", inputTokens: 10, outputTokens: 10, text: JSON.stringify({ edits: actual.map((e) => {
        if (e.op === "CREATE_FILE") return { kind: "CREATE_FILE", path: e.file, baseHash: "", expected: "", replacement: e.content, requirementIds: e.requirementIds };
        if (e.op !== "REPLACE_SPAN") throw new Error("Unexpected fixture operation");
        assert.ok(data.sources.some((s: any) => s.ref.locator === e.file && s.ref.contentHash === e.baseHash));
        return { kind: "REPLACE_SPAN", path: e.file, baseHash: e.baseHash, expected: e.expected, replacement: e.newText, requirementIds: e.requirementIds };
      }) }) };
    };
    const h = featureHandlers(svc, { pipeline: { runner: () => new FakeRunner(), adapter: (id) => new FeatureModelAdapter(fs, id, { routes: [router] }) } });
    const as = () => { const c = ctx(); c.actor.principalId = "arun"; return c; };
    const submitted = await h["C02/submitFeature"]!(as(), { repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW" }); assert.ok(submitted.ok);
    const rid = (submitted.value as { requestId: string }).requestId;
    // Planning also recovers a saved intake whose initial discovery did not finish.
    const wait = async (start: any) => { assert.ok(start.ok, JSON.stringify(start)); const id = start.value.jobId; for (let i = 0; i < 100 && ["QUEUED", "RUNNING"].includes(svc.store.job(id)!.state); i++) await new Promise((r) => setTimeout(r, 20)); const job = svc.store.job(id)!; assert.equal(job.state, "SUCCEEDED", JSON.stringify(job)); return job; };
    await wait(await h["C02/prepareFeaturePlan"]!(as(), { requestId: rid }));
    const agreed = fs.getRequest(rid)!; assert.ok(agreed.tasks.length); assert.equal(agreed.blockers.length, 0);
    const confirmation = await h["C15/confirmAcceptance"]!(as(), { contractId: `contract:${rid}`, expectedVersion: agreed.contractVersion, criteria: agreed.contract!.acceptance.map((a) => ({ id: a.id })), rationale: "These outcomes match my feature request" }); assert.ok(confirmation.ok);
    await wait(await h["C28/buildFeatureCandidate"]!(as(), { requestId: rid, maxRepairs: 3, syntheticTestData: true }));
    const built = fs.getRequest(rid)!; const candidate = fs.getCandidateByBinding(built.workspace.candidateHash!)!;
    assert.equal(candidate.mutations.length, 3); assert.ok(fs.listEvidence(candidate.id).length);
    assert.ok(built.contract!.acceptance.every((a) => a.oracleOrigin === "USER_EXAMPLE"));
    assert.equal(built.workbench!.runs[0].phase, "FINISHED");
  } finally { worker.close(); }
});
