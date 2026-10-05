import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureError } from "../src/feature/errors.ts";
import { advanceStage, canTransition, eventFor, readiness, reconcileAll, resumeRequest, setBlockers, TRANSITIONS, transition } from "../src/feature/lifecycle.ts";
import type { CandidateRecord, DecisionRecord, EvidenceRecord } from "../src/feature/types.ts";
import { fresh, record, SNAP } from "./feature-fixtures.ts";

const decision = (requestId: string, over: Partial<DecisionRecord> = {}): DecisionRecord => ({ schemaVersion: 1, id: "d1", requestId, kind: "ANSWER", answer: "yes", actorId: "u", contractVersion: 0, affectedIds: ["r1"], rationale: "", createdAt: "2026-10-05T00:00:00Z", ...over });
const candidate = (requestId: string, over: Partial<CandidateRecord> = {}): CandidateRecord => ({
  schemaVersion: 1, id: "c1", requestId, ordinal: 1, bindingHash: "b1", mutations: [], invocationIds: [], status: "MATERIALIZED", createdAt: "2026-10-05T00:00:00Z",
  binding: { repositoryId: "repo", baseCommitHash: "x", baseContentHash: "y", candidateContentHash: "z", diffHash: "d", contractHash: "k", originalOracleHash: "o", candidateOracleHash: "o", runManifestIds: [], mutationInventoryHash: "m", generationProvenanceHash: "g" }, ...over,
});

