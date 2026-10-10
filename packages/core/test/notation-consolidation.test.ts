import test from "node:test";
import assert from "node:assert/strict";
import { ChartOutputV2, CHART_REGISTRY, type EvidenceBundle } from "@cie/schema";
import { compileChartPlan } from "../src/chart-creator.ts";
import { erBundle } from "./er-fixture.ts";

const ev = ["ev:1"];
function compile(chartId: keyof typeof CHART_REGISTRY, fields: Record<string, unknown>, bundle: EvidenceBundle = erBundle, chartType = CHART_REGISTRY[chartId].name) {
  const plan = ChartOutputV2.parse({ contractVersion: "chart.v2", chartId, chartType, layout: "flow", caption: "", nodes: [], edges: [], ...fields });
  return compileChartPlan({ plan, bundle, chartId, rev: { id: "rev", repoRoot: "/r", gitHead: null, createdAt: "t", analyzerVersion: "t", diagnostics: [], fileCount: 1 }, question: "show", route: { source: "chosen", confidence: "high", form: "GeneratedChart", name: "Selected", because: "", alternatives: [] } });
}

test("DFD preserves level zero and leaves unspecified levels unclaimed", () => {
  const { view } = compile("S10", { elements: [{ id: "a", kind: "process", label: "Root", level: 0, evidenceIds: ev }, { id: "b", kind: "process", label: "Unknown", evidenceIds: ev }], flows: [] });
  assert.equal(view.nodes[0].badge, "L0?");
  assert.equal(view.nodes[1].badge, undefined);
  assert.match(view.nodes[0].notes!.join(" "), /plan interpretation/);
});

test("a stale compensation cannot close a saga recovery gap", () => {
  const fields = { steps: [{ id: "a", kind: "forward", label: "Write", evidenceIds: ev }, { id: "undo", kind: "compensation", label: "Undo", evidenceIds: ev }], edges: [{ from: "a", to: "undo", kind: "compensation", evidenceIds: ["stale"] }] };
  const missing = compile("S12", fields);
  assert.equal(missing.view.edges.length, 0);
  assert.ok(missing.view.gaps.some(gap => gap.includes("Write has no current evidence-backed compensation")));
  assert.ok(missing.view.gaps.some(gap => gap.includes("absence is not proof of irreversibility")));
  const present = compile("S12", { ...fields, edges: [{ ...fields.edges[0], evidenceIds: ev }] });
  assert.equal(present.view.edges[0].style, "return");
  assert.ok(!present.view.gaps.some(gap => gap.includes("Write has no current evidence-backed compensation")));
});

test("context views disclose zero or multiple grounded subjects", () => {
  for (const count of [0, 2]) {
    const { view } = compile("S27", { elements: Array.from({ length: count }, (_, i) => ({ id: `s${i}`, kind: "softwareSystem", label: `System ${i}`, evidenceIds: ev })), relationships: [] });
    assert.ok(view.gaps.some(gap => gap.includes(`${count} grounded subjects`)));
  }
  const { view } = compile("S27", { elements: [{ id: "s", kind: "softwareSystem", label: "Subject", evidenceIds: ev }], relationships: [] });
  assert.ok(!view.gaps.some(gap => gap.includes("subject software system")));
});

test("sequence omission diagnostics count rejected messages, not only projected edges", () => {
  const { view, diagnostics } = compile("S28", { participants: [{ id: "a", label: "API", evidenceIds: ev }], messages: [{ from: "a", to: "a", order: 1, label: "Run", kind: "sync", evidenceIds: ev }, { from: "a", to: "ghost", order: 2, label: "Missing", kind: "async", evidenceIds: ev }, { from: "a", to: "a", order: 3, label: "Stale", kind: "return", evidenceIds: ["stale"] }], fragments: [] });
  assert.equal(view.sequence!.messages.length, 1);
  assert.equal(diagnostics.acceptedEdges, 1);
  assert.equal(diagnostics.omittedEdges, 2);
});

test("registered chart aliases are accepted and contradictory names are disclosed", () => {
  const fields = { states: [], transitions: [] };
  const alias = compile("S3", fields, erBundle, "state machine");
  assert.ok(!alias.view.gaps.some(gap => gap.includes("disagrees with selected")));
  const wrong = compile("S3", fields, erBundle, "call-flow");
  assert.ok(wrong.view.gaps.some(gap => gap.includes("call-flow") && gap.includes("disagrees with selected")));
  assert.deepEqual(wrong.diagnostics.gaps, wrong.view.gaps);
});

