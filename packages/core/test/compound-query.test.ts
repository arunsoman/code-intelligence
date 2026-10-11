import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cpSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StubProvider } from '@cie/model';
import { parseCompoundQuestion, planCompoundQuestion } from '../src/compound-query.ts';
import { ctx, setup, FIXTURE } from './helpers.ts';
import type { Entity } from '@cie/schema';

const entity=(name:string,file='flow.ts'):Entity=>({entityId:`function:${file}#${name}`,name,kind:'function',file,spans:[]});
test('explicit grammar preserves direction and does not guess ordinary conjunction or nested precedence',()=>{
  assert.equal(parseCompoundQuestion('functions called by both leftFlow and rightFlow')?.operation,'intersection');
  assert.equal(parseCompoundQuestion('functions calling either leftFlow or rightFlow')?.direction,'incoming');
  assert.equal(parseCompoundQuestion('Which functions call both leftFlow and rightFlow?')?.direction,'incoming');
  assert.equal(parseCompoundQuestion('Which functions are called by both leftFlow and rightFlow?')?.direction,'outgoing');
  assert.equal(parseCompoundQuestion('functions called by leftFlow but not rightFlow')?.operation,'difference');
  assert.equal(parseCompoundQuestion('explain leftFlow and rightFlow'),null);
  assert.equal(parseCompoundQuestion('functions called by both A and B or C'),null);
  assert.equal(planCompoundQuestion('functions called by both leftFlow and rightFlow',[entity('leftFlow'),entity('rightFlow')])?.status,'ready');
  assert.equal(planCompoundQuestion('functions called by both leftFlow and rightFlow',[entity('leftFlow'),entity('leftFlow','duplicate.ts'),entity('rightFlow')])?.status,'ambiguous');
  assert.equal(planCompoundQuestion('functions called by both leftFlow and missing',[entity('leftFlow')])?.status,'unbound');
});

async function fixture(t:import('node:test').TestContext,provider:import('@cie/schema').ModelProvider=new StubProvider()){
  const repo=mkdtempSync(join(tmpdir(),'cie-compound-'));cpSync(FIXTURE,repo,{recursive:true});
  writeFileSync(join(repo,'flow.ts'),`export function leftFlow(){ commonHelper(); leftHelper(); }
export function rightFlow(){ commonHelper(); rightHelper(); }
function commonHelper(){return 1;} function leftHelper(){return 2;} function rightHelper(){return 3;}
export function unrelatedFlow(){return 4;}`);
  const f=await setup(provider,repo);
  t.after(()=>{f.worker.close();f.svc.store.db.close();rmSync(repo,{recursive:true,force:true});});
  assert.ok((await f.svc.buildConceptHierarchy(ctx(),{revision:f.revision})).ok);
  return {...f,repo};
}
test('conversational compound intersection/union/difference have deterministic answers and evidence-backed membership',async t=>{
  const f=await fixture(t);
  const question='functions called by both leftFlow and rightFlow';
  const intersection=await f.svc.converse(ctx(),{text:question,revision:f.revision});
  assert.ok(intersection.ok);assert.equal(intersection.value.kind,'view');
  if(intersection.value.kind!=='view')return;
  const result=intersection.value.view.compoundQuery!;
  assert.ok(result);
  assert.deepEqual(result.rows.filter(r=>r.result==='present').map(r=>r.label),['commonHelper']);
  assert.equal(result.rows.find(r=>r.label==='leftHelper')!.result,'unknown');
  assert.ok(result.rows.find(r=>r.label==='commonHelper')!.evidenceIds.length>=2);
  assert.ok(intersection.value.view.answer?.includes('Supported matches (1): commonHelper'));
  const incoming=await f.svc.ask(ctx(),{question:'functions calling both commonHelper and leftHelper',revision:f.revision,chartCode:'S21'});assert.ok(incoming.ok);
  assert.deepEqual(incoming.value.view.compoundQuery!.rows.filter(r=>r.result==='present').map(r=>r.label),['leftFlow']);
  for(const [clause,expected] of [['either leftFlow or rightFlow',3],['leftFlow but not rightFlow',0],['rightFlow but not leftFlow',0]] as const){
    const r=await f.svc.ask(ctx(),{question:`functions called by ${clause}`,revision:f.revision,chartCode:'S21'});assert.ok(r.ok);
    assert.equal(r.value.view.compoundQuery!.rows.filter(r=>r.result==='present').length,expected);
    if(expected===0)assert.ok(r.value.view.compoundQuery!.rows.some(r=>r.result==='unknown'));
  }
});
test('chart reuse keeps the collection and original query, but refuses changed source, access, question and revision',async t=>{
  const f=await fixture(t),question='Explain leftFlow and its helpers';
  const first=await f.svc.ask(ctx(),{question,revision:f.revision,subject:'leftFlow',chartCode:'S21'});assert.ok(first.ok);
  const snapshotId=first.value.manifest!.snapshotId!;assert.ok(snapshotId);
  const before=(f.svc.store.db.prepare('select count(*) n from query_evidence_snapshots').get() as {n:number}).n;
  const second=await f.svc.ask(ctx(),{question,revision:f.revision,chartCode:'S28',snapshotId});assert.ok(second.ok);
  assert.equal(second.value.manifest!.snapshotId,snapshotId);
  assert.equal((f.svc.store.db.prepare('select count(*) n from query_evidence_snapshots').get() as {n:number}).n,before);
  const wrongQuestion=await f.svc.ask(ctx(),{question:'other',revision:f.revision,chartCode:'S21',snapshotId});assert.ok(!wrongQuestion.ok);assert.equal(wrongQuestion.error.code,'INVALID_SCHEMA');
  const wrongRevision=f.svc.store.evidenceSnapshot(snapshotId)!;wrongRevision.revision='other';
  f.svc.store.db.prepare('update query_evidence_snapshots set json=? where id=?').run(JSON.stringify(wrongRevision),snapshotId);
  const cross=await f.svc.ask(ctx(),{question,revision:f.revision,chartCode:'S21',snapshotId});assert.ok(!cross.ok);assert.equal(cross.error.code,'STALE_REVISION');
  wrongRevision.revision=f.revision;f.svc.store.db.prepare('update query_evidence_snapshots set json=? where id=?').run(JSON.stringify(wrongRevision),snapshotId);
  f.svc.store.denyPath(f.repo,'flow.ts');
  const denied=await f.svc.ask(ctx(),{question,revision:f.revision,chartCode:'S21',snapshotId});assert.ok(!denied.ok);assert.equal(denied.error.code,'FORBIDDEN');
  f.svc.store.denyPath(f.repo,'flow.ts',false);
  f.svc.store.setRevoked(f.repo,true);
  const revoked=await f.svc.ask(ctx(),{question,revision:f.revision,chartCode:'S21',snapshotId});assert.ok(!revoked.ok);assert.equal(revoked.error.code,'NOT_FOUND');
  f.svc.store.setRevoked(f.repo,false);
  writeFileSync(join(f.repo,'flow.ts'),'export function leftFlow(){return 99;}');
  const stale=await f.svc.ask(ctx(),{question,revision:f.revision,chartCode:'S21',snapshotId});assert.ok(!stale.ok);assert.equal(stale.error.code,'STALE_REVISION');
});
test('ambiguous compound operands stop before retrieval rather than selecting the first match',async t=>{
  const f=await fixture(t);writeFileSync(join(f.repo,'duplicate.ts'),'export function leftFlow(){return 42;}');
  const indexed=await f.svc.ingestRepository(ctx(),{repoPath:f.repo});assert.ok(indexed.ok);
  assert.ok((await f.svc.buildConceptHierarchy(ctx(),{revision:indexed.value.id})).ok);
  const r=await f.svc.ask(ctx(),{question:'functions called by both leftFlow and rightFlow',revision:indexed.value.id,chartCode:'S21'});
  assert.ok(!r.ok);assert.equal(r.error.code,'INSUFFICIENT_EVIDENCE');assert.ok(r.error.message.includes('Choose an exact operand'));
});


