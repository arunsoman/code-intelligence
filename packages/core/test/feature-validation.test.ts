import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { captureOutcomes, classifyBaseline, computeEligibility, runFeatureValidation, validationPlanHash } from "../src/feature/validation.ts";
import { validationFixture } from "./feature-validation-fixtures.ts";
import type { DecisionRecord, EvidenceRecord, RunResult } from "../src/feature/types.ts";
const run = (f: ReturnType<typeof validationFixture>) => runFeatureValidation({ store: f.fs, runner: f.runner }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs: 30000 });
const gate = (f: ReturnType<typeof validationFixture>, evidence: EvidenceRecord[], decisions: DecisionRecord[] = []) => computeEligibility({ request: f.fs.getRequest(f.request.requestId)!, candidate: f.fs.getCandidate(f.candidate.id)!, plan: f.plan, evidence, decisions });

test("2.J full per-target evidence binds the exact candidate, environment, fixtures, workload and oracle", async () => {
  const f = validationFixture(); try { const evidence = await run(f); assert.equal(evidence.length, f.plan.checks.length); assert.equal(gate(f, evidence).eligibility, "VERIFIED_WITHIN_SCOPE");
    for (const e of evidence) { assert.equal(e.manifest.contentHash, f.candidate.binding.candidateContentHash); assert.equal(e.manifest.harnessHash, validationPlanHash(f.plan)); assert.equal(e.validation?.reportComplete, true); assert.equal(e.manifest.modelIdentityHashes.length, 0, "deterministic execution does not claim an LLM ran"); }
    assert.equal(f.fs.listEvents(f.request.requestId).filter((e) => e.type === "ValidationCompleted").length, f.plan.checks.length);
  } finally { f.close(); }
});

test("AT-12 generated code and generated tests cannot establish an independent oracle", async () => {
  const f = validationFixture(); try { const r = f.fs.getRequest(f.request.requestId)!; r.contract!.acceptance[0].oracleOrigin = "GENERATED_UNREVIEWED"; f.fs.updateRequest(r.requestId, r.version, r);
    const evidence = await run(f); assert.equal(evidence.at(-1)!.results[0].status, "PASS_UNREVIEWED_ORACLE"); assert.equal(gate(f, evidence).eligibility, "REVIEW_ONLY_INCOMPLETE");
    f.fs.putCandidate({ ...f.candidate, oracleState: "PROPERTY_CHANGE_PENDING_REVIEW" }); assert.equal(gate(f, evidence).eligibility, "BLOCKED");
  } finally { f.close(); }
});

test("AT-21/22/77 changes to any execution identity or candidate invalidate eligibility", async () => {
  const f = validationFixture(); try { const evidence = await run(f);
    for (const key of ["contractHash", "contentHash", "environmentHash", "workloadHash", "fixtureHash", "toolchainHash", "oracleHash", "generationProvenanceHash", "buildHash"] as const) { const changed = structuredClone(evidence); changed[0].manifest[key] += "changed"; assert.notEqual(gate(f, changed).eligibility, "VERIFIED_WITHIN_SCOPE", key); }
    f.fs.putCandidate({ ...f.candidate, status: "STALE" }); assert.equal(gate(f, evidence).status, "STALE");
  } finally { f.close(); }
});

test("AT-74 frontend build failure stays separate and prevents tests, browser and performance execution", async () => {
  const f = validationFixture(); try { f.runner.response = (r) => r.argv.includes("frontend.js") ? { status: "FAILED", exitCode: 1 } : {};
    const evidence = await run(f); assert.equal(evidence[0].results[0].status, "PASS"); assert.equal(evidence[1].results[0].status, "FAIL"); assert.ok(evidence.slice(2).every((e) => e.results[0].status === "NOT_RUN")); assert.equal(f.runner.calls.length, 4); assert.equal(gate(f, evidence).eligibility, "BLOCKED");
  } finally { f.close(); }
});

test("AT-75/76 a created but unexecuted test, a skip or a partial rerun never becomes aggregate PASS", async () => {
  const f = validationFixture(); try { f.plan.checks.at(-1)!.expectedTests.push("new test never executed"); const evidence = await run(f); assert.equal(evidence.at(-1)!.results[0].status, "INCOMPLETE"); assert.ok(evidence.at(-1)!.validation!.outcomes.some((o) => o.name === "new test never executed" && o.state === "NOT_RUN")); assert.notEqual(gate(f, evidence.slice(-1)).eligibility, "VERIFIED_WITHIN_SCOPE");
    f.runner.response = () => ({ stdout: "ok 1 - accepts current tenant # SKIP not configured\n# tests 1\n" }); const skipped = await run(f); assert.equal(skipped.at(-1)!.results[0].status, "INCOMPLETE");
  } finally { f.close(); }
});

