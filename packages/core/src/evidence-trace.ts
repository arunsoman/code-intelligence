import type {EvidenceBundle,EvidenceRef,EvidenceTrace,ViewSpec} from "@cie/schema";
import type {Store} from "./store.ts";
import {policyFor} from "./access.ts";
import {bundleFor} from "./retrieval.ts";
/** Bounded, current-source and access-filtered. Metadata never upgrades a claim. */
export function traceBundle(store:Store,bundle:EvidenceBundle,resolve:(e:EvidenceRef)=>{state:string}):EvidenceTrace {
  const trace:EvidenceTrace={version:"evidence-trace.v1",revision:bundle.revision,provenance:"UNAVAILABLE",coverage:"PARTIAL",truncated:false,items:[],limitations:["Inspected static evidence is a bounded selection. Missing links do not establish absence or runtime behavior."]};
  const rev=store.revision(bundle.revision);if(!rev)return trace;
  const access=policyFor(store,rev.repoRoot),entities=new Map(bundle.entities.filter(e=>!access.denied(e.file)).map(e=>[e.entityId,e]));
  const checked=new Map<string,boolean>();
  const runs=new Map<string,ReturnType<Store["evidenceCoreProducerRuns"]>>();
  const coverage=new Map<string,ReturnType<Store["evidenceCoreCoverage"]>>(),exclusions=new Set<string>();
  const rows=[...bundle.facts.map(f=>({kind:"FACT" as const,id:f.id,label:f.predicate,ids:[f.subject],evidence:f.evidence})),
    ...bundle.relationships.map(r=>({kind:"RELATIONSHIP" as const,id:r.id,label:r.kind,ids:[r.from,r.to],evidence:r.evidence}))];
  for(const row of rows){
    if(!row.ids.every(id=>entities.has(id)))continue;
    if(trace.items.length>=40){trace.truncated=true;break;}
    const sources:EvidenceTrace["items"][number]["sources"]=[];
    const owner=entities.get(row.ids[0])!;
    const candidates=row.evidence.filter(ev=>ev.state==="CURRENT"&&["STATIC_PARSED","STATIC_RESOLVED"].includes(ev.class)&&ev.location.kind==="CodeLocation"&&!access.denied(ev.sourceId));
    if(!candidates.length)continue;
    const links=store.evidenceCoreLinks(bundle.revision,row.kind,row.id);
    if(!runs.has(owner.file)){
      runs.set(owner.file,store.evidenceCoreProducerRuns(bundle.revision,owner.file));
      coverage.set(owner.file,store.evidenceCoreCoverage(bundle.revision,"static.observations",owner.file));
    }
    for(const ev of candidates){
      if(sources.length>=2){trace.truncated=true;break;}
      const span=(ev.location as {span?:{sourceId:string;revision:string;contentHash:string;startByte:number;endByteExclusive:number}}).span;
      if(!span||span.sourceId!==ev.sourceId||span.revision!==bundle.revision)continue;
      const key=JSON.stringify([span.sourceId,span.contentHash]);
      if(!checked.has(key)){try{checked.set(key,resolve(ev).state==="CURRENT");}catch{checked.set(key,false);}}
      if(!checked.get(key))continue;
      const link=links.find(l=>l.evidenceId===ev.id&&l.role==="SUPPORTS");
      const run=link&&runs.get(owner.file)?.find(r=>r.id===link.producerRunId&&r.revision===bundle.revision&&r.status==="PARTIAL"&&r.scope.kind==="FILE"&&r.scope.file===owner.file&&coverage.get(owner.file)?.some(c=>c.producerRunId===r.id&&c.status==="PARTIAL"&&c.revision===bundle.revision));
      sources.push({evidenceId:ev.id,file:ev.sourceId,startByte:span.startByte,endByteExclusive:span.endByteExclusive,
        ...(run?{producer:{id:run.producerId,version:run.producerVersion,runId:run.id}}:{})});
      if(run){trace.provenance="AVAILABLE";for(const c of coverage.get(owner.file)??[])if(c.producerRunId===run.id)for(const exclusion of c.exclusions)exclusions.add(exclusion);}
    }
    if(sources.length)trace.items.push({kind:row.kind,id:row.id,label:`${owner.name} · ${row.label}`,entityIds:row.ids,sources});
  }
  if(trace.provenance==="UNAVAILABLE")trace.limitations.push("Analyzer provenance is unavailable for this selection. Indexed source citations can still be shown; re-index with provenance enabled to record producer trails.");
  else trace.limitations.push("Analyzer provenance records where indexed observations came from. It does not prove the answer, runtime execution, or complete coverage.");
  if(exclusions.size)trace.limitations.push(`Analyzer exclusions: ${[...exclusions].slice(0,8).join(", ")}.`);
  if(!trace.items.length)trace.limitations.push("No current static source links are available for this selection. Changed source may need re-indexing.");
  if(trace.truncated)trace.limitations.push("Evidence display capped at 40 observations and two source links per observation.");
  return trace;
}
export function traceEntities(store:Store,revision:string,ids:string[],resolve:(e:EvidenceRef)=>{state:string}):EvidenceTrace {
  const chosen=[...new Set(ids)].slice(0,80),trace=traceBundle(store,bundleFor(store,revision,chosen),resolve);
  if(ids.length>80){trace.truncated=true;trace.limitations.push("Evidence display limited to 80 selected elements.");}return trace;
}
export function viewEvidence(store:Store,view:ViewSpec,resolve:(e:EvidenceRef)=>{state:string}):void {
  const snapshot=view.evidenceProjection?.snapshotId&&store.evidenceSnapshot(view.evidenceProjection.snapshotId);
  if(snapshot&&snapshot.revision===view.revision){view.evidenceTrace={...traceBundle(store,snapshot.bundle,resolve),snapshotId:snapshot.id};return;}
  const ids=[...view.nodes.flatMap(n=>n.entityRefs),...(view.matrix?[...view.matrix.rows,...view.matrix.cols].flatMap(a=>a.entityRefs):[])];
  view.evidenceTrace=traceEntities(store,view.revision,ids,resolve);
}
