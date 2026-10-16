import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerClient } from "../src/worker.ts";
import { graphDigest } from "../src/indexer.ts";
import { EvidenceCoreBatchSchema, type AnalysisBatch, type EvidenceCoreBatchV1 } from "@cie/schema";
import { migrate, rollback, currentVersion } from "../src/migrations.ts";
import { Store, DeltaBaseError } from "../src/store.ts";
import { evidenceCoreIdentity, evidenceCoreManifestInput, evidenceCoreConfig } from "../src/evidence-core.ts";
function fixture(): AnalysisBatch {
  const span = {sourceId:"src/a.ts",revision:"r1",contentHash:"hash",startByte:0,endByteExclusive:0};
  const ev = {id:"ev1",sourceId:"src/a.ts",location:{kind:"CodeLocation" as const,span},class:"STATIC_PARSED" as const,observedAt:"1970-01-01T00:00:00Z",accessScopeId:"local",state:"CURRENT" as const};
  const b: AnalysisBatch = {revision:"r1",gitHead:null,repoRoot:"/repo",analyzerVersion:"v1",entities:[{entityId:"file:src/a.ts",kind:"file",name:"a.ts",file:"src/a.ts",spans:[span]}],facts:[{id:"fact1",subject:"file:src/a.ts",predicate:"parsed",object:{kind:"literal"},resolution:"PARSED",evidence:[ev]}],relationships:[],diagnostics:[],manifest:{"src/a.ts":"manifest"}};
  const scope = {kind:"FILE" as const,file:"src/a.ts"}, association = {subjectKind:"FACT" as const,subjectId:"fact1",evidenceId:"ev1",role:"SUPPORTS" as const};
  const output = evidenceCoreIdentity("output",["manifest",[association]]), run = evidenceCoreIdentity("run",["cie.rust.static","3","v1",scope,"hash",output]);
  b.evidenceCore = {schema:"cie.evidence-core.batch.v1",producerRuns:[{id:run,producerId:"cie.rust.static",producerVersion:"3",analyzerVersion:"v1",revision:"r1",scope,status:"PARTIAL",inputDigest:"hash",outputDigest:output}],links:[{...association,producerRunId:run}],coverage:[{id:evidenceCoreIdentity("coverage",[run,"static.observations"]),producerRunId:run,revision:"r1",scope,domain:"static.observations",status:"PARTIAL",exclusions:["reflection","dynamic dispatch","external dependencies","async delivery","generated or excluded sources"],unresolved:["No closed-world completeness claim; parser diagnostics remain authoritative"]}]};
  return b;
}
function mode(t: { after: (f:()=>void)=>void }, value="on", strict="1") { const saved = {...process.env}; process.env.CIE_EVIDENCE_CORE_MODE=value; process.env.CIE_EVIDENCE_CORE_STRICT=strict; t.after(()=> { for (const key of ["CIE_EVIDENCE_CORE_MODE","CIE_EVIDENCE_CORE_STRICT","CIE_EVIDENCE_CORE_COVERAGE_GATES"]) { if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key]; } }); }

