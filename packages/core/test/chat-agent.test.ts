import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { OPEN } from "../src/access.ts";
import { CHAT_TOOLS, checkArgs, toolByName } from "../src/chat-tools.ts";
import type { AgentMessage, AgentReply, AgentToolSpec, RouterModel } from "../src/llm-router.ts";
import { ModelDeadlineError } from "../src/model-deadline.ts";
import { resolveMentions, within } from "../src/mentions.ts";
import { chartCitesOverlap } from "../src/answer-visual.ts";
import { policyFor } from "../src/access.ts";
import { copyFixture, ctx, setup as ingest } from "./helpers.ts";

/** A tool-calling model that plays a script: each turn is a function of what it has been told so far. */
function scripted(turns: ((messages: AgentMessage[], tools: AgentToolSpec[]) => AgentReply | null)[]): RouterModel & { calls: { messages: AgentMessage[]; tools: AgentToolSpec[] }[] } {
  const calls: { messages: AgentMessage[]; tools: AgentToolSpec[] }[] = [];
  return {
    name: "scripted-agent", calls, choose: async () => null,
    converse: async (messages, tools) => {
      if (tools[0]?.name === "review_answer") return call("review_answer", { verifiedBy: ["obs-1"],  verdict: "SUPPORTED", relevance: true, coverage: true, evidence: true, certainty: true, consistency: true, requirements: [], gaps: [], nextAction: "continue" });
      calls.push({ messages: [...messages], tools }); const t = turns[calls.length - 1] ?? turns.at(-1)!; return t(messages, tools); },
  };
}
const call = (name: string, args: Record<string, unknown>, content = ""): AgentReply => ({ content, toolCalls: [{ name, arguments: args }] });
const request = (m: AgentMessage[]) => JSON.parse(m[1].content) as { mentions: { name: string; match: string; candidates: { id: string; name: string }[] }[]; unresolved: string[] };

test("mentions resolve code-shaped names exactly, then by a small edit distance, and never from an ordinary word", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const m = (q: string) => resolveMentions(svc.store, revision, q, OPEN);
    const exact = m("whats the job of AuthService?");
    assert.equal(exact.resolved[0].text, "AuthService"); assert.equal(exact.resolved[0].how, "exact");
    assert.equal(exact.resolved[0].matches[0].kind, "class", "the class, not the file of the same name");
    assert.equal(m("what does signtoken do").resolved[0]?.matches[0].name, "signToken", "a whole function name in lower case still counts");
    const typo = m("what does AuthSrevice call");
    assert.equal(typo.resolved[0].how, "fuzzy"); assert.equal(typo.resolved[0].matches[0].name, "AuthService", "a swapped pair of letters is one edit");
    assert.deepEqual(m("what is FooBarBazService").unresolved, ["FooBarBazService"]);
    assert.deepEqual(m("how does the token work").resolved.map((x) => x.text), ["token"], "an English word matches only a whole file or symbol name");
    assert.ok(within("mifliter", "mifilter", 1) && !within("mifilter", "usfilter", 1));
  } finally { worker.close(); }
});

