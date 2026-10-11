import { test } from "node:test";
import assert from "node:assert/strict";
import { classCard, g6NodeSize, g6EdgeNotation, g6LensNotation } from "../src/g6-notation.ts";
import { g6Data, g6Layout } from "../src/g6-adapter.ts";
import { focusedPreview, lensDetailCapacity } from "../src/fisheye.ts";
import type { RenderNode, RenderEdge } from "../src/graph.ts";
import type { ViewNode } from "@cie/schema";

const node: RenderNode = { id: "account", label: "Account", kind: "node", members: ["account"], count: 1, displayMode: "FACT", tier: "CRITICAL", pos: { x: 0, y: 0 }, stale: false, role: "uml-class", node: { notes: ["- balance: number", "+ debit(amount: number): void"] } as ViewNode };
const edge: RenderEdge = { id: "relation", from: "a", to: "b", displayMode: "FACT", label: "", count: 1, edgeIds: ["relationship"], evidenceIds: ["evidence"], stale: false };
test("class cards preserve member compartments, visible omission and variable dimensions", () => {
  const card = classCard(node);
  assert.deepEqual(card.attributes, ["- balance: number"]); assert.deepEqual(card.operations, ["+ debit(amount: number): void"]);
  assert.equal(card.stereotype, "«class»"); assert.equal(card.omitted, 0);
  const many = { ...node, node: { ...node.node!, notes: [...Array.from({ length: 14 }, (_, i) => `- field${i}: string`), ...Array.from({ length: 8 }, (_, i) => `+ method${i}()`)] } };
  const full = classCard(many); assert.equal(full.attributes.length, 6); assert.equal(full.operations.length, 6); assert.equal(full.omitted, 10);
  assert.ok(g6NodeSize(many)[1] > g6NodeSize(node)[1]); assert.equal(many.node.notes.length, 22);
  const empty = classCard({ ...node, role: "uml-interface", node: { ...node.node!, notes: [] } });
  assert.equal(empty.stereotype, "«interface»"); assert.deepEqual(empty.attributes, ["No evidenced attributes"]);
});
test("UML relationship arrows preserve source/target semantics in both graph and lens", () => {
  const inherited = g6EdgeNotation({ ...edge, kind: "inheritance" }); assert.equal(inherited.endArrowType, "triangle"); assert.equal(inherited.endArrowFill, "#111827");
  assert.deepEqual(g6EdgeNotation({ ...edge, kind: "realization" }).lineDash, [6, 4]);
  for (const kind of ["aggregation", "composition"]) { const notation = g6EdgeNotation({ ...edge, kind }); assert.equal(notation.startArrow, true); assert.equal(notation.endArrow, false); }
  assert.equal(g6LensNotation({ ...edge, kind: "aggregation" }).sourceArrowFill, "hollow");
  assert.equal(g6LensNotation({ ...edge, kind: "composition" }).sourceArrowFill, "filled");
  assert.equal(g6LensNotation({ ...edge, kind: "dependency" }).targetArrow, "vee");
  assert.equal(g6EdgeNotation({ ...edge, kind: "association" }).endArrow, false);
});
test("layout receives actual class dimensions and nested architecture membership", () => {
  const scene = { nodes: [node], edges: [], groups: [] };
  const layout = g6Layout(scene, 800, 600) as { type: string; nodeSize: (node: {id:string}) => number[] };
  assert.equal(layout.type, "grid"); assert.deepEqual(layout.nodeSize({ id: node.id }), g6NodeSize(node));
  const grouped = g6Data({ ...scene, nodes: [{ ...node, parent: "component" }], groups: [{ id: "system", label: "System", kind: "cluster" }, { id: "component", label: "Component", kind: "file", parent: "system" }] });
  assert.equal(grouped.nodes![0].combo, "component"); assert.equal(grouped.combos![1].combo, "system");
});
test("captured member detail pages expose every note without changing the source", () => {
  const details = Array.from({ length: 29 }, (_, i) => `member ${i}`), capacity = lensDetailCapacity(150);
  const capture = { kind: "node" as const, node: { id: "class", label: "Class", x: 0, y: 0, width: 100, height: 100, color: "#fff", details }, children: [], edges: [] };
  const shown = Array.from({ length: Math.ceil(details.length / capacity) }, (_, page) => focusedPreview(capture, { x: 150, y: 150 }, 150, page).nodes[0].details!).flat();
  assert.deepEqual(shown, details); assert.deepEqual(capture.node.details, details);
});

test("package and communication notation preserves dependencies, numbers and direction", () => {
  assert.deepEqual(g6NodeSize({ ...node, role: "package" }), [260, 100]);
  const messages = ["sync-flow", "async-flow", "return"].map((kind, i) => ({ ...edge, id: `message${i}`, kind, label: `${i + 1}. transfer()`, from: "a", to: "b" }));
  const scene = { nodes: [{ ...node, id: "a", role: "participant" }, { ...node, id: "b", role: "participant" }], edges: messages, groups: [] };
  const before = structuredClone(scene), data = g6Data(scene);
  assert.deepEqual(data.edges!.map(e => e.style!.labelText), ["1. transfer()", "2. transfer()", "3. transfer()"]);
  assert.deepEqual(scene, before);
  assert.equal(g6EdgeNotation(messages[0]).endArrowType, "triangle");
  for (const message of messages.slice(1)) { assert.equal(g6LensNotation(message).targetArrow, "vee"); assert.equal(g6LensNotation(message).dashed, true); }
  assert.equal(g6LensNotation({ ...edge, kind: "package-dependency" }).targetArrow, "vee");
  assert.equal(g6LensNotation({ ...edge, kind: "forbidden-transition" }).targetArrow, "tee");
});

test("fixed layouts retain routes and ER endpoints; topology layouts discard stale routes", () => {
  const n = { ...node, id:"a" }, e={...edge,id:"er",from:"a",to:"a",kind:"er-inferred",sourceLabel:"1?",targetLabel:"N?",via:[{x:30,y:40}]};
  const scene={nodes:[n],edges:[e],groups:[]};
  assert.equal(g6Data(scene).edges![0].type,"cie-er-link");
  assert.equal(g6Data(scene).edges![0].style!.sourceCardinality,"1?");
  assert.equal(g6Data(scene).edges![0].style!.targetCardinality,"N?");
  assert.deepEqual(g6Data(scene).edges![0].style!.controlPoints,[[30,40]]);
  assert.equal(g6Data(scene,false).edges![0].style!.controlPoints,undefined);
  assert.equal(g6Layout(scene,800,600,"TransactionJourney"),undefined);
  assert.equal(g6Layout(scene,800,600,"GeneratedChart","S22"),undefined);
});
