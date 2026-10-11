import { useMemo, useState } from "react";
import type { CanvasProps } from "./Canvas.tsx";
import { G6Canvas } from "./G6Canvas.tsx";
import { timelinePresentation } from "./g6-drawing.ts";
export function G6TimelineCanvas(p: CanvasProps) {
  const presentation=useMemo(()=>timelinePresentation(p.rendered),[p.rendered]),[table,setTable]=useState(false);
  const inspect=(id:string)=>{const message=presentation.messages.get(id),node=presentation.nodes.get(id);if(message)p.onTapEdge(message);else if(node)p.onTapNode(node);};
  return <><G6Canvas {...p} rendered={presentation.rendered} onTapNode={n=>inspect(n.id)}
    selected={new Set(presentation.rendered.nodes.filter(n=>p.selected.has(presentation.nodes.get(n.id)?.id??n.id)).map(n=>n.id))}
    onToggleNode={n=>{const original=presentation.nodes.get(n.id);if(original)p.onToggleNode(original);}}
    onSelectNodes={ids=>p.onSelectNodes([...new Set(ids.flatMap(id=>presentation.nodes.has(id)?[presentation.nodes.get(id)!.id]:[]))])}/>
    <div className="sequence-notice">{p.rendered.sequence?"Time ↓ · inferred order":"Simulated-model time · not production measurements"} <button className="secondary small" aria-expanded={table} onClick={()=>setTable(!table)}>{p.rendered.sequence?"Message table":"Table view"}</button></div>
    {table&&<section className="sequence-table" aria-label={p.rendered.sequence?"Sequence messages as a table":"Replay requests as a table"}><button onClick={()=>setTable(false)}>Close table</button><table>
      {p.rendered.sequence?<><caption>Message order is inferred from the static plan.</caption><thead><tr>{["Order","From","To","Message","Kind","Evidence"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{p.rendered.sequence.messages.map(m=><tr key={m.edge.id}><td>{m.order}</td><td>{p.rendered.nodes.find(n=>n.id===m.edge.from)?.label}</td><td>{p.rendered.nodes.find(n=>n.id===m.edge.to)?.label}</td><td>{m.edge.label}</td><td>{m.kind}</td><td><button onClick={()=>p.onTapEdge(m.edge)}>Inspect evidence for message {m.order}</button></td></tr>)}</tbody></>:
      <><caption>Deterministic model run, not production timing.</caption><thead><tr>{["Request","Outcome","Latency","Retries","Stations"].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{p.rendered.race!.rows.map(r=><tr key={r.requestId}><td>{r.requestId}</td><td>{r.outcome}</td><td>{Math.round(r.latencyMs)} ms</td><td>{r.retries}</td><td>{p.rendered.race!.blocks.filter(b=>b.requestId===r.requestId).map((b,i)=><button key={i} onClick={()=>{const station=p.rendered.race!.stations.find(s=>s.id===b.stationId);if(station)p.onTapNode(station.node);}}>{b.stationId} · {b.event}</button>)}</td></tr>)}</tbody></>}
    </table></section>}
  </>;
}