test("canonical fixtures match the Rust namespace and strict shape rejects unknown schemas", () => {
  const rows = JSON.parse(readFileSync(new URL("../../../fixtures/evidence-core/identities.json",import.meta.url),"utf8"));
  for(const row of rows)assert.equal(evidenceCoreIdentity(row.kind,row.payload),row.id);
  assert.equal(EvidenceCoreBatchSchema.safeParse({...fixture().evidenceCore,schema:"future"}).success,false);
});
test("legacy batches, atomic sidecar writes, access denial and revocation", t => {
  mode(t); const store = new Store(":memory:"); t.after(()=>store.db.close()); const b=fixture();
  store.putBatch(b);
  assert.equal(store.evidenceCoreLinks(b.revision,"FACT","fact1").length,1);
  assert.equal(store.evidenceCoreCoverage(b.revision,"static.observations","src/a.ts")[0].status,"PARTIAL");
  store.denyPath(b.repoRoot,"src"); assert.deepEqual(store.evidenceCoreCoverage(b.revision,"static.observations","src/a.ts"),[]); assert.deepEqual(store.evidenceCoreLinks(b.revision,"FACT","fact1"),[]);
  store.denyPath(b.repoRoot,"src",false); store.setRevoked(b.repoRoot,true); assert.deepEqual(store.evidenceCoreLinks(b.revision,"FACT","fact1"),[]);
  process.env.CIE_EVIDENCE_CORE_STRICT="0"; const legacy={...fixture(),revision:"legacy",evidenceCore:undefined}; store.putBatch(legacy); assert.deepEqual(store.evidenceCoreCoverage("legacy","static.observations","src/a.ts"),[]);
});
test("strict rejection and storage failure roll back the complete revision", t => {
  mode(t);const store=new Store(":memory:");t.after(()=>store.db.close());const b=fixture();b.evidenceCore!.links[0].evidenceId="orphan";
  assert.throws(()=>store.putBatch(b),/EVIDENCE_CORE_INVALID/);assert.equal(store.revision("r1"),null);
  store.db.exec("create trigger fail_core before insert on evidence_core_links begin select raise(abort,'injected core failure'); end;");
  assert.throws(()=>store.putBatch(fixture()),/injected core failure/);assert.equal(store.revision("r1"),null);assert.equal((store.db.prepare("select count(*) n from entities").get() as {n:number}).n,0);
});
test("invalid optional metadata is discarded with a diagnostic and no fabricated coverage", t => {
  mode(t,"on","0");const store=new Store(":memory:");t.after(()=>store.db.close());const b=fixture();b.evidenceCore!.coverage[0].status="COMPLETE";
  store.putBatch(b);assert.equal(store.factsFor("r1","file:src/a.ts").length,1);assert.deepEqual(store.evidenceCoreCoverage("r1","static.observations","src/a.ts"),[]);assert.ok(store.revision("r1")!.diagnostics.some(d=>d.code==="EVIDENCE_CORE_REJECTED"));
});
test("producer versions and stale revision membership cannot be reused; missing delta bases are refused", t=>{
  mode(t);const store=new Store(":memory:");t.after(()=>store.db.close());const b=fixture();b.evidenceCore!.producerRuns[0].producerVersion="99";assert.throws(()=>store.putBatch(b),/EVIDENCE_CORE_INVALID/);
  assert.throws(()=>store.putDelta(fixture()),DeltaBaseError);
  process.env.CIE_EVIDENCE_CORE_COVERAGE_GATES="1"; assert.throws(evidenceCoreConfig,/CONFIG/);
});
test("default off preserves legacy DTO and shadow mode never exposes new metadata", t=>{
  mode(t,"off");const store=new Store(":memory:");t.after(()=>store.db.close());store.putBatch(fixture());assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,0);
  process.env.CIE_EVIDENCE_CORE_MODE="shadow";store.putBatch(fixture());assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,1);assert.deepEqual(store.evidenceCoreLinks("r1","FACT","fact1"),[]);
  store.db.prepare("delete from evidence_core_producer_runs where revision=?").run("r1"); assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,0);
});


