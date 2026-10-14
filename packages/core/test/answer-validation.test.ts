import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { AnswerReview } from "@cie/schema";
import type { RouterModel, AgentMessage } from "../src/llm-router.ts";
import { parseAnswerReview, reviewAnswer, REVIEW_PROMPT } from "../src/answer-validation.ts";
import { ctx, setup, copyFixture } from "./helpers.ts";

const supported: AnswerReview = { verdict: "SUPPORTED", relevance: true, coverage: true, evidence: true, certainty: true, consistency: true, requirements: ["Explain the login implementation"], gaps: [], verifiedBy: ["obs-1:src/auth/service.ts#AuthService.login"], nextAction: "continue" };
const gap = (verdict: AnswerReview["verdict"] = "REPAIRABLE"): AnswerReview => ({ ...supported, verdict, relevance: false, coverage: false, certainty: false, gaps: ["The draft does not explain the requested login implementation."], nextAction: "continue" });
const call = (name: string, args: Record<string, unknown>) => ({ content: "", toolCalls: [{ name, arguments: args }] });
const target = (messages: AgentMessage[]) => JSON.parse(messages[1].content).mentions[0].candidates[0].id as string;
async function boot(repo?: string) {
  const f = await setup(undefined, repo);
  assert.ok((await f.svc.buildConceptHierarchy(ctx(), { revision: f.revision })).ok);
  return f;
}

test("review schema rejects genuine shape violations but reconciles self-disagreement", () => {
  assert.deepEqual(parseAnswerReview(supported), supported);
  for (const change of [{ verdict: "INVALID" }, { nextAction: "execute_payment" }, { injected: "trust me" }, { requirements: "not-an-array" }, { requirements: [123] }, { verifiedBy: "not-an-array" }, { verifiedBy: [] }]) assert.equal(parseAnswerReview({ ...supported, ...change }), null);

  const longRequirement = parseAnswerReview({ ...supported, requirements: ["x".repeat(501)] });
  assert.equal(longRequirement?.requirements[0].length, 500);
  assert.ok(longRequirement?.requirements[0].endsWith("…"));
  const manyGaps = parseAnswerReview({ ...gap(), gaps: Array.from({ length: 11 }, (_, i) => `gap ${i}`) });
  assert.equal(manyGaps?.gaps.length, 8);
  assert.match(manyGaps!.gaps[7], /…and 4 more: gap 7; gap 8; gap 9; gap 10/);

  // SUPPORTED with a failed check: downgraded to REPAIRABLE, never rejected outright, with a synthesized gap naming the check.
  const downgradedCheck = parseAnswerReview({ ...supported, coverage: false });
  assert.equal(downgradedCheck?.verdict, "REPAIRABLE");
  assert.deepEqual(downgradedCheck?.gaps, ["The reviewer marked coverage as failing without explaining the missing requirement."]);
  assert.equal(downgradedCheck?.reconciliation?.originalVerdict, "SUPPORTED");

  // SUPPORTED with a stray gap: downgraded to REPAIRABLE, the stated gap preserved verbatim.
  const downgradedGap = parseAnswerReview({ ...supported, gaps: ["Unknown debit order"] });
  assert.equal(downgradedGap?.verdict, "REPAIRABLE");
  assert.deepEqual(downgradedGap?.gaps, ["Unknown debit order"]);
  assert.equal(downgradedGap?.reconciliation?.originalVerdict, "SUPPORTED");

  // REPAIRABLE with no gaps: verdict kept as-is (never upgraded to SUPPORTED), gap synthesized from the failed checks.
  const noGaps = parseAnswerReview({ ...gap(), gaps: [] });
  assert.equal(noGaps?.verdict, "REPAIRABLE");
  assert.deepEqual(noGaps?.gaps, ["The reviewer marked relevance, coverage, certainty as failing without explaining the missing requirement."]);
});