test("mentions leave out what the caller may not see", async () => {
  const repo = copyFixture();
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    svc.store.denyPath(repo, "src/auth");
    await svc.buildConceptHierarchy(ctx(), { revision });
    const r = resolveMentions(svc.store, revision, "what is AuthService", policyFor(svc.store, repo));
    assert.deepEqual(r.resolved, []); assert.deepEqual(r.unresolved, ["AuthService"]);
    svc.router = scripted([() => call("read_code", { id: "class:src/auth/service.ts#AuthService" }), (m) => {
      const seen = m.filter((x) => x.role === "tool").map((x) => x.content).join("\n");
      assert.match(seen, /No accessible element/); assert.doesNotMatch(seen, /```|Called by|Contains/, "a guessed id gets no source and no links");
      return call("answer", { text: "Not visible.", cites: ["class:src/auth/service.ts#AuthService"] });
    }]);
    const answered = await svc.converse(ctx(), { text: "what is AuthService", revision });
    assert.ok(answered.ok && answered.value.kind === "analysis");
    assert.doesNotMatch(answered.value.message, /Based on/, "a denied id cannot be cited");
  } finally { worker.close(); }
});

test("tool arguments are checked against each tool's own schema", () => {
  const view = toolByName.get("show_view")!.parameters;
  assert.equal(checkArgs(view, { form: "SemanticMap", question: "q" }), null);
  assert.match(checkArgs(view, { form: "Shell", question: "q" })!, /must be one of/);
  assert.match(checkArgs(view, { form: "SemanticMap" })!, /missing required argument "question"/);
  assert.match(checkArgs(view, { form: "SemanticMap", question: "q", url: "http://x" })!, /unknown argument "url"/);
  assert.ok(CHAT_TOOLS.every((t) => t.parameters.required.every((k) => k in t.parameters.properties)), "every required argument is declared");
});

test("the agent starts from resolved mentions, reads the code, and cites only what a tool showed it", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const model = scripted([
      (m) => call("read_code", { id: request(m).mentions[0].candidates[0].id }),
      (m) => {
        const read = m.find((x) => x.role === "tool")!.content;
        assert.match(read, /class AuthService/); assert.match(read, /```/, "the source is in the observation");
        return call("answer", { text: "AuthService signs users in.", cites: [request(m).mentions[0].candidates[0].id, ...(!m.some(x => x.role === "tool" && x.toolName === "answer") ? ["function:src/nowhere.ts#invented"] : [])] });
      },
    ]);
    svc.router = model;
    const r = await svc.converse(ctx(), { text: "what is the job of AuthService?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.match(r.value.message, /^AuthService signs users in\.\n\nBased on: AuthService \(src\/auth\/service\.ts\)\.\n\nProof:\n- AuthService \(src\/auth\/service\.ts\): VERIFIED/);
    assert.equal(r.value.validation?.repairAttempts, 1);
    assert.match(r.value.thinking!, /read_code\(id="class:src\/auth\/service\.ts#AuthService"\)/);
    assert.equal(request(model.calls[0].messages).mentions[0].name, "AuthService");
    // Every chat reply draws a picture alongside the words — a model that only ever called text tools must still
    // leave the user with a view, built automatically and grounded in what the answer actually cited.
    assert.equal(r.value.results.length, 1);
    assert.equal(r.value.results[0].view?.formId, "SemanticMap");
    assert.ok(r.value.results[0].view!.nodes.some((n) => n.entityRefs.includes(request(model.calls[0].messages).mentions[0].candidates[0].id)), "the guaranteed view is seeded from the cited element, not the general map");
  } finally { worker.close(); }
});

test("the writer's history is compacted: old narration and stale tool results stop being re-sent verbatim", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const narration = "Let me reason about this step at length, as a chatty model would. ".repeat(40); // ~2.9KB of scratch thinking per turn
    const supported = { verdict: "SUPPORTED", relevance: true, coverage: true, evidence: true, certainty: true, consistency: true, requirements: ["Explain AuthService"], gaps: [], verifiedBy: ["class:src/auth/service.ts#AuthService"], nextAction: "continue" };
    const turns: ((m: AgentMessage[], tools: { name: string }[]) => AgentReply)[] = [];
    for (let i = 0; i < 8; i++) turns.push((_m, tools) => tools[0].name === "review_answer" ? call("review_answer", { ...supported }) : call("find_code", { query: "AuthService" }, narration));
    turns.push((m, tools) => {
      if (tools[0].name === "review_answer") return call("review_answer", { ...supported });
      const serialized = JSON.stringify(m);
      assert.ok(!serialized.includes("as a chatty model would. ".repeat(20)), "ancient narration must be stubbed, not re-sent every turn");
      assert.ok(serialized.includes("earlier narration trimmed"), "the model sees that its old narration was trimmed");
      assert.ok(serialized.includes("earlier output trimmed"), "stale tool results are stubbed to heads");
      assert.ok(m.slice(-8).some((x) => x.role === "tool" && x.content.length > 700), "recent tool results stay full");
      return call("answer", { text: "AuthService signs users in.", cites: [] });
    });
    const model = scripted(turns as never);
    svc.router = model;
    const r = await svc.converse(ctx(), { text: "what is the job of AuthService?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation?.status, "SUPPORTED");
    assert.equal(r.value.validation?.repairAttempts, 0);
  } finally { worker.close(); }
});

test("an IR-first investigation needs no source read: ir_of alone is citable evidence", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const model = scripted([
      (m) => call("ir_of", { id: request(m).mentions[0].candidates[0].id }),
      (m) => {
        const ir = m.find((x) => x.role === "tool")!.content;
        assert.match(ir, /semantic IR/, "the observation is the rendered IR");
        assert.match(ir, /let\b|when\b|return\b|call\b/, "the IR shows the body's structure");
        return call("answer", { text: "AuthService signs users in.", cites: [request(m).mentions[0].candidates[0].id] });
      },
    ]);
    svc.router = model;
    const r = await svc.converse(ctx(), { text: "what is the job of AuthService?", revision });
    // The gate used to force read_code for any cited element without a source read; an ir_of render is
    // now a genuine inspection of the body's structure, so this passes with no repair at all.
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation?.status, "SUPPORTED");
    assert.equal(r.value.validation?.repairAttempts, 0);
    assert.match(r.value.message, /^AuthService signs users in\./);
    assert.match(r.value.thinking!, /ir_of\(id="class:src\/auth\/service\.ts#AuthService"\)/);
  } finally { worker.close(); }
});

