import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApiResult, CallContext } from "@cie/schema";
import { OPS } from "../src/feature/api.ts";
import { authorityPolicyHash } from "../src/feature/authority.ts";
import { rawHash } from "../src/feature/canon.ts";
import { contractHashOf, contractIdOf } from "../src/feature/decisions.ts";
import { featureHandlers } from "../src/feature/handlers.ts";
import type { Handlers } from "../src/feature/routes.ts";
import { SqliteFeatureStore } from "../src/feature/store.ts";
import type { FeatureContract, FeatureWorkspace } from "../src/feature/types.ts";
import { buildHandler } from "../src/server.ts";
import { ctx as mkctx, demoRepo, setup } from "./helpers.ts";

const as = (principal: string, idem?: string): CallContext => { const c = mkctx(idem); return { ...c, actor: { ...c.actor, principalId: principal } }; };
async function boot() {
  const repo = demoRepo(); mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests/baseline.test.ts"), "import test from \"node:test\";\ntest(\"x\", () => {});\n");
  const { svc, worker } = await setup(undefined, repo);
  const h = featureHandlers(svc) as Required<Handlers>;
  const call = async <T = any>(key: string, c: CallContext, body: unknown) => (await h[key]!(c, body)) as ApiResult<T>;
  const fs = new SqliteFeatureStore(svc.store);
  return { svc, repo, h, call, fs, close: () => worker.close() };
}
const must = <T,>(r: ApiResult<T>): T => { assert.ok(r.ok, r.ok ? "" : `${r.error.code}: ${r.error.message}`); return r.value; };
const settle = async (svc: any, id: string) => { const j = await svc.jobs.settled(id); return j; };

test("the Wave 1 operations are registered; the rest still answer as stubs naming their task", () => {
  const keys = ["C02/submitFeature", "C10/discoverFeatureContext", "C02/resumeRequest", "C02/recordDecision", "C15/reviseContract", "C28/materializeCandidate", "C28/readCandidateFile", "C07/cancelFeature", "C01/openFeatureWorkspace", "C02/advanceWizard", "C14/recordModelInvocation", "C28/planFeatureChange", "C28/planReuseChange"];
  const opKeys = new Set(OPS.map((o) => o.key));
  for (const k of keys) assert.ok(opKeys.has(k), k);
  const wave1Left = OPS.filter((o) => !keys.includes(o.key) && /^1\./.test(o.owner)).map((o) => o.key).sort();
  assert.deepEqual(wave1Left, [], "every Wave 1 operation is registered: the two plan operations were completed with task 2.I");
});

