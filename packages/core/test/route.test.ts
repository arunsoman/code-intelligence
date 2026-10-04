// The router is judged on labelled questions, not on the examples its rules were written from. DEV is what the
// similarity vocabulary was tuned on; HELD_OUT was written before any tuning and is run once per change, so its
// score is the honest one. Both must clear a floor, and a confidently wrong answer ("high") fails the build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { routeQuestion } from "../src/route.ts";
import { ctx, setup } from "./helpers.ts";

type Case = [question: string, form: string, kind?: string];

const DEV: Case[] = [
  ["Show me how authentication works", "SemanticMap"],
  ["explain the payment module", "SemanticMap"],
  ["what does the ledger do", "SemanticMap"],
  ["Show me everything that could cause a payment to fail", "CausalGraph", "failure"],
  ["what can make a transfer break", "CausalGraph", "failure"],
  ["why would createPayment throw an error", "CausalGraph", "failure"],
  ["Why could this balance become incorrect?", "CausalGraph", "invariant"],
  ["how can the ledger drift out of sync", "CausalGraph", "invariant"],
  ["Walk me through createPayment step by step", "TransactionJourney"],
  ["what happens when a user refunds an order", "TransactionJourney"],
  ["follow a request end to end through checkout", "TransactionJourney"],
  ["Who reads and writes balance?", "DataLineage"],
  ["where is the account status updated", "DataLineage"],
  ["who modifies the invoice table", "DataLineage"],
  ["What changed since the last index?", "SemanticDiff"],
  ["compare this version with the last release", "SemanticDiff"],
  ["what is different between the two revisions", "SemanticDiff"],
  ["Why is adjustBalance not transactional?", "Archaeology"],
  ["how did the retry logic end up like this", "Archaeology"],
  ["tell me the history of the fee calculation", "Archaeology"],
  ["Who can reach adjustBalance and what stops them?", "TrustBoundary"],
  ["what would an attacker be able to reach from the public api", "TrustBoundary"],
  ["which endpoints are exposed without authorization", "TrustBoundary"],
  ["What has been going wrong in the last 7 days?", "RuntimeOverlay"],
  ["show reported incidents on the code", "RuntimeOverlay"],
  ["what is breaking in production", "RuntimeOverlay"],
  ["Where can balance race?", "RaceWindow"],
  ["can two requests hit the ledger at the same time", "RaceWindow"],
  ["is there a concurrency problem with transfers", "RaceWindow"],
  ["What if we remove the ledger module?", "Counterfactual"],
  ["what would break if we delete the cache", "Counterfactual"],
  ["is it safe to retire the legacy exporter", "Counterfactual"],
  ["How well tested are our operations?", "TestConfidence"],
  ["which behaviours have no test", "TestConfidence"],
  ["how much of the payment code is covered by tests", "TestConfidence"],
  ["Who owns what and where is the bus factor 1?", "Ownership"],
  ["who is the expert on billing", "Ownership"],
  ["who should review changes to the scheduler", "Ownership"],
  ["Show the implicit concepts in this code", "ConceptAtlas"],
  ["what unwritten business rules does this code follow", "ConceptAtlas"],
  ["list the undocumented assumptions", "ConceptAtlas"],
  ["Which policies are enforced and where do they have gaps?", "PolicyMap"],
  ["which routes get around the audit rule", "PolicyMap"],
  ["are our compliance rules actually enforced", "PolicyMap"],
  ["Where is it risky to change things?", "ChangeRisk"],
  ["which files are the most fragile", "ChangeRisk"],
  ["where is the technical debt worst", "ChangeRisk"],
  // migrated from the first held-out set after its misses informed the vocabulary
["how is the notification system put together", "SemanticMap"],
  ["describe the structure of the billing code", "SemanticMap"],
  ["what makes a checkout fail", "CausalGraph", "failure"],
  ["ways the refund job can crash", "CausalGraph", "failure"],
  ["how could the stock count end up wrong", "CausalGraph", "invariant"],
  ["can the wallet balance go negative", "CausalGraph", "invariant"],
  ["trace what occurs when an invoice is voided", "TransactionJourney"],
  ["take me through the signup flow", "TransactionJourney"],
  ["which functions write to the orders table", "DataLineage"],
  ["who touches the session state", "DataLineage"],
  ["summarise what is new since the previous revision", "SemanticDiff"],
  ["show the diff in behaviour between releases", "SemanticDiff"],
  ["why was the cache layer written this way", "Archaeology"],
  ["where did this workaround come from", "Archaeology"],
  ["can an unauthenticated caller get to the admin functions", "TrustBoundary"],
  ["what protects the payout path", "TrustBoundary"],
  ["which errors were reported this week", "RuntimeOverlay"],
  ["map the incidents onto the modules", "RuntimeOverlay"],
  ["could two jobs process the same payment simultaneously", "RaceWindow"],
  ["where are there thread safety problems", "RaceWindow"],
  ["what depends on the email service if we drop it", "Counterfactual"],
  ["what breaks without the rate limiter", "Counterfactual"],
  ["which parts have weak test coverage", "TestConfidence"],
  ["are the refund paths tested", "TestConfidence"],
  ["who maintains the search module", "Ownership"],
  ["where does only one person know the code", "Ownership"],
  ["what domain concepts are hidden in this repo", "ConceptAtlas"],
  ["show me conventions nobody wrote down", "ConceptAtlas"],
  ["which rules do we bypass", "PolicyMap"],
  ["where is the validation rule not enforced", "PolicyMap"],
  ["which module is riskiest to touch", "ChangeRisk"],
  ["where would a refactor hurt most", "ChangeRisk"],
];

