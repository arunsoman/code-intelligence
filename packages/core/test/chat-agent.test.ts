import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN } from "../src/access.ts";
import { CHAT_TOOLS, checkArgs, toolByName } from "../src/chat-tools.ts";
import type { AgentMessage, AgentReply, AgentToolSpec, RouterModel } from "../src/llm-router.ts";
import { resolveMentions, within } from "../src/mentions.ts";
import { policyFor } from "../src/access.ts";
import { copyFixture, ctx, setup as ingest } from "./helpers.ts";

/** A tool-calling model that plays a script: each turn is a function of what it has been told so far. */
function scripted(turns: ((messages: AgentMessage[], tools: AgentToolSpec[]) => AgentReply | null)[]): RouterModel & { calls: { messages: AgentMessage[]; tools: AgentToolSpec[] }[] } {
  const calls: { messages: AgentMessage[]; tools: AgentToolSpec[] }[] = [];
  return {
    name: "scripted-agent", calls, choose: async () => null,
    converse: async (messages, tools) => { calls.push({ messages: [...messages], tools }); const t = turns[calls.length - 1] ?? turns.at(-1)!; return t(messages, tools); },
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
        return call("answer", { text: "AuthService signs users in.", cites: [request(m).mentions[0].candidates[0].id, "function:src/nowhere.ts#invented"] });
      },
    ]);
    svc.router = model;
    const r = await svc.converse(ctx(), { text: "what is the job of AuthService?", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.match(r.value.message, /^AuthService signs users in\.\n\nBased on: AuthService \(src\/auth\/service\.ts\)\.$/);
    assert.ok(r.metadata.warnings.some((w) => /cited 1 element\(s\) no tool had shown/.test(w)));
    assert.match(r.value.thinking!, /read_code\(id="class:src\/auth\/service\.ts#AuthService"\)/);
    assert.equal(request(model.calls[0].messages).mentions[0].name, "AuthService");
    // Every chat reply draws a picture alongside the words — a model that only ever called text tools must still
    // leave the user with a view, built automatically and grounded in what the answer actually cited.
    assert.equal(r.value.results.length, 1);
    assert.equal(r.value.results[0].view?.formId, "SemanticMap");
    assert.ok(r.value.results[0].view!.nodes.some((n) => n.entityRefs.includes(request(model.calls[0].messages).mentions[0].candidates[0].id)), "the guaranteed view is seeded from the cited element, not the general map");
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
    assert.ok(model.calls.length <= 8);
  } finally { worker.close(); }
});

test("plain text is asked once to become an answer call; bad arguments are refused back to the model", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = scripted([
      () => call("show_view", { form: "Shell", question: "x" }),
      (m) => { assert.match(m.at(-1)!.content, /^Refused: "form" must be one of/); return { content: "I should look it up. Thinking aloud.", toolCalls: [] }; },
      (m) => { assert.match(m.at(-1)!.content, /calling the answer tool/); return call("answer", { text: "Final.", cites: [] }); },
    ]);
    const r = await svc.converse(ctx(), { text: "show me something", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.message, "Final.");
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
    assert.match(r.value.message, /^I could not finish an answer \(scripted-agent stopped answering\)\.\nWhat I looked at:\n• find_code\(query="token"\)/);
    assert.equal(r.metadata.completeness, "PARTIAL");
  } finally { worker.close(); }
});

async function setup(...args: Parameters<typeof ingest>) {
 const fixture=await ingest(...args);
 const hierarchy=await fixture.svc.buildConceptHierarchy(ctx(),{revision:fixture.revision});
 assert.ok(hierarchy.ok,"analysis tests require the current concept hierarchy");
 return fixture;
}
