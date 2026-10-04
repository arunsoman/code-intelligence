import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { ScriptedRouter } from "./scripted-router.ts";
import { ctx, demoRepo, setup } from "./helpers.ts";

const ARCH = { "what archtecture does this project follow?": { label: "overview", target: "" }, "what architecture does this project follow?": { label: "overview", target: "" }, "tell me about the zebra migration plan": { label: "SemanticMap", target: "" } };

test("'what architecture does this project follow?' gets a map and an architecture summary instead of 'nothing matches'", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
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

test("a question whose words match nothing falls back to the project overview and says why, rather than an empty map", async () => {
  const { svc, worker, revision } = await setup(undefined, demoRepo());
  svc.router = new ScriptedRouter(ARCH);
  const r = await svc.converse(ctx(), { text: "tell me about the zebra migration plan", revision });
  assert.ok(r.ok && r.value.kind === "view" && r.value.view.nodes.length > 0);
  assert.match(r.value.message, /No element of the code matches those words, so here is the project as a whole instead/);
  worker.close();
});

test("the architecture summary reads layers, frameworks and call direction in Spring, Go and Python code too", async () => {
  const { svc, worker, revision } = await setup(undefined, resolve(import.meta.dirname, "../../../fixtures/polyglot"));
  svc.router = new ScriptedRouter(ARCH);
  const r = await svc.converse(ctx(), { text: "what architecture does this project follow?", revision });
  assert.ok(r.ok && r.value.kind === "view");
  assert.match(r.value.message, /Languages: .*Java.*|Languages: .*Go.*|Languages: .*Python.*/);
  assert.match(r.value.message, /Spring Boot/);
  assert.match(r.value.message, /Kafka/);
  worker.close();
});