const HELD_OUT: Case[] = [
  ["how are the background workers organised", "SemanticMap"],
  ["what makes a subscription renewal fail", "CausalGraph", "failure"],
  ["what could make the webhook handler blow up", "CausalGraph", "failure"],
  ["how might the inventory count get out of step", "CausalGraph", "invariant"],
  ["can the credit total ever be wrong", "CausalGraph", "invariant"],
  ["show what happens, in order, when someone cancels a plan", "TransactionJourney"],
  ["go through the onboarding sequence", "TransactionJourney"],
  ["what code updates the customer record", "DataLineage"],
  ["which functions read the feature flags", "DataLineage"],
  ["what is new compared with the previous index", "SemanticDiff"],
  ["how has behaviour changed since the last revision", "SemanticDiff"],
  ["how come the scheduler works like this", "Archaeology"],
  ["what is the story behind the retry wrapper", "Archaeology"],
  ["who is able to call the delete endpoint and what checks them", "TrustBoundary"],
  ["where is the privilege boundary", "TrustBoundary"],
  ["which exceptions came in recently", "RuntimeOverlay"],
  ["overlay the failing tests on the modules", "RuntimeOverlay"],
  ["could two workers pick up the same job", "RaceWindow"],
  ["is the counter update atomic", "RaceWindow"],
  ["what would stop working if the queue went away", "Counterfactual"],
  ["what is the blast radius of removing the auth middleware", "Counterfactual"],
  ["which operations lack a safety net of tests", "TestConfidence"],
  ["is the export path covered", "TestConfidence"],
  ["who knows the payments code best", "Ownership"],
  ["which files have a single contributor", "Ownership"],
  ["what implicit rules does the pricing code encode", "ConceptAtlas"],
  ["surface the domain vocabulary buried in the code", "ConceptAtlas"],
  ["which guard rails are only held by convention", "PolicyMap"],
  ["where do we skip the approval check", "PolicyMap"],
  ["what is the most brittle part of the codebase", "ChangeRisk"],
  ["where does churn and coupling pile up", "ChangeRisk"],
];

const read = (set: Case[]) => set.map(([q, form, kind]) => {
  const r = routeQuestion(q);
  return { q, want: form + (kind ? `:${kind}` : ""), got: r.form + (r.kind ? `:${r.kind}` : ""), source: r.source, confidence: r.confidence, hit: r.form === form && (r.kind ?? undefined) === kind, inAlts: r.alternatives.some((a) => a.form === form && (a.kind ?? undefined) === kind) };
});
const score = (rows: ReturnType<typeof read>) => ({ n: rows.length, top1: rows.filter((r) => r.hit).length / rows.length, top3: rows.filter((r) => r.hit || r.inAlts).length / rows.length });

test("routing: dev questions are read correctly, and never confidently wrong", () => {
  const rows = read(DEV);
  const s = score(rows);
  const wrong = rows.filter((r) => !r.hit);
  console.log(`  dev top-1 ${(s.top1 * 100).toFixed(0)}% top-3 ${(s.top3 * 100).toFixed(0)}% (${s.n})`, wrong.map((r) => `${r.q} → ${r.got} [${r.source}/${r.confidence}] want ${r.want}`));
  assert.deepEqual(wrong.filter((r) => r.confidence === "high"), [], "a high-confidence reading was wrong");
  assert.ok(s.top1 >= 0.9, `top-1 ${s.top1}`);
});

test("routing: held-out questions (never used to tune): measured accuracy, and no wrong reading is ever confident", () => {
  const rows = read(HELD_OUT);
  const s = score(rows);
  const wrong = rows.filter((r) => !r.hit);
  console.log(`  held-out top-1 ${(s.top1 * 100).toFixed(0)}% top-3 ${(s.top3 * 100).toFixed(0)}% (${s.n})`, wrong.map((r) => `${r.q} → ${r.got} [${r.source}/${r.confidence}] want ${r.want}`));
  assert.deepEqual(wrong.filter((r) => r.confidence === "high"), [], "a high-confidence reading was wrong");
  // Measured on unseen phrasing, not hoped for: the offline layers are a safety net, and the model layer is where
  // paraphrase is handled. These floors ratchet up when a better layer lands; they never come down to hide a regression.
  assert.ok(s.top1 >= 0.4, `top-1 ${s.top1}`);
  assert.ok(s.top3 >= 0.65, `top-3 ${s.top3}`);
  assert.ok(wrong.every((r) => r.confidence !== "high"), "every wrong reading carries a warning the user can see");
});

