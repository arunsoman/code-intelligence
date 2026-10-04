import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Claim, ViewNode, ViewSpec } from "@cie/schema";
import { basePositions, effectiveView, render, selectedAggregates } from "../src/graph.ts";

const node = (id: string, file: string, over: Partial<ViewNode> = {}): ViewNode => ({ id, entityRefs: [id.slice(2)], label: id.slice(2), kind: "function", file, claimIds: [], evidenceIds: ["e"], tier: "RELEVANT", displayMode: "FACT", unresolvedCalls: 0, role: "symbol", ...over });
const view: ViewSpec = {
  id: "v", version: 1, revision: "r", taskId: "t", formId: "SemanticMap", caption: "", question: "q", level: 4, cameraPolicy: { behavior: "PRESERVE" }, gaps: [],
  legend: [],
  nodes: [node("n:a", "src/auth/x.ts"), node("n:b", "src/auth/x.ts", { tier: "CONTEXT" }), node("n:c", "src/db/y.ts", { displayMode: "HYPOTHESIS" }), node("n:d", "src/db/y.ts")],
  edges: [
    { id: "e1", fromNodeId: "n:a", toNodeId: "n:b", kind: "calls", evidenceIds: ["x"], displayMode: "FACT" },
    { id: "e2", fromNodeId: "n:a", toNodeId: "n:c", kind: "calls", evidenceIds: ["y"], displayMode: "FACT" },
    { id: "e3", fromNodeId: "n:b", toNodeId: "n:d", kind: "calls", evidenceIds: ["z"], displayMode: "FACT" },
  ],
  groups: [
    { id: "g:file:src/auth/x.ts", label: "auth/x.ts", kind: "file", childNodeIds: ["n:a", "n:b"], level: 3, evidenceIds: [], displayMode: "FACT", parentGroupId: "g:concept:Auth" },
    { id: "g:file:src/db/y.ts", label: "db/y.ts", kind: "file", childNodeIds: ["n:c", "n:d"], level: 3, evidenceIds: [], displayMode: "FACT", parentGroupId: "g:concept:Data" },
    { id: "g:concept:Auth", label: "Auth", kind: "concept", childNodeIds: ["n:a", "n:b"], level: 4, evidenceIds: [], displayMode: "INFERENCE" },
    { id: "g:concept:Data", label: "Data", kind: "concept", childNodeIds: ["n:c", "n:d"], level: 4, evidenceIds: [], displayMode: "INFERENCE" },
  ],
};

test("level 5 shows every symbol with compound groups; identities are the node ids", () => {
  const r = render(view, 5, basePositions(view));
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), ["n:a", "n:b", "n:c", "n:d"]);
  assert.ok(r.nodes.every((n) => n.kind === "node" && n.parent));
  assert.equal(r.edges.length, 3);
  assert.equal(r.groups.length, 4);
});

test("level 4 hides context-tier symbols and their edges", () => {
  const r = render(view, 4, basePositions(view));
  assert.deepEqual(r.nodes.map((n) => n.id).sort(), ["n:a", "n:c", "n:d"]);
  assert.deepEqual(r.edges.map((e) => e.id), ["e2"]);
});

test("level 3 collapses to files with aggregated, counted edges; worst display mode wins", () => {
  const r = render(view, 3, basePositions(view));
  assert.deepEqual(r.nodes.map((n) => n.label).sort(), ["auth/x.ts (2)", "db/y.ts (2)"]);
  assert.equal(r.nodes.find((n) => n.label.startsWith("db/"))!.displayMode, "HYPOTHESIS");
  assert.equal(r.edges.length, 1, "a→c and b→d merge; a→b is internal and disappears");
  assert.equal(r.edges[0].count, 2);
  assert.deepEqual(r.edges[0].edgeIds.sort(), ["e2", "e3"]);
  assert.deepEqual(r.edges[0].evidenceIds.sort(), ["y", "z"]);
  assert.equal(r.groups.length, 0);
});

test("level 2 collapses to concept groups", () => {
  const r = render(view, 2, basePositions(view));
  assert.deepEqual(r.nodes.map((n) => n.label).sort(), ["Auth (2)", "Data (2)"]);
  assert.equal(r.edges.length, 1);
});