test("PF-001/037 create is idempotent per (owner,key); a reused key with a different prompt is refused", () => {
  const { fs } = fresh();
  const r = record();
  const a = fs.createRequest(r, eventFor(r, "FeatureSubmitted", "u"), "k1");
  const again = fs.createRequest(record({ requestId: "req:other" }), eventFor(r, "FeatureSubmitted", "u", { eventId: "evt:2" }), "k1");
  assert.equal(a.replayed, false); assert.equal(again.replayed, true); assert.equal(again.record.requestId, r.requestId);
  assert.throws(() => fs.createRequest(record({ promptRef: { artifactId: "a", contentHash: "z".repeat(64), redactedPreview: "other" } }), eventFor(r, "FeatureSubmitted", "u", { eventId: "evt:3" }), "k1"), (e: any) => e instanceof FeatureError && e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(fs.listEvents(r.requestId).length, 1, "the replay wrote no second event");
  assert.throws(() => fs.createRequest(record(), eventFor(r, "FeatureSubmitted", "u"), ""), /idempotency key/);
});

test("PF-003 compare-and-swap: a stale writer gets VERSION_CONFLICT with the current version and nothing is written", () => {
  const { fs, make } = fresh();
  const r = make();
  const v1 = fs.updateRequest(r.requestId, 0, { ...r, state: "DISCOVERING" }, eventFor(r, "StateChanged", "u"));
  assert.equal(v1.version, 1);
  assert.throws(() => fs.updateRequest(r.requestId, 0, { ...r, state: "FAILED" }, eventFor(r, "StateChanged", "u")), (e: any) => e.code === "VERSION_CONFLICT" && e.currentVersion === 1);
  assert.equal(fs.getRequest(r.requestId)!.state, "DISCOVERING");
  assert.equal(fs.listEvents(r.requestId).length, 2);
  assert.throws(() => fs.updateRequest(r.requestId, 1, { ...r, createdBy: "someone-else" }), /cannot change/);
  assert.throws(() => fs.updateRequest("req:none", 0, record({ requestId: "req:none" })), (e: any) => e.code === "NOT_FOUND");
});

test("the state change and its event commit together: a failing event rolls the state back", () => {
  const { fs, make } = fresh();
  const r = make();
  const first = fs.listEvents(r.requestId)[0]!;
  // an event id owned by another request makes the event insert fail after the state row was updated
  const other = make();
  assert.throws(() => fs.updateRequest(r.requestId, 0, { ...r, state: "DISCOVERING" }, eventFor(other, "StateChanged", "u", { eventId: first.eventId, requestId: other.requestId } as any)), FeatureError);
  const cur = fs.getRequest(r.requestId)!;
  assert.equal(cur.state, "RECEIVED"); assert.equal(cur.version, 0);
});

test("events are dense per request, ordered, deduplicated by id, and the outbox tracks sync", () => {
  const { fs, make } = fresh();
  const a = make(), b = make();
  fs.appendEvent(eventFor(a, "DecisionRecorded", "u")); fs.appendEvent(eventFor(b, "DecisionRecorded", "u"));
  const dup = eventFor(a, "DecisionRecorded", "u", { eventId: "evt:fixed" });
  const e1 = fs.appendEvent(dup), e2 = fs.appendEvent(dup);
  assert.equal(e1.sequence, e2.sequence);
  assert.deepEqual(fs.listEvents(a.requestId).map((e) => e.sequence), [1, 2, 3]);
  assert.deepEqual(fs.listEvents(a.requestId, 1).map((e) => e.sequence), [2, 3]);
  const pend = fs.pendingSync(100); assert.equal(pend.length, 5);
  fs.markSynced(pend[0]!.eventId, { state: "SENT", remoteId: "c-1", attempts: 1 });
  assert.equal(fs.pendingSync(100).length, 4);
  fs.markSynced(pend[1]!.eventId, { state: "FAILED", attempts: 2 });
  assert.equal(fs.pendingSync(100).length, 4, "FAILED events stay in the outbox for retry");
  assert.throws(() => fs.markSynced("nope", { state: "SENT", attempts: 1 }), (e: any) => e.code === "NOT_FOUND");
});

test("decisions are immutable; supersession is a new record and only the latest is active", () => {
  const { fs, make } = fresh();
  const r = make();
  const d1 = fs.putDecision(decision(r.requestId));
  assert.deepEqual(fs.putDecision(decision(r.requestId)), d1, "same content is a no-op");
  assert.throws(() => fs.putDecision(decision(r.requestId, { answer: "no" })), (e: any) => e.code === "IDEMPOTENCY_CONFLICT");
  fs.putDecision(decision(r.requestId, { id: "d2", answer: "no", supersedesId: "d1", createdAt: "2026-10-05T00:00:01Z" }));
  assert.deepEqual(fs.activeDecisions(r.requestId).map((d) => d.id), ["d2"]);
  assert.equal(fs.listDecisions(r.requestId).length, 2, "history is kept");
  assert.throws(() => fs.putDecision(decision(r.requestId, { id: "d3", supersedesId: "ghost" })), /supersede/);
  assert.throws(() => fs.putDecision(decision("req:none")), (e: any) => e.code === "NOT_FOUND");
});

test("candidates keep their binding; evidence is bound to the exact candidate and immutable", () => {
  const { fs, make } = fresh();
  const r = make();
  fs.putCandidate(candidate(r.requestId));
  fs.putCandidate(candidate(r.requestId, { status: "STALE" }));
  assert.equal(fs.getCandidate("c1")!.status, "STALE");
  assert.throws(() => fs.putCandidate(candidate(r.requestId, { bindingHash: "other" })), (e: any) => e.code === "IDEMPOTENCY_CONFLICT");
  assert.equal(fs.nextOrdinal(r.requestId), 2);
  assert.equal(fs.getCandidateByBinding("b1")!.id, "c1");
  const manifest = { id: "m1", contractHash: "k", contentHash: "z", buildHash: "", harnessHash: "", fixtureHash: "", workloadHash: "", environmentHash: "", toolchainHash: "", oracleHash: "o", outcomesArtifactHash: "", generationProvenanceHash: "g", modelIdentityHashes: [], startedAt: "t", exitStatus: "0", isolation: "LOCAL_PERMISSION_MODEL" as const };
  const ev = (over: Partial<EvidenceRecord> = {}): EvidenceRecord => ({ schemaVersion: 1, id: "e1", requestId: r.requestId, candidateId: "c1", bindingHash: "b1", kind: "UNIT", manifest, results: [], toolVersions: {}, coverage: { state: "COMPLETE_WITHIN_SCOPE", gaps: [] }, outcomeRef: "o1", createdAt: "t", ...over });
  fs.putEvidence(ev());
  assert.equal(fs.putEvidence(ev()).id, "e1");
  assert.throws(() => fs.putEvidence(ev({ outcomeRef: "o2" })), (e: any) => e.code === "IDEMPOTENCY_CONFLICT");
  assert.throws(() => fs.putEvidence(ev({ id: "e2", bindingHash: "forged" })), (e: any) => e.code === "STALE_REVISION");
  assert.throws(() => fs.putEvidence(ev({ id: "e3", candidateId: "ghost" })), (e: any) => e.code === "NOT_FOUND");
  assert.equal(fs.listEvidence("c1").length, 1);
});

test("PF-002 lifecycle: only declared transitions, terminal states are final, every move writes one event", () => {
  const { fs, make } = fresh();
  const r = make();
  assert.ok(canTransition("RECEIVED", "DISCOVERING")); assert.ok(!canTransition("RECEIVED", "VALIDATING"));
  for (const t of ["CANCELLED", "FAILED"] as const) assert.deepEqual(TRANSITIONS[t], []);
  let cur = transition(fs, r.requestId, 0, "DISCOVERING", "u", "start");
  assert.throws(() => transition(fs, r.requestId, cur.version, "VALIDATING", "u", ""), (e: any) => e.code === "ILLEGAL_TRANSITION");
  assert.throws(() => transition(fs, r.requestId, 0, "CONTRACTING", "u", ""), (e: any) => e.code === "VERSION_CONFLICT");
  cur = transition(fs, r.requestId, cur.version, "CONTRACTING", "u", "");
  cur = transition(fs, r.requestId, cur.version, "CANCELLED", "u", "user asked");
  assert.throws(() => transition(fs, r.requestId, cur.version, "DISCOVERING", "u", ""), (e: any) => e.code === "ILLEGAL_TRANSITION");
  assert.equal(fs.listEvents(r.requestId).length, 4);
  assert.equal(readiness(fs.getRequest(r.requestId)!), "TERMINAL");
});

test("blockers flip readiness; clearing them restores READY; the workspace version moves with each change", () => {
  const { fs, make } = fresh();
  const r = make();
  assert.equal(readiness(r), "READY");
  const b = setBlockers(fs, r.requestId, 0, "u", [{ id: "q1", kind: "QUESTION", requirementIds: [], text: "which format?" }]);
  assert.equal(readiness(b), "BLOCKED"); assert.deepEqual(b.workspace.blockers, ["q1"]); assert.equal(b.workspace.workspaceVersion, 1);
  const c = setBlockers(fs, r.requestId, b.version, "u", []);
  assert.equal(readiness(c), "READY"); assert.equal(c.workspace.workspaceVersion, 2);
  assert.equal(fs.listEvents(r.requestId).map((e) => e.type).join(), "FeatureSubmitted,TaskBlocked,StateChanged");
});

test("S10 advanceWizard moves the view only, is bounded by state, and rejects a stale workspace version", () => {
  const { fs, make } = fresh();
  const r = make();
  assert.equal(advanceStage(fs, r.requestId, "u", "DELIVER", 0).stage, "DELIVER", "reading any stage is free");
  assert.equal(advanceStage(fs, r.requestId, "u", "DESCRIBE", 1).stage, "DESCRIBE");
  let cur = fs.getRequest(r.requestId)!; cur = transition(fs, r.requestId, cur.version, "DISCOVERING", "u", "");
  cur = transition(fs, r.requestId, cur.version, "CONTRACTING", "u", "");
  const ws = advanceStage(fs, r.requestId, "u", "PLAN", cur.workspace.workspaceVersion);
  assert.equal(ws.stage, "PLAN");
  assert.throws(() => advanceStage(fs, r.requestId, "u", "CLARIFY", cur.workspace.workspaceVersion), (e: any) => e.code === "VERSION_CONFLICT");
  const back = advanceStage(fs, r.requestId, "u", "DESCRIBE", ws.workspaceVersion);
  assert.equal(back.stage, "DESCRIBE");
  assert.throws(() => advanceStage(fs, r.requestId, "u", "NOPE" as any, back.workspaceVersion), /unknown stage/);
  const rec = fs.getRequest(r.requestId)!;
  assert.equal(rec.state, "CONTRACTING", "navigation never changes the request state");
  assert.equal(fs.listCandidates(r.requestId).length, 0);
  // a backward state move pulls the open stage back with it
  advanceStage(fs, r.requestId, "u", "PLAN", back.workspaceVersion);
  const c2 = fs.getRequest(r.requestId)!;
  const moved = transition(fs, r.requestId, c2.version, "DISCOVERING", "u", "base changed");
  assert.equal(moved.workspace.stage, "DESCRIBE");
});

test("AT-27/48 crash reconciliation: jobs that stopped are dropped, their tasks blocked, and the event says why", () => {
  const { fs, make } = fresh();
  const r = make({ workspace: { requestId: "x", stage: "DESCRIBE", blockers: [], runningJobIds: ["job:alive", "job:dead"], workspaceVersion: 0 },
    tasks: [{ id: "t1", componentId: "C28", requirementIds: [], dependencyTaskIds: [], obligationIds: [], plannedEdits: [], capabilityIds: [], state: "RUNNING", evidenceIds: [] }] });
  const ws = resumeRequest(fs, r.requestId, "system", (j) => j === "job:alive");
  assert.deepEqual(ws.runningJobIds, ["job:alive"]);
  const cur = fs.getRequest(r.requestId)!;
  assert.equal(cur.tasks[0]!.state, "BLOCKED"); assert.equal(readiness(cur), "BLOCKED");
  assert.equal(fs.listEvents(r.requestId).at(-1)!.type, "RequestReconciled");
  const before = fs.listEvents(r.requestId).length;
  resumeRequest(fs, r.requestId, "system", (j) => j === "job:alive");
  assert.equal(fs.listEvents(r.requestId).length, before, "a second resume changes nothing");
  assert.throws(() => resumeRequest(fs, "req:none", "s", () => true), (e: any) => e.code === "NOT_FOUND");
});

test("reconcileAll skips finished requests and reports the ones it fixed", () => {
  const { fs, make } = fresh();
  const ws = (jobs: string[]) => ({ requestId: "x", stage: "DESCRIBE" as const, blockers: [], runningJobIds: jobs, workspaceVersion: 0 });
  const a = make({ workspace: ws(["j1"]) }), done = make({ workspace: ws(["j2"]), state: "CANCELLED" }), clean = make();
  assert.deepEqual(reconcileAll(fs, "system", () => false), [a.requestId]);
  assert.deepEqual(fs.getRequest(done.requestId)!.workspace.runningJobIds, ["j2"]);
  void clean; void SNAP;
});
