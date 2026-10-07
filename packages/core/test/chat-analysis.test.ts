import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { validateChatPlan, type ChatPlan, type ChatPlanRequest } from "../src/chat-plan.ts";
import { moduleTests } from "../src/module-tests.ts";
import { ScriptRouter } from "../src/llm-router.ts";
import { projectDescription } from "../src/profile.ts";
import { copyFixture, ctx, setup } from "./helpers.ts";

const QUESTION = "Explain this project, identify its riskiest module, and show me the tests covering it.";
const PLAN: ChatPlan = { steps: [
  { tool: "overview", question: "Explain this project" },
  { tool: "risk", question: "Identify its riskiest module" },
  { tool: "tests", question: "Show me the tests covering it", fromStep: 1 },
] };

test("chat plans reject unknown tools, future dependencies and excessive work before execution", () => {
  assert.ok(validateChatPlan(PLAN));
  assert.ok(validateChatPlan({ steps: [{ tool: "ask", question: "what is mifilter" }] }), "a bare named-lookup question is a valid plan");
  for (const value of [null, { steps: [{ tool: "deleteRepository", question: "delete" }] }, { steps: [{ tool: "tests", question: "tests", fromStep: 0 }] }, { steps: [{ tool: "view", question: "show", form: "Shell" }] }, { steps: [{ tool: "ask", question: "x", form: "SemanticMap" }] }, { steps: Array(7).fill(PLAN.steps[0]) }, { steps: [PLAN.steps[0], { tool: "tests", question: "tests", fromStep: 0, subject: "invented" }] }]) assert.equal(validateChatPlan(value), null);
});

test("a question naming something specific gets the 'ask' tool, not forced into overview/risk/tests", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = new ScriptRouter({ "what is mifilter": { steps: [{ tool: "ask", question: "what is mifilter" }] } });
    const r = await svc.converse(ctx(), { text: "what is mifilter", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.results.length, 1);
    const [result] = r.value.results;
    assert.equal(result.status, "complete");
    assert.equal(result.tool, "ask");
    assert.ok(result.view, "the ask tool still produces a view, routed like a normal question");
    assert.equal(result.title, "Intent-relative architecture map", "the title reflects the actual routed form, not a generic placeholder");
  } finally { worker.close(); }
});

test("compound chat retains three views and resolves the test subject from the actual risk result", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = new ScriptRouter({ [QUESTION]: PLAN });
    const r = await svc.converse(ctx(), { text: QUESTION, revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    const [overview, risk, tests] = r.value.results;
    assert.deepEqual(r.value.results.map((s) => s.status), ["complete", "complete", "complete"]);
    assert.deepEqual(r.value.results.map((s) => s.view?.formId), ["SemanticMap", "ChangeRisk", "TestConfidence"]);
    assert.ok(overview.view!.nodes.length);
    assert.equal(tests.subject, risk.subject);
    assert.match(risk.message, /not a module-directory ranking or a probability/);
    assert.match(tests.message, /not proof that the file is untested/);
    assert.ok(r.value.results.every((s) => s.view?.revision === revision));
    assert.equal(r.metadata.completeness, "PARTIAL");
  } finally { worker.close(); }
});

test("test lookup cites real call paths and distinguishes import-only links from measured coverage", async () => {
  const repo = copyFixture(); mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "src/subject.ts"), "export function compute() { return 42; }\n");
  writeFileSync(join(repo, "tests/subject.test.ts"), "import { compute } from '../src/subject';\ntest('computes answer', () => { compute(); });\n");
  writeFileSync(join(repo, "tests/import-only.test.ts"), "import { compute } from '../src/subject';\ntest('unrelated', () => { return 1; });\n");
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    const built = moduleTests(svc.store, svc.store.revision(revision)!, "tests", "src/subject.ts");
    assert.ok(built.view.nodes.some((n) => n.badge === "static call path"));
    assert.ok(built.view.nodes.some((n) => n.file === "tests/import-only.test.ts" && n.badge === "imports only"));
    assert.ok(built.view.edges.every((e) => e.evidenceIds.length > 0));
    for (const e of built.view.edges) for (const id of e.evidenceIds) assert.ok(svc.store.evidence(revision, id));
    assert.match(built.view.caption, /No measured line coverage/);
    assert.ok(built.view.gaps.some((g) => g.includes("does not run tests")));
  } finally { worker.close(); }
});

