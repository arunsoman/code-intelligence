import assert from "node:assert/strict";
import { test } from "node:test";
import { clipLink, invertLens, localChildren, projectLens, relaxLensNodes, type LensNode } from "../src/fisheye.ts";
import type { Rendered } from "../src/graph.ts";

test("lens projection fixes the boundary and all surrounding context", () => {
  const centre = { x: 100, y: 200 }, radius = 242;
  for (const magnification of [.35, 1, 2.2, 4]) {
    for (const point of [{ x: 342, y: 200 }, { x: 1000, y: -100 }, centre]) {
      assert.deepEqual(projectLens(point, centre, magnification, radius), point);
    }
    const p = projectLens({ x: 105, y: 200 }, centre, magnification, radius);
    assert.equal(Math.sign(p.x - 105), Math.sign(magnification - 1));
  }
});

test("projection is monotonic and inverse hit testing round-trips magnification and shrinking", () => {
  const centre = { x: 75, y: 100 };
  for (const magnification of [.35, .55, 1, 2.2, 4]) {
    let previous = -1;
    for (let distance = 0; distance < 500; distance++) {
      const point = { x: centre.x + distance * .6, y: centre.y + distance * .8 };
      const projected = projectLens(point, centre, magnification, 242);
      const radial = Math.hypot(projected.x - centre.x, projected.y - centre.y);
      assert.ok(radial > previous); previous = radial;
      const inverted = invertLens(projected, centre, magnification, 242);
      assert.ok(Math.hypot(inverted.x - point.x, inverted.y - point.y) < 1e-8);
    }
  }
});

test("links stop at endpoints and are clipped around intervening node boxes", () => {
  const boxes = [{ x: 0, y: 0, width: 100, height: 40 }, { x: 150, y: 0, width: 60, height: 40 }, { x: 300, y: 0, width: 100, height: 40 }];
  assert.deepEqual(clipLink({ x: 0, y: 0 }, { x: 300, y: 0 }, boxes), [
    [{ x: 53, y: 0 }, { x: 117, y: 0 }], [{ x: 183, y: 0 }, { x: 247, y: 0 }],
  ]);
  assert.deepEqual(clipLink({ x: 0, y: 100 }, { x: 300, y: 100 }, boxes), [[{ x: 0, y: 100 }, { x: 300, y: 100 }]]);
  assert.deepEqual(clipLink({ x: -20, y: 0 }, { x: 20, y: 0 }, boxes), []);
});

test("local expansion retains identities and evidence without mutating the source graph", () => {
  const graph: Rendered = {
    nodes: Array.from({ length: 15 }, (_, i) => ({ id: `n${i}`, kind: "node", label: `Function ${i}`, count: 1, members: [`n${i}`], displayMode: "FACT", tier: "RELEVANT", pos: { x: i * 250, y: i * 80 }, stale: false })),
    edges: [{ id: "e", from: "n0", to: "n1", label: "calls", count: 1, kind: "calls", edgeIds: ["e"], evidenceIds: ["proof"], displayMode: "FACT", stale: false }], groups: [],
  };
  const parent: LensNode = { id: "aggregate", label: "Module", x: 900, y: 800, width: 190, height: 44, color: "#60a5fa" };
  const before = structuredClone(graph), first = localChildren(parent, graph.nodes, graph.edges, { x: 300, y: 250 }, 242);
  assert.equal(first.nodes.length, 10);
  assert.equal(first.edges[0].ref, graph.edges[0]);
  assert.equal(first.nodes[0].ref, graph.nodes[0]);
  const second = localChildren(parent, graph.nodes, graph.edges, { x: 300, y: 250 }, 242, 1);
  assert.equal(second.nodes.length, 5);
  assert.equal(second.nodes[0].id, "n10");
  assert.deepEqual(graph, before);
  assert.equal(second.edges.length, 0, "no edges are fabricated across pages");
});

test("local relaxation separates focus boxes without moving context or mutating layout", () => {
  const common = { label: "Function", width: 100, height: 40, color: "#60a5fa" };
  const nodes = [{ ...common, id: "a", x: 0, y: 0, movable: true }, { ...common, id: "b", x: 20, y: 0, movable: true }, { ...common, id: "context", x: 500, y: 500 }];
  const before = structuredClone(nodes), result = relaxLensNodes(nodes, { x: 0, y: 0 }, 242);
  assert.deepEqual(result[2], nodes[2]); assert.deepEqual(nodes, before);
  assert.ok(Math.abs(result[0].x - result[1].x) >= 110 || Math.abs(result[0].y - result[1].y) >= 50);
});
