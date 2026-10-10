import { StateSpecSchema, stateTransitionLabel, type RendererModule } from "@cie/schema";
import { render, type Rendered } from "../../graph.ts";
export const id = "state" as const;
export default {
  id, description: "Lifecycle states, guarded transitions, replay and explicitly uncertain forbidden paths.",
  render(view, _level, positions, stale) {
    const parsed = StateSpecSchema.safeParse(view.state);
    if (!parsed.success) return render(view, 5, positions, stale);
    const states = new Map(parsed.data.states.map(s => [s.nodeId,s]));
    const prepared = { ...view, nodes: view.nodes.map(n => { const s=states.get(n.id); return s ? { ...n, role: s.final ? "lifecycle-final" : s.initial ? "lifecycle-initial" : "lifecycle-state", label: `${n.label}${s.initial ? " · initial?" : ""}${s.final ? " · final?" : ""}` } : n; }) };
    const transitions = new Map(parsed.data.transitions.map(t => [t.edgeId,t]));
    const r = render(prepared, 5, positions, stale);
    const loops = view.edges.filter(e => e.fromNodeId === e.toNodeId && r.nodes.some(n => n.id === e.fromNodeId)).map(e => ({ id: e.id, kind: e.kind, from: e.fromNodeId, to: e.toNodeId, displayMode: e.displayMode, label: e.label ?? "", count: 1, edgeIds: [e.id], evidenceIds: e.evidenceIds, stale: stale.has(e.id) }));
    const byId = new Map([...r.edges,...loops].map(e => [e.id,e]));
    const ordered = view.edges.flatMap(e => { const rendered=byId.get(e.id); return rendered ? [rendered] : []; });
    return { ...r, edges: ordered.map(e => { const t=transitions.get(e.id); return t ? { ...e, label: stateTransitionLabel(t), kind: t.forbidden ? "forbidden-transition" : t.replay ? "replay-transition" : "transition" } : e; }) };
  },
  textAlternative(view) {
    const parsed=StateSpecSchema.safeParse(view.state);
    if (!parsed.success) return [view.caption,...view.nodes.map(n=>n.label),...view.edges.map(e=>e.label),...view.gaps].join("\n");
    const names=new Map(view.nodes.map(n=>[n.id,n.label]));
    return [view.caption,"? denotes a plan interpretation; an absent path is unknown, not forbidden.",...parsed.data.states.map(s=>`${names.get(s.nodeId) ?? s.nodeId}${s.initial ? " · initial?" : ""}${s.final ? " · final?" : ""}`),...parsed.data.transitions.map(t=>{const e=view.edges.find(e=>e.id===t.edgeId);return `${names.get(e?.fromNodeId ?? "") ?? "unknown"} → ${names.get(e?.toNodeId ?? "") ?? "unknown"}: ${stateTransitionLabel(t)}`;}),...view.gaps].join("\n");
  },
} satisfies RendererModule<typeof id, Rendered>;
