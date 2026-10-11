import { test } from "node:test";
import assert from "node:assert/strict";
import { g6Data, g6Layout, usesG6 } from "../src/g6-adapter.ts";
import type { Rendered } from "../src/graph.ts";

const scene: Rendered = { nodes: ["a", "b"].map((id, i) => ({ id, label: `Function ${id}`, kind: "node", members: [id], count: 1, displayMode: "FACT", tier: "RELEVANT", pos: { x: i * 100, y: 0 }, stale: false, evidenceIds: [`e-${id}`], parent: "module" })), groups: [{ id: "module", label: "Module", kind: "file" }], edges: [{ id: "call", from: "a", to: "b", kind: "call", displayMode: "FACT", label: "calls", count: 1, edgeIds: ["indexed-call"], evidenceIds: ["call-site"], stale: false }] };
test("G6 adapter preserves entity and relationship identity without modifying source evidence", () => {
  const before = structuredClone(scene), data = g6Data(scene);
  assert.deepEqual(scene, before);
  assert.deepEqual(data.nodes?.map(n => n.id), ["a", "b"]);
  assert.equal(data.nodes?.[0].combo, "module");
  assert.deepEqual(data.edges?.map(e => [e.id, e.source, e.target]), [["call", "a", "b"]]);
  assert.equal(scene.edges[0].evidenceIds[0], "call-site");
  assert.equal(g6Data({ ...scene, edges: [{ ...scene.edges[0], to: "missing" }] }).edges?.length, 0);
});
test("G6 migration and layout are explicit and content aware", () => {
  assert.equal(usesG6("S21"), true); assert.equal(usesG6("S23"), true);
  assert.equal(usesG6("S17"), true); assert.equal(usesG6("S18"), true);
  assert.equal(usesG6("S1"), true); assert.equal(usesG6("S16"), true);
  for (const id of ["S28", "generic", undefined]) assert.equal(usesG6(id), true);
  assert.equal((g6Layout(scene, 1000, 500) as { rankdir: string }).rankdir, "LR");
  assert.equal((g6Layout(scene, 500, 1000) as { rankdir: string }).rankdir, "TB");
  assert.equal((g6Layout({ ...scene, edges: [], groups: [] }, 800, 500) as { type: string }).type, "grid");
});
