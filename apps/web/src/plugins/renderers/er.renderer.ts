import { ErSpecSchema, erColumnLabel, type RendererModule } from "@cie/schema";
import { render, type Rendered } from "../../graph.ts";
export const id = "er" as const;
export default {
  id, description: "Entity cards with current-evidence columns and explicit uncertain cardinalities.",
  render(view, _level, positions, stale) {
    const parsed = ErSpecSchema.safeParse(view.er);
    if (!parsed.success) return render(view,5,positions,stale);
    const columns = new Map(parsed.data.tables.map(t => [t.nodeId,t.columns]));
    const prepared = { ...view, nodes: view.nodes.map(n => columns.has(n.id) ? { ...n, role: "er-entity", notes: columns.get(n.id)!.map(erColumnLabel) } : n) };
    const r = render(prepared,5,positions,stale), relations = new Map(parsed.data.relationships.map(rel => [rel.edgeId,rel]));
    return { ...r, edges: r.edges.map(e => { const rel=relations.get(e.id); const [a,b]=(rel?.cardinality ?? "").split(":"); return rel ? { ...e, sourceLabel: `${a}?`, targetLabel: `${b}?`, kind: e.displayMode === "FACT" ? "er-declared" : "er-inferred" } : e; }) };
  },
  textAlternative(view) {
    return [view.caption,"? means a plan interpretation, not a verified constraint.",...(view.er?.tables ?? []).flatMap(t => [view.nodes.find(n=>n.id===t.nodeId)?.label ?? t.nodeId,...t.columns.map(erColumnLabel)]),...view.edges.map(e=>`${view.nodes.find(n=>n.id===e.fromNodeId)?.label} → ${view.nodes.find(n=>n.id===e.toNodeId)?.label}: ${e.label}`),...view.gaps].join("\n");
  },
} satisfies RendererModule<typeof id, Rendered>;
