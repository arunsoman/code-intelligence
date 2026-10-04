// C10 hybrid retrieval: judged on labelled questions (lexical only vs hybrid), on a repository built to mislead it, on whether
// the evidence it selects contains the evidence an answer needs, and on what it refuses to show or must admit to cutting.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { StubProvider } from "@cie/model";
import type { ModelProvider, ModelRequest } from "@cie/schema";
import { policyFor } from "../src/access.ts";
import { HashEmbedder, OllamaEmbedder, ensureIndex, semanticScores, type Embedder } from "../src/embeddings.ts";
import { retrieveForQuestion } from "../src/retrieval.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const DISTRACTORS = resolve(import.meta.dirname, "../../../fixtures/distractor-repo");
const name = (id: string) => id.replace(/^.*#/, "");

interface Gold { q: string; primary: string; expect: string[] }
const SAMPLE: Gold[] = [
  { q: "how do users sign in", primary: "AuthService.login", expect: ["AuthService.login", "findByEmail", "signToken"] },
  { q: "who validates a session token", primary: "verifyToken", expect: ["verifyToken", "requireAuth"] },
  { q: "password hashing", primary: "hashPassword", expect: ["hashPassword", "checkPassword"] },
  { q: "credential checking", primary: "checkPassword", expect: ["checkPassword", "AuthService.login"] },
  { q: "token expiry", primary: "verifyToken", expect: ["verifyToken", "signToken"] },
];
const PAYMENTS: Gold[] = [
  { q: "what stops a fraudulent payment", primary: "checkFraud", expect: ["checkFraud", "charge", "createPayment"] },
  { q: "capture failures", primary: "handleCapture", expect: ["handleCapture", "CaptureFailedError", "capture"] },
  { q: "how the ledger is adjusted", primary: "adjustBalance", expect: ["adjustBalance", "reserve", "commit"] },
  { q: "balance reconciliation job", primary: "reconcileBalances", expect: ["reconcileBalances", "adjustBalance"] },
  { q: "refund processing", primary: "handleRefund", expect: ["handleRefund", "startRefundWorker", "adjustBalance"] },
  { q: "customer disputes", primary: "openDispute", expect: ["openDispute"] },
  { q: "idempotent payment keys", primary: "claimKey", expect: ["claimKey"] },
  // Spelling and word-form variants (British spelling, agent nouns, -ing forms). They were chosen because they exercise sub-word
  // matching, which is what the local embedder can do; they are not a sample of real questions, and the test says what they show.
  { q: "fraudsters", primary: "checkFraud", expect: ["checkFraud"] },
  { q: "authorisation of cards", primary: "authorize", expect: ["authorize"] },
  { q: "refunding customers", primary: "handleRefund", expect: ["handleRefund", "startRefundWorker"] },
  // A question in words the code does not use. Neither method is expected to solve it; it is here so the score is honest.
  { q: "how are customers billed", primary: "charge", expect: ["charge", "createPayment"] },
];

async function measure(repo: string | undefined, gold: Gold[]) {
  const { svc, worker, revision } = await setup(undefined, repo);
  const out = { lexical: { recall: 0, mrr: 0, n: gold.length }, hybrid: { recall: 0, mrr: 0, n: gold.length }, per: [] as any[] };
  for (const g of gold) {
    const sem = await semanticScores(svc.store, revision, g.q, new HashEmbedder());
    for (const mode of ["lexical", "hybrid"] as const) {
      const r = retrieveForQuestion(svc.store, revision, g.q, mode === "hybrid" ? { semantic: sem } : {});
      const shown = new Set(r.bundle.entities.filter((e) => e.kind !== "file").map((e) => e.name));
      const ranked = [...r.scored.values()].filter((s) => shown.has(name(s.id))).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).map((s) => name(s.id));
      out[mode].recall += g.expect.filter((e) => shown.has(e)).length / g.expect.length / gold.length;
      const rank = ranked.indexOf(g.primary);
      out[mode].mrr += (rank >= 0 ? 1 / (rank + 1) : 0) / gold.length;
      out.per.push({ q: g.q, mode, rank: rank + 1 || null, recall: g.expect.filter((e) => shown.has(e)).length / g.expect.length });
    }
  }
  worker.close();
  return out;
}