const clustered: ViewSpec = {
  ...view,
  groups: [
    ...view.groups.map((g) => (g.kind === "concept" ? { ...g, parentGroupId: g.label === "Auth" ? "g:cluster:Identity" : "g:cluster:Storage" } : g)),
    { id: "g:cluster:Identity", label: "Identity", kind: "cluster", childNodeIds: ["n:a", "n:b"], level: 1, evidenceIds: [], displayMode: "INFERENCE" },
    { id: "g:cluster:Storage", label: "Storage", kind: "cluster", childNodeIds: ["n:c", "n:d"], level: 1, evidenceIds: [], displayMode: "INFERENCE" },
  ],
  system: { name: "shop", files: 2, symbols: 4, externals: [{ name: "jsonwebtoken", files: 1, evidenceIds: ["x1"] }, { name: "bcrypt", files: 1, evidenceIds: ["x2"] }] },
};

test("level 1 shows model-proposed domains when they exist, and falls back to concepts when they do not", () => {
  const withClusters = render(clustered, 1, basePositions(clustered));
  assert.deepEqual(withClusters.nodes.map((n) => n.label).sort(), ["Identity (2)", "Storage (2)"]);
  const without = render(view, 1, basePositions(view));
  assert.deepEqual(without.nodes.map((n) => n.label).sort(), ["Auth (2)", "Data (2)"], "no invented abstraction when there is none");
});

test("level 5 nests concepts inside domains", () => {
  const r = render(clustered, 5, basePositions(clustered));
  assert.equal(r.groups.find((g) => g.id === "g:concept:Auth")!.parent, "g:cluster:Identity");
  assert.ok(r.groups.some((g) => g.kind === "cluster"));
});

test("level 0 is the whole system as one node, with its external dependencies around it", () => {
  const r = render(clustered, 0, basePositions(clustered));
  const sys = r.nodes.filter((n) => n.kind === "agg");
  assert.equal(sys.length, 1);
  assert.equal(sys[0].label, "shop (4)");
  const ext = r.nodes.filter((n) => n.kind === "ext");
  assert.deepEqual(ext.map((n) => n.label).sort(), ["bcrypt (1)", "jsonwebtoken (1)"]);
  assert.ok(ext.every((n) => n.evidenceIds!.length > 0), "every dependency cites its import");
  assert.equal(r.edges.filter((e) => e.kind === "depends-on").length, 2);
  assert.equal(render(clustered, 1, basePositions(clustered)).nodes.filter((n) => n.kind === "ext").length, 0, "externals only at level 0");
});

test("selection survives zooming: an aggregate is selected when any member is", () => {
  const sel = ["n:c"];
  assert.deepEqual([...selectedAggregates(render(view, 5, basePositions(view)), sel)], ["n:c"]);
  assert.deepEqual([...selectedAggregates(render(view, 3, basePositions(view)), sel)], ["agg:file:src/db/y.ts"]);
  assert.deepEqual([...selectedAggregates(render(view, 2, basePositions(view)), sel)], ["agg:g:concept:Data"]);
  assert.deepEqual([...selectedAggregates(render(clustered, 0, basePositions(clustered)), sel)], ["agg:system"]);
});

test("synthetic nodes (failure sites, symptoms, state) are never aggregated", () => {
  const v: ViewSpec = { ...view, formId: "CausalGraph", groups: [], nodes: [node("n:op", "src/a.ts", { layer: 0, role: "operation" }), node("n:fail", "src/a.ts", { layer: 1, role: "failure-site", kind: "failure" }), node("n:f", "", { layer: 2, role: "state" })], edges: [] };
  const r = render(v, 2, basePositions(v));
  assert.deepEqual(r.nodes.map((n) => n.kind).sort(), ["agg", "node", "node"]);
  const pos = basePositions(v);
  assert.ok(pos.get("n:op")!.x < pos.get("n:fail")!.x && pos.get("n:fail")!.x < pos.get("n:f")!.x, "layers run left to right");
});

