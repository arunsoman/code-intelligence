// Reading questions with a small local model: what it is shown, what it may answer, what is done with the answer, and what happens when there is no answer.
// How accurate a real model is on unseen questions is measured elsewhere (scripts/eval-tiny-models.ts, route-live.test.ts); these tests pin the contract around it.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OllamaRouter, buildRequest, candidateLabels, nearest, readText, routerFor, scriptRouterFromEnv } from "../src/llm-router.ts";
import { EXEMPLARS, INTENT_EXEMPLARS } from "../src/route-exemplars.ts";
import { ctx, setup } from "./helpers.ts";
import { DEV, HELD_OUT, HELD_OUT_V2, HELD_OUT_V3 } from "./route-sets.ts";
import { ScriptedRouter } from "./scripted-router.ts";

const none = { hasView: false, selectionCount: 0, looksLikeTrace: false };

test("the labels offered depend on what is on screen: no 'why isn't it shown' without a map, no 'ignore' outside a hypothesis graph", () => {
  const bare = candidateLabels(none);
  assert.ok(bare.includes("overview") && bare.includes("resume") && bare.includes("TrustBoundary") && bare.includes("CausalGraph:failure"));
  for (const l of ["zoomIn", "whyHidden", "pin", "whyShown", "connected", "ignore"]) assert.ok(!bare.includes(l), l);
  const map = candidateLabels({ ...none, hasView: true });
  assert.ok(map.includes("zoomOut") && map.includes("pin") && map.includes("whyHidden") && !map.includes("whyShown") && !map.includes("ignore"));
  assert.ok(candidateLabels({ hasView: true, selectionCount: 2, looksLikeTrace: false }).includes("connected"));
  assert.ok(candidateLabels({ hasView: true, viewForm: "HypothesisGraph", selectionCount: 0, looksLikeTrace: false }).includes("whySuspect"));
  assert.deepEqual(candidateLabels({ ...none, hasView: true }, true).filter((l) => !(l in EXEMPLARS)), [], "forms only: nothing but views");
});

test("the prompt shows only the nearest labelled examples, restricted to the labels on offer, and never a held-out question", () => {
  const labels = candidateLabels(none);
  const req = buildRequest("pin charge", candidateLabels({ ...none, hasView: true }));
  assert.match(req.system, /Similar messages and their answers/);
  assert.match(req.system, /"label":"pin","target":"charge"/);
  assert.equal(req.user, "Q: pin charge\nA:");
  assert.ok(nearest("pin charge", labels).every((s) => labels.includes(s.label)), "an example for an unavailable label is never shown");
  // The evaluation sets must stay unseen: none of their questions is a prompt example.
  const shown = new Set([...Object.values(EXEMPLARS).flat(), ...Object.values(INTENT_EXEMPLARS).flatMap((x) => x.map((e) => e[0]))].map((q) => q.toLowerCase()));
  const leaked = [...DEV, ...HELD_OUT, ...HELD_OUT_V2, ...HELD_OUT_V3].map((c) => c[0]).filter((q) => shown.has(q.toLowerCase().replace(/[?.!]$/, "")));
  assert.deepEqual(leaked, [], "a labelled evaluation question is also a prompt example");
});

test("an answer becomes an intent: views, requests that name something, and requests that depend on the screen", async () => {
  const m = new ScriptedRouter({
    "who can reach the db": { label: "TrustBoundary", target: "" }, "pin charge": { label: "pin", target: "the charge" },
    "continue payment work": { label: "resume", target: "payment" }, "zoom out": { label: "zoomOut", target: "" }, "what is this": { label: "overview", target: "" },
    "why not ledger": { label: "whyHidden", target: "ledger" },
  });
  const map = { hasView: true, selectionCount: 0, looksLikeTrace: false };
  const ask = (await readText(m, "who can reach the db", none)).intent;
  assert.ok(ask.type === "ask" && ask.route?.form === "TrustBoundary" && ask.route.source === "model" && ask.route.confidence === "medium");
  assert.match(ask.type === "ask" ? ask.route!.because : "", /scripted read this as "TrustBoundary"/);
  assert.deepEqual((await readText(m, "pin charge", map)).intent, { type: "pin", target: "charge" }, "'the' is dropped from the target");
  assert.deepEqual((await readText(m, "continue payment work", none)).intent, { type: "resume", name: "payment" });
  assert.deepEqual((await readText(m, "zoom out", map)).intent, { type: "zoom", direction: "out" });
  assert.deepEqual((await readText(m, "what is this", none)).intent, { type: "overview" });
  assert.deepEqual((await readText(m, "why not ledger", map)).intent, { type: "whyHidden", target: "ledger" });
  const f = (await readText(new ScriptedRouter({ q: { label: "CausalGraph:invariant", target: "" } }), "q", none)).intent;
  assert.ok(f.type === "ask" && f.route?.form === "CausalGraph" && f.route.kind === "invariant" && f.route.alternatives.length <= 3);
});