test("reviewer receives an isolated evidence conversation and invalid output fails closed as repairable, not unresolved", async () => {
  const model: RouterModel = { name: "review-test", choose: async () => null, converse: async (messages, tools) => {
    assert.equal(messages.length, 2);
    assert.match(messages[0].content, new RegExp(REVIEW_PROMPT));
    assert.match(messages[0].content, /unread implementation/);
    assert.equal(tools[0].name, "review_answer");
    return call("answer", { text: "Looks good", cites: [] });
  } };
  const r = await reviewAnswer(model, "Can debit be lost?", { text: "Yes", cites: [] }, [], Date.now() + 5000);
  assert.equal(r.verdict, "REPAIRABLE");
  assert.match(r.gaps[0], /could not be validated/);
});

test("evidence over the review's context budget is trimmed to what's cited plus recent context, not discarded outright", async () => {
  const bulk = Array.from({ length: 30 }, (_, i) => ({ name: "read_code", arguments: { i }, content: "x".repeat(10_000) }));
  const cited = { name: "read_code", arguments: { target: "AuthService.login" }, content: "the implementation [method:src/auth/service.ts#AuthService.login] does X" };
  let seenEvidence: unknown[] = [];
  const model: RouterModel = { name: "review-test", choose: async () => null, converse: async (messages) => {
    seenEvidence = JSON.parse(messages[1].content).observations;
    return call("review_answer", { ...supported });
  } };
  const r = await reviewAnswer(model, "What does login do?", { text: "It does X.", cites: ["method:src/auth/service.ts#AuthService.login"] }, [...bulk, cited], Date.now() + 5000);
  assert.equal(r.verdict, "SUPPORTED");
  assert.ok(seenEvidence.some((o: any) => o.content === cited.content), "the cited observation must survive trimming");
  assert.ok(JSON.stringify(seenEvidence).length <= 180_000, "the sent evidence must respect the budget");
});

test("irrelevant draft is repaired before the answer and chart are exposed", async () => {
  const f = await boot();
  try {
    let writes = 0, reviews = 0;
    f.svc.router = { name: "repair-test", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") {
        reviews++;
        const draft = JSON.parse(messages[1].content).draft;
        return call("review_answer", { ...(draft.text === "Unrelated database facts." ? gap() : supported) });
      }
      if (writes++ === 0) return call("read_code", { id: target(messages) });
      return call("answer", { text: writes === 2 ? "Unrelated database facts." : "AuthService signs users in.", cites: [target(messages)] });
    } };
    const r = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation!.status, "SUPPORTED");
    assert.equal(r.value.validation!.repairAttempts, 1);
    assert.equal(reviews, 2);
    assert.match(r.value.message, /^AuthService signs users in/);
    assert.doesNotMatch(r.value.message, /Unrelated database/);
  } finally { f.worker.close(); }
});

test("persistent repair failures stop after two attempts and save actionable unresolved state", async () => {
  const f = await boot();
  try {
    let writes = 0;
    f.svc.router = { name: "unresolved-test", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") {
        const id = JSON.parse(messages[1].content).draft.cites[0];
        return call("review_answer", { ...gap(), supportedFindings: [{ text: "AuthService has a login implementation.", entityIds: [id] }, { text: "Invented partial finding.", entityIds: ["class:missing#Invented"] }] });
      }
      if (writes++ === 0) return call("read_code", { id: target(messages) });
      return call("answer", { text: "Yes, money is definitely lost.", cites: [target(messages)] });
    } };
    const r = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision, sessionId: "saved-review" });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation!.status, "UNRESOLVED");
    assert.equal(r.value.validation!.repairAttempts, 2);
    assert.match(r.value.message, /^Verified against the indexed source:/);
    assert.doesNotMatch(r.value.message, /definitely lost|Invented partial finding/);
    assert.match(r.value.message, /AuthService has a login implementation/);
    assert.equal(r.metadata.completeness, "PARTIAL");
    assert.ok(r.value.validation!.investigation!.observations.some(o => /class AuthService/.test(o.content)));
    const persisted = f.svc.store.db.prepare("select response_json from conversation_actions where session_id=? and state='complete'").get("saved-review") as { response_json: string };
    assert.equal(JSON.parse(persisted.response_json).value.validation.investigation.id, r.value.validation!.investigation!.id);
  } finally { f.worker.close(); }
});