const claim = (id: string, over: Partial<Claim>): Claim => ({
  draft: { id, revision: "r", assertion: "a", claimClass: "c", evidenceIds: [], counterEvidenceIds: [], rationaleSummary: "" },
  version: 1, state: "DISPLAYED", gates: [], displayMode: "INFERENCE", confidence: { mode: "NOT_ESTIMATED", reasonCodes: [] }, verdicts: [], counterArgument: "", ...over,
});

test("verdicts update what is shown: refuted claims disappear with their edges; stale ones are flagged", () => {
  const v: ViewSpec = {
    ...view, formId: "CausalGraph", groups: [],
    nodes: [node("n:op", "src/a.ts", { role: "operation" }), node("n:f1", "src/a.ts", { role: "failure-site", claimIds: ["c1"], displayMode: "INFERENCE" }), node("n:f2", "src/a.ts", { role: "failure-site", claimIds: ["c2"], displayMode: "HYPOTHESIS" })],
    edges: [
      { id: "r1", fromNodeId: "n:op", toNodeId: "n:f1", kind: "raises", claimId: "c1", evidenceIds: ["x"], displayMode: "FACT" },
      { id: "r2", fromNodeId: "n:op", toNodeId: "n:f2", kind: "raises", claimId: "c2", evidenceIds: ["x"], displayMode: "FACT" },
      { id: "as", fromNodeId: "n:op", toNodeId: "n:f2", kind: "async-flow", claimId: "c2", evidenceIds: ["x"], displayMode: "HYPOTHESIS" },
    ],
  };
  const e = effectiveView(v, { c1: claim("c1", { displayMode: "HIDDEN", state: "REFUTED" }), c2: claim("c2", { displayMode: "INFERENCE", state: "STALE" }) });
  assert.deepEqual(e.view.nodes.map((n) => n.id), ["n:op", "n:f2"]);
  assert.deepEqual(e.view.edges.map((x) => x.id), ["r2", "as"], "edges to a refuted node are gone");
  assert.equal(e.view.edges.find((x) => x.id === "as")!.displayMode, "INFERENCE", "hypothesis edge follows its claim");
  assert.equal(e.view.edges.find((x) => x.id === "r2")!.displayMode, "FACT", "static facts are never rewritten by a verdict");
  assert.deepEqual([...e.stale].sort(), ["as", "n:f2", "r2"]);
});

import { describeNode, nextByDirection, outline } from "../src/graph.ts";

test("keyboard navigation moves to the nearest node in the pressed direction, preferring ones in line", () => {
  const items = [{ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 5 }, { id: "c", x: 100, y: 200 }, { id: "d", x: 300, y: 0 }, { id: "e", x: -80, y: -10 }];
  assert.equal(nextByDirection(items, "a", "right"), "b");
  assert.equal(nextByDirection(items, "b", "right"), "d");
  assert.equal(nextByDirection(items, "a", "down"), "c", "falls back to the half-plane when nothing is in line");
  assert.equal(nextByDirection(items, "a", "left"), "e");
  assert.equal(nextByDirection(items, "e", "up"), null, "nothing above the topmost node: stay put rather than wrap");
  assert.equal(nextByDirection(items, null, "right"), "e", "with nothing focused, start at the leftmost");
  assert.equal(nextByDirection([], null, "down"), null);
  let at = "e"; const path = [at];
  for (let i = 0; i < 6; i++) { const n = nextByDirection(items, at, "right"); if (!n) break; at = n; path.push(at); }
  assert.deepEqual(path, ["e", "a", "b", "d"], "repeated presses traverse left to right");
});

test("every node can be described and outlined in words, with its state and links, without relying on colour", () => {
  const r = render(clustered, 5, basePositions(clustered));
  const n = r.nodes.find((x) => x.id === "n:c")!;
  const d = describeNode(n, r, true);
  assert.match(d, /hypothesis/); assert.match(d, /selected/); assert.match(d, /\d+ outgoing and \d+ incoming link/);
  assert.match(describeNode(n, r, false), /not selected/);
  const o = outline(r);
  assert.equal(o.length, r.nodes.length, "the outline covers every node");
  assert.ok(o.every((x) => /fact|inference|hypothesis|fog/.test(x.text)), "each entry states how it is known");
  assert.ok(o.some((x) => x.links.some((l) => /fact/.test(l))), "links state how they are known too");
  const sys = outline(render(clustered, 0, basePositions(clustered)));
  assert.ok(sys.some((x) => /external dependency/.test(x.text)));
});