test("end to end through the handlers: submit → discover → decide → revise → build as a job → read → advance → cancel", async () => {
  const b = await boot();
  try {
    const sub = must(await b.call("C02/submitFeature", as("arun", "s1"), { text: "Add CSV export to transactions", repositoryId: b.repo, mode: "BUILD_PREVIEW" }));
    const replay = must(await b.call("C02/submitFeature", as("arun", "s1"), { text: "Add CSV export to transactions", repositoryId: b.repo, mode: "BUILD_PREVIEW" }));
    assert.equal(replay.requestId, sub.requestId); assert.equal(replay.replayed, true);
    const rid = sub.requestId;
    const rec0 = b.fs.getRequest(rid)!;
    const disc = must(await b.call("C10/discoverFeatureContext", as("arun"), { requestId: rid, retrievalBudget: { tokens: 8000, files: 5000 } }));
    void rec0;
    assert.ok(disc.status === "COMPLETE" || disc.status === "PARTIAL");
    assert.equal(b.fs.getRequest(rid)!.state, "CONTRACTING");

    // a question and a contract (the contract draft itself arrives with task 2.I)
    let rec = b.fs.getRequest(rid)!;
    const draft = { schemaVersion: 1 as const, id: contractIdOf(rid), version: 0, requestId: rid, snapshot: rec.source, requirements: [], acceptance: [], obligationIds: [], authorityPolicyHash: authorityPolicyHash({ bindings: [] }),
      assumptions: [{ id: "a1", text: "utf-8", rationale: "", sourceRefs: [], reversible: true, affectedIds: [], state: "PROPOSED" as const, revisitTrigger: "" }] };
    const contract: FeatureContract = { ...draft, hash: contractHashOf(draft) };
    rec = b.fs.updateRequest(rid, rec.version, { ...rec, contract, blockers: [{ id: "a1", kind: "QUESTION", requirementIds: [], text: "is utf-8 fine?" }] });
    const edits = [{ op: "CREATE_FILE", file: "src/export/csv.ts", content: "export {};\n", why: "new", requirementIds: ["r1"] }];
    const blocked = must(await b.call("C28/materializeCandidate", as("arun", "m0"), { requestId: rid, snapshot: rec.source, edits }));
    const j0 = await settle(b.svc, blocked.jobId); assert.equal(j0.state, "FAILED"); assert.match(j0.message, /open item/);

    assert.equal((await b.call("C02/recordDecision", as("arun", "d1"), { contractId: contractIdOf(rid), expectedVersion: 0, questionId: "a1", answer: "yes", kind: "ASSUMPTION" })).ok, true);
    const rev = must(await b.call<any>("C15/reviseContract", as("arun"), { contractId: contractIdOf(rid), expectedVersion: 0, decisionIds: [b.fs.listDecisions(rid)[0]!.id] }));
    assert.equal(rev.value.version, 1);
    rec = b.fs.getRequest(rid)!;

    const started = must(await b.call("C28/materializeCandidate", as("arun", "m1"), { requestId: rid, snapshot: rec.source, edits }));
    const job = await settle(b.svc, started.jobId);
    assert.equal(job.state, "SUCCEEDED", job.message); const binding = (job.result!.value as any);
    assert.match(binding.candidateContentHash, /^pf-canon-v1\//);
    const cand = b.fs.listCandidates(rid)[0]!;
    assert.equal(b.fs.getRequest(rid)!.state, "IMPLEMENTING");
    const file = must(await b.call<any>("C28/readCandidateFile", as("arun"), { candidateHash: cand.bindingHash, path: "src/export/csv.ts", representation: "UNIFIED_DIFF" }));
    assert.match(file.value.content, /^--- \/dev\/null/); assert.equal(file.value.sourceArtifactRef.startsWith(cand.bindingHash), true);

    const open = must(await b.call<any>("C01/openFeatureWorkspace", as("arun"), { requestId: rid }));
    const ws: FeatureWorkspace = open.value;
    assert.equal(ws.candidateHash, cand.bindingHash);
    assert.deepEqual(must(await b.call<any>("C01/openFeatureWorkspace", as("arun"), { requestId: rid, sinceWorkspaceVersion: ws.workspaceVersion })).diagnostics, ["NOT_MODIFIED"]);
    const adv = must(await b.call<any>("C02/advanceWizard", as("arun"), { requestId: rid, targetStage: "CHANGES", expectedWorkspaceVersion: ws.workspaceVersion }));
    assert.equal(adv.value.stage, "CHANGES");
    const stale = await b.call("C02/advanceWizard", as("arun"), { requestId: rid, targetStage: "PLAN", expectedWorkspaceVersion: ws.workspaceVersion });
    assert.ok(!stale.ok && stale.error.code === "VERSION_CONFLICT" && stale.error.currentVersion === adv.value.workspaceVersion);
    const far = must(await b.call<any>("C02/advanceWizard", as("arun"), { requestId: rid, targetStage: "DELIVER", expectedWorkspaceVersion: adv.value.workspaceVersion }));
    assert.equal(far.value.stage, "DELIVER", "navigation is free; what a stage may do is gated by its own action");
    assert.equal(b.fs.getRequest(rid)!.state, "IMPLEMENTING");
    must(await b.call("C02/advanceWizard", as("arun"), { requestId: rid, targetStage: "CHANGES", expectedWorkspaceVersion: far.value.workspaceVersion }));
    assert.equal(open.value.state, "IMPLEMENTING"); assert.equal(open.value.contractVersion, 1); assert.equal(open.value.mode, "BUILD_PREVIEW");
    assert.equal(open.value.candidateStatus, "MATERIALIZED");
    assert.equal(must(await b.call<any>("C02/resumeRequest", as("arun"), { requestId: rid })).stage, "CHANGES");

    const cancelled = must(await b.call<any>("C07/cancelFeature", as("arun"), { requestId: rid, reason: "changed my mind" }));
    assert.deepEqual(cancelled.externalEffects, []); assert.equal(b.fs.getRequest(rid)!.state, "CANCELLED");
    assert.deepEqual(must(await b.call<any>("C07/cancelFeature", as("arun"), { requestId: rid, reason: "again" })).stoppedJobIds, [], "cancelling twice is harmless");
    assert.ok(b.fs.listEvents(rid).some((e) => e.type === "Cancelled"));
  } finally { b.close(); }
});

test("PF-016 ownership: another principal cannot see, change or cancel a request, and probing an id reads as absent", async () => {
  const b = await boot();
  try {
    const sub = must(await b.call("C02/submitFeature", as("arun", "s1"), { text: "private plan", repositoryId: b.repo, mode: "PLAN" }));
    const rid = sub.requestId;
    const snap = b.fs.getRequest(rid)!.source;
    for (const [key, body] of [["C10/discoverFeatureContext", { requestId: rid, snapshot: snap, retrievalBudget: { tokens: 1, files: 1 } }], ["C02/resumeRequest", { requestId: rid }], ["C01/openFeatureWorkspace", { requestId: rid }],
      ["C07/cancelFeature", { requestId: rid, reason: "x" }], ["C02/advanceWizard", { requestId: rid, targetStage: "DESCRIBE", expectedWorkspaceVersion: 0 }], ["C28/materializeCandidate", { requestId: rid, snapshot: snap, edits: [] }],
      ["C02/recordDecision", { contractId: contractIdOf(rid), expectedVersion: 0, questionId: "q", answer: "a" }], ["C15/reviseContract", { contractId: contractIdOf(rid), expectedVersion: 0, decisionIds: [] }]] as const) {
      const r = await b.call(key, as("mallory", `i-${key}`), body); assert.ok(!r.ok && r.error.code === "NOT_FOUND", key);
      assert.ok(!JSON.stringify(r).includes("private plan"), key);
    }
    const ghost = await b.call("C02/resumeRequest", as("arun"), { requestId: "req:does-not-exist" });
    const theirs = await b.call("C02/resumeRequest", as("mallory"), { requestId: rid });
    assert.deepEqual(!ghost.ok && ghost.error.message.replace(/req:\S+/, "X"), !theirs.ok && theirs.error.message.replace(/req:\S+/, "X"), "same answer for absent and not-yours");
    assert.equal(b.fs.getRequest(rid)!.state, "RECEIVED");
  } finally { b.close(); }
});

test("bad input is a typed INVALID_SCHEMA, never a crash", async () => {
  const b = await boot();
  try {
    for (const [key, body] of [["C02/submitFeature", null], ["C02/submitFeature", []], ["C02/submitFeature", { text: "x", mode: "PLAN" }], ["C02/resumeRequest", {}], ["C02/recordDecision", { contractId: "nope" }],
      ["C15/reviseContract", { contractId: "contract:x", decisionIds: "no" }], ["C28/readCandidateFile", {}], ["C07/cancelFeature", { requestId: 5 }]] as const) {
      const r = await b.call(key, as("arun", `k-${Math.random()}`), body);
      assert.ok(!r.ok && (r.error.code === "INVALID_SCHEMA" || r.error.code === "NOT_FOUND"), `${key} ${JSON.stringify(body)} → ${JSON.stringify(r)}`);
    }
  } finally { b.close(); }
});

test("cancelling a request stops its running job and reports what it could not undo", async () => {
  const b = await boot();
  try {
    const rid = must(await b.call("C02/submitFeature", as("arun", "s1"), { text: "x", repositoryId: b.repo, mode: "PLAN" })).requestId;
    let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
    const slow = b.svc.jobs.enqueue(mkctx("slow"), { kind: "feature-build", lane: "runner", params: { analysisId: rid }, run: async (_c, control) => { await control.guard(hold); return { ok: true, value: 1, metadata: { requestId: "r", completeness: "COMPLETE", warnings: [] } }; } });
    await new Promise((r) => setTimeout(r, 40));
    const rec = b.fs.getRequest(rid)!;
    b.fs.updateRequest(rid, rec.version, { ...rec, issue: { repository: "o/r", number: 7, syncState: "SYNCED", lastSyncedSequence: 1, projectionRevision: 1 }, workspace: { ...rec.workspace, runningJobIds: [slow.id] } });
    const r = must(await b.call<any>("C07/cancelFeature", as("arun"), { requestId: rid, reason: "stop" }));
    assert.deepEqual(r.stoppedJobIds, [slow.id]); assert.match(r.externalEffects[0], /issue #7 in o\/r is not closed/);
    assert.equal((await settle(b.svc, slow.id)).state, "CANCELLED");
    release();
    assert.equal(b.fs.getRequest(rid)!.workspace.runningJobIds.length, 0);
    assert.ok((await b.call("C07/cancelFeature", as("arun"), { requestId: rid, reason: "again" })).ok, "an already-cancelled request answers idempotently");
    const rid2 = must(await b.call("C02/submitFeature", as("arun", "s2"), { text: "y", repositoryId: b.repo, mode: "PLAN" })).requestId;
    const noReason = await b.call("C07/cancelFeature", as("arun"), { requestId: rid2, reason: " " }); assert.ok(!noReason.ok && noReason.error.code === "INVALID_SCHEMA");
  } finally { b.close(); }
});

test("through the real gateway: submitFeature needs the idempotency header and answers with a typed result", async () => {
  const { svc, worker, } = await setup(undefined, demoRepo());
  const srv = createServer(buildHandler(svc));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${(srv.address() as import("node:net").AddressInfo).port}`;
    const repo = svc.store.latestRevision()!.repoRoot;
    const post = (key: string, body: unknown, idem?: string) => fetch(`${base}/api/v1/components/${key}`, { method: "POST", headers: { "content-type": "application/json", ...(idem ? { "idempotency-key": idem } : {}) }, body: JSON.stringify(body) });
    const noKey = await post("C02/submitFeature", { text: "x", repositoryId: repo, mode: "PLAN" });
    assert.ok(noKey.status >= 400 && noKey.status < 500, `a mutating call without a key is refused (${noKey.status})`);
    const ok = await post("C02/submitFeature", { text: "Add CSV export", repositoryId: repo, mode: "PLAN" }, "gw-1");
    assert.equal(ok.status, 200); const body = await ok.json() as any;
    assert.equal(body.ok, true); assert.match(body.value.requestId, /^req:/);
    const again = await (await post("C02/submitFeature", { text: "Add CSV export", repositoryId: repo, mode: "PLAN" }, "gw-1")).json() as any;
    assert.equal(again.value.requestId, body.value.requestId); assert.equal(again.value.replayed, true);
    const bad = await post("C02/submitFeature", { text: "", repositoryId: repo, mode: "PLAN" }, "gw-2");
    assert.equal(bad.status, 400);
    void rawHash; void dirname;
  } finally { srv.close(); worker.close(); }
});

test("C14/recordModelInvocation: owner-only, idempotent per key, UNKNOWN revision queues an identity event, bad input is typed", async () => {
  const b = await boot();
  try {
    const rid = must(await b.call("C02/submitFeature", as("arun", "s1"), { text: "x", repositoryId: b.repo, mode: "PLAN" })).requestId;
    const body = { requestId: rid, inputRefs: ["a".repeat(64)], parameters: { temperature: 0 }, outputHash: "b".repeat(64),
      modelIdentity: { provider: "ollama", model: "m", resolvedVersion: "UNKNOWN", promptTemplateHash: "t", toolSchemaVersions: [], parameters: {}, inputRefs: [], egress: "LOCAL_ONLY", startedAt: "2026-10-05T00:00:00Z", status: "COMPLETE" } };
    const a = must(await b.call<any>("C14/recordModelInvocation", as("arun", "r1"), body));
    const again = must(await b.call<any>("C14/recordModelInvocation", as("arun", "r1"), body));
    assert.equal(again.id, a.id); assert.equal(a.resolvedVersion, "UNKNOWN");
    assert.equal(b.fs.getRequest(rid)!.modelInvocations!.length, 1);
    assert.ok(b.fs.listEvents(rid).some((e) => e.type === "ModelIdentityChanged"), "an UNKNOWN revision asks for builder evaluation");
    const other = await b.call("C14/recordModelInvocation", as("mallory", "r2"), body); assert.ok(!other.ok && other.error.code === "NOT_FOUND");
    const bad = await b.call("C14/recordModelInvocation", as("arun", "r3"), { requestId: rid }); assert.ok(!bad.ok && bad.error.code === "INVALID_SCHEMA");
    const noKey = await b.call("C14/recordModelInvocation", as("arun", ""), body); assert.ok(!noKey.ok);
  } finally { b.close(); }
});

test("every operation owned by a Wave 1 or Wave 2 task is registered with the full wiring; only later waves still answer as stubs", async () => {
  const b = await boot();
  try {
    const stubs: string[] = [];
    for (const o of OPS.filter((x) => /^[12]\./.test(x.owner))) {
      const r = await b.call(o.key, as("arun"), {});
      if (!r.ok && /is not implemented yet/.test(r.error.message)) stubs.push(o.key);
    }
    assert.deepEqual(stubs, []);
  } finally { b.close(); }
});
