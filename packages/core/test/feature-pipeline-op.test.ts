import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FeatureModelAdapter } from "../src/feature/model.ts";
import { parseDeclaration, parsePipelineBody } from "../src/feature/pipeline-handlers.ts";
import { setupCheck } from "../src/feature/setup-check.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import { Forge } from "./feature-pipeline-forge.ts";
import { AUTH, demo, exportEdits, FakeRunner, PROMPT, Script } from "./feature-pipeline-fixtures.ts";
import { ctx, setup } from "./helpers.ts";

const FULL = { confirm: { criteria: "ALL", rationale: "these are the outcomes I want" }, releasePlan: { applicability: "APPLICABLE", revertRunbook: "revert the draft PR" },
  validation: { fidelity: "REPRESENTATIVE", dependencies: "AVAILABLE", environmentLabel: "test-double", testData: { kind: "SYNTHETIC" }, performanceApplicable: false } };

async function world(over: Record<string, unknown> = {}) {
  const repo = demo(AUTH); const { svc, worker } = await setup(undefined, repo); const fs = new SqliteFeatureStore(svc.store); const router = new Script(); const runner = new FakeRunner();
  const { featureHandlers } = await import("../src/feature/handlers.ts");
  const h = featureHandlers(svc, { pipeline: { runner: () => runner, adapter: (rid: string) => new FeatureModelAdapter(fs, rid, { routes: [router], egress: "LOCAL_ONLY" }), generateEdits: async () => ({ edits: exportEdits(repo), invocationIds: [] }), probes: { docker: () => ({ daemon: true, image: true }), gh: () => ({ ok: true, detail: "x" }), ollama: async () => ({ reachable: true, models: ["m"] }) }, ...over } }) as Record<string, (c: any, b: any) => any>;
  const as = (p: string, idem?: string) => { const c = ctx(idem); return { ...c, actor: { ...c.actor, principalId: p } }; };
  const wait = async (jobId: string) => { for (let i = 0; i < 300; i++) { const j = svc.store.job(jobId); if (j && !["QUEUED", "RUNNING"].includes(j.state)) return j; await new Promise((r) => setTimeout(r, 50)); } throw new Error("job did not finish"); };
  return { repo, svc, fs, h, as, wait, runner, close: () => worker.close() };
}
const body = (repo: string, over: Record<string, unknown> = {}) => ({ repositoryId: repo, text: PROMPT, mode: "BUILD_PREVIEW", ...FULL, ...over });

test("4.1 C02/runFeaturePipeline runs the slice as a job and returns a summary that carries no file contents or prompt text", async () => {
  const w = await world();
  try {
    const r = w.h["C02/runFeaturePipeline"](w.as("arun", "run-1"), body(w.repo)); assert.equal(r.ok, true, JSON.stringify(r.error));
    const job = await w.wait(r.value.jobId); assert.equal(job.state, "SUCCEEDED", JSON.stringify(job)); const out = (job.result as any).value;
    assert.equal(out.stop, "COMPLETE"); assert.equal(out.decision.eligibility, "VERIFIED_WITHIN_SCOPE", out.decision.reasons.join("; ")); assert.equal(out.isolation, "CONTAINER");
    assert.deepEqual(out.candidate.files.map((f: any) => f.path).sort(), ["src/api.ts", "src/export.ts", "tests/export.test.ts"]);
    const text = JSON.stringify(out); assert.doesNotMatch(text, /export function toCsv|Support staff must not/, "no file contents or prompt wording leave the gateway"); assert.ok(out.steps.some((s: any) => s.step === "VALIDATE"));
    // the same key and body is the same job, not a second run
    const again = w.h["C02/runFeaturePipeline"](w.as("arun", "run-1"), body(w.repo)); assert.equal(again.value.jobId, r.value.jobId); assert.equal(w.fs.listRequests(w.repo).length, 1);
  } finally { w.close(); }
});