import { composite, squarify } from "../src/graph.ts";

test("squarify fills the box exactly, with areas proportional to the values and no overlap", () => {
  const vals = [6, 6, 4, 3, 2, 2, 1];
  const box = { x: 0, y: 0, w: 600, h: 400 };
  const rs = squarify(vals, box);
  const area = (r: { w: number; h: number }) => r.w * r.h, total = vals.reduce((a, b) => a + b, 0);
  rs.forEach((r, i) => assert.ok(Math.abs(area(r) / (box.w * box.h) - vals[i] / total) < 1e-9, `cell ${i}`));
  assert.ok(Math.abs(rs.reduce((n, r) => n + area(r), 0) - box.w * box.h) < 1e-6, "covers the whole box");
  for (const r of rs) assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= box.w + 1e-9 && r.y + r.h <= box.h + 1e-9, "inside the box");
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
    const a = rs[i], b = rs[j];
    assert.ok(a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6, `cells ${i} and ${j} overlap`);
  }
  const aspect = rs.map((r) => Math.max(r.w / r.h, r.h / r.w));
  assert.ok(Math.max(...aspect) < 4, `reasonably square, worst ${Math.max(...aspect).toFixed(2)}`);
  assert.deepEqual(squarify([], box), []);
  assert.deepEqual(squarify([5], box)[0], { x: 0, y: 0, w: 600, h: 400 });
});

test("composite risk follows the weights, treats missing factors as neutral, and ignores a zero total", () => {
  const f = { a: 1, b: 0 };
  assert.equal(composite(f, { a: 1, b: 1 }), 0.5);
  assert.equal(composite(f, { a: 3, b: 1 }), 0.75);
  assert.equal(composite(f, { a: 0, b: 1 }), 0);
  assert.equal(composite({}, { a: 1 }), 0.5, "no data is neutral, not zero");
  assert.equal(composite(f, { a: 0, b: 0 }), 0);
});

test("forms with their own layout keep their positions; lanes and walls become parents, brackets become flags", () => {
  const v: ViewSpec = { ...view, formId: "TransactionJourney", groups: [
    { id: "g:lane:x", label: "x", kind: "lane", childNodeIds: ["n:a", "n:b"], level: 1, evidenceIds: [], displayMode: "FACT" },
    { id: "g:region:tx", label: "transaction", kind: "region", childNodeIds: ["n:a"], level: 3, evidenceIds: [], displayMode: "FACT" },
  ], nodes: view.nodes.map((n, i) => ({ ...n, pos: { x: i * 100, y: i * 10 } })) };
  const pos = basePositions(v);
  assert.deepEqual(pos.get("n:c"), { x: 200, y: 20 });
  const r = render(v, 5, pos);
  assert.equal(r.nodes.find((n) => n.id === "n:b")!.parent, "g:lane:x");
  assert.equal(r.nodes.find((n) => n.id === "n:a")!.inTx, true);
  assert.equal(r.nodes.find((n) => n.id === "n:b")!.inTx, undefined);
});

import { cellKey } from "../src/graph.ts";

