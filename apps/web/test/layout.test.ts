// Layout quality is asserted, not eyeballed. Overlaps and edges drawn through nodes must be zero for every form at every
// level; edge crossings are held to a per-form ceiling (dense graphs have crossings no layout can remove, so the ceiling
// is a ratchet: it can go down, and going up fails the build). See layout.ts for the algorithms.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { VISUALS } from "../../../packages/core/src/visuals.ts";
import { ctx, demoRepo, setup, traceFor } from "../../../packages/core/test/helpers.ts";
import { arrange } from "../src/arrange.ts";
import { basePositions, effectiveView, render } from "../src/graph.ts";
import { callDepth, columnFlow, forceLayout, geometricCrossings, gutterRoutes, laneBands, layered, marginArcs, orderColumns, pathClear, routeEdges, separate, wrapColumns, type Item } from "../src/layout.ts";
import { SIZES, measure, measureLegibility } from "../src/layoutmetrics.ts";

const item = (id: string, x: number, y: number, w = 150, h = 28): Item => ({ id, x, y, w, h });
const overlapping = (items: Item[], gap = 0) => { let n = 0; for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) { const a = items[i], b = items[j]; if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + gap && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + gap) n++; } return n; };

test("generated chart arrangement preserves its requested columns and rows", () => {
  const node = (id: string, x: number, y: number) => ({
    id, entityRefs: [id], label: id, kind: "class", file: `${id}.ts`, claimIds: [], evidenceIds: ["ev"],
    tier: "RELEVANT" as const, displayMode: "FACT" as const, unresolvedCalls: 0, pos: { x, y },
  });
  const view = {
    id: "generated", version: 1, revision: "rev", taskId: "task", formId: "GeneratedChart" as const,
    caption: "Generated sequence", question: "show sequence", level: 5,
    nodes: [node("a", 0, 0), node("b", 210, 110), node("c", 630, 0)],
    edges: [
      { id: "ab", fromNodeId: "a", toNodeId: "b", kind: "calls", evidenceIds: ["ev"], displayMode: "FACT" as const },
      { id: "bc", fromNodeId: "b", toNodeId: "c", kind: "calls", evidenceIds: ["ev"], displayMode: "FACT" as const },
    ], groups: [], legend: [], cameraPolicy: { behavior: "PRESERVE" as const }, gaps: [],
  };
  const laidOut = arrange(render(view, 5, basePositions(view)), view, 5);
  assert.deepEqual(Object.fromEntries(laidOut.nodes.map((n) => [n.id, n.pos])), {
    a: { x: 0, y: 0 }, b: { x: 210, y: 110 }, c: { x: 630, y: 0 },
  });
});

test("separate: removes every overlap, including nodes stacked on the same centre", () => {
  const items = Array.from({ length: 30 }, (_, i) => item(`n${i}`, (i % 3) * 20, (i % 5) * 6));
  assert.ok(overlapping(items) > 0);
  separate(items, 14);
  assert.equal(overlapping(items, 13), 0);
});

test("forceLayout then separate: a connected cluster ends with no overlaps and every node placed", () => {
  const items = Array.from({ length: 24 }, (_, i) => item(`n${i}`, 0, 0, 190, 44));
  const links = items.slice(1).map((it, i) => ({ from: items[Math.floor(i / 2)].id, to: it.id }));
  forceLayout(items, links);
  separate(items, 24);
  assert.equal(overlapping(items, 23), 0);
  assert.ok(items.every((i) => Number.isFinite(i.x) && Number.isFinite(i.y)));
});

test("layered: a tree and a diamond lattice are drawn with zero crossings; long edges get waypoints", () => {
  const nodes = ["a", "b", "c", "d", "e", "f", "g"].map((id, i) => ({ id, layer: [0, 1, 1, 2, 2, 2, 3][i], w: 150, h: 28, order: i }));
  const links = [["a", "b"], ["a", "c"], ["b", "d"], ["b", "e"], ["c", "f"], ["d", "g"], ["a", "g"]].map(([from, to]) => ({ from, to }));
  const r = layered(nodes, links);
  assert.equal(r.crossings, 0);
  // Same layer, never overlapping vertically.
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) if (nodes[i].layer === nodes[j].layer) assert.ok(Math.abs(r.pos.get(nodes[i].id)!.y - r.pos.get(nodes[j].id)!.y) >= 28 + 26 - 1e-6);
  assert.equal(r.via.get("a\u0001g")?.length, 2, "a→g spans three layers, so two waypoints");
});

