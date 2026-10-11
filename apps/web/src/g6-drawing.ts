import type { Rendered, RenderNode, RenderEdge } from "./graph.ts";
import { wrapSequenceText } from "./sequence-layout.ts";
export interface Primitive { type: "rect" | "line" | "text" | "path"; style: Record<string, unknown> }
export interface Drawing { size: [number, number]; shapes: Primitive[] }
const text = (value: string, x: number, y: number, extra = {}): Primitive => ({ type: "text", style: { text: value, x, y, fill: "#e5e7eb", fontSize: 12, fontFamily: "ui-monospace, monospace", textBaseline: "top", ...extra } });
const line = (x1: number, y1: number, x2: number, y2: number, extra = {}): Primitive => ({ type: "line", style: { x1, y1, x2, y2, stroke: "#94a3b8", lineWidth: 1, ...extra } });
const rect = (x: number, y: number, width: number, height: number, extra = {}): Primitive => ({ type: "rect", style: { x, y, width, height, fill: "#111827", stroke: "#475569", ...extra } });
function graphic(id: string, label: string, pos: {x:number;y:number}, drawing: Drawing, original?: RenderNode): RenderNode {
  return { ...(original ?? { kind: "node", members: [], count: 1, displayMode: "INFERENCE", tier: "RELEVANT", stale: false }), id, label, pos, drawing, decorative: !original } as RenderNode;
}
function backgroundNode(id:string,label:string,width:number,height:number,shapes:Primitive[]) {
  const x=width/2,y=height/2;
  const local=shapes.map(shape=>{const style={...shape.style};for(const key of ["x","x1","x2"])if(typeof style[key]==="number")style[key]=(style[key] as number)-x;for(const key of ["y","y1","y2"])if(typeof style[key]==="number")style[key]=(style[key] as number)-y;return {...shape,style};});
  return graphic(id,label,{x,y},{size:[width,height],shapes:local});
}
export interface TimelinePresentation { rendered: Rendered; nodes: Map<string, RenderNode>; messages: Map<string, RenderEdge> }
/** Fixed geometry is authoritative: topology layout must never replace time or order. */
export function timelinePresentation(source: Rendered): TimelinePresentation {
  const nodes: RenderNode[] = [], bindings = new Map<string, RenderNode>(), messages = new Map<string, RenderEdge>();
  if (source.sequence) {
    const s = source.sequence, background: Primitive[] = [];
    for (const f of s.fragments) { background.push(rect(20, f.y, s.width - 40, f.height, { fillOpacity: .12, lineDash: [4, 3] }), text(f.label, 30, f.y + 8)); }
    for (const p of s.participants) background.push(line(p.x, 14 + s.headerHeight, p.x, s.height - 20, { lineDash: [6, 4] }));
    nodes.push(backgroundNode("g6:sequence-background", "Sequence lifelines and fragments", s.width, s.height, background));
    for (const p of s.participants) { const n = { ...p.node, pos: {x:p.x,y:14+s.headerHeight/2}, drawing: { size: [200,s.headerHeight] as [number,number], shapes: [rect(-100,-s.headerHeight/2,200,s.headerHeight,{stroke:"#60a5fa",radius:6}), text(wrapSequenceText(p.node.label,25).join("\n"),0,-s.headerHeight/2+12,{textAlign:"center",lineHeight:16})] } }; nodes.push(n); bindings.set(n.id,p.node); }
    for (const m of s.messages) {
      const self = m.x1 === m.x2, left = Math.min(m.x1,m.x2), width = self ? 320 : Math.max(100,Math.abs(m.x2-m.x1)), x = self ? m.x1+160 : (m.x1+m.x2)/2;
      const label = wrapSequenceText(`${m.order}. ${m.edge.label}`), height = label.length*16+36+(self?28:0), y=m.y-height/2+28;
      const dx1=m.x1-x,dx2=m.x2-x,dy=m.y-y;
      const shapes: Primitive[] = [text(label.join("\n"),self?dx1+70:0,dy-14-label.length*16,{textAlign:self?"left":"center",lineHeight:16})];
      const color = m.edge.displayMode === "FACT" ? "#94a3b8" : "#a78bfa";
      if (self) shapes.push({type:"path",style:{d:[["M",dx1,dy],["L",dx1+55,dy],["L",dx1+55,dy+28],["L",dx1,dy+28]],stroke:color,lineWidth:2,fill:"none"}});
      else shapes.push(line(dx1,dy,dx2,dy,{stroke:color,lineWidth:2,lineDash:m.kind==="sync"?[]:[6,4]}));
      const targetX=self?dx1:dx2,targetY=self?dy+28:dy,dir=self?-1:Math.sign(dx2-dx1);
      shapes.push({type:"path",style:{d:[["M",targetX-dir*10,targetY-5],["L",targetX,targetY],["L",targetX-dir*10,targetY+5],...(m.kind==="sync"||self?[["Z"]]:[])],fill:m.kind==="sync"||self?color:"none",stroke:color,lineWidth:2}});
      const ref = { ...s.participants.find(p=>p.node.id===m.edge.from)!.node, node: { ...s.participants.find(p=>p.node.id===m.edge.from)!.node.node!, notes:[`${m.order}. ${m.edge.label}`,`${m.kind}; order inferred from the static plan`,`${m.edge.evidenceIds.length} evidence links`] } };
      const n=graphic(m.edge.id,`${m.order}. ${m.edge.label}`,{x,y},{size:[width,height],shapes},ref);n.members=[];nodes.push(n);messages.set(n.id,m.edge);
    }
  } else if (source.race) {
    const s=source.race, background: Primitive[] = [text(`Replay · ${s.rows.length} sampled requests · simulated-model time`,12,-18)];
    for (const t of [0,.25,.5,.75,1]) { const x=s.plotX+t*s.plotW;background.push(line(x,s.headerHeight-6,x,s.headerHeight+s.rows.length*s.rowHeight,{opacity:.2}),text(`${Math.round(t*s.timeMaxMs)}ms`,x,s.headerHeight-18,{fontSize:10,textAlign:"center"})); }
    for (const r of s.rows) background.push(text(`${r.requestId} · ${r.outcome}${r.retries?` · ${r.retries}r`:""}`,8,r.y,{fontSize:10,fill:r.outcome==="SUCCESS"?"#4ade80":"#fb7185"}));
    nodes.push(backgroundNode("g6:race-background","Simulated time axis",s.width,s.height,background));
    for (const station of s.stations) { const n=graphic(station.node.id,station.node.label,{x:67+station.index*118,y:-40},{size:[110,26],shapes:[rect(-55,-13,110,26,{fill:`hsl(${station.hue} 45% 25%)`}),text(station.id,0,-8,{textAlign:"center",fontSize:10})]},station.node);nodes.push(n);bindings.set(n.id,station.node); }
    s.blocks.forEach((b,i)=>{ const station=s.stations.find(st=>st.id===b.stationId);if(!station)return;
      const left=Math.min(b.x,b.waitX),width=b.x+b.w-left,x=left+width/2,y=b.y+b.h/2,shapes:Primitive[]=[];
      if(b.waitW>2) { shapes.push(rect(b.waitX-x,-b.h/2,b.waitW,b.h,{fill:"#475569",fillOpacity:.3,lineDash:[2,2]})); for(let hx=b.waitX;hx<b.x;hx+=6)shapes.push(line(hx-x,-b.h/2,Math.min(hx+4,b.x)-x,b.h/2,{opacity:.4})); }
      shapes.push(rect(b.x-x,-b.h/2,b.w,b.h,{fill:b.event==="SERVICE"?`hsl(${station.hue} 55% 62%)`:"#fb7185",radius:2}));
      const row=s.rows.find(r=>r.requestId===b.requestId)!;
      const ref={...station.node,node:{...station.node.node!,notes:[`${b.requestId} · ${b.stationId} · ${b.event}`,`Outcome ${b.outcome}; latency ${Math.round(row.latencyMs)}ms; attempt ${b.attempt+1}`,`Wait ${Math.round(b.waitW*s.timeMaxMs/s.plotW)}ms; service window ${Math.round(b.w*s.timeMaxMs/s.plotW)}ms`,"Simulated-model time — not a production measurement."]}};
      const n=graphic(`g6:race-block:${i}`,`${b.requestId} · ${b.stationId}`,{x,y},{size:[Math.max(2,width),b.h],shapes},ref);nodes.push(n);bindings.set(n.id,station.node);
    });
  }
  return {rendered:{nodes,edges:[],groups:[]},nodes:bindings,messages};
}