test("a matrix follows verdicts like the graph does: a refuted claim removes its cells, a stale one marks them, facts are not rewritten", () => {
  const cell = (row: string, col: string, over: object) => ({ row, col, state: "enforced", displayMode: "INFERENCE" as const, evidenceIds: ["x"], note: "n", ...over });
  const v: ViewSpec = {
    ...view, formId: "PolicyMap", nodes: [node("n:a", "src/a.ts")], edges: [], groups: [],
    matrix: {
      rowTitle: "Route", colTitle: "Rule", emptyMeaning: "", states: { enforced: { label: "enforced", glyph: "✓", description: "" } },
      rows: [{ id: "r1", label: "r1", entityRefs: [], evidenceIds: [] }], cols: [1, 2, 3, 4].map((i) => ({ id: `c${i}`, label: `c${i}`, entityRefs: [], evidenceIds: [] })),
      cells: [cell("r1", "c1", { claimId: "k1" }), cell("r1", "c2", { claimId: "k2" }), cell("r1", "c3", { claimId: "k3", displayMode: "HYPOTHESIS" }), cell("r1", "c4", { displayMode: "FACT" })],
    },
  };
  const e = effectiveView(v, { k1: claim("k1", { displayMode: "HIDDEN", state: "REFUTED" }), k2: claim("k2", { displayMode: "INFERENCE", state: "STALE" }), k3: claim("k3", { displayMode: "INFERENCE" }) });
  const cells = e.view.matrix!.cells;
  assert.deepEqual(cells.map((c) => c.col), ["c2", "c3", "c4"], "the refuted claim's cell is gone");
  assert.equal(cells.find((c) => c.col === "c3")!.displayMode, "INFERENCE", "a hypothesis cell follows its claim's mode");
  assert.equal(cells.find((c) => c.col === "c4")!.displayMode, "FACT", "static facts are never rewritten by a verdict");
  assert.ok(e.stale.has(cellKey({ row: "r1", col: "c2" })) && !e.stale.has(cellKey({ row: "r1", col: "c3" })));
  assert.equal(v.matrix!.cells.length, 4, "the original view is untouched");
});

test("collapse and expand are orphan-free: at every level each edge has both ends, each member sits in exactly one rendered element, and evidence is carried up", () => {
  const pos = basePositions(view);
  for (let level = 1; level <= 5; level++) {
    const r = render(view, level, pos);
    const ids = new Set(r.nodes.map((n) => n.id));
    for (const e of r.edges) assert.ok(ids.has(e.from) && ids.has(e.to), `level ${level}: edge ${e.id} has a missing end`);
    for (const g of r.groups) if (g.parent) assert.ok(r.groups.some((x) => x.id === g.parent), `level ${level}: group ${g.id} lost its parent`);
    const count = new Map<string, number>();
    for (const n of r.nodes) for (const m of n.members) count.set(m, (count.get(m) ?? 0) + 1);
    for (const [m, c] of count) assert.equal(c, 1, `level ${level}: ${m} appears in ${c} rendered elements`);
    if (level <= 3) for (const n of view.nodes) assert.equal(count.get(n.id), 1, `level ${level}: ${n.id} was orphaned by collapsing`);
    // Evidence is transported: an aggregated edge carries the evidence of every edge folded into it.
    for (const e of r.edges) {
      const folded = view.edges.filter((x) => e.edgeIds.includes(x.id));
      assert.deepEqual([...e.evidenceIds].sort(), [...new Set(folded.flatMap((x) => x.evidenceIds))].sort());
    }
  }
  // Expanding again restores the original elements with their own identities.
  const back = render(view, 5, pos);
  assert.deepEqual(back.nodes.map((n) => n.id).sort(), view.nodes.map((n) => n.id).sort());
});

test("identity-preserving zoom: element ids, evidence and selection survive going out and back in", () => {
  const pos = basePositions(view);
  const before = render(view, 5, pos);
  const out = render(view, 3, pos);
  const again = render(view, 5, pos);
  assert.deepEqual(again.nodes.map((n) => [n.id, n.evidenceIds ?? n.node?.evidenceIds, n.displayMode]), before.nodes.map((n) => [n.id, n.evidenceIds ?? n.node?.evidenceIds, n.displayMode]));
  assert.deepEqual([...selectedAggregates(out, ["n:a"])], ["agg:file:src/auth/x.ts"]);
  assert.deepEqual([...selectedAggregates(again, ["n:a"])], ["n:a"], "the same selection finds the same element after zooming back in");
  for (const n of out.nodes) assert.ok(n.members.every((m) => view.nodes.some((x) => x.id === m)), "aggregates are made of real elements");
  assert.equal(view.nodes[0].id, "n:a", "the view itself is not rewritten by zooming");
});

test("levels are driven by legibility, not by a relative zoom table", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/graph.ts"), "utf8");
  assert.doesNotMatch(src, /export function nextLevel|export const zoomForLevel/, "the relative-zoom level mechanism is gone");
  const canvas = readFileSync(join(import.meta.dirname, "../src/Canvas.tsx"), "utf8");
  assert.match(canvas, /levelMove\(/, "the canvas asks the legibility rule which way the level moves");
});
