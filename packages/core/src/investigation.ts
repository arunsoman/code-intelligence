import type { Entity, EvidenceRef, InvestigationBudget, InvestigationReport, Relationship, ResolvedEvidence } from "@cie/schema";
import type { AccessPolicy } from "./access.ts";
import type { Store } from "./store.ts";
import { sourceRecovery } from "./source-recovery.ts";

export const INVESTIGATION_BUDGET: InvestigationBudget = {maxEntities:64,maxDepth:3,maxSourceFiles:8,maxSourceBytes:128_000,maxMs:1500};
const words = (value:string): string[] => value.replace(/([a-z\d])([A-Z])/g,"$1 $2").toLowerCase().match(/[a-z][a-z0-9]+/g) ?? [];
const generic = new Set("show explain describe diagram chart flow call calls function functions component components sequence order interaction interactions how does the this that what generate generated generation work works between of in and to from a an for please me all complete exact system repository code pipeline".split(" "));

export function bindSubjects(entities:Entity[],question:string,subject?:string,seeds:string[]=[]):InvestigationReport["binding"] {
  const visible = new Set(entities.map(e=>e.entityId));
  const explicit = [...new Set(seeds.filter(id=>visible.has(id)))];
  if (explicit.length) return {status:"bound",roots:explicit,candidates:explicit};
  // Bind explicit compound identifiers mentioned in a longer question before treating its prose as a search phrase.
  if (!subject) {
    const tokens = new Set((question.toLowerCase().match(/[a-z_$][a-z0-9_$]*/g) ?? []));
    const qualified = new Set((question.toLowerCase().match(/[a-z_$][a-z0-9_$]*(?:\.[a-z_$][a-z0-9_$]*)*/g) ?? []));
    const qualifiedMembers = entities.filter(e => e.name.includes(".") && qualified.has(e.name.toLowerCase()));
    const named = entities.filter(e => !qualifiedMembers.some(member => member.name.startsWith(e.name + ".")) && ["function","method","class"].includes(e.kind) && ((/[a-z][A-Z]|[_$]/.test(e.name.split(/[.#]/).at(-1)!) && tokens.has(e.name.split(/[.#]/).at(-1)!.toLowerCase())) || e.name.includes(".") && qualified.has(e.name.toLowerCase())));
    if (named.length) {
      const names = new Map<string,Entity[]>();
      for (const e of named) { const name=e.name.split(/[.#]/).at(-1)!.toLowerCase(); names.set(name,[...(names.get(name)??[]),e]); }
      const candidates=named.map(e=>e.entityId);
      return [...names.values()].some(matches=>matches.length>1) ? {status:"ambiguous",roots:[],candidates:candidates.slice(0,8)} : {status:"bound",roots:candidates,candidates};
    }
  }
  const wanted = words(subject || question).filter(w=>!generic.has(w));
  if (!wanted.length) return {status:"unbound",roots:[],candidates:[]};
  const compact = wanted.join("");
  const ranked = entities.filter(e=>["function","method","class","module","package"].includes(e.kind)).map(e=>{
    const name = words(e.name), file = words(e.file);
    const symbol = name.join("");
    const score = symbol === compact ? 120 : name.length && wanted.every(w=>name.includes(w)) ? 100 : wanted.every(w=>file.includes(w)) ? 60 : 0;
    return {id:e.entityId,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score || a.id.localeCompare(b.id));
  if (!ranked.length) return {status:"unbound",roots:[],candidates:[]};
  const best = ranked.filter(x=>x.score===ranked[0]!.score).map(x=>x.id);
  return best.length===1 ? {status:"bound",roots:best,candidates:best} : {status:"ambiguous",roots:[],candidates:best.slice(0,8)};
}

export function investigate(store:Store,revision:string,question:string,options:{subject?:string;seeds?:string[];access:AccessPolicy;resolveEvidence?:(ev:EvidenceRef)=>ResolvedEvidence;budget?:Partial<InvestigationBudget>}) {
  const started=performance.now(), budget={...INVESTIGATION_BUDGET,...options.budget};
  const until=started+budget.maxMs;
  const entities=store.entities(revision).filter(e=>!options.access.denied(e.file) && !options.access.deniedEntity(e.entityId));
  const byId=new Map(entities.map(e=>[e.entityId,e]));
  const binding=bindSubjects(entities,question,options.subject,options.seeds);
  const bindingMs=performance.now()-started;
  const report:InvestigationReport={version:"investigation.v1",revision,goal:/\b(flow|calls?|sequence|order|interaction|work|works)\b/i.test(question)?"flow":"structure",binding,
    outcome:binding.status==="bound"?"supported":binding.status,scope:"bounded static neighborhood",budget,
    counts:{entities:0,indexedRelationships:0,recoveredRelationships:0,sourceFiles:0,sourceBytes:0,unresolvedCalls:0},timings:{bindingMs,investigationMs:0},gaps:[]};
  if (binding.status!=="bound") report.gaps.push({code:binding.status==="ambiguous"?"SUBJECT_AMBIGUOUS":"SUBJECT_UNBOUND",message:binding.status==="ambiguous"?"Several source subjects match; select the intended entry point before claiming a complete flow.":"No source subject was bound; the broader retrieved context does not establish the requested flow."});
  const seen=new Set<string>(), contextOnly=new Set<string>(), depths=new Map<string,number>(), relationships=new Map<string,Relationship>();
  const queue=binding.roots.slice(0,budget.maxEntities).map(id=>({id,depth:0}));
  if(binding.roots.length>budget.maxEntities) report.gaps.push({code:"BUDGET_EXHAUSTED",message:"Subject count exceeds the investigation entity budget."});
  const current = (r:Relationship) => r.evidence.filter(ev=>ev.state==="CURRENT" && (!options.resolveEvidence || options.resolveEvidence(ev).state==="CURRENT"));
  while(queue.length && seen.size<budget.maxEntities && performance.now()<until){
    const {id,depth}=queue.shift()!;
    if(seen.has(id)||!byId.has(id))continue;
    seen.add(id); depths.set(id,depth);
    for(const r of store.relationshipsFor(revision,id)){
      if(performance.now()>=until)break;
      if(!byId.has(r.from)||!byId.has(r.to))continue;
      const evidence=current(r); if(!evidence.length) {report.gaps.push({code:"SOURCE_STALE",entityId:id,message:"An indexed relationship has no current supporting source; refresh its file before using it."});continue;}
      if(r.kind==="contains" && r.from!==id)continue;
      if(!["calls","async_handoff","contains"].includes(r.kind))continue;
      const other=r.from===id?r.to:r.from;
      // Incoming callers provide entry context only; expansion follows outgoing calls/containment.
      if(r.from!==id && depth>0)continue;
      if(seen.size+queue.length>=budget.maxEntities&&!seen.has(other)){report.gaps.push({code:"BUDGET_EXHAUSTED",message:"Indexed neighbors exceed the entity budget."});continue;}
      relationships.set(r.id,{...r,evidence});
      if(r.from!==id){ if(!seen.has(other)){seen.add(other);depths.set(other,depth+1);contextOnly.add(other);} continue; }
      if(contextOnly.delete(other))seen.delete(other);
      if(depth<budget.maxDepth)queue.push({id:other,depth:depth+1});
      else if(!seen.has(other))report.gaps.push({code:"BUDGET_EXHAUSTED",entityId:id,message:"Indexed tracing reached its depth boundary."});
    }
  }
  if(queue.length || performance.now()>=until)report.gaps.push({code:"BUDGET_EXHAUSTED",message:"Indexed tracing reached its entity or time budget."});
  // Inspect reachable implementations even when indexed edges exist: an index may omit only some calls.
  const roots=[...seen].map(id=>byId.get(id)!).filter(e=>["function","method"].includes(e.kind)&&!contextOnly.has(e.entityId));
  if(options.resolveEvidence && roots.length && performance.now()<until){
    const rev=store.revision(revision)!;
    const recovered=sourceRecovery({revision,roots,depths,entities,budget,until,resolve:options.resolveEvidence,observedAt:rev.createdAt,accessScopeId:rev.repoRoot});
    for(const r of recovered.relationships){
      if(!seen.has(r.to)&&seen.size>=budget.maxEntities){report.gaps.push({code:"BUDGET_EXHAUSTED",message:"Recovered targets exceed the entity budget."});continue;}
      seen.add(r.to);
      if(![...relationships.values()].some(old=>old.from===r.from&&old.to===r.to&&old.kind===r.kind)){relationships.set(r.id,r);report.counts.recoveredRelationships++;}
    }
    report.gaps.push(...recovered.gaps);report.counts.sourceFiles=recovered.sourceFiles;report.counts.sourceBytes=recovered.sourceBytes;report.counts.unresolvedCalls=recovered.unresolved;
  } else if(roots.length)report.gaps.push({code:"SOURCE_UNAVAILABLE",message:"Current source inspection was unavailable or its investigation time budget was exhausted."});
  report.counts.entities=seen.size;report.counts.indexedRelationships=relationships.size-report.counts.recoveredRelationships;
  report.gaps=[...new Map(report.gaps.map(g=>[`${g.code}|${g.entityId??""}|${g.message}`,g])).values()];
  if(binding.status==="bound"&&report.gaps.length)report.outcome="partial";
  report.timings.investigationMs=performance.now()-started;
  return {report,seeds:[...seen],relationships:[...relationships.values()]};
}