test("layered: crossing reduction finds the planar order for a graph that starts crossed", () => {
  // Layer 0: a b c; layer 1 seeded in the worst order. Edges a→x, b→y, c→z are a perfect matching.
  const nodes = [{ id: "a", layer: 0, order: 0 }, { id: "b", layer: 0, order: 1 }, { id: "c", layer: 0, order: 2 }, { id: "z", layer: 1, order: 3 }, { id: "y", layer: 1, order: 4 }, { id: "x", layer: 1, order: 5 }].map((n) => ({ ...n, w: 150, h: 28 }));
  const r = layered(nodes, [{ from: "a", to: "x" }, { from: "b", to: "y" }, { from: "c", to: "z" }]);
  assert.equal(r.crossings, 0);
});

test("routeEdges: an edge whose straight line crosses a node is routed around it; a clear edge is left straight", () => {
  const items = [item("a", 0, 0), item("mid", 300, 0), item("b", 600, 0), item("c", 0, 200), item("d", 600, 200)];
  const routes = routeEdges(items, [{ from: "a", to: "b", key: "ab" }, { from: "c", to: "d", key: "cd" }]);
  assert.ok(routes.has("ab") && routes.get("ab")!.length >= 1);
  assert.ok(pathClear(items, "a", "b", routes.get("ab")!));
  assert.ok(!routes.has("cd"));
});

test("marginArcs: same-column links that would cross the nodes between them become clear C-shaped arcs", () => {
  const items = [0, 1, 2, 3, 4].map((i) => item(`n${i}`, 0, i * 60));
  const links = [{ from: "n0", to: "n3", key: "a" }, { from: "n1", to: "n4", key: "b" }, { from: "n0", to: "n2", key: "c" }];
  const arcs = marginArcs(items, links);
  assert.equal(arcs.size, 3);
  for (const l of links) assert.ok(pathClear(items, l.from, l.to, arcs.get(l.key)!), l.key);
});

test("wrapColumns: a 36-node column becomes side-by-side sub-columns, none overlapping, columns to the right shifted over", () => {
  const items = [...Array.from({ length: 36 }, (_, i) => item(`o${i}`, 0, i * 74)), item("far", 280, 0)];
  assert.ok(wrapColumns(items, 12));
  assert.equal(overlapping(items.filter((i) => i.id !== "far"), 20), 0);
  assert.ok(Math.max(...items.filter((i) => i.id !== "far").map((i) => i.y)) < 12 * 74);
  assert.ok(items.find((i) => i.id === "far")!.x > Math.max(...items.filter((i) => i.id !== "far").map((i) => i.x)), "the next column starts to the right of every sub-column");
});

test("orderColumns: swapping rows inside columns removes crossings the form's own order had", () => {
  const items = [item("a", 0, 0), item("b", 0, 60), item("c", 0, 120), item("x", 300, 0), item("y", 300, 60), item("z", 300, 120)];
  const links = [{ from: "a", to: "z" }, { from: "b", to: "y" }, { from: "c", to: "x" }];
  assert.ok(geometricCrossings(items, links) > 0);
  orderColumns(items, links);
  assert.equal(geometricCrossings(items, links), 0);
});

test("columnFlow: a form whose edges run across its columns is a layered graph; one whose edges stay inside columns is not", () => {
  const across = [item("a", 0, 0), item("b", 300, 0), item("c", 600, 0)];
  assert.ok(columnFlow(across, [{ from: "a", to: "b" }, { from: "b", to: "c" }]));
  const within = [item("a", 0, 0), item("b", 0, 60), item("c", 300, 0), item("d", 300, 60)];
  assert.equal(columnFlow(within, [{ from: "a", to: "b" }, { from: "c", to: "d" }]), null);
});

test("callDepth: depth follows calls from the entry, and a cycle does not loop", () => {
  const items = [item("a", 0, 0), item("b", 100, 0), item("c", 200, 0)];
  const d = callDepth(items, [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "c", to: "b" }]);
  assert.deepEqual([d.get("a"), d.get("b"), d.get("c")], [0, 1, 2]);
});

test("the sizes the metric assumes are the sizes the stylesheet draws", () => {
  const css = readFileSync(join(import.meta.dirname, "../src/Canvas.tsx"), "utf8");
  for (const [role, [w, h]] of Object.entries(SIZES)) {
    const line = css.split("\n").find((l) => l.includes(`role = '${role}'`) && /width: \d+/.test(l));
    assert.ok(line, `no stylesheet rule sizes role ${role}`);
    assert.equal(Number(/width: (\d+)/.exec(line)![1]), w, `${role} width`);
    assert.equal(Number(/height: (\d+)/.exec(line)![1]), h, `${role} height`);
  }
});