test("AT-63 a scoped waiver remains visible and does not turn a failure into PASS", async () => {
  const f = validationFixture(); try { f.runner.response = (r) => r.argv.includes("tests.js") ? { status: "FAILED", exitCode: 1, stdout: "✖ accepts current tenant (1ms)\nℹ tests 1\n" } : {}; const evidence = await run(f);
    const waiver: DecisionRecord = { schemaVersion: 1, id: "waiver", requestId: f.request.requestId, kind: "WAIVER", answer: "review only", actorId: "u", authorityBindingId: "policy-owner", contractVersion: 1, affectedIds: ["a1"], rationale: "temporary", createdAt: f.request.createdAt, waiver: { owner: "u", criteria: ["a1"], expiresAt: "2999-01-01T00:00:00Z", residualRisk: "test fails" } };
    assert.equal(gate(f, evidence).eligibility, "BLOCKED"); const decision = gate(f, evidence, [waiver]); assert.equal(decision.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.ok(decision.reasons.some((r) => r.includes("waived by waiver"))); assert.equal(evidence.at(-1)!.results[0].status, "FAIL");
  } finally { f.close(); }
});

test("AT-64 baseline failures and flaky results are classified separately without weakening tests", async () => {
  const f = validationFixture(); try { let calls = 0; f.runner.response = () => (++calls === 1 ? { status: "FAILED", exitCode: 1 } : {}); const evidence = await run(f); assert.equal(evidence[0].validation!.baselineHealth, "PREEXISTING_FAILURE"); assert.equal(evidence[0].results[0].status, "PASS"); assert.equal(gate(f, evidence).eligibility, "REVIEW_ONLY_INCOMPLETE");
    const r: RunResult = { status: "PASSED", exitCode: 0, stdout: "", stderr: "", isolation: "CONTAINER", omissions: [], truncated: false, usage: { wallMs: 1 } };
    assert.equal(classifyBaseline(r, [{ name: "flaky", state: "FLAKY" }], true), "FLAKY");
  } finally { f.close(); }
});

test("AT-65 protected fixtures stop all execution; synthetic fixture identity is required", async () => {
  const f = validationFixture(); try { f.plan.testData.kind = "PROTECTED"; const evidence = await run(f); assert.equal(f.runner.calls.length, 0); assert.ok(evidence.every((e) => e.results[0].status === "INCOMPLETE")); assert.equal(gate(f, evidence).eligibility, "BLOCKED"); } finally { f.close(); }
});

test("2.J unknown test coverage selects the full suite and preserves budget, infrastructure and truncation gaps", async () => {
  const f = validationFixture(); try { f.plan.coverageKnown = false; await run(f); assert.ok(f.runner.calls.some((r) => r.argv.includes("all-tests.js"))); f.runner.calls = []; f.runner.response = () => ({ status: "TIMEOUT", exitCode: null, truncated: true }); const evidence = await run(f); assert.equal(evidence[0].results[0].status, "INCOMPLETE"); assert.equal(evidence[0].validation!.runState, "TIMEOUT"); assert.notEqual(gate(f, evidence).eligibility, "VERIFIED_WITHIN_SCOPE");
    writeFileSync(join(f.root, "src/app.ts"), "changed while running"); f.runner.calls = []; const stale = await run(f); assert.equal(f.runner.calls.length, 0); assert.ok(stale.every((e) => e.results[0].status === "STALE"));
  } finally { f.close(); }
});

test("2.J omitted mandatory gates and unsupported applicability cannot be hidden by a green subset", async () => {
  const f = validationFixture(); try { const evidence = await run(f); f.plan.checks = f.plan.checks.filter((c) => c.kind !== "SECURITY"); const decision = gate(f, evidence); assert.equal(decision.eligibility, "REVIEW_ONLY_INCOMPLETE"); assert.ok(decision.reasons.some((r) => r.includes("mandatory SECURITY")));
    const check = { ...f.plan.checks.at(-1)!, expectedTests: [] }; const capture = captureOutcomes({ status: "PASSED", exitCode: 0, stdout: "", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } }, check); assert.equal(capture.complete, false);
  } finally { f.close(); }
});

test("2.J (#87) a fenced-out validation job stops writing evidence at the next check", async () => {
  const f = validationFixture(); try {
    let lost = false; let n = 0; const real = f.runner;
    const runner = { ...real, run: async (...a: Parameters<typeof real.run>) => { if (++n === 3) lost = true; return real.run(...a); } } as typeof real;
    const before = () => { if (lost) throw new Error("fenced"); };
    await assert.rejects(runFeatureValidation({ store: f.fs, runner, beforeSave: before }, { candidateId: f.candidate.id, plan: f.plan, actor: "u", wallMs: 30000 }), /fenced/);
    assert.ok(f.fs.listEvidence(f.candidate.id).length < f.plan.checks.length);
  } finally { f.close?.(); }
});
