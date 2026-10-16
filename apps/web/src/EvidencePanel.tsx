import type {EvidenceTrace} from "@cie/schema";
export function EvidencePanel({trace,onOpen}:{trace:EvidenceTrace;onOpen?:(revision:string,entityId:string)=>void}){
  return <details className="evidence-panel">
    <summary>Evidence and coverage · {trace.items.length} observation(s) · partial{trace.truncated?" · limited display":""}</summary>
    <p className="muted small">Inspected evidence for revision <code>{trace.revision}</code>. Static analysis; answer review is separate.</p>
    {trace.snapshotId&&<p className="muted small">Shared evidence collection: <code>{trace.snapshotId}</code></p>}
    <p>{trace.provenance==="AVAILABLE"?"Analyzer provenance recorded for one or more observations.":"Analyzer provenance unavailable; source citations shown where available."}</p>
    <ul className="evidence-limitations">{trace.limitations.map((text,i)=><li key={i}>{text}</li>)}</ul>
    <ol>{trace.items.map(item=><li key={`${item.kind}:${item.id}`}>
      <strong>{item.label}</strong>
      <ul>{item.sources.map(source=><li key={source.evidenceId}>
        {onOpen?<button className="link" onClick={()=>onOpen(trace.revision,`file:${source.file}`)}>{source.file}</button>:<span>{source.file}</span>}
        {" · "}bytes {source.startByte}–{source.endByteExclusive}
        {source.producer?<><span> · {source.producer.id} v{source.producer.version}</span><details><summary>Producer run</summary><code>{source.producer.runId}</code></details></>:<span> · producer not recorded</span>}
      </li>)}</ul>
    </li>)}</ol>
  </details>;
}
