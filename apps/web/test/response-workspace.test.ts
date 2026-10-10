import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResponseManifest, ViewSpec } from "@cie/schema";
import { acceptCompletion, activateTab, closeTab, createWorkspace, projectSelection, updateTab, workspaceExport } from "../src/response-workspace.ts";
import { responsePortfolio } from "../../../packages/core/src/response-portfolio.ts";

const view = (id = "a", revision = "r1", code = "S23") => ({ id, revision, version: 1, question: "Show component structure", formId: "GeneratedChart", level: 5, params: { chartId: code, scope: "subject", subject: "Checkout" }, caption: "Checkout", gaps: [], nodes: [{ id: `${id}:node`, entityRefs: ["entity:checkout"], label: "Checkout", kind: "function", evidenceIds: ["ev:1"] }], edges: [] } as unknown as ViewSpec);
const manifest = () => responsePortfolio({ views: [view()], catalog: [], question: "Show component structure" });

test("portfolio uses stable chart order, identity and explicit unsupported notations", () => {
  assert.deepEqual(manifest(), manifest());
  const m = manifest();
  assert.equal(m.views[0].code, "S23");
  assert.equal(m.views.find((d) => d.code === "S29")?.status, "unavailable");
  assert.equal(m.plan?.supportingCodes.length, 3);
  assert.equal(m.views.filter(d => d.relevant).length, 4);
  assert.equal(m.views.find((d) => d.code === "S16")?.scope, "subject");
  assert.deepEqual(m.views[0].seeds, ["entity:checkout"]);
  assert.throws(() => responsePortfolio({ views: [view(), view("b", "r2")], catalog: [], question: "x" }));
});

test("tab activation and close retain other chart specs and state", () => {
  let w = createWorkspace(manifest(), [{ view: view(), claims: [] }]);
  const first = w.activeId;
  const second = w.tabs.find((t) => t.code === "S16")!.id;
  w = updateTab(w, first, { ui: { selection: ["a:node"], cellSelection: [], level: 3, drawMode: "graph", terrainWeights: {} } });
  w = activateTab(w, second);
  assert.equal(w.tabs.find((t) => t.id === first)?.ui?.level, 3);
  w = closeTab(w, second);
  assert.equal(w.activeId, first);
  assert.equal(w.tabs.find((t) => t.id === second)?.open, false);
  assert.ok(w.tabs.find((t) => t.id === first)?.view);
});

test("late, wrong-revision and wrong-notation results never replace the requested tab", () => {
  let w = createWorkspace(manifest(), [{ view: view(), claims: [] }]);
  const tab = w.tabs.find((t) => t.code === "S16")!;
  w = updateTab(w, tab.id, { attempt: 1, status: "generating" });
  const token = { responseId: w.manifest.responseId, revision: "r1", tabId: tab.id, attempt: 1 };
  assert.equal(acceptCompletion(w, { ...token, responseId: "other" }, { view: view("b", "r1", "S16"), claims: [] }), w);
  assert.equal(acceptCompletion(w, { ...token, attempt: 0 }, { view: view("b", "r1", "S16"), claims: [] }), w);
  assert.equal(acceptCompletion(w, token, { view: view("b", "r2", "S16"), claims: [] }), w);
  const rejected = acceptCompletion(w, token, { view: view("b", "r1", "S23"), claims: [] });
  assert.equal(rejected.tabs.find((t) => t.id === tab.id)?.status, "failed");
  assert.equal(rejected.tabs.find((t) => t.id === tab.id)?.view, undefined);
  const accepted = acceptCompletion(w, token, { view: view("b", "r1", "S16"), claims: [] });
  assert.equal(accepted.tabs.find((t) => t.id === tab.id)?.view?.id, "b");
  assert.equal(accepted.activeId, w.activeId);
});

test("selection transfers by entity identity and export carries pinned revision", () => {
  assert.deepEqual(projectSelection(view(), ["a:node"], view("b")), ["b:node"]);
  assert.deepEqual(projectSelection(view(), ["unrelated"], view("b")), []);
  const exported = JSON.parse(workspaceExport(createWorkspace(manifest(), [{ view: view(), claims: [] }])));
  assert.equal(exported.manifest.revision, "r1");
  assert.equal(exported.schemaVersion, "workspace.v1");
});

test("history restoration retains selection, viewport, level and active tab", async () => {
  const { restoreWorkspace } = await import("../src/response-workspace.ts");
  let w = createWorkspace(manifest(), [{ view: view(), claims: [] }]);
  const ui = { selection: ["a:node"], cellSelection: [], level: 2, drawMode: "graph" as const, terrainWeights: {}, canvas: { zoom: 1.8, pan: { x: 12, y: -7 }, lens: { enabled: true, magnification: 2.2, radius: 186, falloff: 1 / .88, easing: true, rings: true, pinned: false } } };
  w = updateTab(w, w.activeId, { ui });
  const pending = w.tabs.find(t => t.code === "S16")!;
  w = updateTab(w, pending.id, { status: "generating", attempt: 2 });
  const restored = restoreWorkspace(w);
  assert.equal(restored.activeId, w.activeId);
  assert.deepEqual(restored.tabs.find(t => t.id === w.activeId)?.ui, ui);
  assert.equal(restored.tabs.find(t => t.id === pending.id)?.attempt, 3);
  assert.equal(restored.tabs.find(t => t.id === pending.id)?.status, "available");
});

test("exploration disables absent evidence and varies structural perspective by element kind", async () => {
  const { explorationChoices } = await import("../src/exploration-choices.ts");
  const m = responsePortfolio({ views: [view()], catalog: [], question: "structure", evidenceKinds: { function: 1 } });
  assert.equal(explorationChoices("class", m)[0].code, "S16");
  assert.equal(explorationChoices("function", m)[0].code, "S23");
  assert.equal(explorationChoices("function", m).find(c => c.code === "S9")?.disabled, true);
});