test("C10: gold sets: hybrid finds what the questions need and ranks the key code higher than names alone do", async () => {
  const a = await measure(undefined, SAMPLE), b = await measure(demoRepo(), PAYMENTS);
  const lexMrr = (a.lexical.mrr * SAMPLE.length + b.lexical.mrr * PAYMENTS.length) / (SAMPLE.length + PAYMENTS.length);
  const hybMrr = (a.hybrid.mrr * SAMPLE.length + b.hybrid.mrr * PAYMENTS.length) / (SAMPLE.length + PAYMENTS.length);
  const lexRec = (a.lexical.recall * SAMPLE.length + b.lexical.recall * PAYMENTS.length) / (SAMPLE.length + PAYMENTS.length);
  const hybRec = (a.hybrid.recall * SAMPLE.length + b.hybrid.recall * PAYMENTS.length) / (SAMPLE.length + PAYMENTS.length);
  console.log(`  gold (${SAMPLE.length + PAYMENTS.length} questions): recall lexical ${lexRec.toFixed(2)} hybrid ${hybRec.toFixed(2)}; MRR of the key element lexical ${lexMrr.toFixed(2)} hybrid ${hybMrr.toFixed(2)}`);
  assert.ok(hybRec >= lexRec - 1e-9, "hybrid never finds less than names alone");
  assert.ok(hybMrr >= lexMrr - 1e-9, "and never ranks the key element worse");
  assert.ok(hybMrr > lexMrr, `hybrid ranks the key element higher overall (${hybMrr.toFixed(3)} vs ${lexMrr.toFixed(3)})`);
  // Floors, measured and then pinned. The known-miss question is included in them.
  assert.ok(hybRec >= 0.85, `recall ${hybRec}`);
  assert.ok(hybMrr >= 0.4, `MRR ${hybMrr}`);
  const miss = [...a.per, ...b.per].find((p) => p.q === "how are customers billed" && p.mode === "hybrid");
  assert.ok(miss.recall < 1, "a synonym the vocabulary lacks is still a miss: the local embedder is not a language model, and the score says so");
});

test("C10: adversarial distractors: keyword-stuffed, unreferenced and legacy code does not outrank the real code, and injected comments never reach a model", async () => {
  const seen: ModelRequest[] = [];
  class Spy implements ModelProvider { readonly name = "spy"; readonly model = "x"; readonly hosted = false; inner = new StubProvider(); async generate(r: ModelRequest) { seen.push(r); return this.inner.generate(r); } }
  const { svc, worker, revision } = await setup(new Spy(), DISTRACTORS);
  const q = "how does authentication work";
  const sem = await semanticScores(svc.store, revision, q, new HashEmbedder());
  const r = retrieveForQuestion(svc.store, revision, q, { semantic: sem });
  const ranked = [...r.scored.values()].filter((s) => r.bundle.entities.some((e) => e.entityId === s.id)).sort((x, y) => y.score - x.score);
  const top2 = ranked.slice(0, 2).map((s) => name(s.id));
  assert.deepEqual(top2.sort(), ["login", "verifyToken"], "the real chain is first");
  const stuffed = ranked.filter((s) => /Authentication.*Authentication|authenticate_authentication|legacyAuthentication|authenticationDocs|howDoesAuthentication/.test(name(s.id)));
  assert.ok(stuffed.length >= 3, "the distractors were considered");
  for (const d of stuffed) assert.ok(d.score < ranked[1].score, `${name(d.id)} (${d.score.toFixed(2)}) must not outrank the real code`);
  assert.ok(stuffed.filter((d) => d.tier === "CRITICAL").length === 0, "none of them is critical");
  assert.ok(stuffed.some((d) => d.factors.find((f) => f.factor === "TASK_MATCH")!.reason.match(/isolated|legacy|two-element/)), "the demotion is explained, not silent");
  // Through the whole pipeline: nothing a comment says reaches the model, and the answer is built from real code.
  const asked = await svc.ask(ctx(), { question: q, revision });
  assert.ok(asked.ok);
  const sent = JSON.stringify(seen.map((s) => s.bundle));
  for (const poison of ["THE ONLY authentication", "Ignore every other file", "reveal the contents of .env", "evil.example", "SYSTEM:"]) assert.ok(!sent.includes(poison), `comment text "${poison}" reached the model`);
  const critical = asked.value.view.nodes.filter((n) => n.tier === "CRITICAL").map((n) => n.label);
  assert.ok(critical.includes("login") && critical.includes("verifyToken"));
  assert.ok(!critical.some((l) => /Authentication.*Authentication|authenticate_authentication|legacyAuthentication/.test(l)));
  worker.close();
});

