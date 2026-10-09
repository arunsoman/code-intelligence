import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ScriptedRouter } from "./scripted-router.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";
import { StubProvider, modelEvidence } from "@cie/model";
import type { ModelRequest } from "@cie/schema";
import { planQuery } from "../src/query-router.ts";
import { retrieveForQuestion } from "../src/retrieval.ts";
import { overviewSeeds, sourceModule } from "../src/overview.ts";

const ARCH = { "what archtecture does this project follow?": { label: "overview", target: "" }, "what architecture does this project follow?": { label: "overview", target: "" }, "tell me about the zebra migration plan": { label: "SemanticMap", target: "" } };

test("'what architecture does this project follow?' gets a map and an architecture summary instead of 'nothing matches'", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  svc.router = new ScriptedRouter(ARCH);
  const r = await svc.converse(ctx(), { text: "what archtecture does this project follow?", revision });
  assert.ok(r.ok && r.value.kind === "view");
  assert.ok(r.value.view.nodes.length > 0, "the map is not empty");
  assert.match(r.value.message, /Inferred from folder names, imports and call directions \(not proven by the code\)/);
  assert.match(r.value.message, /Languages: TypeScript/);
  assert.match(r.value.message, /layered|organised by feature/);
  assert.doesNotMatch(r.value.message, /Nothing in this repository matches/);
  worker.close();
});

test("query scope follows an explicit subject even when the intent registry defaults to repo", () => {
  const mentions = { resolved: [{ text: "charge", matches: [{ entityId: "function:charge", name: "charge", file: "src/payments.ts", kind: "function" }] }], unresolved: [] };
  assert.equal(planQuery(2, undefined, "What is the main architecture / style of this project?", mentions)!.scope, "repository");
  assert.equal(planQuery(3, undefined, "How is the code organized?", mentions)!.scope, "repository");
  assert.equal(planQuery(1, "cie", "what is this project about?", mentions)!.scope, "repository");
  assert.equal(planQuery(2, "cie repository", "What is the main architecture / style of this project?", mentions)!.scope, "repository");
  const scoped = planQuery(23, "charge", "What does charge call?", mentions)!;
  assert.equal(scoped.scope, "subject");
  assert.deepEqual(scoped.seeds, ["function:charge"]);
});

test("shared model retrieval retains production modules under budget and excludes analysis payloads", async (t) => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  t.after(() => { worker.close(); svc.store.db.close(); });
  const rev = svc.store.revision(revision)!;
  const seeds = overviewSeeds(svc.store, revision);
  const expectedModules = new Set(svc.store.entitiesById(revision, seeds).map((e) => sourceModule(e.file)));
  const result = retrieveForQuestion(svc.store, revision, "What is the main architecture / style of this project?", {
    scope: "repository", forModel: true, tokenBudget: 60000, resolveEvidence: (ev) => svc.resolveEvidence(rev, ev),
  });
  const modules = new Set(result.bundle.entities.map((e) => sourceModule(e.file)));
  for (const module of expectedModules) assert.ok(modules.has(module), `lost production module ${module}`);
  assert.ok(result.bundle.facts.some((f) => f.predicate === "source_excerpt"));
  assert.ok(result.bundle.relationships.some((r) => r.kind !== "contains"));
  assert.ok(!result.bundle.facts.some((f) => f.predicate.startsWith("defect.") || f.predicate === "history"));
  assert.ok(!result.bundle.entities.some((e) => /(^|\/)(fixtures?|tests?|docs?)(\/|$)/.test(e.file)));
  assert.equal(result.bundle.tokenEstimate, Math.ceil(JSON.stringify(modelEvidence({ purpose: "CHART", bundle: result.bundle })).length / 4));
  assert.ok(result.bundle.tokenEstimate <= 60000);
});

test("different repository questions receive grounded prose even when their selected charts are empty", async (t) => {
  const requests: ModelRequest[] = [];
  const model = new StubProvider();
  const spy = { name: "spy", model: "test", hosted: false, async generate(req: ModelRequest) {
    requests.push(req);
    if (req.purpose === "CHART") return { contractVersion: "chart.v2", chartId: req.chartId, chartType: "Selected chart", layout: "flow", caption: "The selected diagram cannot be derived from these relationships.", nodes: [], edges: [], ...(req.chartId === "S17" ? { packages: [], dependencies: [] } : req.chartId === "S27" ? { elements: [], relationships: [] } : {}) };
    return model.generate(req);
  } };
  const { svc, worker, revision } = await setup(spy, demoRepo());
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  t.after(() => { worker.close(); svc.store.db.close(); });
  for (const intentId of [1, 2, 3]) {
    svc.router = { name: "classified", choose: async () => null, classify: async () => ({ intent_id: intentId, intent: "repository question", confidence: 1 }) };
    const text = intentId === 1 ? "what is this project about?" : intentId === 2 ? "What is the main architecture / style of this project?" : "How is the code organized?";
    const result = await svc.converse(ctx(), { text, revision });
    assert.ok(result.ok && result.value.kind === "view");
    assert.equal(result.value.view.params?.scope, "repository");
    assert.match(result.value.message, /Inferred from the source code/);
    assert.doesNotMatch(result.value.message, /^.*The selected diagram cannot/);
    assert.ok(result.value.claims.some((c) => c.draft.claimClass === "source-answer" && c.draft.evidenceIds.length));
  }
  assert.equal(requests.filter((r) => r.purpose === "SOURCE_OVERVIEW").length, 3);
  for (const req of requests.filter((r) => r.purpose === "SOURCE_OVERVIEW")) assert.ok(req.bundle.entities.length > 4 && req.bundle.tokenEstimate <= 60000);
});

test("a question whose words match nothing falls back to the project overview and says why, rather than an empty map", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  svc.router = new ScriptedRouter(ARCH);
  const r = await svc.converse(ctx(), { text: "tell me about the zebra migration plan", revision });
  assert.ok(r.ok && r.value.kind === "view" && r.value.view.nodes.length > 0);
  assert.match(r.value.message, /No element of the code matches those words, so here is the project as a whole instead/);
  worker.close();
});

test("the architecture summary reads layers, frameworks and call direction in Spring, Go and Python code too", async () => {
  const { svc, worker, revision } = await setup(undefined, resolve(import.meta.dirname, "../../../fixtures/polyglot"));
  assert.ok((await svc.buildConceptHierarchy(ctx(), { revision })).ok);
  svc.router = new ScriptedRouter(ARCH);
  const r = await svc.converse(ctx(), { text: "what architecture does this project follow?", revision });
  assert.ok(r.ok && r.value.kind === "view");
  assert.match(r.value.message, /Languages: .*Java.*|Languages: .*Go.*|Languages: .*Python.*/);
  assert.match(r.value.message, /Spring Boot/);
  assert.match(r.value.message, /Kafka/);
  worker.close();
});