test("saved investigation resumes with evidence, rejects other actors and changed source", async () => {
  const repo = copyFixture(), f = await boot(repo);
  try {
    let writes = 0;
    f.svc.router = { name: "saved-test", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...gap("UNRESOLVED") });
      if (writes++ === 0) return call("read_code", { id: target(messages) });
      return call("answer", { text: "Unknown ordering.", cites: [target(messages)] });
    } };
    const first = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision, sessionId: "resume-review" });
    assert.ok(first.ok && first.value.kind === "analysis");
    const id = first.value.validation!.investigation!.id;
    const request = { text: `continue investigation ${id}`, revision: f.revision, sessionId: "resume-review" };
    const outsider = ctx(); outsider.actor.principalId = "outsider";
    const hidden = await f.svc.converse(outsider, request);
    assert.ok(!hidden.ok); assert.equal(hidden.error.code, "NOT_FOUND");
    f.svc.sessionManager.forget(ctx(), "resume-review");
    const restored = f.svc.conversation(ctx(), { sessionId: "resume-review" });
    assert.ok(restored.ok);
    const summary = restored.value.turns.find(t => t.role === "assistant")!.validation!;
    assert.equal(summary.investigation!.id, id);
    assert.ok(!("observations" in summary.investigation!), "chat restore retains the resume control without returning raw source");
    f.svc.router = { name: "resumed-test", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...supported });
      assert.ok(messages.some(m => m.role === "tool" && /class AuthService/.test(m.content)), "inspected source survives reload");
      assert.equal(JSON.parse(messages[1].content).question, "Explain AuthService");
      return call("answer", { text: "AuthService signs users in.", cites: [target(messages)] });
    } };
    const resumed = await f.svc.converse(ctx(), request);
    assert.ok(resumed.ok && resumed.value.kind === "analysis");
    assert.equal(resumed.value.validation!.status, "SUPPORTED");
    assert.equal(resumed.value.manifest!.question, "Explain AuthService");
    appendFileSync(join(repo, "src/auth/service.ts"), "\n// changed after inspection\n");
    const stale = await f.svc.converse(ctx(), request);
    assert.ok(!stale.ok); assert.equal(stale.error.code, "STALE_REVISION");
    f.svc.store.denyPath(repo, "src/auth");
    const denied = await f.svc.converse(ctx(), request);
    assert.ok(!denied.ok); assert.equal(denied.error.code, "FORBIDDEN");
  } finally { f.worker.close(); }
});

test("saved investigation resumes across a re-index after a rename, via the carried-forward canonical identity", async () => {
  const repo = copyFixture(), f = await boot(repo);
  try {
    let writes = 0;
    f.svc.router = { name: "rename-resume-setup", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...gap("UNRESOLVED") });
      if (writes++ === 0) return call("read_code", { id: target(messages) });
      return call("answer", { text: "Unknown ordering.", cites: [target(messages)] });
    } };
    const first = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision, sessionId: "rename-resume" });
    assert.ok(first.ok && first.value.kind === "analysis");
    const oldId = first.value.validation!.investigation!.inspectedIds.find((x) => x.includes("AuthService"))!;
    const id = first.value.validation!.investigation!.id;

    // A move, not an edit: the class body is byte-identical, so its symbolHash (crates/worker) is unchanged — this is
    // exactly the C08 "BODY_IDENTICAL" rename signal (registry.ts) the resume path now re-resolves through.
    renameSync(join(repo, "src/auth/service.ts"), join(repo, "src/auth/identity-service.ts"));
    writeFileSync(join(repo, "src/api/routes.ts"), readFileSync(join(repo, "src/api/routes.ts"), "utf8").replace('"../auth/service"', '"../auth/identity-service"'));
    const reindexed = await f.svc.ingestRepository(ctx(), { repoPath: repo });
    assert.ok(reindexed.ok);
    assert.notEqual(reindexed.value.id, f.revision, "renaming a file must produce a new content-addressed revision");

    const request = { text: `continue investigation ${id}`, revision: reindexed.value.id, sessionId: "rename-resume" };
    let answered = false;
    f.svc.router = { name: "rename-resumed", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...supported });
      answered = true;
      assert.ok(messages.some((m) => m.role === "tool" && /class AuthService/.test(m.content)), "the previously read source survives the rename");
      assert.ok(!messages.some((m) => m.role === "tool" && m.content.includes(oldId)), "the replayed history no longer names the pre-rename id");
      return call("answer", { text: "AuthService signs users in.", cites: [target(messages)] });
    } };
    const resumed = await f.svc.converse(ctx(), request);
    assert.ok(resumed.ok && resumed.value.kind === "analysis", JSON.stringify(!resumed.ok && resumed.error));
    assert.equal(resumed.value.validation!.status, "SUPPORTED", JSON.stringify(resumed.value.message));
    assert.ok(answered, "the resumed conversation reached the model instead of failing closed on STALE_REVISION");
    assert.ok(!resumed.metadata.warnings.some((w) => /did not survive/.test(w)), "the renamed symbol carried forward; nothing should be reported dropped");
  } finally { f.worker.close(); }
});