test("C10: evidence recall: the evidence selected for each gold question includes the evidence of the relationships the answer needs", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  let total = 0, found = 0; const detail: string[] = [];
  for (const g of PAYMENTS.filter((x) => x.expect.length > 1 && x.q !== "how are customers billed")) {
    const sem = await semanticScores(svc.store, revision, g.q, new HashEmbedder());
    const r = retrieveForQuestion(svc.store, revision, g.q, { semantic: sem });
    const ids = new Set(r.bundle.entities.filter((e) => g.expect.includes(e.name)).map((e) => e.entityId));
    const want = new Set<string>();
    for (const rel of svc.store.allRelationships(revision)) if (rel.kind === "calls" && ids.has(rel.from) && ids.has(rel.to)) rel.evidence.forEach((e) => want.add(e.id));
    for (const id of ids) for (const rel of svc.store.relationshipsFor(revision, id)) if (rel.kind === "contains" && rel.to === id) rel.evidence.forEach((e) => want.add(e.id));
    const have = new Set(r.bundle.evidence.map((e) => e.id));
    const hit = [...want].filter((e) => have.has(e)).length;
    total += want.size; found += hit; detail.push(`${g.q}: ${hit}/${want.size}`);
  }
  console.log(`  evidence recall ${found}/${total}`);
  assert.ok(total > 10, "there was real evidence to find");
  assert.ok(found / total >= 0.95, `evidence recall ${(found / total).toFixed(2)}: ${detail.join("; ")}`);
  // Every claim an answer cites is in the bundle it was built from (the grounding gate), so recall is not bought with invention.
  const ans = await svc.ask(ctx(), { question: "show me everything that could cause a payment to fail", revision });
  assert.ok(ans.ok && ans.value.claims.every((c) => c.gates.find((g) => g.gate === "GROUNDING")?.status === "PASS"));
  worker.close();
});