test("a withheld draft's full prose is replaced in history after repair, not kept alongside the retry", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const bigDraft = "AuthService signs users in. ".repeat(190); // long (close to the answer tool's 6000-char maxLength) but still valid, so it reaches review instead of being refused for its length
    const model = scripted([
      (m) => call("read_code", { id: request(m).mentions[0].candidates[0].id }),
      // Cites an id never shown, so the local gap check downgrades this to REPAIRABLE even though the scripted review always says SUPPORTED.
      (m) => call("answer", { text: bigDraft, cites: [request(m).mentions[0].candidates[0].id, "function:src/nowhere.ts#invented"] }),
      (m) => {
        const serialized = JSON.stringify(m);
        assert.ok(!serialized.includes(bigDraft), "the rejected draft's full text must not still be in the next request's history");
        assert.ok(serialized.includes("withheld after review"), "a short placeholder must stand in for it");
        return call("answer", { text: "AuthService signs users in.", cites: [request(m).mentions[0].candidates[0].id] });
      },
    ]);
    svc.router = model;
    const r = await svc.converse(ctx(), { text: "what is the job of AuthService?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation?.repairAttempts, 1);
    assert.equal(model.calls.length, 3, "the assertion inside the third scripted turn must actually have run");
  } finally { worker.close(); }
});

test("a model that answers with no tool call at all (not_analysis, or an answer with nothing cited) still gets a default view, never a blank canvas", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = scripted([() => call("answer", { text: "I could not find anything relevant.", cites: [] })]);
    const r = await svc.converse(ctx(), { text: "what is the weather like", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.results.length, 1);
    assert.equal(r.value.results[0].view?.formId, "SemanticMap", "falls back to the general map when nothing was cited or mentioned");
  } finally { worker.close(); }
});

test("analysis tools reuse the existing steps and become the reply's views", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = scripted([
      () => ({ content: "", toolCalls: [{ name: "change_risk", arguments: { question: "riskiest file" } }, { name: "change_risk", arguments: { question: "riskiest file" } }] }),
      (m) => {
        const [first, second] = m.filter((x) => x.role === "tool").map((x) => x.content);
        assert.match(first, /Highest-ranked source file/); assert.match(second, /^Same call as before/);
        return call("answer", { text: "The riskiest file is shown.", cites: [] });
      },
    ]);
    const r = await svc.converse(ctx(), { text: "which file is riskiest?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.deepEqual(r.value.results.map((x) => x.view?.formId), ["ChangeRisk"], "the repeated call ran once");
    assert.ok(r.metadata.warnings.includes("The answer cites no code element."));
  } finally { worker.close(); }
});

