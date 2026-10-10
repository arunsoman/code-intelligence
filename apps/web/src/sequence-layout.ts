export function wrapSequenceText(text: string, limit = 34): string[] {
  const lines: string[] = [];
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    for (let start = 0; start < word.length; start += limit) {
      const part = word.slice(start, start + limit), last = lines.at(-1);
      if (last && last.length + part.length + 1 <= limit) lines[lines.length - 1] = `${last} ${part}`;
      else lines.push(part);
    }
  }
  return lines.length ? lines : [""];
}
import { SequenceSpecSchema, type ViewSpec } from "@cie/schema";
import type { Rendered, RenderEdge, RenderNode } from "./graph.ts";
export interface SequenceScene {
  width: number; height: number; headerHeight: number; participants: { node: RenderNode; x: number }[];
  messages: { edge: RenderEdge; order: number; kind: "sync" | "async" | "return" | "self"; y: number; x1: number; x2: number; fragmentId?: string }[];
  fragments: { id: string; label: string; y: number; height: number; evidenceIds: string[] }[];
}
export function sequenceScene(view: ViewSpec, rendered: Rendered): SequenceScene | undefined {
  const parsed = SequenceSpecSchema.safeParse(view.sequence);
  if (!parsed.success) return;
  const spec = parsed.data, byNode = new Map(rendered.nodes.map(n => [n.id, n]));
  const participants = spec.participantIds.flatMap((id,i) => byNode.has(id) ? [{ node: byNode.get(id)!, x: 140 + i * 260 }] : []);
  const byX = new Map(participants.map(p => [p.node.id,p.x]));
  const byEdge = new Map(rendered.edges.map(e => [e.id,e]));
  const messages = [...spec.messages].sort((a,b) => a.order - b.order).flatMap(m => {
    const edge = byEdge.get(m.edgeId); if (!edge || !byX.has(edge.from) || !byX.has(edge.to)) return [];
    return [{ ...m, edge, y: 0, x1: byX.get(edge.from)!, x2: byX.get(edge.to)! }];
  });
  const headerHeight = Math.max(52,...participants.map(p => wrapSequenceText(p.node.label,25).length * 16 + 22));
  let y = headerHeight + 50;
  for (const m of messages) { const labelHeight = wrapSequenceText(`${m.order}. ${m.edge.label}`).length * 16; m.y = y + Math.max(36,labelHeight + 16); y = m.y + 48 + (m.x1 === m.x2 ? 28 : 0); }
  const fragments = spec.fragments.flatMap(f => {
    const rows = messages.filter(m => m.fragmentId === f.id); if (!rows.length) return [];
    const runs: typeof rows[] = [];
    for (const row of rows) {
      const last = runs.at(-1);
      if (last && messages.indexOf(row) === messages.indexOf(last.at(-1)!) + 1) last.push(row); else runs.push([row]);
    }
    return runs.map(run => ({ id: f.id, label: [f.kind === "par" ? "parallel (inferred; rows show display order)" : f.kind, f.condition].filter(Boolean).join(": "), y: run[0].y - 38, height: run.at(-1)!.y - run[0].y + 76, evidenceIds: f.evidenceIds }));
  });
  return { width: Math.max(540, participants.length * 260 + 80, ...messages.filter(m => m.x1 === m.x2).map(m => m.x1 + 350)), height: Math.max(240,y + 30), headerHeight, participants, messages, fragments };
}
