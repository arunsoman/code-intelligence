import type {CallPath, CallTraversalCoverage, EvidenceSet, EvidenceSnapshot} from '@cie/schema';
import {currentDirectCallCoverage} from './evidence-snapshot.ts';

/** Possible static paths of length >= 1. A cycle is a path; zero-length identity is not. */
export function callReachability(snapshot:EvidenceSnapshot, subjects:string[], direction:'outgoing'|'incoming', limits={maxNodes:1024,maxEdges:4096}) {
  if(snapshot.revision!==snapshot.bundle.revision)throw new Error('Reachability requires a single revision');
  if(!Number.isSafeInteger(limits.maxNodes)||limits.maxNodes<1||!Number.isSafeInteger(limits.maxEdges)||limits.maxEdges<1)throw new Error('Invalid traversal budget');
  const entities=new Map(snapshot.bundle.entities.map(e=>[e.entityId,e]));
  const current=new Set(snapshot.bundle.evidence.filter(e=>e.state==='CURRENT').map(e=>e.id));
  const edges=snapshot.bundle.relationships.filter(r=>r.kind==='calls'&&r.resolution!=='UNRESOLVED'&&r.evidence.length>0&&r.evidence.every(e=>e.state==='CURRENT'&&current.has(e.id)&&['STATIC_PARSED','STATIC_RESOLVED'].includes(e.class)));
  const certificates=new Map(currentDirectCallCoverage(snapshot).map(c=>[c.entityId,c]));
  const adjacency=new Map<string,typeof edges>();
  for(const edge of edges.sort((a,b)=>a.id.localeCompare(b.id))){
    const from=direction==='outgoing'?edge.from:edge.to;
    adjacency.set(from,[...(adjacency.get(from)??[]),edge]);
  }
  const paths=new Map<string,CallPath>(), visited=new Set<string>(), queued=new Set<string>();
  const queue:[string,string[],string[]][]=[];
  for(const id of [...new Set(subjects)].sort())if(entities.has(id)){queue.push([id,[id],[]]);queued.add(id);}
  const frontier=new Set(subjects.filter(id=>!entities.has(id)));
  const proof=new Set<string>();let scanned=0,budgetExhausted=false;
  while(queue.length){
    if(visited.size>=limits.maxNodes){budgetExhausted=true;break;}
    const [id,path,pathEvidence]=queue.shift()!;visited.add(id);
    const certificate=certificates.get(id);
    if(!certificate)frontier.add(id);
    else {
      certificate.evidence.forEach(e=>proof.add(e.id));
      // A projection that omitted a certified target edge cannot close a transitive branch.
      if(direction==='outgoing'&&certificate.targetIds.some(target=>!adjacency.get(id)?.some(e=>e.to===target)))frontier.add(id);
    }
    for(const edge of adjacency.get(id)??[]){
      if(scanned++>=limits.maxEdges){budgetExhausted=true;break;}
      const target=direction==='outgoing'?edge.to:edge.from;
      if(!entities.has(target)){frontier.add(id);continue;}
      const ids=[...path,target],evidence=[...new Set([...pathEvidence,...edge.evidence.map(e=>e.id)])];
      if(!paths.has(target)){
        const entityIds=direction==='outgoing'?ids:[...ids].reverse();
        paths.set(target,{entityIds,labels:entityIds.map(key=>entities.get(key)!.name),evidenceIds:evidence});
      }
      if(!queued.has(target)){queued.add(target);queue.push([target,ids,evidence]);}
    }
    if(budgetExhausted)break;
  }
  const complete=direction==='outgoing'&&subjects.length>0&&frontier.size===0&&!budgetExhausted;
  const members:EvidenceSet['members']=Object.create(null);
  if(complete)for(const id of entities.keys())members[id]='absent';
  for(const id of paths.keys())members[id]='present';
  const coverage:CallTraversalCoverage={complete,visited:visited.size,unknownFrontier:frontier.size,budgetExhausted};
  return {set:{snapshotId:snapshot.id,members} satisfies EvidenceSet,paths,coverage,exclusionEvidenceIds:complete?[...proof].sort():[]};
}