// ---- every form, every level -------------------------------------------------------------------------------
/** Crossings no layout removed, per form (largest over levels 1, 3, 5, 6) on the demo repository. A ratchet. */
const CROSSING_CEILING: Record<string, number> = {
  SemanticMap: 0, HypothesisGraph: 7, CausalGraph: 0, TransactionJourney: 0, DataLineage: 7, SemanticDiff: 0, Archaeology: 0,
  TrustBoundary: 2, RuntimeOverlay: 0, RaceWindow: 2, Counterfactual: 4, TestConfidence: 1, Ownership: 6, ConceptAtlas: 3, PolicyMap: 6,
};
/** Edge labels may still have a line running beneath them; Canvas draws each with an opaque halo, so it stays legible. This
 *  ratchet holds how many remain, and is zero for the journey, whose long cross-lane edges are routed through gutters. */
const EDGE_LABEL_CEILING: Record<string, number> = { PolicyMap: 2, TestConfidence: 1, HypothesisGraph: 3 };

test("every form at every level: no node overlaps and no edge through an unrelated node; crossings stay under the form's ceiling", async () => {
  const repo = demoRepo();
  const { svc, worker, revision } = await setup(undefined, repo);
  await svc.extractConcepts(ctx(), { revision });
  for (let i = 0; i < 3; i++) svc.reportException(ctx(), { trace: traceFor(repo), source: "api" });
  const views: { form: string; view: any; claims: any[] }[] = [];
  for (const v of VISUALS.filter((x) => x.formId !== "ChangeRisk" && x.formId !== "HypothesisGraph" && x.formId !== "SemanticDiff")) {
    const r = await svc.ask(ctx(), { question: v.example, revision, form: v.formId } as any);
    assert.ok(r.ok, v.formId);
    views.push({ form: v.formId, view: r.value.view, claims: r.value.claims });
  }
  const inv = await svc.investigate(ctx(), { trace: traceFor(repo), revision });
  assert.ok(inv.ok);
  views.push({ form: "HypothesisGraph", view: inv.value.view, claims: inv.value.claims });
  // A second revision gives the diff something to show.
  const f = join(repo, "src/ledger/ledger.ts");
  writeFileSync(f, readFileSync(f, "utf8") + `\nexport class LedgerLockedError extends Error {}\nexport function freeze(id: string) { if (!id) throw new LedgerLockedError(id); }\n`);
  execFileSync("git", ["-C", repo, "-c", "user.name=Sam", "-c", "user.email=s@x", "commit", "-qam", "add freeze"]);
  const r2 = await svc.ingestRepository(ctx(), { repoPath: repo });
  assert.ok(r2.ok);
  const diff = await svc.ask(ctx(), { question: "what changed since the last index", revision: r2.value.id } as any);
  assert.ok(diff.ok);
  views.push({ form: "SemanticDiff", view: diff.value.view, claims: diff.value.claims });

  const problems: string[] = [];
  const worst: Record<string, number> = {};
  const worstTruncated: Record<string, number> = {};
  const worstEdgeLabel: Record<string, number> = {};
  for (const { form, view: raw, claims: cs } of views) {
    const claims = Object.fromEntries(cs.map((c: any) => [c.draft.id, c]));
    const { view, stale } = effectiveView(raw, claims);
    for (const level of [0, 1, 2, 3, 4, 5, 6]) {
      const drawn = arrange(render(view, level, basePositions(view), stale), view, level);
      const m = measure(drawn);
      const lg = measureLegibility(drawn);
      if (m.nodeOverlaps) problems.push(`${form} L${level}: ${m.nodeOverlaps} overlap(s) ${m.detail.join("; ")}`);
      if (m.edgeThroughNode) problems.push(`${form} L${level}: ${m.edgeThroughNode} edge(s) through a node ${m.detail.join("; ")}`);
      if (lg.edgeLabelCollisions) worstEdgeLabel[form] = Math.max(worstEdgeLabel[form] ?? 0, lg.edgeLabelCollisions);
      worstTruncated[form] = Math.max(worstTruncated[form] ?? 0, lg.truncatedLabels);
      worst[form] = Math.max(worst[form] ?? 0, m.edgeCrossings);
    }
  }
  assert.deepEqual(problems, []);
  for (const [form, n] of Object.entries(worst)) assert.ok(n <= (CROSSING_CEILING[form] ?? 0), `${form}: ${n} crossings exceeds its ceiling of ${CROSSING_CEILING[form] ?? 0}`);
  // A label that cannot fit its box is a silent truncation; every form's labels must fit once wrapped.
  for (const [form, n] of Object.entries(worstTruncated)) assert.equal(n, 0, `${form}: ${n} label(s) do not fit their node`);
  for (const [form, n] of Object.entries(worstEdgeLabel)) assert.ok(n <= (EDGE_LABEL_CEILING[form] ?? 0), `${form}: ${n} edge label(s) under an edge exceeds its ceiling of ${EDGE_LABEL_CEILING[form] ?? 0}`);
  assert.equal(views.length, VISUALS.filter((x) => x.formId !== "ChangeRisk" && x.formId !== "HypothesisGraph" && x.formId !== "SemanticDiff").length + 2,
    "every node-link visual, investigation graph and semantic diff was checked (the terrain view is not a node-link drawing)");
  worker.close();
});