test("a label the model was not offered, no answer, or no model at all gives the general map and says so; a stack trace never reaches the model", async () => {
  const offered = new ScriptedRouter({ q: { label: "pin", target: "x" } });          // 'pin' is not offered when no map is on screen
  const silent = new ScriptedRouter({ q: null });
  for (const [model, why] of [[offered, /did not answer/], [silent, /did not answer/], [null, /No router model is configured/]] as const) {
    const r = await readText(model, "q", none);
    assert.ok(r.intent.type === "ask" && r.intent.route?.source === "default" && r.intent.route.form === "SemanticMap" && r.intent.route.confidence === "low");
    assert.match(r.because, why);
    assert.match(r.intent.route!.because, /pick another kind of view from the gallery/);
  }
  const trace = new ScriptedRouter();
  assert.equal((await readText(trace, "Error: x\n    at f (a.ts:1:1)", { ...none, looksLikeTrace: true })).intent.type, "investigate");
  assert.equal(trace.seen.length, 0, "parsing a stack trace is not a language-model job");
});

test("a hosted router model is allowed when explicitly named, and marks itself as hosted", () => {
  assert.equal(new OllamaRouter({ model: "gpt-oss:120b-cloud" }).hosted, true);
  assert.equal(new OllamaRouter({ model: "x:cloud" }).hosted, true);
  assert.equal(new OllamaRouter({ model: "qwen3:0.6b" }).hosted, false);
});

test("the Ollama router asks for one constrained label at temperature 0, parses the answer, and treats every failure as 'no answer'", async () => {
  const seen: any[] = []; let mode: "ok" | "bad" | "off-list" | "http500" = "ok";
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      seen.push(JSON.parse(b));
      if (mode === "http500") { res.writeHead(500); return res.end("x"); }
      const content = mode === "ok" ? { label: "RaceWindow", target: "balance" } : mode === "off-list" ? { label: "Nonsense", target: "" } : "not json";
      res.end(JSON.stringify({ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  try {
    const router = new OllamaRouter({ model: "qwen3:0.6b", baseUrl: base });
    const req = buildRequest("where can balance race", candidateLabels(none));
    assert.deepEqual(await router.choose(req), { label: "RaceWindow", target: "balance" });
    const sent = seen[0];
    assert.equal(sent.model, "qwen3:0.6b"); assert.equal(sent.options.temperature, 0); assert.equal(sent.think, false); assert.equal(sent.stream, false);
    assert.deepEqual(sent.format.properties.label.enum, candidateLabels(none), "the daemon is told the closed list");
    for (const m of ["bad", "off-list", "http500"] as const) { mode = m; assert.equal(await router.choose(req), null, m); }
  } finally { srv.close(); }
  assert.equal(await new OllamaRouter({ model: "qwen3:0.6b", baseUrl: "http://127.0.0.1:9", timeoutMs: 500 }).choose(buildRequest("x", candidateLabels(none))), null, "unreachable daemon");
});

test("through the service: the model's reading builds the view, an explicit choice is never second-guessed, and no router means the plain map", async () => {
  const { svc, worker, revision } = await setup();
  const m = new ScriptedRouter({ "where can balance go wrong": { label: "RaceWindow", target: "" } });
  svc.router = m;
  const r = await svc.ask(ctx(), { question: "where can balance go wrong", revision });
  assert.ok(r.ok && r.value.view.formId === "RaceWindow" && r.value.view.route?.source === "model");
  const before = m.seen.length;
  const chosen = await svc.ask(ctx(), { question: "where can balance go wrong", revision, form: "SemanticMap" });
  assert.ok(chosen.ok && chosen.value.view.route?.source === "chosen");
  assert.equal(m.seen.length, before, "a chosen view is never sent to the model");
  svc.router = null;
  const plain = await svc.ask(ctx(), { question: "where can balance go wrong", revision });
  assert.ok(plain.ok && plain.value.view.route?.source === "default" && plain.value.view.formId === "SemanticMap");
  assert.equal(plain.value.view.formReason, undefined, "a default never claims the question said something");
  worker.close();
});

test("routerFor: no model means no router; CIE_ROUTER=off disables it even with one resolved", () => {
  assert.equal(routerFor(null, {}), null);
  assert.equal(routerFor("glm-5.3:cloud", { CIE_ROUTER: "off" }), null);
  assert.equal(routerFor("glm-5.3:cloud", {})?.name, "glm-5.3:cloud");
});

test("CIE_ROUTER_SCRIPT makes the router deterministic for tests and demos, and always wins over a resolved model", async () => {
  assert.equal(scriptRouterFromEnv({}), null);
  const dir = mkdtempSync(join(tmpdir(), "cie-router-"));
  const file = join(dir, "script.json");
  writeFileSync(file, JSON.stringify({ "how are these connected?": "connected", "pin charge": { label: "pin", target: "charge" } }));
  const env = { CIE_ROUTER_SCRIPT: file };
  const r = scriptRouterFromEnv(env);
  assert.equal(r?.name, "scripted");
  assert.deepEqual(await r!.choose(buildRequest("how are these connected?", ["connected", "SemanticMap"])), { label: "connected", target: "" });
  assert.deepEqual(await r!.choose(buildRequest("pin charge", ["pin", "SemanticMap"])), { label: "pin", target: "charge" });
  assert.equal(await r!.choose(buildRequest("something else", ["connected", "SemanticMap"])), null, "an unlisted question gets no answer, so the caller falls back");
  assert.equal(await r!.choose(buildRequest("how are these connected?", ["SemanticMap"])), null, "a label that is not on offer is refused");
  assert.equal(routerFor("glm-5.3:cloud", env)?.name, "scripted", "the script takes precedence over the resolved model");
});