test("real worker metadata roundtrips and fences older bases without changing legacy content IDs", async t=>{
  mode(t,"off","0");const root=mkdtempSync(join(tmpdir(),"cie-core-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,"a.ts"),"export function paid(){return 1;}\nexport function topup(){return paid();}\n");
  const firstWorker=new WorkerClient();const start=performance.now();const legacy=await firstWorker.index(root);const baselineMs=performance.now()-start;firstWorker.close();
  const oldStore=new Store(":memory:");t.after(()=>oldStore.db.close());oldStore.putBatch(legacy);
  process.env.CIE_EVIDENCE_CORE_MODE="on";process.env.CIE_EVIDENCE_CORE_STRICT="1";
  const worker=new WorkerClient();t.after(()=>worker.close());const enabledStart=performance.now();const batch=await worker.index(root);const enabledMs=performance.now()-enabledStart;
  assert.ok(batch.evidenceCore);assert.equal(batch.revision,legacy.revision+"-ec3");
  const rebind=(rows:unknown)=>JSON.parse(JSON.stringify(rows).replaceAll(legacy.revision,batch.revision));
  assert.deepEqual(batch.entities,rebind(legacy.entities));assert.deepEqual(batch.facts,rebind(legacy.facts));assert.deepEqual(batch.relationships,rebind(legacy.relationships));
  const store=new Store(":memory:");t.after(()=>store.db.close());store.putBatch(batch);
  assert.equal(graphDigest(store,batch.revision).digest,graphDigest(oldStore,legacy.revision).digest);
  assert.ok(batch.evidenceCore.coverage.every(c=>c.status==="PARTIAL"));
  const base={revision:batch.revision,analyzerVersion:batch.analyzerVersion,digests:batch.manifest!};
  const repeat=await worker.index(root,120000,undefined,base);assert.equal(repeat.mode,"full");assert.deepEqual(repeat.evidenceCore,batch.evidenceCore);
  writeFileSync(join(root,"a.ts"),"export function paid(){return 2;}\nexport function topup(){return paid();}\n");
  const changed=await worker.index(root,120000,undefined,base);const clean=await worker.index(root);
  assert.equal(changed.mode,"full");assert.deepEqual(changed.evidenceCore,clean.evidenceCore);
  store.putBatch(changed);assert.notEqual(changed.evidenceCore!.producerRuns[0].id,batch.evidenceCore.producerRuns[0].id);
  const metadataBytes=Buffer.byteLength(JSON.stringify(batch.evidenceCore)), legacyBytes=Buffer.byteLength(JSON.stringify({...batch,evidenceCore:undefined}));
  t.diagnostic(JSON.stringify({baselineMs,enabledMs,metadataBytes,legacyBytes}));
});


test("migration upgrades retain legacy data, and revision deletion cascades sidecars", t=>{
  mode(t);const store=new Store(":memory:");t.after(()=>store.db.close());store.putBatch(fixture());
  assert.deepEqual(rollback(store.db,53),[54]);assert.equal(store.factsFor("r1","file:src/a.ts").length,1);
  assert.deepEqual(migrate(store.db),[54]);assert.equal(currentVersion(store.db),54);assert.deepEqual(store.evidenceCoreCoverage("r1","static.observations","src/a.ts"),[]);
  store.putBatch(fixture());store.db.prepare("delete from revisions where id=?").run("r1");
  assert.equal((store.db.prepare("select count(*) n from evidence_core_producer_runs").get() as {n:number}).n,0);
  assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,0);
});


test("metadata cannot overwrite a held revision with a different persisted manifest", t=>{
  mode(t,"off");const store=new Store(":memory:");t.after(()=>store.db.close());const original=fixture();original.manifest={"src/a.ts":"different"};store.putBatch(original);
  process.env.CIE_EVIDENCE_CORE_MODE="on";
  assert.throws(()=>store.putBatch(fixture()),/PERSISTED_BINDING/);
  assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,0);
});

test("strict metadata requires every scope and one coverage record per run",t=>{
  mode(t);const store=new Store(":memory:");t.after(()=>store.db.close());
  const noCoverage=fixture();noCoverage.evidenceCore!.coverage=[];
  assert.throws(()=>store.putBatch(noCoverage),/EVIDENCE_CORE_INVALID/);assert.equal(store.revision("r1"),null);
  const silentFile=fixture();silentFile.manifest!["src/empty.ts"]="empty";
  silentFile.entities.push({entityId:"file:src/empty.ts",kind:"file",name:"empty.ts",file:"src/empty.ts",spans:[{...silentFile.entities[0].spans[0],sourceId:"src/empty.ts",contentHash:"empty"}]});
  assert.throws(()=>store.putBatch(silentFile),/EVIDENCE_CORE_INVALID/);assert.equal(store.revision("r1"),null);
  const repo=fixture();repo.manifest![""]="repository";
  assert.throws(()=>store.putBatch(repo),/EVIDENCE_CORE_INVALID/);
  const failed=fixture();failed.evidenceCore!.producerRuns[0].status="FAILED";
  assert.throws(()=>store.putBatch(failed),/EVIDENCE_CORE_INVALID/);
});
test("optional incomplete scope metadata is discarded while legacy facts remain",t=>{
  mode(t,"on","0");const store=new Store(":memory:");t.after(()=>store.db.close());
  const batch=fixture();batch.evidenceCore!.coverage=[];store.putBatch(batch);
  assert.equal(store.factsFor("r1","file:src/a.ts").length,1);
  assert.equal(store.evidenceCoreBaseVersion("r1"),undefined);
  assert.deepEqual(store.evidenceCoreProducerRuns("r1","src/a.ts"),[]);
  assert.ok(store.revision("r1")!.diagnostics.some(d=>d.code==="EVIDENCE_CORE_REJECTED"));
});

