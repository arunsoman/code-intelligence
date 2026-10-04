// F09 — adapters from the existing graph.ts Rendered output to the new RenderedLevel type.
// Kept separate from detail.ts to avoid a circular dependency: graph.ts → legibility.ts → detail.ts.

import type { Rendered } from "./graph.ts";
import { detailPolicyFor, type DetailPolicy, type LabelClass, type RenderedBox, type RenderedLevel } from "./detail.ts";

/** Build a RenderedLevel from the graph.ts Rendered output, using policy label classes for font units. */
export function renderedLevelFromGraph(rendered: Rendered, level: number, policy: DetailPolicy): RenderedLevel {
  const levelDef = policy.levels.find((l) => l.n === level);
  const nodeFont = levelDef?.labelClasses.NODE_NAME?.fontUnits ?? 11;
  const nodes = rendered.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    members: n.members,
    x: n.pos.x,
    y: n.pos.y,
    width: n.node?.role === "symbol" ? 150 : 190,
    height: n.node?.role === "symbol" ? 28 : 44,
    labelClass: "NODE_NAME" as LabelClass,
  }));
  const edges = rendered.edges.map((e) => ({
    id: e.id,
    label: e.label,
    from: e.from,
    to: e.to,
    labelClass: "EDGE_RELATION" as LabelClass,
  }));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const widths = nodes.map((n) => n.width), heights = nodes.map((n) => n.height);
  const bbox: RenderedBox = {
    x1: Math.min(...xs.map((x, i) => x - widths[i] / 2)),
    y1: Math.min(...ys.map((y, i) => y - heights[i] / 2)),
    x2: Math.max(...xs.map((x, i) => x + widths[i] / 2)),
    y2: Math.max(...ys.map((y, i) => y + heights[i] / 2)),
  };
  return {
    level,
    nodes,
    edges,
    membership: new Map(nodes.map((n) => [n.id, n.members])),
    bbox,
    labelStats: [{ class: "NODE_NAME", count: nodes.length, fontUnits: nodeFont, maxTextWidthUnits: 136 }],
    caveats: [],
  };
}

/** Convenience: build a level from a Rendered object using the policy for `view.formId`. */
export function renderedLevelFor(rendered: Rendered, view: { formId: string }, level: number): RenderedLevel {
  const policy = detailPolicyFor(view.formId as Parameters<typeof detailPolicyFor>[0]);
  return renderedLevelFromGraph(rendered, level, policy);
}