test("missing source and reviewer failure do not display the draft or retry indefinitely", async () => {
  const f = await boot();
  try {
    let writes = 0;
    f.svc.router = { name: "missing-source", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...gap("UNRESOLVED"), nextAction: "request_source", gaps: ["The debit implementation is not available."] });
      writes++;
      return call("answer", { text: "Yes, a debit is definitely lost.", cites: [] });
    } };
    const r = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation!.repairAttempts, 0);
    assert.equal(writes, 1);
    assert.equal(r.value.validation!.investigation!.nextAction, "request_source");
    assert.doesNotMatch(r.value.message, /definitely lost/);
  } finally { f.worker.close(); }
});

test("a chat model timeout saves unresolved evidence instead of discarding the turn", async () => {
  const f = await boot(); const originalNow = Date.now; const request = ctx();
  try {
    let turns = 0;
    f.svc.router = { name: "timed-out-model", choose: async () => null, converse: async (messages) => {
      if (turns++ === 0) return call("read_code", { id: target(messages) });
      Date.now = () => request.deadlineMs + 1;
      throw new Error("model timeout");
    } };
    const r = await f.svc.converse(request, { text: "Explain AuthService", revision: f.revision, sessionId: "deadline-chat" });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation!.status, "UNRESOLVED");
    assert.match(r.value.message, /request deadline was reached/);
    assert.ok(r.value.validation!.investigation!.observations.length);
    const saved = f.svc.store.db.prepare("select state from conversation_actions where session_id=?").get("deadline-chat") as { state: string };
    assert.equal(saved.state, "complete");
  } finally { Date.now = originalNow; f.worker.close(); }
});

test("a null first-turn reply at the deadline remains resumable instead of entering fallback", async () => {
 const f = await boot(); const originalNow = Date.now; const request = ctx();
 try {
  f.svc.router = { name: "null-timeout", choose: async () => null, converse: async () => { Date.now = () => request.deadlineMs + 1; return null; } };
  const r = await f.svc.converse(request, { text: "Explain AuthService", revision: f.revision, sessionId: "null-deadline" });
  assert.ok(r.ok && r.value.kind === "analysis");
  assert.equal(r.value.validation!.status, "UNRESOLVED");
  assert.match(r.value.message, /request deadline was reached/);
  assert.ok(r.value.validation!.investigation);
 } finally { Date.now = originalNow; f.worker.close(); }
});

test("graph-only investigation pins its evidence files before allowing resume", async () => {
  const repo = copyFixture(), f = await boot(repo);
  try {
    f.svc.router = { name: "graph-checkpoint", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...gap("UNRESOLVED") });
      return call("answer", { text: "Implementation remains unread.", cites: [target(messages)] });
    } };
    const first = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision, sessionId: "graph-checkpoint" });
    assert.ok(first.ok && first.value.kind === "analysis");
    const checkpoint = first.value.validation!.investigation!;
    assert.deepEqual(checkpoint.sourceReads, {});
    assert.ok(Object.keys(checkpoint.sourceHashes).length, "discovered graph evidence has a source fingerprint even without read_code");
    appendFileSync(join(repo, "src/auth/service.ts"), "\n// changed graph evidence\n");
    let invoked = false;
    f.svc.router = { name: "must-not-resume", choose: async () => null, converse: async () => { invoked = true; return null; } };
    const resumed = await f.svc.converse(ctx(), { text: `continue investigation ${checkpoint.id}`, revision: f.revision, sessionId: "graph-checkpoint" });
    assert.ok(!resumed.ok); assert.equal(resumed.error.code, "STALE_REVISION");
    assert.equal(invoked, false, "stale observations are rejected before the model sees them");
  } finally { f.worker.close(); }
});