test("opt-in stage timing leaves the analysis batch unchanged",async t=>{
  mode(t);const root=mkdtempSync(join(tmpdir(),"cie-timed-")),log=join(tmpdir(),`cie-stages-${process.pid}.log`),saved=process.env.CIE_WORKER_TIMING;
  t.after(()=>{rmSync(root,{recursive:true,force:true});rmSync(log,{force:true});if(saved===undefined)delete process.env.CIE_WORKER_TIMING;else process.env.CIE_WORKER_TIMING=saved;});
  writeFileSync(join(root,"a.ts"),'export function a(){return 1;}\n');
  delete process.env.CIE_WORKER_TIMING;const plain=new WorkerClient();let baseline;try{baseline=await plain.index(root);}finally{plain.close();}
  process.env.CIE_WORKER_TIMING=log;const timed=new WorkerClient();try{assert.deepEqual(await timed.index(root),baseline);}finally{timed.close();}
  const stages=readFileSync(log,"utf8");
  for(const name of ["normalization","delta sharding","provenance emit","metadata wire cap","handle serialization + flush"])assert.ok(stages.split("\n").some(line=>line.startsWith(name+": ")&&Number.isFinite(Number(line.slice(name.length+2).replace(" ms","")))));
});

test("nested field reads retain both observations and the first legacy ID",async t=>{
  mode(t,"off","0");const root=new URL("../../../fixtures/evidence-core/nested-reads",import.meta.url).pathname;
  const legacyWorker=new WorkerClient();let legacy;try{legacy=await legacyWorker.index(root);}finally{legacyWorker.close();}
  process.env.CIE_EVIDENCE_CORE_MODE="on";process.env.CIE_EVIDENCE_CORE_STRICT="1";
  const worker=new WorkerClient(),store=new Store(":memory:");t.after(()=>{worker.close();store.db.close();});
  const batch=await worker.index(root);store.putBatch(batch);
  const reads=batch.facts.filter(f=>f.predicate==="reads"&&f.subject.endsWith("#read"));
  assert.deepEqual(reads.map(f=>f.object.value).sort(),["content","length"]);
  assert.equal(reads.filter(f=>f.id.includes(":observation-v3:")).length,1);
  const old=legacy.facts.find(f=>f.predicate==="reads"&&f.subject.endsWith("#read"))!;
  assert.ok(reads.some(f=>f.id===old.id&&JSON.stringify(f.object)===JSON.stringify(old.object)));
  assert.equal(new Set(reads.map(f=>f.id)).size,2);
  assert.equal(store.evidenceCoreBaseVersion(batch.revision),"3");
  const oldBase={revision:batch.revision,analyzerVersion:batch.analyzerVersion,digests:batch.manifest!,evidenceCoreVersion:"2"};
  assert.equal((await worker.index(root,120000,undefined,oldBase)).mode,"full");
});

test("bulk metadata insertion retains persisted owner and evidence binding checks",t=>{
  mode(t);
  for(const sql of ["update facts set ev='[]'", "update facts set file='other.ts'", "delete from evidence"]){
    const store=new Store(":memory:");try{store.putBatch(fixture());store.db.exec(sql);assert.throws(()=>store.putBatch(fixture()),/EVIDENCE_CORE_PERSISTED_BINDING/);assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,1);}finally{store.db.close();}
  }
});

test("repository input manifests encode empty owner keys and bind persisted digests",t=>{
  mode(t);const scope={kind:"REPOSITORY" as const},manifest={"":"root"};
  const input=evidenceCoreManifestInput(manifest),output=evidenceCoreIdentity("output",["root",[]]),id=evidenceCoreIdentity("run",["cie.rust.static","3","v1",scope,input,output]);
  const b:AnalysisBatch={revision:"root-r1",repoRoot:"/repo",gitHead:null,analyzerVersion:"v1",entities:[],facts:[],relationships:[],diagnostics:[],manifest,evidenceCore:{schema:"cie.evidence-core.batch.v1",producerRuns:[{id,producerId:"cie.rust.static",producerVersion:"3",analyzerVersion:"v1",revision:"root-r1",scope,status:"PARTIAL",inputDigest:input,outputDigest:output}],links:[],coverage:[{...fixture().evidenceCore!.coverage[0],id:evidenceCoreIdentity("coverage",[id,"static.observations"]),producerRunId:id,revision:"root-r1",scope}]}};
  const store=new Store(":memory:");try{store.putBatch(b);assert.equal(store.evidenceCoreBaseVersion(b.revision),"3");store.db.prepare("update rev_files set digest='moved' where revision=?").run(b.revision);assert.throws(()=>store.putBatch(b),/EVIDENCE_CORE_PERSISTED_BINDING/);}finally{store.db.close();}
});
