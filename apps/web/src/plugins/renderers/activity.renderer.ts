import { ActivitySpecSchema, type RendererModule } from "@cie/schema";
import { render, type Rendered } from "../../graph.ts";
export const id = "activity" as const;
const roles = { process: "activity-action", decision: "activity-decision", event: "activity-event", state: "activity-state", external: "activity-external" } as const;
export default {
 id, description: "Interpreted activity roles and swimlanes with source relationship kinds retained.",
 render(view, _level, positions, stale) {
  const parsed=ActivitySpecSchema.safeParse(view.activity);
  if (!parsed.success) return render(view,5,positions,stale);
  const steps=new Map(parsed.data.steps.map(s=>[s.nodeId,s]));
  const prepared={...view,nodes:view.nodes.map(n=>{const s=steps.get(n.id);return s ? {...n,role:roles[s.shape]} : n;})};
  const r=render(prepared,5,positions,stale);
  const loops=view.edges.filter(e=>e.fromNodeId===e.toNodeId&&r.nodes.some(n=>n.id===e.fromNodeId)).map(e=>({id:e.id,from:e.fromNodeId,to:e.toNodeId,kind:e.kind,displayMode:e.displayMode,label:e.label??"",count:1,edgeIds:[e.id],evidenceIds:e.evidenceIds,stale:stale.has(e.id)}));
  const byId=new Map([...r.edges,...loops].map(e=>[e.id,e])),links=new Map(parsed.data.links.map(l=>[l.edgeId,l]));
  return {...r,edges:view.edges.flatMap(e=>{const edge=byId.get(e.id),link=links.get(e.id);return edge ? [{...edge,label:link ? `${link.annotation ? `${link.annotation} · ` : ""}${link.relationshipKind} · flow?` : edge.label}] : [];})};
 },
 textAlternative(view) {
  const parsed=ActivitySpecSchema.safeParse(view.activity);
  if (!parsed.success) return [view.caption,...view.nodes.map(n=>n.label),...view.edges.map(e=>e.label),...view.gaps].join("\n");
  const names=new Map(view.nodes.map(n=>[n.id,n.label]));
  return [view.caption,"Roles, lanes and flow are inferred. Fan-out does not prove parallel execution.",...parsed.data.steps.map(s=>`${names.get(s.nodeId)??s.nodeId}: ${s.shape}? · lane ${s.lane??"unassigned"}`),...parsed.data.links.map(l=>{const e=view.edges.find(e=>e.id===l.edgeId);return `${names.get(e?.fromNodeId??"")??"unknown"} → ${names.get(e?.toNodeId??"")??"unknown"}: ${l.annotation??""} (${l.relationshipKind}; flow?)`;}),...view.gaps].join("\n");
 },
} satisfies RendererModule<typeof id, Rendered>;
