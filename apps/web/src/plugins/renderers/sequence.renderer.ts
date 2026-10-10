import type { RendererModule } from "@cie/schema";
import { render, type Rendered } from "../../graph.ts";
import { sequenceScene } from "../../sequence-layout.ts";
export const id = "sequence" as const;
export default {
  id, description: "Sequence lifelines, ordered messages and evidence-linked control fragments.",
  render(view, _level, positions, stale) {
    // Sequence semantics do not aggregate by graph zoom level or merge repeated messages.
    const base = render({ ...view, edges: [] }, 5, positions, stale);
    base.edges = view.edges.map(e => ({ id: e.id, from: e.fromNodeId, to: e.toNodeId, kind: e.kind, displayMode: e.displayMode, label: e.label ?? "", count: 1, edgeIds: [e.id], evidenceIds: [...e.evidenceIds], stale: stale.has(e.id) }));
    return { ...base, sequence: sequenceScene(view, base) };
  },
  textAlternative(view) {
    const nodes = new Map(view.nodes.map(n => [n.id,n.label])), edges = new Map(view.edges.map(e => [e.id,e]));
    return [view.caption, "Ordering inferred from static evidence; runtime timing is not established.", ...(view.sequence?.messages ?? []).slice().sort((a,b)=>a.order-b.order).flatMap(m => {
      const e = edges.get(m.edgeId); return e ? [`${m.order}. ${nodes.get(e.fromNodeId)} → ${nodes.get(e.toNodeId)}: ${e.label} (${m.kind})`] : [];
    }), ...view.gaps].join("\n");
  },
} satisfies RendererModule<typeof id, Rendered>;
