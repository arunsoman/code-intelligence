import { useState } from "react";
import { EXPLORATION_CONCERNS, type ExplorationChoice, type ExplorationTarget } from "./exploration-choices.ts";
export function ExplorationPanel(p:{ target?: ExplorationTarget; choices: ExplorationChoice[]; onExplore:(choice:ExplorationChoice)=>void; onSource:()=>void; onOther:()=>void }) {
 const [all,setAll]=useState(false);
 const visible=all ? p.choices : p.choices.filter(c=>c.recommended);
 if (!p.target) return <p>Select source-backed elements or a relationship with source-backed endpoints. Unbound diagram elements cannot establish an exploration scope.</p>;
 return <section className="exploration-panel" aria-label="Choose an exploration perspective">
  <strong>{p.target.label}</strong><p className="muted small">{p.target.source==="flow" ? "Explore this flow through its source-backed endpoints." : `Explore ${p.target.entityRefs.length} source ${p.target.entityRefs.length===1 ? "entity" : "entities"}.`} Each view checks evidence for this scope during generation. You can also type “explore” followed by a view’s name in chat.</p>
  {p.target.limitation && <p className="small">{p.target.limitation}</p>}
  <button className="link small" aria-pressed={all} onClick={()=>setAll(!all)}>{all ? "Show recommended views" : "Show all perspectives"}</button>
  <div className="exploration-groups">{EXPLORATION_CONCERNS.map(concern=>{const choices=visible.filter(c=>c.concern===concern);return choices.length ? <fieldset key={concern}><legend>{concern}</legend>{choices.map(c=><div className="exploration-option" key={c.code}><button className="secondary small" disabled={c.disabled} aria-describedby={`exploration-${c.code}`} onClick={()=>p.onExplore(c)}>{c.label}</button><p className="small">{c.questionAnswered}</p><p className="muted small" id={`exploration-${c.code}`}>{c.reason}</p></div>)}</fieldset> : null;})}</div>
  <div className="exploration-actions"><button className="secondary small" disabled={p.target.source!=="element" || p.target.entityRefs.length!==1} onClick={p.onSource}>Open source</button><button className="link small" onClick={p.onOther}>Ask something else…</button></div>
 </section>;
}