test("gutterRoutes: a lane-crossing edge is routed through the free corridor between columns, a same-lane edge is left straight", () => {
  const laneOf = new Map([["a", "L1"], ["b", "L2"], ["c", "L1"], ["d", "L1"]]);
  // Column 1: a above, c/d below; column 2: b. `a→b` crosses lanes, `c→d` does not.
  const items = [item("a", 0, 0), item("c", 0, 160), item("d", 0, 220), item("b", 300, 160)];
  const links = [{ from: "a", to: "b" }, { from: "c", to: "d" }];
  const routes = gutterRoutes(items, laneOf, links);
  const key = `${links[0].from}\u0001${links[0].to}`;
  assert.ok(routes.has(key), "the cross-lane edge has a corridor route");
  const via = routes.get(key)!;
  assert.equal(via.length, 2, "two waypoints: into the corridor and back out");
  assert.equal(via[0].x, via[1].x, "the vertical run is in one corridor");
  assert.ok(via[0].x > 75 && via[0].x < 225, `corridor sits between the column boxes (got ${via[0].x})`);
  assert.ok(pathClear(items, links[0].from, links[0].to, via), "the corridor route clears every node");
  assert.equal(routes.has(`${links[1].from}\u0001${links[1].to}`), false, "a same-lane edge is not touched");
  assert.equal(laneBands(items, laneOf).get("L1")!.y, (0 + 220) / 2, "a lane band is centred on its nodes");
});

test("the canvas draws labels so they are readable: nodes wrap and carry a halo, edges carry a halo, and the full text is on hover", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/Canvas.tsx"), "utf8");
  const nodeStyle = src.split("\n").find((l) => l.includes('selector: "node", style'))!;
  assert.ok(/"text-wrap": "wrap"/.test(nodeStyle), "node labels wrap instead of being ellipsised");
  assert.ok(/"text-background-color"/.test(nodeStyle), "node labels sit on a background so lane fills do not wash them out");
  const edgeStyle = src.split("\n").find((l) => l.includes('selector: "edge", style'))!;
  assert.ok(/"text-background-color"/.test(edgeStyle) && /"text-border-width"/.test(edgeStyle), "edge labels sit on an opaque halo");
  assert.ok(/mouseover/.test(src) && /canvas-tip/.test(src), "the full label is shown on hover");
  assert.ok(/readableFitZoom/.test(src), "a fit clamps to the readable floor");
  assert.equal(CROSSING_CEILING.TransactionJourney, 0, "gutter routing removed the journey's crossings");
});

test("forceLayout: nodes with no links stay near the rest instead of drifting away", () => {
  const items = [...Array.from({ length: 6 }, (_, i) => item(`c${i}`, i * 40, (i % 2) * 40)), ...Array.from({ length: 6 }, (_, i) => item(`lone${i}`, i * 10, 5))];
  const links = Array.from({ length: 5 }, (_, i) => ({ from: `c${i}`, to: `c${i + 1}` }));
  forceLayout(items, links);
  const w = Math.max(...items.map((i) => i.x)) - Math.min(...items.map((i) => i.x)), h = Math.max(...items.map((i) => i.y)) - Math.min(...items.map((i) => i.y));
  assert.ok(w < 2000 && h < 2000, `layout spans ${Math.round(w)} x ${Math.round(h)}`);
});