test("class members cannot rescue an uncited parent and duplicate declarations retain the first", () => {
  const cls = { id: "a", name: "Original", kind: "class", attributes: [{ text: "current member", evidenceIds: ev }], operations: [], evidenceIds: [] };
  assert.equal(compile("S16", { classes: [cls], relations: [] }).view.nodes.length, 0);
  const { view, diagnostics } = compile("S16", { classes: [{ ...cls, evidenceIds: ev }, { ...cls, name: "Replacement", evidenceIds: ev }], relations: [] });
  assert.equal(view.nodes.length, 1);
  assert.equal(view.nodes[0].label, "Original");
  assert.equal(diagnostics.omittedNodes, 1);
});

test("UML relation facts require indexed endpoints with matching evidence", () => {
  const bundle: EvidenceBundle = { ...erBundle, entities: [{ entityId: "class:a", kind: "class", name: "A", file: "a.ts", spans: [] }, { entityId: "class:b", kind: "interface", name: "B", file: "b.ts", spans: [] }] };
  const fields = { classes: [{ id: "a", name: "A", kind: "class", attributes: [], operations: [], evidenceIds: ev }, { id: "b", name: "B", kind: "interface", attributes: [], operations: [], evidenceIds: ev }], relations: [{ from: "a", to: "b", kind: "realization", isInferred: false, evidenceIds: ev }] };
  assert.equal(compile("S16", fields, bundle).view.edges[0].displayMode, "INFERENCE");
  const relationship = { id: "implements", from: "class:a", to: "class:b", kind: "implements", evidence: bundle.evidence, resolution: "RESOLVED" as const };
  const verified = compile("S16", fields, { ...bundle, relationships: [relationship] }).view.edges[0];
  assert.equal(verified.displayMode, "FACT");
  assert.equal(verified.relationshipId, "implements");
  assert.equal(compile("S16", fields, { ...bundle, relationships: [{ ...relationship, evidence: [] }] }).view.edges.length, 0);
});


test("duplicate BPMN and DFD declarations cannot create colliding graph identities", () => {
  for (const chartId of ["S7", "S10"] as const) {
    const element = { id: "a", kind: chartId === "S7" ? "task" : "process", label: "Original", evidenceIds: ev };
    const flow = { from: "a", to: "a", kind: chartId === "S7" ? "sequence" : "sync", evidenceIds: ev, ...(chartId === "S10" ? { label: "data" } : {}) };
    const { view, diagnostics } = compile(chartId, { elements: [element, { ...element, label: "Replacement" }], flows: [flow, flow], ...(chartId === "S7" ? { lanes: [] } : {}) });
    assert.equal(view.nodes.length, 1);
    assert.equal(view.nodes[0].label, "Original");
    assert.equal(diagnostics.omittedNodes, 1);
    assert.equal(new Set(view.edges.map(edge => edge.id)).size, 2);
  }
});

test("ambiguous class names cannot verify UML relations through an arbitrary declaration", () => {
  const entities = ["one", "two"].map(id => ({ entityId: `class:${id}`, kind: "class", name: "Duplicate", file: `${id}.ts`, spans: [] }));
  const { view } = compile("S16", { classes: [{ id: "a", name: "Duplicate", kind: "class", attributes: [], operations: [], evidenceIds: ev }], relations: [] }, { ...erBundle, entities });
  assert.deepEqual(view.nodes[0].entityRefs, []);
  assert.equal(view.nodes[0].displayMode, "INFERENCE");
  assert.ok(view.gaps.some(gap => gap.includes("multiple source declarations")));
});


test("an uncited compensation target cannot close a saga gap even with a cited edge", () => {
  const { view } = compile("S12", { steps: [{ id: "a", kind: "forward", label: "Write", evidenceIds: ev }, { id: "undo", kind: "compensation", label: "Undo", evidenceIds: ["missing"] }], edges: [{ from: "a", to: "undo", kind: "compensation", evidenceIds: ev }] });
  assert.equal(view.edges.length, 0);
  assert.ok(view.gaps.some(gap => gap.includes("Write has no current evidence-backed compensation")));
});

test("sequence fragments retain the first grounded identity and disclose duplicates", () => {
  const { view } = compile("S28", { participants: [{ id: "a", label: "API", evidenceIds: ev }], messages: [{ from: "a", to: "a", order: 1, label: "Run", kind: "sync", fragmentId: "f", evidenceIds: ev }], fragments: [{ id: "f", kind: "alt", condition: "Original", evidenceIds: ev }, { id: "f", kind: "par", condition: "Replacement", evidenceIds: ev }] });
  assert.equal(view.sequence!.fragments.length, 1);
  assert.equal(view.sequence!.fragments[0].kind, "alt");
  assert.equal(view.sequence!.messages[0].fragmentId, "f");
  assert.ok(view.gaps.some(gap => gap.includes("Duplicate fragment f")));
});
