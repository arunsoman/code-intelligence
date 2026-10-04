import assert from "node:assert/strict";
import { test } from "node:test";
import type { ViewEdge, ViewNode, ViewSpec } from "@cie/schema";
import { arrange } from "../src/arrange.ts";
import { MAX_ELEMENTS, MAX_FOREGROUND, basePositions, boundView, describeNode, effectiveView, modeWord, outline, render } from "../src/graph.ts";

/** A repeatable synthetic repository: n symbols over n/10 files, calls to earlier symbols, a few percent in the foreground. */
function synth(n: number, fgEvery = 5): ViewSpec {
  const nodes: ViewNode[] = [], edges: ViewEdge[] = [];
  for (let i = 0; i < n; i++) nodes.push({ id: `n:s${i}`, entityRefs: [`s${i}`], label: `sym${i}`, kind: "function", file: `src/m${Math.floor(i / 10)}/f${Math.floor(i / 10)}.ts`, claimIds: [], evidenceIds: [`e${i}`], tier: i % fgEvery === 0 ? "RELEVANT" : "CONTEXT", displayMode: i % 17 === 0 ? "FOG" : "FACT", unresolvedCalls: i % 17 === 0 ? 1 : 0, score: 1 - i / n, role: "symbol" });
  for (let i = 1; i < n; i++) edges.push({ id: `e${i}`, fromNodeId: `n:s${i}`, toNodeId: `n:s${(i * 7) % i}`, kind: "calls", evidenceIds: [`e${i}`], displayMode: "FACT" });
  const groups = [...new Set(nodes.map((x) => x.file))].map((f) => ({ id: `g:file:${f}`, label: f, kind: "file" as const, childNodeIds: nodes.filter((x) => x.file === f).map((x) => x.id), level: 3, evidenceIds: [], displayMode: "FACT" as const }));
  return { id: "v", version: 1, revision: "r", taskId: "t", formId: "SemanticMap", caption: "c", question: "q", level: 5, nodes, edges, groups, legend: [], cameraPolicy: { behavior: "PRESERVE" }, gaps: [] };
}
const fgCount = (v: ViewSpec) => v.nodes.filter((n) => n.tier === "CRITICAL" || n.tier === "RELEVANT").length;

test("bounded views: at most 50 foreground and 2000 drawn elements, the rest is context or left out, edges follow, and the view says so", () => {
  const big = synth(3000);
  assert.ok(fgCount(big) > 500);
  const { view, stale, bounded } = effectiveView(big, {});
  assert.ok(stale.size === 0 && bounded);
  assert.ok(view.nodes.length <= MAX_ELEMENTS, `${view.nodes.length} nodes`);
  assert.ok(fgCount(view) <= MAX_FOREGROUND, `${fgCount(view)} foreground`);
  const ids = new Set(view.nodes.map((n) => n.id));
  assert.ok(view.edges.every((e) => ids.has(e.fromNodeId) && ids.has(e.toNodeId)), "no edge points at a removed node");
  assert.equal(bounded.total, 3000);
  assert.equal(bounded.shown + bounded.dropped, 3000);
  assert.ok(view.gaps.some((g) => /view is bounded: 2000 of 3000/.test(g)));
  // The highest-ranked foreground nodes are the ones kept in the foreground.
  const keptFg = view.nodes.filter((n) => n.tier === "RELEVANT").map((n) => n.id);
  assert.ok(keptFg.includes("n:s0") && !keptFg.includes("n:s2995"));
  // Deterministic: the same input bounds the same way.
  assert.deepEqual(effectiveView(big, {}).view.nodes.map((n) => n.id), view.nodes.map((n) => n.id));
  // A view within the bounds is returned untouched.
  const small = synth(40, 10);
  assert.equal(boundView(small).view, small);
  assert.equal(effectiveView(small, {}).bounded, undefined);
});

