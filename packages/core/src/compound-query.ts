import type { CompoundQueryPlan, CompoundQueryResult, Entity, EvidenceSnapshot, EvidenceSetOperation } from '@cie/schema';
import { bindSubjects } from './investigation.ts';
import {callReachability} from './call-reachability.ts';
import { combineEvidenceSets, evaluateEvidenceSet } from './evidence-snapshot.ts';

/** Deliberately narrow grammar: ordinary "A and B" does not imply intersection. */
export function parseCompoundQuestion(question: string): { operation: EvidenceSetOperation; direction: 'outgoing' | 'incoming'; traversal: 'direct' | 'transitive'; left: string; right: string } | null {
  const q = question.trim().replace(/[?.!]$/, '');
  const prefix = /^(?:(?:show|list|find|which|what are|compare)\s+)?(?:(?:the|all)\s+)?(?:functions?|methods?|helpers?|components?)\s+(?:that\s+)?(?:(?:are|is)\s+)?(called by|calling|call|reachable from|can reach)\s+(.+)$/i.exec(q);
  if (!prefix) return null;
  const clause = prefix[2]!;
  const patterns: [RegExp, EvidenceSetOperation][] = [
    [/^both\s+(.+?)\s+and\s+(.+)$/i, 'intersection'],
    [/^either\s+(.+?)\s+or\s+(.+)$/i, 'union'],
    [/^(.+?)\s+(?:but not|except those called by|minus)\s+(.+)$/i, 'difference'],
  ];
  for (const [pattern,operation] of patterns) {
    const match = pattern.exec(clause);
    if (!match) continue;
    const clean = (s: string) => s.trim().replace(/^`([^`]+)`$/, '$1');
    const left=clean(match[1]!),right=clean(match[2]!);
    // More than two operands and nested prose need a real planner, never a guessed precedence.
    if ([left,right].some(s => !s || s.length > 180 || /\s(?:and|or|but|minus|except)\s/i.test(s))) return null;
    const verb=prefix[1]!.toLowerCase();
    return {operation,direction:['called by','reachable from'].includes(verb)?'outgoing':'incoming',traversal:['reachable from','can reach'].includes(verb)?'transitive':'direct',left,right};
  }
  return null;
}
export function planCompoundQuestion(question: string, entities: Entity[]): CompoundQueryPlan | null {
  const parsed=parseCompoundQuestion(question);
  if (!parsed) return null;
  const bind=(label:string) => {
    // Exact names/IDs win; duplicate exact names stay ambiguous.
    const exact=entities.filter(e=>e.entityId===label || e.name.toLowerCase()===label.toLowerCase());
    const binding=exact.length ? {status:exact.length===1?'bound':'ambiguous',roots:exact.length===1?[exact[0]!.entityId]:[],candidates:exact.map(e=>e.entityId)}
      : bindSubjects(entities,'',label);
    return {label,entityIds:binding.roots,candidates:binding.candidates};
  };
  const left=bind(parsed.left),right=bind(parsed.right);
  const status=left.entityIds.length && right.entityIds.length ? 'ready' : left.candidates.length>1 || right.candidates.length>1 ? 'ambiguous' : 'unbound';
  return {version:'compound-query.v1',operation:parsed.operation,relationshipKind:'calls',direction:parsed.direction,traversal:parsed.traversal,left,right,status};
}
export function evaluateCompoundQuestion(snapshot: EvidenceSnapshot, plan: CompoundQueryPlan): CompoundQueryResult {
  if(plan.status!=='ready')throw new Error('Compound operands must be bound before evaluation');
  const staticSnapshot={...snapshot,bundle:{...snapshot.bundle,relationships:snapshot.bundle.relationships.map(r=>({...r,
    evidence:r.evidence.filter(e=>e.class==='STATIC_PARSED'||e.class==='STATIC_RESOLVED')})).filter(r=>r.evidence.length>0)}};
  if(plan.traversal==='transitive')return evaluateReachableComparison(staticSnapshot,plan);
  const operand=(subjectIds:string[])=>evaluateEvidenceSet(staticSnapshot,{kind:'neighbors',subjectIds,relationshipKind:plan.relationshipKind,direction:plan.direction});
  const left=operand(plan.left.entityIds),right=operand(plan.right.entityIds);
  const combined=combineEvidenceSets(left,right,plan.operation);
  const byId=new Map(snapshot.bundle.entities.map(e=>[e.entityId,e]));
  // Candidate rows are observed calls, not every unrelated entity in the collection.
  const candidates=new Set(staticSnapshot.bundle.relationships.filter(r=>r.kind==='calls' && r.resolution!=='UNRESOLVED' && r.evidence.every(e=>e.state==='CURRENT')).flatMap(r=>plan.direction==='outgoing' ? [...plan.left.entityIds,...plan.right.entityIds].includes(r.from)?[r.to]:[] : [...plan.left.entityIds,...plan.right.entityIds].includes(r.to)?[r.from]:[]));
  const rows=Object.keys(combined.members).filter(id=>candidates.has(id)).sort().map(entityId=>({entityId,label:byId.get(entityId)?.name??entityId,
    left:left.members[entityId]??'unknown',right:right.members[entityId]??'unknown',result:combined.members[entityId]!,
    evidenceIds:[...new Set(staticSnapshot.bundle.relationships.filter(r=>r.kind===plan.relationshipKind && r.resolution!=="UNRESOLVED" &&
      (plan.direction==="outgoing" ? r.to===entityId && [...plan.left.entityIds,...plan.right.entityIds].includes(r.from)
        : r.from===entityId && [...plan.left.entityIds,...plan.right.entityIds].includes(r.to)) &&
      r.evidence.length>0 && r.evidence.every(ev=>snapshot.bundle.evidence.some(e=>e.id===ev.id&&e.state==="CURRENT")))
      .flatMap(r=>r.evidence.map(e=>e.id))), ...(plan.direction==='outgoing' ? (snapshot.bundle.investigation?.directCallCoverage ?? []).filter(c=>[...plan.left.entityIds,...plan.right.entityIds].includes(c.entityId) && !c.targetIds.includes(entityId)).flatMap(c=>c.evidence.filter(e=>snapshot.bundle.evidence.some(b=>b.id===e.id&&b.state==='CURRENT')).map(e=>e.id)) : [])],
  }));
  return {plan,snapshotId:snapshot.id,rows,limitations:[
    'Membership is based on current direct static call evidence; runtime dispatch and transitive calls are not included.',
    'Exclusions require a complete current source-body scan of direct calls. Uninspected or unresolved calls remain unknown; incoming comparisons have no repository-wide absence proof.',
  ]};
}
function evaluateReachableComparison(snapshot:EvidenceSnapshot, plan:CompoundQueryPlan):CompoundQueryResult {
  const left=callReachability(snapshot,plan.left.entityIds,plan.direction),right=callReachability(snapshot,plan.right.entityIds,plan.direction);
  const combined=combineEvidenceSets(left.set,right.set,plan.operation);
  const byId=new Map(snapshot.bundle.entities.map(e=>[e.entityId,e]));
  const candidates=[...new Set([...left.paths.keys(),...right.paths.keys()])].sort();
  const rows=candidates.map(entityId=>{
    const a=left.set.members[entityId]??'unknown',b=right.set.members[entityId]??'unknown';
    const leftPath=left.paths.get(entityId),rightPath=right.paths.get(entityId);
    return {entityId,label:byId.get(entityId)!.name,left:a,right:b,result:combined.members[entityId]!,
      paths:{left:leftPath,right:rightPath},
      evidenceIds:[...new Set([...(leftPath?.evidenceIds??[]),...(rightPath?.evidenceIds??[]),...(a==='absent'?left.exclusionEvidenceIds:[]),...(b==='absent'?right.exclusionEvidenceIds:[])])].sort()};
  });
  return {plan,snapshotId:snapshot.id,rows,traversalCoverage:{left:left.coverage,right:right.coverage},limitations:[
    'Reachability means a possible static call path of one or more edges, not a runtime trace.',
    plan.direction==='outgoing' ? 'Exclusions require current direct-call coverage at every reachable implementation. Unresolved or uninspected paths remain unknown.' : 'Missing callers remain unknown because this collection does not cover all repository entry points.',
    `Coverage: ${plan.left.label} ${left.coverage.complete?'closed':'partial'} (${left.coverage.visited} graph nodes); ${plan.right.label} ${right.coverage.complete?'closed':'partial'} (${right.coverage.visited} graph nodes).`,
  ]};
}
export function compoundAnswer(result: CompoundQueryResult): string {
  const proven=result.rows.filter(r=>r.result==='present'),unknown=result.rows.filter(r=>r.result==='unknown');
  const title={union:'Union',intersection:'Intersection',difference:'Difference'}[result.plan.operation];
  return `${result.plan.traversal==='transitive'?'Static reachability '+title.toLowerCase():title}: ${result.plan.left.label} ${result.plan.operation==='difference'?'minus':result.plan.operation==='union'?'or':'and'} ${result.plan.right.label}.\n\n`+
    `Supported matches (${proven.length}): ${proven.map(r=>r.label).join(', ') || 'none established in this snapshot'}.\n\n`+
    `Unknown candidates (${unknown.length}): ${unknown.map(r=>r.label).join(', ') || 'none among the observed candidates'}.\n\n`+result.limitations.join(' ');
}