test("4.1 C02/runFeaturePipeline refuses what it cannot run before any job exists: unknown fields, bad declarations, unindexed repositories, no key", async () => {
  const w = await world();
  try {
    const call = (b: Record<string, unknown>, key = "k", who = "arun") => w.h["C02/runFeaturePipeline"](w.as(who, key), b);
    assert.equal(call({ ...body(w.repo), surprise: 1 }).error.code, "INVALID_SCHEMA"); assert.equal(call({ ...body(w.repo), mode: "YOLO" }).error.code, "INVALID_SCHEMA");
    assert.equal(call({ ...body(w.repo), validation: { fidelity: "PERFECT" } }).error.code, "INVALID_SCHEMA"); assert.equal(call({ ...body(w.repo), validation: { testData: { kind: "AUTHORIZED_REDACTED" } } }).error.code, "INVALID_SCHEMA");
    assert.equal(call({ ...body(w.repo), confirm: { criteria: "ALL" } }).error.code, "INVALID_SCHEMA"); assert.equal(call({ ...body(w.repo), answers: { q: "" } }).error.code, "INVALID_SCHEMA");
    assert.equal(call({ ...body("/etc") }).error.code, "NOT_FOUND"); assert.equal(call(body(w.repo), "").error.code, "INVALID_SCHEMA");
    assert.equal(w.fs.listRequests(w.repo).length, 0, "nothing was created by a refused call");
    // another person's run is their own: a request id never crosses principals
    const a = await w.wait(call(body(w.repo), "pa").value.jobId); const b = await w.wait(call(body(w.repo), "pb", "bob").value.jobId);
    assert.notEqual((a.result as any).value.requestId, (b.result as any).value.requestId);
    assert.deepEqual(parsePipelineBody({ repositoryId: "r", text: "t", mode: "PLAN" }), { repositoryId: "r", text: "t", mode: "PLAN", idempotencyKey: "" });
    assert.equal(parseDeclaration(undefined), undefined);
  } finally { w.close(); }
});

const conflicting = () => { const r = new Script(); r.generate = async (req) => {
  const base = { resolvedVersion: "v", inputTokens: 1, outputTokens: 1 };
  if (/Draft acceptance/.test(req.system)) return { ...base, text: JSON.stringify({ acceptance: [{ id: "A1", requirementIds: ["R1"], scenario: "s", expectedOutcome: "e", mandatory: true }, { id: "A2", requirementIds: ["R2"], scenario: "s", expectedOutcome: "e", mandatory: true }], assumptions: [] }) };
  if (/Propose exact edits/.test(req.system)) return { ...base, text: JSON.stringify({ edits: [] }) };
  return { ...base, text: JSON.stringify({ requirements: [{ id: "R1", text: "Admins must export all transactions.", type: "FUNCTIONAL", sourceIndex: 0, actorIds: ["admin"], conditions: [], dependsOn: [] }, { id: "R2", text: "Admins must never export transactions.", type: "FUNCTIONAL", sourceIndex: 0, actorIds: ["admin"], conditions: [], dependsOn: [] }] }) };
}; return r; };

test("4.1 a pipeline job stops at an open question and returns the question; nothing is built while it is open", async () => {
  const router = conflicting(); let fsRef!: SqliteFeatureStore;
  const w = await world({ adapter: (rid: string) => new FeatureModelAdapter(fsRef, rid, { routes: [router], egress: "LOCAL_ONLY" }) }); fsRef = w.fs;
  try {
    const r = w.h["C02/runFeaturePipeline"](w.as("arun", "q1"), body(w.repo, { text: "Admins must export all transactions. Admins must never export transactions." })); const job = await w.wait(r.value.jobId);
    const out = (job.result as any).value; assert.equal(job.state, "SUCCEEDED"); assert.equal(out.stop, "NEEDS_ANSWER"); assert.ok(out.questions.length >= 1); assert.equal(out.candidate, undefined);
    assert.ok(!out.steps.some((s: any) => s.step === "GENERATE")); assert.equal(w.fs.listCandidates(out.requestId).length, 0); assert.equal(w.runner.calls.length, 0, "no build or test ran while a question was open");
  } finally { w.close(); }
});