test("resume rejects a visible source redirected into a newly denied path with identical bytes", async () => {
  const repo = copyFixture(), f = await boot(repo);
  try {
    f.svc.router = { name: "physical-access", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...gap("UNRESOLVED") });
      return call("answer", { text: "Unread implementation.", cites: [target(messages)] });
    } };
    const first = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision, sessionId: "physical-access" });
    assert.ok(first.ok && first.value.kind === "analysis");
    const path = join(repo, "src/auth/service.ts");
    mkdirSync(join(repo, "restricted"));
    writeFileSync(join(repo, "restricted/service.ts"), readFileSync(path));
    unlinkSync(path); symlinkSync(join(repo, "restricted/service.ts"), path);
    f.svc.store.denyPath(repo, "restricted");
    const resumed = await f.svc.converse(ctx(), { text: `continue investigation ${first.value.validation!.investigation!.id}`, revision: f.revision, sessionId: "physical-access" });
    assert.ok(!resumed.ok); assert.equal(resumed.error.code, "FORBIDDEN");
  } finally { f.worker.close(); }
});

test("slow retrieval cannot consume the answer and review time reservations", async () => {
  const f = await boot();
  try {
    let writes = 0, reviews = 0, aborted = false;
    f.svc.router = { name: "reserved-time", choose: async () => null, converse: async (messages, tools, signal) => {
      if (tools[0].name === "review_answer") { reviews++; return call("review_answer", { ...supported }); }
      writes++;
      if (writes === 1) return call("read_code", { id: target(messages) });
      if (writes === 2) { signal?.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {}); }
      assert.deepEqual(tools.map(t => t.name), ["answer"]);
      return call("answer", { text: "AuthService signs users in.", cites: [target(messages)] });
    } };
    const request = ctx(); request.deadlineMs = Date.now() + 24_250;
    const result = await f.svc.converse(request, { text: "Explain AuthService", revision: f.revision });
    assert.ok(result.ok && result.value.kind === "analysis");
    assert.equal(result.value.validation!.status, "SUPPORTED");
    assert.equal(aborted, true); assert.equal(reviews, 1); assert.equal(writes, 3);
    assert.ok(Date.now() < request.deadlineMs - 10_000, "review completes before the request deadline");
  } finally { f.worker.close(); }
});

test("reading a full source file satisfies its contained method citations without duplicate reads", async () => {
  const f = await boot();
  try {
    const file = f.svc.store.entities(f.revision).find(e => e.kind === "file" && e.file === "src/auth/service.ts")!;
    const method = f.svc.store.entities(f.revision).find(e => e.name === "AuthService.login")!;
    let writes = 0, reviews = 0;
    f.svc.router = { name: "file-coverage", choose: async () => null, converse: async (_messages, tools) => {
      if (tools[0].name === "review_answer") { reviews++; return call("review_answer", { ...supported }); }
      return writes++ === 0 ? call("read_code", { id: file.entityId }) : call("answer", { text: "AuthService implements login.", cites: [method.entityId] });
    } };
    const result = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision });
    assert.ok(result.ok && result.value.kind === "analysis");
    assert.equal(result.value.validation!.status, "SUPPORTED"); assert.equal(result.value.validation!.repairAttempts, 0);
    assert.equal(writes, 2); assert.equal(reviews, 1);
  } finally { f.worker.close(); }
});