test("a model that keeps calling tools is stopped and offered only the answer tool", async () => {
  const { svc, worker, revision } = await setup();
  try {
    let n = 0;
    const model = scripted([(_, tools) => tools.length === 1 ? call("answer", { text: "Out of budget; here is what I found.", cites: [] }) : call("find_code", { query: `token ${n++}` })]);
    svc.router = model;
    const r = await svc.converse(ctx(), { text: "keep looking", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.message, "Out of budget; here is what I found.");
    assert.deepEqual(model.calls.at(-1)!.tools.map((t) => t.name), ["answer"]);
    assert.ok(model.calls.length <= 16);
    assert.equal(r.metadata.completeness, "PARTIAL", "budget-limited answers must not be marked complete");
  } finally { worker.close(); }
});

test("plain text is asked once to become an answer call; bad arguments are refused back to the model", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = scripted([
      () => call("show_view", { form: "Shell", question: "x" }),
      (m) => { assert.match(m.at(-1)!.content, /^Refused: "form" must be one of/); return { content: "I should look it up. Thinking aloud.", toolCalls: [] }; },
      (m) => { assert.ok(m.some(x => /calling the answer tool/.test(x.content))); return call("answer", { text: "Final.", cites: [] }); },
    ]);
    const r = await svc.converse(ctx(), { text: "show me something", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.match(r.value.message, /^Unresolved:/);
  } finally { worker.close(); }
});

test("a message that is not about the code, or a model that does not answer, goes to the other handlers", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = { ...scripted([() => call("not_analysis", { reason: "map command" })]), choose: async () => ({ label: "overview", target: "" }) };
    const handed = await svc.converse(ctx(), { text: "give me the big picture", revision });
    assert.ok(handed.ok && handed.value.kind === "view", "the single-question route answered");
    svc.router = { ...scripted([() => null]), choose: async () => ({ label: "SemanticMap", target: "" }) };
    const silent = await svc.converse(ctx(), { text: "how does authentication work", revision });
    assert.ok(silent.ok && silent.value.kind === "view");
  } finally { worker.close(); }
});

test("a model that stops mid-way gets a reply listing what was looked at, not an invented conclusion", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = scripted([() => call("find_code", { query: "token" }), () => null]);
    const r = await svc.converse(ctx(), { text: "where are tokens made", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.match(r.value.message, /^Unresolved:/);
    assert.equal(r.value.validation?.status, "UNRESOLVED");
    assert.equal(r.metadata.completeness, "PARTIAL");
  } finally { worker.close(); }
});