test("4.1 mandatory issue tracking stops a draft-PR run before anything is built or pushed", async () => {
  const forge = new Forge(""); const clones = mkdtempSync(join(tmpdir(), "pf-c-")); const w = await world(); forge.repo = w.repo;
  const w3 = await world({ publish: { forge, cloneRoot: clones } }); forge.repo = w3.repo; w.close();
  try {
    const run = w3.h["C02/runFeaturePipeline"](w3.as("arun", "pub"), body(w3.repo, { mode: "CREATE_DRAFT_PR", publishTo: "acme/transactions:main" })); const j = await w3.wait(run.value.jobId); const out = (j.result as any).value;
    assert.equal(out.stop, "BLOCKED"); assert.match(out.reason, /issue tracking is mandatory/); assert.equal(forge.creates, 0); assert.equal(w3.runner.calls.length, 0, "nothing was built");
    assert.equal(w3.fs.listCandidates(out.requestId).length, 0);
  } finally { w3.close(); }
});

test("4.1 cancelling a pipeline job during validation stops it, and the request is never published", async () => {
  const w = await world(); w.runner.run = async (req) => { w.runner.calls.push(req); await new Promise((r) => setTimeout(r, 400)); return { status: "PASSED", exitCode: 0, stdout: req.argv.includes("test") ? "TAP version 13\nok 1 - a\n# tests 1\n# pass 1\n# fail 0\n" : "ok\n", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 400 } }; };
  try {
    const r = w.h["C02/runFeaturePipeline"](w.as("arun", "cancel-1"), body(w.repo)); const id = r.value.jobId;
    for (let i = 0; i < 100 && w.runner.calls.length === 0 && !["SUCCEEDED", "FAILED"].includes(w.svc.store.job(id)?.state ?? ""); i++) await new Promise((x) => setTimeout(x, 30));
    w.svc.jobs.cancel(id); const job = await w.wait(id);
    assert.notEqual(job.state, "SUCCEEDED", "a cancelled job does not report success"); assert.ok(["CANCELLED", "FAILED"].includes(job.state), job.state);
    assert.notEqual(w.fs.listRequests(w.repo)[0]?.state, "PUBLISHED");
  } finally { w.close(); }
});

test("4.1 C02/featureSetupCheck says what is ready and what is missing, with the fix, and reads no repository files for an unindexed path", async () => {
  const w = await world();
  try {
    const ok = await w.h["C02/featureSetupCheck"](w.as("arun"), { repositoryId: w.repo }); assert.equal(ok.ok, true);
    const by = Object.fromEntries(ok.value.items.map((i: any) => [i.id, i])); assert.equal(by.INDEX.state, "READY"); assert.equal(by.CONTAINER.state, "READY"); assert.equal(by.STACK.state, "READY"); assert.equal(by.SECURITY_POLICY.state, "READY"); assert.equal(by.AUTHORITY.state, "READY"); assert.match(by.AUTHORITY.detail, /4 authority binding/);
    assert.equal(ok.value.ready, true);
    const probes = { docker: () => ({ daemon: true, image: false }), gh: () => ({ ok: false, detail: "not logged in" }), ollama: async () => ({ reachable: true, models: ["qwen3:0.6b"] }) };
    const bad = await setupCheck(w.svc.store, w.repo, probes); const b = Object.fromEntries(bad.items.map((i) => [i.id, i]));
    assert.equal(b.CONTAINER.state, "MISSING"); assert.match(b.CONTAINER.fix!, /docker pull node:24-alpine/); assert.equal(b.GITHUB.state, "WARN"); assert.match(b.GITHUB.fix!, /gh auth login/); assert.equal(b.MODEL_SIZE.state, "WARN"); assert.equal(bad.ready, false);
    const down = await setupCheck(w.svc.store, w.repo, { ...probes, docker: () => ({ daemon: false, image: false }), ollama: async () => ({ reachable: false, models: [] }) });
    assert.match(down.items.find((i) => i.id === "CONTAINER")!.detail, /not reachable/); assert.match(down.items.find((i) => i.id === "MODEL")!.fix!, /ollama serve/);
    const un = await setupCheck(w.svc.store, "/etc", probes); assert.deepEqual(un.items.filter((i) => ["FEATURE_CONFIG", "AUTHORITY", "STACK", "SECURITY_POLICY"].includes(i.id)), [], "no repository file of an unindexed path is read");
    assert.equal(un.items[0]!.id, "INDEX"); assert.equal(un.items[0]!.state, "MISSING"); assert.equal(un.ready, false);
    assert.equal((await w.h["C02/featureSetupCheck"](w.as("arun"), {})).error.code, "INVALID_SCHEMA");
  } finally { w.close(); }
});