test("routing: the canonical explain phrasings are recognised by a rule, not merely defaulted to the map", () => {
  for (const q of ["Show me how authentication works", "explain the payment module", "what does the ledger do", "how does the scheduler work"]) assert.equal(routeQuestion(q).source, "rule", q);
  const come = routeQuestion("how come the scheduler works like this");
  assert.deepEqual([come.source, come.confidence], ["default", "low"], "not mistaken for 'how does it work'; flagged as a guess");
});

test("routing: every reading says which layer produced it, and unsure readings are never 'high'", () => {
  for (const q of ["hello", "asdf qwerty", "show me stuff", "what about the thing", ...DEV.map((d) => d[0])]) {
    const r = routeQuestion(q);
    assert.ok(["rule", "similarity", "default"].includes(r.source));
    if (r.source !== "rule") assert.notEqual(r.confidence, "high", q);
    assert.ok(r.because.length > 10 && r.name.length > 0);
    assert.ok(r.alternatives.length <= 3 && r.alternatives.every((a) => !(a.form === r.form && a.kind === r.kind)));
  }
  assert.equal(routeQuestion("asdf qwerty").source, "default");
});

class Router implements ModelProvider {
  readonly name = "fake"; readonly model = "router"; readonly hosted = false;
  seen: ModelRequest[] = []; private inner = new StubProvider();
  private answer: unknown;
  constructor(answer: unknown) { this.answer = answer; }
  async generate(req: ModelRequest) { this.seen.push(req); return req.purpose === "ROUTE" ? this.answer : this.inner.generate(req); }
}

test("routing: the model is asked only when the offline layers are unsure, and it can only choose a form", async () => {
  const model = new Router({ form: "CausalGraph", kind: "failure", confidence: 0.9, reason: "asks what could go wrong" });
  const { svc, worker, revision } = await setup(model);
  // Sure by rule: no model call.
  const sure = await svc.ask(ctx(), { question: "Where can balance race?", revision });
  assert.ok(sure.ok && sure.value.view.route?.source === "rule" && sure.value.view.formId === "RaceWindow");
  assert.equal(model.seen.filter((r) => r.purpose === "ROUTE").length, 0);
  // Unsure offline: the model names the form, the view is built by the same code, and the reading says so.
  const unsure = await svc.ask(ctx(), { question: "what could make the webhook handler blow up", revision });
  assert.ok(unsure.ok);
  const route = unsure.value.view.route!;
  assert.equal(route.source, "model");
  assert.equal(route.form, "CausalGraph");
  assert.match(route.because, /fake\/router.*not calibrated/);
  assert.equal(model.seen.filter((r) => r.purpose === "ROUTE").length, 1);
  assert.ok(route.alternatives.some((a) => a.form === "SemanticMap"), "the offline reading stays one click away");
  worker.close();
});

test("routing: a model that is unsure, off-list, over-confident in nothing, or invalid leaves the offline reading", async () => {
  for (const answer of [{ form: null, confidence: 0.2, reason: "unclear" }, { form: "RaceWindow", confidence: 0.3, reason: "meh" }, { form: "NotAForm", confidence: 0.99, reason: "x" }, "not json"]) {
    const { svc, worker, revision } = await setup(new Router(answer));
    const r = await svc.ask(ctx(), { question: "what could make the webhook handler blow up", revision });
    assert.ok(r.ok);
    assert.equal(r.value.view.route?.source, "default", JSON.stringify(answer));
    worker.close();
  }
});

test("routing: an explicit choice (gallery or a chip) is obeyed, including the architecture map and either causal kind", async () => {
  const model = new Router({ form: "RaceWindow", confidence: 1, reason: "x" });
  const { svc, worker, revision } = await setup(model);
  const map = await svc.ask(ctx(), { question: "what makes a payment fail", revision, form: "SemanticMap" });
  assert.ok(map.ok && map.value.view.formId === "SemanticMap" && map.value.view.route?.source === "chosen");
  const inv = await svc.ask(ctx(), { question: "what makes a payment fail", revision, form: "CausalGraph", kind: "invariant" });
  assert.ok(inv.ok && inv.value.view.route?.kind === "invariant" && inv.value.view.meta?.kind === "invariant");
  assert.equal(model.seen.filter((r) => r.purpose === "ROUTE").length, 0, "a chosen view is never second-guessed");
  worker.close();
});

test("routing: a guessed reading never claims the question said something it did not", async () => {
  const { svc, worker, revision } = await setup();
  const guess = await svc.ask(ctx(), { question: "what would stop working if the queue went away", revision });
  assert.ok(guess.ok && guess.value.view.route?.source !== "rule");
  assert.equal(guess.value.view.formReason, undefined, "no 'the question is about how something works' for a default");
  const said = await svc.ask(ctx(), { question: "show me how authentication works", revision });
  assert.ok(said.ok && said.value.view.route?.source === "rule" && /how something works/.test(said.value.view.formReason ?? ""));
  worker.close();
});