test("missing source at the original call cap gets bounded repair reads before model review", async () => {
  const f = await boot();
  try {
    const targetEntity = f.svc.store.entities(f.revision).find(e => e.name === "signToken")!;
    let writes = 0, reviews = 0;
    f.svc.router = { name: "repair-cap", choose: async () => null, converse: async (messages, tools) => {
      if (tools[0].name === "review_answer") { reviews++; return call("review_answer", { ...supported }); }
      writes++;
      if (writes === 1) return call("read_code", { id: target(messages) });
      if (writes === 2) return { content: "", toolCalls: Array.from({ length: 27 }, (_, i) => ({ name: "find_code", arguments: { query: i === 0 ? "signToken" : `NoSuchImplementation${i}` } })) };
      if (writes === 4) {
        assert.ok(tools.some(t => t.name === "read_code"), "repair has its own tool allowance after 28 calls");
        assert.equal(reviews, 0, "known missing source is handled before paying for a reviewer call");
        return call("read_code", { id: targetEntity.entityId });
      }
      return call("answer", { text: "signToken implements token signing.", cites: [targetEntity.entityId] });
    } };
    const request = ctx(); request.deadlineMs = Date.now() + 90000;
    const result = await f.svc.converse(request, { text: "Explain AuthService", revision: f.revision });
    assert.ok(result.ok && result.value.kind === "analysis");
    assert.equal(result.value.validation!.status, "SUPPORTED"); assert.equal(result.value.validation!.repairAttempts, 1);
    assert.equal(reviews, 1); assert.equal(writes, 5);
  } finally { f.worker.close(); }
});

test("review can finish after fifteen seconds while staying within its thirty-second budget", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (value: ReturnType<typeof call>) => void, signal!: AbortSignal;
  const model: RouterModel = { name: "long-review", choose: async () => null, converse: async (_messages, _tools, s) => {
    signal = s!; return new Promise(resolve => { finish = resolve; });
  } };
  const pending = reviewAnswer(model, "Explain login", { text: "Draft", cites: [] }, [], Date.now() + 45000);
  await Promise.resolve(); await Promise.resolve();
  t.mock.timers.tick(16000);
  assert.equal(signal.aborted, false);
  finish(call("review_answer", { ...supported }));
  assert.equal((await pending).verdict, "SUPPORTED");
});

test("old saved file reads regain contained-method coverage on Continue without duplicate reads", async () => {
  const f = await boot();
  try {
    const file = f.svc.store.entities(f.revision).find(e => e.kind === "file" && e.file === "src/auth/service.ts")!;
    const method = f.svc.store.entities(f.revision).find(e => e.name === "AuthService.login")!;
    let writes = 0;
    f.svc.router = { name: "old-checkpoint", choose: async () => null, converse: async (_messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...gap("UNRESOLVED") });
      return writes++ === 0 ? call("read_code", { id: file.entityId }) : call("answer", { text: "Login exists.", cites: [method.entityId] });
    } };
    const first = await f.svc.converse(ctx(), { text: "Explain AuthService", revision: f.revision, sessionId: "old-coverage" });
    assert.ok(first.ok && first.value.kind === "analysis");
    const row = f.svc.store.db.prepare("select response_json from conversation_actions where session_id=? and state='complete'").get("old-coverage") as { response_json: string };
    const saved = JSON.parse(row.response_json), checkpoint = saved.value.validation.investigation;
    checkpoint.sourceReads = { [file.entityId]: checkpoint.sourceReads[file.entityId] };
    checkpoint.observations = checkpoint.observations.map((o: { content: string }) => ({ ...o, content: o.content.split("Contained implementations fully covered")[0] }));
    f.svc.store.db.prepare("update conversation_actions set response_json=? where session_id=? and state='complete'").run(JSON.stringify(saved), "old-coverage");
    let resumedWrites = 0;
    f.svc.router = { name: "continue-coverage", choose: async () => null, converse: async (_messages, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...supported });
      resumedWrites++; return call("answer", { text: "AuthService implements login.", cites: [method.entityId] });
    } };
    const resumed = await f.svc.converse(ctx(), { text: `continue investigation ${checkpoint.id}`, revision: f.revision, sessionId: "old-coverage" });
    assert.ok(resumed.ok && resumed.value.kind === "analysis");
    assert.equal(resumed.value.validation!.status, "SUPPORTED"); assert.equal(resumedWrites, 1);
  } finally { f.worker.close(); }
});