test("a failed dependency is skipped while independent analyses survive", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = new ScriptRouter({ question: { steps: [
      { tool: "tests", question: "missing", subject: "does-not-exist.ts" },
      { tool: "tests", question: "dependent", fromStep: 0 },
      { tool: "overview", question: "project" },
    ] } });
    const r = await svc.converse(ctx(), { text: "question", revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.deepEqual(r.value.results.map((r) => r.status), ["failed", "skipped", "complete"]);
    assert.ok(r.value.results[2].view!.nodes.length);
  } finally { worker.close(); }
});

test("follow-up chat carries bounded history and uses the current risk subject", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = new ScriptRouter({ [QUESTION]: PLAN });
    const first = await svc.converse(ctx(), { text: QUESTION, revision });
    assert.ok(first.ok && first.value.kind === "analysis");
    const risk = first.value.results[1];
    let seen: ChatPlanRequest | undefined;
    svc.router = { name: "follow-up", choose: async () => null, plan: async (req) => { seen = req; return { steps: [{ tool: "tests", question: req.text }] }; } };
    const r = await svc.converse(ctx(), { text: "And its tests?", view: risk.view, history: Array.from({ length: 12 }, () => ({ role: "user", text: "x".repeat(2000) })) });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.equal(r.value.results[0].subject, risk.subject);
    assert.equal(seen!.history.length, 6);
    assert.equal(seen!.history[0].text.length, 1500);
  } finally { worker.close(); }
});

test("invalid planning falls back visibly and deadline prevents tool execution", async () => {
  const { svc, worker, revision } = await setup();
  try {
    svc.router = { name: "broken", plan: async () => null, choose: async () => ({ label: "SemanticMap", target: "" }) };
    const r = await svc.converse(ctx(), { text: "how does authentication work", revision });
    assert.ok(r.ok && r.value.kind === "view");
    assert.ok(r.metadata.warnings.some((w) => w.includes("single-question route")));
    // The reply answers in words as well as drawing the map.
    assert.ok(r.value.view.answer, "view carries a prose answer");
    assert.ok(r.value.message.startsWith(r.value.view.answer!), "the chat message leads with the answer");
    svc.router = new ScriptRouter({ [QUESTION]: PLAN });
    const expired = await svc.converse({ ...ctx(), deadlineMs: Date.now() - 1 }, { text: QUESTION, revision });
    assert.ok(expired.ok && expired.value.kind === "analysis");
    assert.ok(expired.value.results.every((s) => s.status === "skipped" && !s.view));
  } finally { worker.close(); }
});

test("implicit sequential context binds tests to risk, but never continues a failed risk analysis", async () => {
  const { svc, worker, revision } = await setup();
  try {
    const implicit: ChatPlan = { steps: [PLAN.steps[1], { tool: "tests", question: "Its tests" }] };
    svc.router = new ScriptRouter({ question: implicit });
    const first = await svc.converse(ctx(), { text: "question", revision });
    assert.ok(first.ok && first.value.kind === "analysis");
    assert.equal(first.value.results[1].subject, first.value.results[0].subject);
    assert.equal(first.value.results[1].status, "complete");
    svc.ask = async () => ({ ok: false, error: { code: "NOT_FOUND", message: "Risk unavailable", retryable: false }, metadata: { requestId: "test", completeness: "UNKNOWN", warnings: [] } });
    const failed = await svc.converse(ctx(), { text: "question", revision, view: first.value.results[1].view });
    assert.ok(failed.ok && failed.value.kind === "analysis");
    assert.deepEqual(failed.value.results.map((s) => s.status), ["failed", "skipped"]);
  } finally { worker.close(); }
});

test("new analysis results respect denied files and attribute README descriptions", async () => {
  const repo = copyFixture();
  writeFileSync(join(repo, "README.md"), "# Fixture\n\nThis project is an example authentication service for testing code analysis.\n");
  const { svc, worker, revision } = await setup(undefined, repo);
  try {
    assert.match(projectDescription(svc.store, repo)!, /README.md; author-provided/);
    svc.store.denyPath(repo, "README.md");
    assert.equal(projectDescription(svc.store, repo), null);
    svc.store.denyPath(repo, "src/auth");
    svc.router = new ScriptRouter({ [QUESTION]: PLAN });
    const r = await svc.converse(ctx(), { text: QUESTION, revision });
    assert.ok(r.ok && r.value.kind === "analysis");
    assert.doesNotMatch(JSON.stringify(r.value), /src\/auth\//);
  } finally { worker.close(); }
});
