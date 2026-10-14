import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EvidenceBundle, EvidenceSet, Membership } from '@cie/schema';
import { collectSnapshot, combineEvidenceSets, projectionOf } from '../src/evidence-snapshot.ts';

const bundle = (): EvidenceBundle => ({ id:'b',revision:'r',entities:[],relationships:[],facts:[],evidence:[],coverage:[],unresolved:[],tokenEstimate:0 });
test('snapshot owns its data and identity changes for revision, question and evidence content', () => {
  const b=bundle(), snapshot=collectSnapshot('flow',b);
  b.unresolved.push('later mutation');
  assert.deepEqual(snapshot.bundle.unresolved,[]);
  assert.equal(snapshot.id,collectSnapshot('flow',bundle()).id);
  assert.notEqual(snapshot.id,collectSnapshot('other',bundle()).id);
  assert.notEqual(snapshot.id,collectSnapshot('flow',{...bundle(),revision:'r2'}).id);
  assert.equal(snapshot.coverage.exhaustive,false);
  assert.throws(()=>projectionOf(snapshot,{...bundle(),revision:'r2'}),/revisions/);
});
test('all 27 three-valued set results preserve unknown and directional difference', () => {
  const states: Membership[]=['present','absent','unknown'];
  const expected = {
    union: ['present','present','present','present','absent','unknown','present','unknown','unknown'],
    intersection: ['present','absent','unknown','absent','absent','absent','unknown','absent','unknown'],
    difference: ['absent','present','unknown','absent','absent','absent','absent','unknown','unknown'],
  };
  for (const operation of ['union','intersection','difference'] as const) for(const [i,a] of states.entries()) for(const [j,b] of states.entries()) {
    const left: EvidenceSet={snapshotId:'s',members:{x:a}},right:EvidenceSet={snapshotId:'s',members:{x:b}};
    assert.equal(combineEvidenceSets(left,right,operation).members.x,expected[operation][i*3+j]);
  }
  assert.equal(combineEvidenceSets({snapshotId:'s',members:{x:'present'}},{snapshotId:'s',members:{}},'difference').members.x,'unknown');
  assert.throws(()=>combineEvidenceSets({snapshotId:'s',members:{}},{snapshotId:'other',members:{}},'union'),/same evidence snapshot/);
});

test('nested set expressions do not infer absence for missing entities', async () => {
  const { evaluateEvidenceSet } = await import('../src/evidence-snapshot.ts');
  const snapshot=collectSnapshot('flow',bundle());
  const result=evaluateEvidenceSet(snapshot,{kind:'operation',operation:'difference',left:{kind:'members',entityIds:['missing']},right:{kind:'neighbors',subjectIds:['missing'],relationshipKind:'calls',direction:'outgoing'}});
  assert.equal(result.members.missing,'unknown');
  let expression: import('@cie/schema').EvidenceSetExpression={kind:'members',entityIds:[]};
  for(let i=0;i<129;i++)expression={kind:'operation',operation:'union',left:expression,right:{kind:'members',entityIds:[]}};
  assert.throws(()=>evaluateEvidenceSet(snapshot,expression),/128 nodes/);
});

test('snapshot migration rolls back and reapplies without rolling back older irreversible migrations', async () => {
  const { Store }=await import('../src/store.ts');
  const { rollback, migrate, MIGRATIONS }=await import('../src/migrations.ts');
  const store=new Store(':memory:');
  try {
    // Everything above 49 rolls back (all have down steps); later migrations keep extending this list,
    // so derive it instead of hard-coding the versions known when this test was written.
    assert.deepEqual(rollback(store.db, 49), MIGRATIONS.filter((m) => m.version > 49).map((m) => m.version).sort((a, b) => b - a));
    assert.ok(migrate(store.db).includes(50));
    const fk=store.db.prepare('pragma foreign_key_list(query_evidence_snapshots)').all() as {table:string;on_delete:string}[];
    assert.ok(fk.some(f=>f.table==='revisions'&&f.on_delete==='CASCADE'));
  } finally {store.db.close();}
});
