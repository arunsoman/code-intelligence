import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Entity, EvidenceRef} from '@cie/schema';
import {sourceRecovery} from '../src/source-recovery.ts';
import {collectSnapshot, evaluateEvidenceSet} from '../src/evidence-snapshot.ts';

function scan(text:string, names:string[], overrides:Record<string,number>={}) {
  const span={sourceId:'flow.ts',revision:'r',contentHash:'hash',startByte:0,endByteExclusive:Buffer.byteLength(text)};
  const entities:Entity[]=names.map(name=>({entityId:name,name,kind:'function',file:'flow.ts',spans:[span]}));
  const recovered=sourceRecovery({revision:'r',roots:entities,entities,budget:{maxEntities:64,maxDepth:3,maxSourceFiles:8,maxSourceBytes:128000,maxMs:1500,...overrides},until:performance.now()+1500,
    observedAt:'now',accessScopeId:'repo',resolve:ev=>({ ...ev,file:'flow.ts',startByte:0,endByte:span.endByteExclusive,startLine:1,endLine:1,snippet:Buffer.from(text).subarray((ev.location as {span:typeof span}).span.startByte,(ev.location as {span:typeof span}).span.endByteExclusive).toString()})});
  return {entities,recovered};
}
test('certificates require completed implementations and immutable, resolvable direct calls',()=>{
  const {recovered}=scan('function left(){helper()} function right(){} function helper(){}',['left','right','helper']);
  assert.deepEqual(recovered.directCallCoverage.find(c=>c.entityId==='left')!.targetIds,['helper']);
  assert.deepEqual(recovered.directCallCoverage.find(c=>c.entityId==='right')!.targetIds,[]);
  for(const body of ['callback()', 'obj.method()', 'new External()', 'tag`text`', 'missing()', 'helper?.()']) {
    assert.ok(!scan(`function root(){${body}} function helper(){}`,['root','helper']).recovered.directCallCoverage.some(c=>c.entityId==='root'),body);
  }
  assert.ok(scan('function root(){} function unrelated(){new External()}', ['root','unrelated']).recovered.directCallCoverage.some(c=>c.entityId==='root'));
  assert.equal(scan('function root(){}',['root'],{maxSourceBytes:1}).recovered.directCallCoverage.length,0);
  assert.equal(scan('function root();',['root']).recovered.directCallCoverage.length,0);
  assert.ok(!scan('function root(){helper()} function helper(){}; ({helper}=external);',['root','helper']).recovered.directCallCoverage.some(c=>c.entityId==='root'));
});
test('absence is revision-bound, evidence-backed, outgoing-only and invalidated by contradictions',()=>{
  const {entities,recovered}=scan('function left(){helper()} function right(){} function helper(){}',['left','right','helper']);
  const evidence:EvidenceRef[]=[...recovered.directCallCoverage.flatMap(c=>c.evidence),...recovered.relationships.flatMap(r=>r.evidence)];
  const snapshot=collectSnapshot('comparison',{id:'b',revision:'r',entities,relationships:recovered.relationships,facts:[],evidence,coverage:[],unresolved:[],tokenEstimate:0,
    investigation:{version:'investigation.v1',revision:'r',goal:'flow',binding:{status:'bound',roots:['left','right'],candidates:[]},outcome:'supported',scope:'bounded static neighborhood',budget:{maxEntities:64,maxDepth:3,maxSourceFiles:8,maxSourceBytes:128000,maxMs:1500},counts:{entities:3,indexedRelationships:0,recoveredRelationships:1,sourceFiles:1,sourceBytes:0,unresolvedCalls:0},timings:{bindingMs:0,investigationMs:0},gaps:[],directCallCoverage:recovered.directCallCoverage}});
  const expr={kind:'neighbors',subjectIds:['right'],relationshipKind:'calls',direction:'outgoing'} as const;
  const query={...expr,subjectIds:[...expr.subjectIds]};
  assert.equal(evaluateEvidenceSet(snapshot,query).members.helper,'absent');
  assert.equal(evaluateEvidenceSet(snapshot,{...query,direction:'incoming'}).members.helper,undefined);
  for(const change of ['revision','stale','missing','contradiction'] as const){
    const altered=structuredClone(snapshot);
    if(change==='revision')altered.bundle.investigation!.revision='old';
    if(change==='stale')altered.bundle.evidence.forEach(e=>e.state='STALE');
    if(change==='missing')altered.bundle.evidence=[];
    if(change==='contradiction')altered.bundle.relationships.push({...recovered.relationships[0]!,from:'right',resolution:'UNRESOLVED'});
    assert.notEqual(evaluateEvidenceSet(altered,query).members.helper,'absent',change);
  }
  const omitted=structuredClone(snapshot);omitted.bundle.entities=entities.filter(e=>e.entityId!=='helper');
  assert.notEqual(evaluateEvidenceSet(omitted,{...query,subjectIds:['left']}).members.right,'absent');
});