test("a reviewer that persistently times out ends the investigation as a process failure, not a rejected answer", async () => {
  const { svc, worker, revision } = await setup();
  try {
    let turnCalls = 0, entityId = "";
    const model: RouterModel = {
      name: "flaky-reviewer", choose: async () => null,
      converse: async (messages, tools) => {
        // The reviewer's own call is a separate conversation identified by its tool set, not by turn order;
        // it times out on every attempt, exactly as a slow model would against a large evidence set.
        if (tools[0]?.name === "review_answer") throw new ModelDeadlineError();
        turnCalls++;
        if (turnCalls === 1) { entityId = request(messages).mentions[0].candidates[0].id; return call("read_code", { id: entityId }); }
        return call("answer", { text: "AuthService signs users in.", cites: [entityId] });
      },
    };
    svc.router = model;
    const r = await svc.converse(ctx(), { text: "what is the job of AuthService?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.match(r.value.message, /^Unresolved:/);
    assert.match(r.value.message, /interrupted by a model or tool failure, not by insufficient evidence/);
    assert.match(r.value.message, /retrying the same session may succeed/);
    // The draft was fully written before the reviewer died: shown once, labeled unreviewed, not repeated as Notes.
    assert.match(r.value.message, /Draft completed before the interruption \(not independently reviewed — treat as unverified\):/);
    assert.equal(r.value.validation?.investigation?.processFailure, true);
    assert.equal(r.value.validation?.investigation?.unverifiedDraft?.indexOf("AuthService signs users in."), 0);
    assert.ok(!r.metadata.warnings.some((w) => /model or tool call itself failed|repeatedly timed out/.test(w)), "the message states the process failure once; Notes must not repeat it");
    assert.match(r.value.message, /AuthService signs users in\./);
  } finally { worker.close(); }
});

for (const finishPages of [false, true]) test(`paged source ${finishPages ? "can be completed" : "makes an early answer partial"}`, async () => {
  const repo = copyFixture();
  appendFileSync(join(repo, "src/auth/service.ts"), "\n" + "// source padding\n".repeat(400) + "// compensation marker\n");
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    const file = svc.store.entities(revision).find((e) => e.kind === "file" && e.file === "src/auth/service.ts")!;
    svc.router = scripted([
      () => call("read_code", { id: file.entityId }),
      (m) => {
        const observation = m.filter((x) => x.role === "tool").at(-1)!.content;
        const next = observation.match(/and offset=(\d+)\./);
        if (finishPages && next) return call("read_code", { id: file.entityId, offset: Number(next[1]) });
        if (finishPages) assert.match(observation, /compensation marker/);
        return call("answer", { text: "Source inspected.", cites: [file.entityId] });
      },
    ]);
    const r = await svc.converse(ctx(), { text: "inspect AuthService implementation", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    // The incomplete-source fact is stated exactly once: whatever the final message already carries cannot re-appear as a Note.
    assert.equal(r.value.message.includes("remains unread") || r.metadata.warnings.some((w) => /Source incomplete/.test(w)), !finishPages);
    if (!finishPages) { assert.equal(r.metadata.completeness, "PARTIAL"); assert.match(r.value.message, /remains unread/); }
  } finally { worker.close(); }
});

async function setup(...args: Parameters<typeof ingest>) {
 const fixture=await ingest(...args);
 const hierarchy=await fixture.svc.buildConceptHierarchy(ctx(),{revision:fixture.revision});
 assert.ok(hierarchy.ok,"analysis tests require the current concept hierarchy");
 return fixture;
}

test("refund findings select compensation as primary and alternative charts reuse its evidence", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const answer = "The provider call fails; reconciliation and rollback must return the refund. Exact debit ordering is unverified.";
    svc.router = scripted([
      m => call("read_code", { id: request(m).mentions[0].candidates[0].id }),
      m => call("answer", { text: answer, cites: [request(m).mentions[0].candidates[0].id] }),
    ]);
    const r = await svc.converse(ctx(), { text: "Explain AuthService", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    const primary = r.value.results[0].view!;
    assert.equal(primary.params?.chartId, "S12");
    assert.match(primary.formReason!, /question and answer/);
    assert.ok(primary.gaps.some(g => /ordering is unverified/.test(g)));
    const manifest = r.value.manifest!;
    assert.equal(manifest.question, "Explain AuthService");
    assert.match(manifest.answerContext!, /ordering is unverified/);
    assert.ok(manifest.snapshotId);
    assert.ok(manifest.views[0].seeds.includes("class:src/auth/service.ts#AuthService"));
    const checkpoint = JSON.stringify(svc.store.evidenceSnapshot(manifest.snapshotId!));
    const alternate = await svc.ask(ctx(), { question: manifest.question, revision, chartCode: "S28", snapshotId: manifest.snapshotId, answerContext: manifest.answerContext });
    assert.ok(alternate.ok);
    assert.equal(alternate.value.manifest!.snapshotId, manifest.snapshotId);
    assert.equal(alternate.value.manifest!.answerContext, manifest.answerContext);
    assert.equal(JSON.stringify(svc.store.evidenceSnapshot(manifest.snapshotId!)), checkpoint, "answer text is not added to source evidence");
  } finally { worker.close(); }
});

test("answer findings supersede an earlier architecture view while preserving it as supporting", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = scripted([
      m => call("read_code", { id: request(m).mentions[0].candidates[0].id }),
      () => call("show_view", { form: "SemanticMap", question: "AuthService" }),
      m => call("answer", { text: "Reconciliation may fail to refund; rollback ordering is unverified.", cites: [request(m).mentions[0].candidates[0].id] }),
    ]);
    const r = await svc.converse(ctx(), { text: "Explain AuthService", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.results[0].view!.params?.chartId, "S12");
    assert.ok(r.value.results.some(result => result.view?.formId === "SemanticMap"));
    assert.equal(r.value.manifest!.views[0].code, "S12");
  } finally { worker.close(); }
});

// A question the 34-intent classifier can't confidently place should still get an attempted answer
// (via the same agent the "ask" route already uses), not a bare refusal: confidence should only pick
// which specialized chart renders, never whether an answer is attempted at all.
test("a question the intent classifier reports as new_intent still reaches the chat agent and gets answered", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = {
      ...scripted([() => call("answer", { text: "The concept hierarchy groups entities into zoom levels L0-L6.", cites: [] })]),
      classify: async () => ({ intent_id: "new_intent", intent: "unknown", confidence: 0.2, reason: "unsupported query" }),
    };
    const r = await svc.converse(ctx(), { text: "what's the hierarchy concept in this project?", revision });
    assert.ok(r.ok && r.value.kind === "analysis", "the agent answered instead of a flat refusal");
  } finally { worker.close(); }
});

