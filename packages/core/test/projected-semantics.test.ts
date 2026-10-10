import test from "node:test";
import assert from "node:assert/strict";
import { ChartOutputV2, type EvidenceBundle } from "@cie/schema";
import { compileChartPlan } from "../src/chart-creator.ts";
import { erBundle } from "./er-fixture.ts";
const ev = ["ev:1"];
function compile(chartId: string, fields: Record<string, unknown>, bundle: EvidenceBundle = erBundle, offline = false) {
  const plan = ChartOutputV2.parse({ contractVersion: "chart.v2", chartId, chartType: "Selected", caption: "", layout: "flow", nodes: [], edges: [], ...fields });
  return compileChartPlan({ plan, bundle, chartId, rev: { id: "rev", repoRoot: "/r", gitHead: null, createdAt: "t", analyzerVersion: "t", diagnostics: [], fileCount: 1 }, question: "show", route: { source: "chosen", confidence: "high", form: "GeneratedChart", name: "Selected", because: "", alternatives: [] }, ...(offline ? { diag: { provider: "stub", cacheHit: false, schemaValidationPassed: true } } : {}) });
}
test("call graphs preserve call identity and owner notes without manufacturing containment calls", () => {
  const { view, diagnostics } = compile("S21", { functions: [{ id: "owner", label: "Service", kind: "function", evidenceIds: ev }, { id: "method", label: "run", kind: "method", parentId: "owner", evidenceIds: ev }], calls: [{ from: "method", to: "owner", evidenceIds: ev }, { from: "method", to: "ghost", evidenceIds: ev }] });
  assert.equal(view.edges.length, 1); assert.equal(view.edges[0].kind, "call"); assert.equal(view.edges[0].displayMode, "INFERENCE");
  assert.match(view.nodes.find(n => n.role === "method")!.notes!.join(" "), /Owner: Service/);
  assert.equal(diagnostics.omittedEdges, 1);
});
test("dependency graphs preserve dependency category and omit absent endpoints", () => {
  const { view } = compile("S23", { modules: [{ id: "a", label: "Core", kind: "package", evidenceIds: ev }, { id: "b", label: "Schema", kind: "package", evidenceIds: ev }], dependencies: [{ from: "a", to: "b", kind: "compileTime", evidenceIds: ev }, { from: "a", to: "unknown", kind: "test", evidenceIds: ev }] });
  assert.equal(view.edges.length, 1); assert.equal(view.edges[0].kind, "depends-on"); assert.equal(view.edges[0].label, "compileTime");
});
test("communication messages expose order and kind while disclosing duplicate order", () => {
  const { view } = compile("S18", { participants: [{ id: "a", label: "API", evidenceIds: ev }, { id: "b", label: "Queue", evidenceIds: ev }], messages: [{ from: "a", to: "b", order: 1, label: "Publish", kind: "async", evidenceIds: ev }, { from: "b", to: "a", order: 1, label: "Ack", kind: "return", evidenceIds: ev }] });
  assert.ok(view.nodes.every(n => n.role === "participant")); assert.equal(view.edges[0].label, "1. Publish"); assert.equal(view.edges[0].kind, "async-flow"); assert.equal(view.edges[1].kind, "return"); assert.ok(view.gaps.some(g => /relative order is ambiguous/.test(g)));
});
test("layers become ordered regions, not synthetic elements and containment edges", () => {
  const { view, diagnostics } = compile("S22", { layers: [{ id: "data", label: "Data", order: 2, evidenceIds: ev }, { id: "api", label: "API", order: 0, evidenceIds: ev }, { id: "empty", label: "Empty", order: 3, evidenceIds: ev }], components: [{ id: "api", label: "Controller", layerId: "api", kind: "component", evidenceIds: ev }, { id: "store", label: "Ledger", layerId: "data", kind: "store", evidenceIds: ev }, { id: "stray", label: "Stray", layerId: "missing", kind: "component", evidenceIds: ev }], edges: [{ from: "api", to: "store", kind: "async", evidenceIds: ev }] });
  assert.equal(view.nodes.length, 2); assert.equal(view.groups.length, 2); assert.equal(view.groups[0].label, "API"); assert.equal(view.edges.length, 1); assert.equal(view.edges[0].kind, "async-flow"); assert.ok(view.nodes[0].pos!.y < view.nodes[1].pos!.y); assert.equal(diagnostics.omittedNodes, 1); assert.ok(view.gaps.some(g => g.includes("Empty")));
});
test("invalid explicit citations cannot be rescued by coincidentally matching source names", () => {
  const bundle: EvidenceBundle = { ...erBundle, relationships: [{ id: "r", from: "t:a", to: "t:e", kind: "calls", resolution: "RESOLVED", evidence: erBundle.evidence }] };
  for (const offline of [false, true]) {
    const { view } = compile("S21", { functions: [{ id: "a", label: "Account", kind: "function", evidenceIds: ["fabricated"] }, { id: "b", label: "Entry", kind: "function", evidenceIds: ev }], calls: [{ from: "a", to: "b", evidenceIds: ev }] }, bundle, offline);
    assert.equal(view.nodes.length, 1); assert.equal(view.edges.length, 0);
  }
  const fields = { functions: [{ id: "a", label: "Account", kind: "function", evidenceIds: [] }], calls: [] };
  assert.equal(compile("S21", fields, bundle).view.nodes.length, 0);
  const recovered = compile("S21", fields, bundle, true).view.nodes[0]; assert.equal(recovered.displayMode, "INFERENCE");
});
test("duplicate elements retain the first declaration and disclose omission", () => {
  const { view, diagnostics } = compile("S17", { packages: [{ id: "a", name: "First", members: [], evidenceIds: ev }, { id: "a", name: "Replacement", members: [], evidenceIds: ev }], dependencies: [] });
  assert.equal(view.nodes.length, 1); assert.equal(view.nodes[0].label, "First"); assert.equal(view.nodes[0].role, "package"); assert.equal(diagnostics.omittedNodes, 1); assert.ok(view.gaps.some(g => g.includes("Duplicate")));
});
test("nested member citations cannot establish their parent or leak stale details", () => {
  const packages = [{ id: "a", name: "Core", members: [{ text: "current member", evidenceIds: ev }, { text: "stale secret detail", evidenceIds: ["missing"] }], evidenceIds: ev }];
  const view = compile("S17", { packages, dependencies: [] }).view;
  assert.match(view.nodes[0].notes!.join(" "), /current member/); assert.doesNotMatch(view.nodes[0].notes!.join(" "), /stale secret/);
  assert.equal(compile("S17", { packages: [{ ...packages[0], evidenceIds: [] }], dependencies: [] }).view.nodes.length, 0);
});
test("outbox roles and uncertain atomicity are preserved without reliability guarantees", () => {
  const { view } = compile("S13", { elements: [{ id: "w", label: "Writer", kind: "writer", evidenceIds: ev }, { id: "s", label: "Outbox", kind: "outboxStore", evidenceIds: ev }], flows: [{ from: "w", to: "s", kind: "transactionalWrite", isAtomic: true, evidenceIds: ev }] });
  assert.equal(view.nodes[1].role, "outbox-store"); assert.match(view.edges[0].label!, /atomic\? \(plan interpretation\)/); assert.equal(view.edges[0].displayMode, "INFERENCE");
});
test("saga irreversible and DI unresolved annotations remain visible and tentative", () => {
  const saga = compile("S12", { steps: [{ id: "a", label: "Post", kind: "forward", isIrreversible: true, evidenceIds: ev }], edges: [] }).view;
  assert.equal(saga.nodes[0].badge, "irreversible?");
  const di = compile("S15", { components: [{ id: "a", label: "Service", kind: "class", evidenceIds: ev }, { id: "b", label: "Store", kind: "interface", evidenceIds: ev }], bindings: [{ from: "a", to: "b", injectionKind: "constructor", qualifier: "primary", isUnresolved: true, evidenceIds: ev }], cycles: [] }).view;
  assert.match(di.edges[0].label!, /constructor.*primary.*unresolved/); assert.equal(di.edges[0].displayMode, "INFERENCE");
});
test("system context roles match renderer shapes and retain relationship technology", () => {
  const { view } = compile("S27", { elements: [{ id: "p", label: "Customer", kind: "person", evidenceIds: ev }, { id: "s", label: "Wallet", kind: "softwareSystem", evidenceIds: ev }, { id: "e", label: "Bank", kind: "externalSystem", evidenceIds: ev }], relationships: [{ from: "s", to: "e", label: "Settle", technology: "HTTPS", evidenceIds: ev }] });
  assert.deepEqual(view.nodes.map(n => n.role), ["c4-person", "c4-system", "c4-external"]); assert.equal(view.edges[0].label, "Settle · HTTPS");
});
test("DI cycle citations cannot rescue uncited component declarations", () => {
  const { view } = compile("S15", { components: [{ id: "a", label: "Unknown", kind: "class", evidenceIds: [] }, { id: "b", label: "Known", kind: "class", evidenceIds: ev }], bindings: [], cycles: [{ componentIds: ["a", "b"], evidenceIds: ev }] });
  assert.equal(view.nodes.length, 1); assert.equal(view.nodes[0].label, "Known"); assert.match(view.nodes[0].notes!.join(" "), /dependency cycle/);
});
test("sequence frames are semantic metadata and never counted as omitted participant nodes", () => {
  const { view, diagnostics } = compile("S28", { participants: [{ id: "a", label: "API", evidenceIds: ev }, { id: "b", label: "Store", evidenceIds: ev }], messages: [{ from: "a", to: "b", label: "Write", kind: "sync", order: 1, fragmentId: "f", evidenceIds: ev }], fragments: [{ id: "f", kind: "opt", condition: "Valid", evidenceIds: ev }] });
  assert.equal(view.nodes.length, 2); assert.equal(view.sequence!.fragments.length, 1); assert.equal(diagnostics.omittedNodes, 0); assert.equal(diagnostics.omittedEdges, 0);
});
test("offline layer limits never place unrelated directories into the first layer", async () => {
  const { StubProvider } = await import("@cie/model"); const { SCHEMA_CHART_V2 } = await import("@cie/schema");
  const bundle: EvidenceBundle = { ...erBundle, entities: Array.from({ length: 10 }, (_, i) => ({ entityId: `f:${i}`, kind: "function", name: `f${i}`, file: `dir${i}/file.ts`, spans: [] })) };
  const plan = ChartOutputV2.parse(await new StubProvider().generate({ purpose: "CHART", schemaId: SCHEMA_CHART_V2, question: "Layers", chartId: "S22", bundle }));
  if (plan.chartId !== "S22") throw new Error("Wrong selected chart");
  assert.equal(plan.layers.length, 6); assert.equal(plan.components.length, 6);
  assert.ok(plan.components.every(c => plan.layers.some(l => l.id === c.layerId && l.label === c.label)));
});