test("bounding never demotes a safety fact: code a failure points at or a pin stays in the foreground even past 50", () => {
  const v = synth(400, 2);
  for (const i of [300, 302, 304, 306, 308]) v.nodes[i].factors = [{ factor: "RUNTIME_HOTNESS", rawValue: 1, normalizedScore: 0.9, reason: "top frame", evidenceIds: [] }];
  v.nodes[310].factors = [{ factor: "USER_OVERRIDE", rawValue: 1, normalizedScore: 1, reason: "pinned", evidenceIds: [] }];
  const { view } = effectiveView(v, {});
  for (const i of [300, 302, 304, 306, 308, 310]) assert.ok(["RELEVANT", "CRITICAL"].includes(view.nodes.find((n) => n.id === `n:s${i}`)!.tier), `s${i} was demoted`);
  assert.ok(fgCount(view) <= MAX_FOREGROUND + 6);
});

test("p95 latency: rendering and laying out a bounded 2,000-element view stays within budget at the file and symbol levels", () => {
  const big = synth(3000);
  const { view } = effectiveView(big, {});
  // CPU time of this process, not wall time: other test files run beside this one, and their load must not decide whether it passes.
  const run = (level: number) => { const t = process.cpuUsage(); const r = arrange(render(view, level, basePositions(view)), view, level); const u = process.cpuUsage(t); assert.ok(r.nodes.length > 0); return (u.user + u.system) / 1000; };
  for (const level of [3, 5]) {
    run(level); // warm-up
    const times = Array.from({ length: 4 }, () => run(level)).sort((a, b) => a - b);
    const p95 = times[Math.ceil(times.length * 0.95) - 1];
    // Isolated this is about 1-2 s; the ceiling allows for the suite running beside heavier tests. It exists so a 5x regression fails the build, not as a product SLO.
    assert.ok(p95 < 8000, `level ${level}: p95 ${p95.toFixed(0)}ms`);
    console.log(`# level ${level} p95 ${p95.toFixed(0)}ms`);
  }
});

test("layout stability: the same view lays out identically, and a small change moves little of what was already there", () => {
  const base = synth(200, 4);
  const pos = (v: ViewSpec, level = 5) => { const r = arrange(render(v, level, basePositions(v)), v, level); return new Map(r.nodes.map((n) => [n.id, n.pos])); };
  const a = pos(base), b = pos(base);
  assert.deepEqual([...a], [...b], "deterministic");
  // Removing the last symbol and its edge.
  const smaller: ViewSpec = { ...base, nodes: base.nodes.slice(0, -1), edges: base.edges.slice(0, -1), groups: base.groups.map((g) => ({ ...g, childNodeIds: g.childNodeIds.filter((c) => c !== base.nodes.at(-1)!.id) })) };
  const c = pos(smaller);
  let moved = 0;
  for (const [id, p] of c) { const q = a.get(id)!; if (Math.hypot(p.x - q.x, p.y - q.y) > 1) moved++; }
  assert.ok(moved / c.size <= 0.1, `${moved} of ${c.size} existing nodes moved`);
  // Aggregated levels: the same input, the same drawing.
  assert.deepEqual([...pos(base, 3)], [...pos(base, 3)]);
});

test("accessibility and fog: every node, fog included, can be described in words without colour, and fog says what it is", () => {
  const v = synth(30, 3);
  const r = render(v, 5, basePositions(v));
  const fog = r.nodes.find((n) => n.displayMode === "FOG")!;
  assert.ok(fog, "the view has fog");
  assert.match(modeWord("FOG"), /fog, some calls unresolved/);
  for (const n of r.nodes) {
    const d = describeNode(n, r, false);
    assert.ok(d.length > 0 && d.includes(n.label), n.id);
    assert.match(d, /fact|inference|hypothesis|fog/i, `${n.id} has a mode in words`);
  }
  assert.match(describeNode(fog, r, false), /fog/i);
  const out = outline(r);
  assert.equal(out.length, r.nodes.length, "the text outline has every node");
  assert.ok(out.every((o) => o.text.length > 0));
  assert.ok(out.some((o) => o.links.length > 0), "and its links");
});