test("a new_intent question the chat agent declines still falls back to the original refusal message", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = {
      ...scripted([() => call("not_analysis", { reason: "not a question about this code" })]),
      classify: async () => ({ intent_id: "new_intent", intent: "unknown", confidence: 0.2, reason: "unsupported query" }),
    };
    const r = await svc.converse(ctx(), { text: "what's the hierarchy concept in this project?", revision });
    assert.ok(r.ok && r.value.kind === "message" && /unsupported query/.test(r.value.message), "falls through to the classifier's own refusal, unchanged");
  } finally { worker.close(); }
});

test("chartCitesOverlap: a chart depicts the answer if it touches the same file as something cited, even at a different granularity", () => {
  const nodes = (refs: string[][]) => refs.map((entityRefs, i) => ({ id: `n:${i}`, entityRefs } as any));
  const cls = "class:src/auth/service.ts#AuthService", method = "method:src/auth/service.ts#AuthService.login";
  const other = "function:src/db/users.ts#findByEmail";
  assert.equal(chartCitesOverlap([], { nodes: nodes([[other]]) } as any), true, "nothing cited means nothing to contradict");
  assert.equal(chartCitesOverlap([cls], { nodes: nodes([[method]]) } as any), true, "a cited class's own method, shown instead of the class node, still counts");
  assert.equal(chartCitesOverlap([cls], { nodes: nodes([[other]]) } as any), false, "a chart entirely from a different file depicts something the answer never discussed");
  assert.equal(chartCitesOverlap([cls, other], { nodes: nodes([[other]]) } as any), true, "one of several cited files appearing is enough");
});

test("a chart with no overlap with what the answer cited is replaced by a minimal view built from the cited elements", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const tokenFn = "function:src/auth/token.ts#signToken";
    svc.router = scripted([
      () => call("show_view", { form: "SemanticMap", question: "database user lookups", subject: "src/db/users.ts" }),
      () => call("read_code", { id: tokenFn }),
      () => call("answer", { text: "Tokens are signed in the auth module.", cites: [tokenFn] }),
    ]);
    const r = await svc.converse(ctx(), { text: "Where are tokens signed?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    const primary = r.value.results[0].view!;
    assert.equal(primary.formId, "SemanticMap", "the SemanticMap seeded from the wrong file was rejected, not kept");
    assert.ok(primary.nodes.some(n => n.entityRefs.includes(tokenFn)), "the fallback view is built from exactly what the answer cited");
    assert.ok(primary.gaps.some(g => /didn't correspond to what the answer cited/.test(g)));
  } finally { worker.close(); }
});

test("a scan-shaped question is answered from the duplicates tool in one call, not from guessed anchors", async () => {
  const repo = copyFixture();
  appendFileSync(join(repo, "src/pay.ts"), `
export function payA(account, amount) { let total = reserve(account, amount); if (total > limit) { return reject(account); } return total; }
export function payB(client, value) { let total = reserve(client, value); if (total > limit) { return reject(client); } return total; }
`);
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    const ids: string[] = [];
    svc.router = scripted([
      () => call("duplicates", {}),
      (m) => {
        const result = m.filter((x) => x.role === "tool").at(-1)!.content;
        for (const hit of result.matchAll(/\[([a-z]+:[^\]\s]+)\]/g)) if (!ids.includes(hit[1])) ids.push(hit[1]);
        assert.ok(/payA|payB/.test(result), "the scan surfaced both renamed twins");
        return call("answer", { text: "The system has an exact-shape duplicate pair.", cites: ids.slice(0, 2) });
      },
    ]);
    const r = await svc.converse(ctx(), { text: "check if there are any duplicate code in the system", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation?.status, "SUPPORTED");
    assert.equal(ids.length >= 2, true, "the twins were citable");
  } finally { worker.close(); }
});

test("similar_to resolves an element by name without a prior find_code", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = scripted([
      () => call("similar_to", { name: "AuthService" }),
      (m) => {
        const result = m.filter((x) => x.role === "tool").at(-1)!.content;
        assert.match(result, /Resolved "AuthService" to \[class:src\/auth\/service\.ts#AuthService\]/);
        return call("answer", { text: "Its neighbors are listed by structural similarity.", cites: ["class:src/auth/service.ts#AuthService"] });
      },
    ]);
    const r = await svc.converse(ctx(), { text: "what code is similar to AuthService?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.validation?.status, "SUPPORTED");
  } finally { worker.close(); }
});
