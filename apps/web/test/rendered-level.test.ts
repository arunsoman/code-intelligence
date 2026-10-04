// F09 adapter tests: graph.ts Rendered → RenderedLevel.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderedLevelFor } from "../src/rendered-level.ts";

test("renderedLevelFor builds a RenderedLevel from a graph.ts Rendered object", () => {
  const rendered = {
    nodes: [
      { id: "a", label: "A", kind: "node" as const, members: ["e1"], count: 1, displayMode: "FACT" as const, tier: "RELEVANT" as const, pos: { x: 100, y: 100 }, node: { role: "symbol" } as never, stale: false },
      { id: "b", label: "B", kind: "agg" as const, members: ["e2", "e3"], count: 2, displayMode: "FACT" as const, tier: "CONTEXT" as const, pos: { x: 300, y: 200 }, stale: false },
    ],
    edges: [{ id: "e1", from: "a", to: "b", displayMode: "FACT" as const, label: "calls", count: 1, edgeIds: [], evidenceIds: [], stale: false }],
    groups: [],
  };
  const level = renderedLevelFor(rendered, { formId: "SemanticMap" }, 5);
  assert.equal(level.level, 5);
  assert.equal(level.nodes.length, 2);
  assert.equal(level.edges.length, 1);
  assert.equal(level.labelStats[0].fontUnits, 11);
  assert.ok(level.bbox.x2 > level.bbox.x1);
  assert.ok(level.bbox.y2 > level.bbox.y1);
});
