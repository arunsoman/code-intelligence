import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Entity, EvidenceBundle, EvidenceRef, InvestigationReport} from '@cie/schema';
import {callReachability} from '../src/call-reachability.ts';
import {collectSnapshot} from '../src/evidence-snapshot.ts';
import {evaluateCompoundQuestion, planCompoundQuestion} from '../src/compound-query.ts';

function fixture(pairs:[string,string][], missing:string[]=[]) {
  const names=[...new Set(['left','right','isolated',...pairs.flat()])];
  const entities:Entity[]=names.map(name=>({entityId:name,name,kind:'function',file:'flow.ts',spans:[]}));
  const proof:EvidenceRef={id:'source',sourceId:'flow.ts',location:{kind:'CodeLocation'},class:'STATIC_PARSED',state:'CURRENT',observedAt:'now',accessScopeId:'repo'};
  const relationships=pairs.map(([from,to],index)=>({id:`edge:${index}`,from,to,kind:'calls',resolution:'STATIC_RESOLVED' as const,evidence:[{...proof,id:`ev:${index}`}]}));
  const investigation:InvestigationReport={version:'investigation.v1',revision:'r',goal:'flow',binding:{status:'bound',roots:['left','right'],candidates:[]},outcome:'supported',scope:'bounded static neighborhood',budget:{maxEntities:64,maxDepth:3,maxSourceFiles:8,maxSourceBytes:128000,maxMs:1500},counts:{entities:names.length,indexedRelationships:pairs.length,recoveredRelationships:0,sourceFiles:1,sourceBytes:0,unresolvedCalls:0},timings:{bindingMs:0,investigationMs:0},gaps:[],directCallCoverage:names.filter(n=>!missing.includes(n)).map(entityId=>({entityId,targetIds:pairs.filter(([from])=>from===entityId).map(([,to])=>to),evidence:[proof]}))};
  const bundle:EvidenceBundle={id:'b',revision:'r',entities,relationships,facts:[],evidence:[proof,...relationships.flatMap(r=>r.evidence)],coverage:[],unresolved:[],tokenEstimate:0,investigation};
  return collectSnapshot('query',bundle);
}
test('cycles terminate, shortest witnesses are deterministic, and identity needs an actual cycle',()=>{
  const snapshot=fixture([['left','branch'],['branch','leaf'],['leaf','left'],['left','leaf']]);
  const result=callReachability(snapshot,['left'],'outgoing');
  assert.equal(result.coverage.complete,true);
  assert.equal(result.coverage.visited,3);
  assert.deepEqual(result.paths.get('leaf')!.entityIds,['left','leaf']);
  assert.deepEqual(result.paths.get('left')!.entityIds,['left','leaf','left']);
  assert.equal(callReachability(snapshot,['right'],'outgoing').set.members.right,'absent');
  const reverse=callReachability({...snapshot,bundle:{...snapshot.bundle,relationships:[...snapshot.bundle.relationships].reverse()}},['left'],'outgoing');
  assert.deepEqual([...reverse.paths],[...result.paths]);
});
test('all reachable bodies must be covered before exclusions; positive paths survive missing coverage',()=>{
  const complete=fixture([['left','branch'],['branch','leaf']]);
  assert.equal(callReachability(complete,['left'],'outgoing').set.members.isolated,'absent');
  const partial=fixture([['left','branch'],['branch','leaf']],['branch']);
  const result=callReachability(partial,['left'],'outgoing');
  assert.equal(result.set.members.leaf,'present');assert.equal(result.set.members.isolated,undefined);
  assert.equal(result.coverage.complete,false);assert.equal(result.coverage.unknownFrontier,1);
  assert.deepEqual(result.exclusionEvidenceIds,[]);
  const projection=structuredClone(complete);projection.bundle.relationships.pop();
  assert.equal(callReachability(projection,['left'],'outgoing').coverage.complete,false);
});
test('stale, runtime-only, unresolved and outside-universe edges cannot establish reachability or exclusions',()=>{
  for(const kind of ['stale','runtime','unresolved','outside'] as const){
    const snapshot=fixture([['left','leaf']]);
    const edge=snapshot.bundle.relationships[0]!;
    if(kind==='stale')snapshot.bundle.evidence.forEach(e=>e.state='STALE');
    if(kind==='runtime')edge.evidence.forEach(e=>e.class='RUNTIME');
    if(kind==='unresolved')edge.resolution='UNRESOLVED';
    if(kind==='outside')snapshot.bundle.entities=snapshot.bundle.entities.filter(e=>e.entityId!=='leaf');
    const result=callReachability(snapshot,['left'],'outgoing');
    assert.notEqual(result.set.members.leaf,'present',kind);assert.equal(result.coverage.complete,false,kind);
  }
});
test('traversal budgets and incoming scope preserve unknown, and mixed revisions fail',()=>{
  const snapshot=fixture([['left','branch'],['branch','leaf']]);
  for(const limits of [{maxNodes:1,maxEdges:10},{maxNodes:10,maxEdges:1}]){
    const r=callReachability(snapshot,['left'],'outgoing',limits);
    assert.equal(r.coverage.budgetExhausted,true);assert.equal(r.coverage.complete,false);assert.equal(r.set.members.isolated,undefined);
  }
  const incoming=callReachability(snapshot,['leaf'],'incoming');
  assert.deepEqual(incoming.paths.get('left')!.entityIds,['left','branch','leaf']);
  assert.equal(incoming.set.members.isolated,undefined);assert.equal(incoming.coverage.complete,false);
  assert.equal(callReachability(snapshot,['missing'],'outgoing').coverage.complete,false);
  assert.throws(()=>callReachability(snapshot,['left'],'outgoing',{maxNodes:0,maxEdges:1}),/budget/);
  assert.throws(()=>callReachability({...snapshot,revision:'other'},['left'],'outgoing'),/revision/);
});
test('transitive algebra uses full snapshot, proves both differences, and cites intermediate call paths',()=>{
  const snapshot=fixture([['left','leftBranch'],['leftBranch','common'],['right','rightBranch'],['rightBranch','common']]);
  const evaluate=(clause:string)=>evaluateCompoundQuestion(snapshot,planCompoundQuestion(`functions reachable from ${clause}`,snapshot.bundle.entities)!);
  const intersection=evaluate('both left and right');
  assert.deepEqual(intersection.rows.filter(r=>r.result==='present').map(r=>r.label),['common']);
  assert.deepEqual(intersection.rows.find(r=>r.label==='common')!.paths!.left!.entityIds,['left','leftBranch','common']);
  assert.deepEqual(intersection.rows.find(r=>r.label==='common')!.evidenceIds,['ev:0','ev:1','ev:2','ev:3']);
  assert.deepEqual(evaluate('left but not right').rows.filter(r=>r.result==='present').map(r=>r.label),['leftBranch']);
  assert.deepEqual(evaluate('right but not left').rows.filter(r=>r.result==='present').map(r=>r.label),['rightBranch']);
  assert.equal(evaluate('either left or right').rows.filter(r=>r.result==='present').length,3);
});


test('an uninspected transitive branch keeps difference unknown while retaining its known paths',()=>{
  const snapshot=fixture([['left','leftBranch'],['leftBranch','common'],['right','rightBranch'],['rightBranch','common']],['rightBranch']);
  const plan=planCompoundQuestion('functions reachable from left but not right',snapshot.bundle.entities)!;
  const result=evaluateCompoundQuestion(snapshot,plan);
  assert.equal(result.rows.find(r=>r.label==='leftBranch')!.result,'unknown');
  assert.equal(result.rows.find(r=>r.label==='common')!.result,'absent');
  assert.equal(result.traversalCoverage!.right.complete,false);
});
test('protected witness functions survive model trimming, which reports an over-budget projection',async()=>{
  const {retrieveFromSnapshot}=await import('../src/retrieval.ts');
  const snapshot=fixture([['left','branch'],['branch','leaf']]);
  const result=retrieveFromSnapshot(snapshot,{tokenBudget:1,subjectIds:['left'],resultIds:['left','branch','leaf'],protectedIds:['left','branch','leaf']});
  assert.deepEqual(result.bundle.entities.map(e=>e.entityId).sort(),['branch','leaf','left']);
  assert.ok(result.bundle.tokenEstimate>1);
});