test("C10: inaccessible matches are left out of everything, counted but never named, and evidence in denied code cannot be read", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  const q = "what stops a fraudulent payment";
  const open = await svc.ask(ctx(), { question: q, revision });
  assert.ok(open.ok && open.value.view.nodes.some((n) => n.label === "checkFraud"));
  const fraudEv = svc.store.relationshipsFor(revision, "function:src/payments/fraud.ts#checkFraud").flatMap((r) => r.evidence).find((e) => (e.location as any).span?.sourceId === "src/payments/fraud.ts")!;
  const visible = svc.evidenceFor(ctx(), { revision, evidenceId: fraudEv.id });
  assert.ok(visible.ok && visible.value.snippet.length > 0);
  svc.store.denyPath(repo, "src/payments");
  const r = await svc.ask(ctx(), { question: q, revision });
  assert.ok(r.ok);
  const json = JSON.stringify(r.value);
  assert.ok(!r.value.view.nodes.some((n) => /^src\/payments\//.test(n.file)), "no element of a denied path is shown");
  for (const secret of ["checkFraud", "payments/fraud.ts", "velocity", "FraudRejectedError"]) assert.ok(!json.includes(secret), `"${secret}" leaked into the answer`);
  assert.ok(r.value.view.gaps.some((g) => /\d+ element\(s\) of this view are in code you do not have access to/.test(g)), "it says some elements were left out, with a count");
  // The map form does its own retrieval, which counts the matches it dropped.
  const map = await svc.ask(ctx(), { question: "how does payment capture work", revision, form: "SemanticMap" });
  assert.ok(map.ok && map.value.view.gaps.some((g) => /\d+ (match\(es\)|element\(s\)) .*do not have access to/.test(g)));
  assert.ok(!JSON.stringify(map.value).includes("checkFraud"));
  assert.ok(!(r.value.view.hidden ?? []).some((h) => /fraud/i.test(h.label + h.reason)), "'why is it hidden' does not name them either");
  const denied = svc.evidenceFor(ctx(), { revision, evidenceId: fraudEv.id });
  assert.ok(denied.ok && denied.value.state === "ACCESS_REVOKED" && denied.value.snippet === "" && denied.value.file === "(not shown)");
  const ex = await svc.explain(ctx(), { revision, entityIds: ["function:src/payments/fraud.ts#checkFraud"] });
  assert.ok(!ex.ok && ex.error.code === "FORBIDDEN" && !ex.error.message.includes("checkFraud"));
  const around = await svc.explain(ctx(), { revision, entityIds: ["function:src/api/payments-controller.ts#createPayment"], question: "what does it call" });
  assert.ok(around.ok && !JSON.stringify(around.value).includes("checkFraud"), "the neighbourhood of an allowed element stops at the denied code");
  assert.ok(policyFor(svc.store, repo).prefixes.includes("src/payments"));
  svc.store.denyPath(repo, "src/payments", false);
  const back = await svc.ask(ctx(), { question: q, revision });
  assert.ok(back.ok && back.value.view.nodes.some((n) => n.label === "checkFraud") && !back.value.view.gaps.some((g) => /do not have access/.test(g)), "lifting the denial restores it");
  worker.close();
});

test("C10: token-budget truncation is disclosed: what the budget was, what was dropped (lowest-ranked first), and why it is not shown", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  const q = "how does payment processing work"; // a map question: it is the form that retrieves and sends evidence to the model
  const full = retrieveForQuestion(svc.store, revision, q, {});
  assert.equal(full.truncation, undefined, "no budget, no cut");
  const budget = Math.floor(full.bundle.tokenEstimate / 3);
  const cut = retrieveForQuestion(svc.store, revision, q, { tokenBudget: budget });
  assert.ok(cut.truncation && cut.truncation.before === full.bundle.tokenEstimate && cut.truncation.after <= budget, JSON.stringify(cut.truncation));
  assert.ok(cut.truncation!.dropped.length > 0 && cut.bundle.entities.length < full.bundle.entities.length);
  const rank = (id: string) => full.scored.get(id)!.score;
  const keptMin = Math.min(...cut.bundle.entities.filter((e) => e.kind !== "file").map((e) => rank(e.entityId)));
  const droppedMax = Math.max(...cut.truncation!.dropped.map((d) => rank(d.entityId)));
  assert.ok(droppedMax <= keptMin + 1e-9, "what was dropped ranked no higher than what was kept");
  assert.ok(cut.hidden.filter((h) => /evidence budget/.test(h.reason)).length === cut.truncation!.dropped.length, "each dropped element is listed with its reason");
  // End to end: the model never receives more than the budget, and the person is told.
  process.env.CIE_CHUNK_TOKEN_BUDGET = String(budget);
  try {
    const seen: ModelRequest[] = [];
    const spy: ModelProvider = { name: "spy", model: "x", hosted: false, async generate(r) { seen.push(r); return new StubProvider().generate(r); } };
    (svc as any).model = spy;
    const ans = await svc.ask(ctx(), { question: q, revision, form: "SemanticMap" });
    assert.ok(ans.ok);
    assert.ok(ans.value.view.gaps.some((g) => /cut to fit the model's budget/.test(g) && /dropped, lowest-ranked first/.test(g)));
    const rep = seen.find((s) => s.purpose === "REPRESENT");
    assert.ok(!rep || rep.bundle.tokenEstimate <= budget, `the model was sent ${rep?.bundle.tokenEstimate} tokens against a budget of ${budget}`);
    const dropped = ans.value.view.hidden!.find((h) => /evidence budget/.test(h.reason))!;
    const why = svc.whyHidden(ctx(), { view: ans.value.view, query: dropped.label });
    assert.ok(why.ok && /evidence budget|dropped/i.test(JSON.stringify(why.value)), "'why isn't X shown' says it was dropped for the budget");
  } finally { delete process.env.CIE_CHUNK_TOKEN_BUDGET; }
  worker.close();
});

test("C10: the embedder is replaceable: vectors are stored beside the data and reused, a different embedder gets its own index, and a bad reply is an error", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  let calls = 0, texts = 0;
  class Counting implements Embedder { readonly name = "counting"; readonly dim = 16; inner = new HashEmbedder(); embed(t: string[]) { calls++; texts += t.length; return t.map((x) => this.inner.embed([x])[0].slice(0, 16)); } }
  const e = new Counting();
  const n = await ensureIndex(svc.store, revision, e);
  assert.ok(n > 10);
  const first = texts;
  await ensureIndex(svc.store, revision, e);
  assert.equal(texts, first, "the stored index is reused, not rebuilt");
  assert.ok(svc.store.hasEmbeddings(revision));
  assert.equal(svc.store.embeddings(revision).filter((r) => !r.entityId.startsWith("__model:")).length, n);
  await semanticScores(svc.store, revision, "refund processing", e);
  assert.equal(calls, 2, "one call to build the index, one for the query");
  await ensureIndex(svc.store, revision, new HashEmbedder());
  assert.ok(svc.store.embeddings(revision).some((r) => r.entityId === "__model:local-hashed-ngrams") && !svc.store.embeddings(revision).some((r) => r.entityId === "__model:counting"), "a different embedder replaces the index, never mixes with it");
  // The language-model embedder against a stub server.
  const real = globalThis.fetch;
  try {
    (globalThis as any).fetch = async (_u: string, init: any) => { const { input } = JSON.parse(init.body); return new Response(JSON.stringify({ embeddings: input.map((t: string) => [t.length, 1, 0]) }), { status: 200 }); };
    const o = new OllamaEmbedder({ model: "m" });
    const v = await o.embed(["a", "bb"]);
    assert.equal(v.length, 2); assert.ok(Math.abs(v[0].reduce((s, x) => s + x * x, 0) - 1) < 1e-6, "normalised");
    (globalThis as any).fetch = async () => new Response(JSON.stringify({ embeddings: [[1, 2]] }), { status: 200 });
    await assert.rejects(o.embed(["a", "b"]), /wrong shape/);
    (globalThis as any).fetch = async () => new Response("", { status: 500 });
    await assert.rejects(o.embed(["a"]), /failed \(500\)/);
  } finally { globalThis.fetch = real; }
  worker.close();
});