test('snapshot freshness is rechecked after asynchronous chart generation',async t=>{
  const provider=new StubProvider(),original=provider.generate.bind(provider);
  let edit: (()=>void)|undefined;
  provider.generate=async request=>{const output=await original(request);if(request.purpose==='CHART')edit?.();return output;};
  const f=await fixture(t,provider),question='Explain leftFlow and its helpers';
  const first=await f.svc.ask(ctx(),{question,revision:f.revision,subject:'leftFlow',chartCode:'S21'});assert.ok(first.ok);
  edit=()=>writeFileSync(join(f.repo,'flow.ts'),'export function leftFlow(){return 999;}');
  const changed=await f.svc.ask(ctx(),{question,revision:f.revision,chartCode:'S28',snapshotId:first.value.manifest!.snapshotId});
  assert.ok(!changed.ok);assert.equal(changed.error.code,'STALE_REVISION');
});


test('static compound membership excludes runtime-only call observations',async()=>{
  const {collectSnapshot}=await import('../src/evidence-snapshot.ts');
  const {evaluateCompoundQuestion}=await import('../src/compound-query.ts');
  const entities=[entity('leftFlow'),entity('rightFlow'),entity('observedHelper')];
  const ev:import('@cie/schema').EvidenceRef={id:'runtime',sourceId:'trace',location:{kind:'RuntimeLocation'},class:'RUNTIME',observedAt:'now',accessScopeId:'repo',state:'CURRENT'};
  const snapshot=collectSnapshot('functions called by either leftFlow or rightFlow',{id:'b',revision:'r',entities,evidence:[ev],facts:[],relationships:[{id:'observed-call',kind:'calls',from:entities[0]!.entityId,to:entities[2]!.entityId,evidence:[ev],resolution:'RUNTIME'}],coverage:[],unresolved:[],tokenEstimate:0});
  const plan=planCompoundQuestion(snapshot.question,entities)!;
  assert.equal(evaluateCompoundQuestion(snapshot,plan).rows.length,0);
});
