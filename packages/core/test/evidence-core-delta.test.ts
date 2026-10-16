import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync,writeFileSync,rmSync,unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisBatch } from "@cie/schema";
import { WorkerClient } from "../src/worker.ts";
import { Store,DeltaBaseError } from "../src/store.ts";
import { graphDigest } from "../src/indexer.ts";
async function boot(t: {after:(f:()=>void)=>void}) {
  const env={mode:process.env.CIE_EVIDENCE_CORE_MODE,strict:process.env.CIE_EVIDENCE_CORE_STRICT};
  process.env.CIE_EVIDENCE_CORE_MODE="on";process.env.CIE_EVIDENCE_CORE_STRICT="1";
  const root=mkdtempSync(join(tmpdir(),"cie-delta-"));
  writeFileSync(join(root,"a.ts"),"export function first(){return 1;}\n");writeFileSync(join(root,"b.ts"),"export function second(){return 2;}\n");
  const worker=new WorkerClient(),store=new Store(":memory:");
  t.after(()=>{worker.close();store.db.close();rmSync(root,{recursive:true,force:true});for(const [key,value]of [["CIE_EVIDENCE_CORE_MODE",env.mode],["CIE_EVIDENCE_CORE_STRICT",env.strict]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}});
  const batch=await worker.index(root);store.putBatch(batch);
  const base={revision:batch.revision,analyzerVersion:batch.analyzerVersion,digests:batch.manifest!,evidenceCoreVersion:store.evidenceCoreBaseVersion(batch.revision)};
  return {root,worker,store,batch,base};
}
function metadata(store:Store,revision:string) {
  return ["evidence_core_producer_runs","evidence_core_links","evidence_core_coverage"].map(table=>store.db.prepare(`select * from ${table} where revision=? order by 2,3`).all(revision));
}
test("native delta copies unchanged scoped metadata and equals clean full metadata",async t=>{
  const {root,worker,store,batch,base}=await boot(t);assert.equal(base.evidenceCoreVersion,"2");
  const same=await worker.index(root,120000,undefined,base);assert.equal(same.mode,"unchanged");assert.equal(same.evidenceCore,undefined);
  writeFileSync(join(root,"a.ts"),"export function first(){return 10;}\n");
  const delta=await worker.index(root,120000,undefined,base);assert.equal(delta.mode,"delta");assert.deepEqual(delta.changedFiles,["a.ts"]);assert.ok(delta.entities.every(e=>e.file!=="b.ts"));
  const unchanged=store.evidenceCoreProducerRuns(batch.revision,"b.ts")[0];store.putDelta(delta);
  assert.equal(store.evidenceCoreProducerRuns(delta.revision,"b.ts")[0].id,unchanged.id);assert.equal(store.evidenceCoreProducerRuns(delta.revision,"b.ts")[0].revision,delta.revision);
  const full=await worker.index(root),clean=new Store(":memory:");try{clean.putBatch(full);assert.deepEqual(metadata(store,delta.revision),metadata(clean,full.revision));assert.equal(graphDigest(store,delta.revision).digest,graphDigest(clean,full.revision).digest);}finally{clean.db.close();}
  store.denyPath(root,"b.ts");assert.deepEqual(store.evidenceCoreProducerRuns(delta.revision,"b.ts"),[]);store.setRevoked(root,true);assert.deepEqual(store.evidenceCoreCoverage(delta.revision,"static.observations","a.ts"),[]);
});
test("removals leave no old provenance; added files acquire new metadata",async t=>{
  const {root,worker,store,base}=await boot(t);unlinkSync(join(root,"a.ts"));writeFileSync(join(root,"c.ts"),"export function third(){return 3;}\n");
  const delta=await worker.index(root,120000,undefined,base);assert.equal(delta.mode,"delta");assert.deepEqual(delta.removedFiles,["a.ts"]);store.putDelta(delta);
  assert.deepEqual(store.evidenceCoreProducerRuns(delta.revision,"a.ts"),[]);assert.equal(store.evidenceCoreProducerRuns(delta.revision,"c.ts").length,1);
  const full=await worker.index(root),clean=new Store(":memory:");try{clean.putBatch(full);assert.deepEqual(metadata(store,delta.revision),metadata(clean,full.revision));}finally{clean.db.close();}
});
test("producer fence mismatch, missing coverage and forged unchanged manifests force full indexing",async t=>{
  const {root,worker,store,batch,base}=await boot(t);
  assert.equal((await worker.index(root,120000,undefined,{...base,evidenceCoreVersion:"1"})).mode,"full");
  store.db.prepare("delete from evidence_core_coverage where revision=?").run(batch.revision);assert.equal(store.evidenceCoreBaseVersion(batch.revision),undefined);
  writeFileSync(join(root,"a.ts"),"export function first(){return 5;}\n");const delta=await worker.index(root,120000,undefined,base);assert.throws(()=>store.putDelta(delta),DeltaBaseError);
  store.putBatch(await worker.index(root));
});
test("failed delta sidecar insertion rolls back copied rows and leaves its base intact",async t=>{
  const {root,worker,store,batch,base}=await boot(t);writeFileSync(join(root,"a.ts"),"export function first(){return 20;}\n");const delta=await worker.index(root,120000,undefined,base);
  assert.throws(()=>store.putDelta({...delta,changedFiles:[]}),DeltaBaseError);
  store.db.exec("create trigger fail_delta before insert on evidence_core_coverage begin select raise(abort,'delta injected failure');end;");
  assert.throws(()=>store.putDelta(delta),/delta injected failure/);assert.equal(store.revision(delta.revision),null);assert.ok(store.revision(batch.revision));assert.equal(store.evidenceCoreBaseVersion(batch.revision),"2");
});
test("chained unresolved calls preserve the legacy observation and retain the previously collided observation",async t=>{
  const {root,worker,store}=await boot(t);writeFileSync(join(root,"chain.ts"),"export function run(res:any){res.status(401).end();}\n");
  const batch=await worker.index(root);store.putBatch(batch);
  const calls=batch.facts.filter(f=>f.predicate==="calls"&&f.subject.includes("chain.ts"));assert.equal(calls.length,2);
  assert.equal(calls.filter(f=>f.id.includes(":observation-v2:")).length,1);assert.equal(new Set(calls.map(f=>f.id)).size,2);
});

test("cross-file target edits retain full-index metadata equivalence",async t=>{
  const {root,worker,store}=await boot(t);
  writeFileSync(join(root,"b.ts"),'import {first} from "./a"; export function second(){return first();}\n');
  const batch=await worker.index(root);store.putBatch(batch);
  const base={revision:batch.revision,analyzerVersion:batch.analyzerVersion,digests:batch.manifest!,evidenceCoreVersion:store.evidenceCoreBaseVersion(batch.revision)};
  writeFileSync(join(root,"a.ts"),'export function renamed(){return 7;}\n');
  const delta=await worker.index(root,120000,undefined,base);assert.equal(delta.mode,"delta");store.putDelta(delta);
  const full=await worker.index(root),clean=new Store(":memory:");try{clean.putBatch(full);assert.deepEqual(metadata(store,delta.revision),metadata(clean,full.revision));assert.equal(graphDigest(store,delta.revision).digest,graphDigest(clean,full.revision).digest);}finally{clean.db.close();}
});
test("incomplete support links cannot authorize delta reuse",async t=>{
  const {store,batch}=await boot(t);
  store.db.prepare("delete from evidence_core_links where rowid=(select rowid from evidence_core_links where revision=? limit 1)").run(batch.revision);
  assert.equal(store.evidenceCoreBaseVersion(batch.revision),undefined);
});
