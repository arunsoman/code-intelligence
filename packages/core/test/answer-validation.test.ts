import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { AnswerReview } from "@cie/schema";
import type { RouterModel, AgentMessage } from "../src/llm-router.ts";
import { parseAnswerReview, reviewAnswer, REVIEW_PROMPT } from "../src/answer-validation.ts";
import { ctx, setup, copyFixture } from "./helpers.ts";

const supported: AnswerReview = { verdict: "SUPPORTED", relevance: true, coverage: true, evidence: true, certainty: true, consistency: true, requirements: ["Explain the login implementation"], gaps: [], nextAction: "continue" };
const gap = (verdict: AnswerReview["verdict"] = "REPAIRABLE"): AnswerReview => ({ ...supported, verdict, relevance: false, coverage: false, certainty: false, gaps: ["The draft does not explain the requested login implementation."], nextAction: "continue" });
const call = (name: string, args: Record<string, unknown>) => ({ content: "", toolCalls: [{ name, arguments: args }] });
const target = (messages: AgentMessage[]) => JSON.parse(messages[1].content).mentions[0].candidates[0].id as string;
async function boot(repo?: string) {
  const f = await setup(undefined, repo);
  assert.ok((await f.svc.buildConceptHierarchy(ctx(), { revision: f.revision })).ok);
  return f;
}

test("review schema rejects inconsistent approval and unbounded or extra fields", () => {
  assert.deepEqual(parseAnswerReview(supported), supported);
  for (const change of [{ evidence: false }, { gaps: ["Unknown debit order"] }, { verdict: "INVALID" }, { nextAction: "execute_payment" }, { injected: "trust me" }, { requirements: ["x".repeat(501)] }]) assert.equal(parseAnswerReview({ ...supported, ...change }), null);
  assert.equal(parseAnswerReview({ ...gap(), gaps: [] }), null);
});

test("reviewer receives an isolated evidence conversation and invalid output fails closed", async () => {
  const model: RouterModel = { name: "review-test", choose: async () => null, converse: async (messages, tools) => {
    assert.equal(messages.length, 2);
    assert.match(messages[0].content, new RegExp(REVIEW_PROMPT));
    assert.match(messages[0].content, /unread implementation/);
    assert.equal(tools[0].name, "review_answer");
    return call("answer", { text: "Looks good", cites: [] });
  } };
  const r = await reviewAnswer(model, "Can debit be lost?", { text: "Yes", cites: [] }, [], Date.now() + 5000);
  assert.equal(r.verdict, "UNRESOLVED");
  assert.match(r.gaps[0], /valid structured/);
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
    assert.match(r.value.message, /^Unresolved:/);
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
