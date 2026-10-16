import {spawnSync} from "node:child_process";
import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync,readdirSync,renameSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,basename} from "node:path";
import {cleanupStaleCoreStreams,CORE_STREAM_STALE_MS} from "../src/evidence-core-cleanup.ts";
import {createHash} from "node:crypto";
import {WorkerClient} from "../src/worker.ts";
import {Store} from "../src/store.ts";
import {coreStreamPath,attachCoreStream} from "../src/evidence-core-stream.ts";
import {evidenceCoreConfig,evidenceCoreIdentity,evidenceCoreManifestInput} from "../src/evidence-core.ts";
import {graphDigest} from "../src/indexer.ts";
function setup(t:any){
  const saved={...process.env},root=mkdtempSync(join(tmpdir(),"cie-stream-"));
  for(const key of Object.keys(process.env))if(key.startsWith("CIE_EVIDENCE_CORE_"))delete process.env[key];
  process.env.CIE_EVIDENCE_CORE_MODE="on";process.env.CIE_EVIDENCE_CORE_STRICT="1";
  writeFileSync(join(root,"a.ts"),'export function first(){return 1;}\n');writeFileSync(join(root,"b.ts"),'export function second(){return 2;}\n');
  t.after(()=>{rmSync(root,{recursive:true,force:true});for(const key of Object.keys(process.env))if(key.startsWith("CIE_EVIDENCE_CORE_"))delete process.env[key];for(const[key,value]of Object.entries(saved))if(key.startsWith("CIE_EVIDENCE_CORE_"))process.env[key]=value;});return root;
}
async function index(root:string){const worker=new WorkerClient();try{return await worker.index(root);}finally{worker.close();}}
function rows(store:Store,revision:string){return ["evidence_core_producer_runs","evidence_core_links","evidence_core_coverage"].map(table=>store.db.prepare(`select * from ${table} where revision=? order by 2,3,4`).all(revision));}
function rewrite(path:string,edit:(records:any[])=>any[]){
  const records=edit(readFileSync(path,"utf8").trim().split("\n").map(line=>JSON.parse(line)));
  const footer=records.at(-1);if(footer?.kind==="footer"){const hash=createHash("sha256");let n=0;for(const r of records)if(r.kind==="chunk"){hash.update(JSON.stringify(r)+"\n");n++;}footer.sha256=hash.digest("hex");footer.chunks=n;}
  writeFileSync(path,records.map(r=>JSON.stringify(r)).join("\n")+"\n");
}
test("stream and inline persist exactly equal metadata, including after worker close",async t=>{
  const root=setup(t),inline=await index(root),a=new Store(":memory:"),b=new Store(":memory:");t.after(()=>{a.db.close();b.db.close();});a.putBatch(inline);
  process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";const stream=await index(root),path=coreStreamPath(stream)!;
  assert.equal(stream.evidenceCore,undefined);assert.ok(existsSync(path));b.putBatch(stream);assert.ok(!existsSync(path));
  assert.deepEqual(rows(a,inline.revision),rows(b,stream.revision));assert.equal(graphDigest(a,inline.revision).digest,graphDigest(b,stream.revision).digest);assert.equal(b.evidenceCoreBaseVersion(stream.revision),"4");
  b.denyPath(root,"a.ts");assert.deepEqual(b.evidenceCoreCoverage(stream.revision,"static.observations","a.ts"),[]);b.setRevoked(root,true);assert.equal(b.evidenceCoreBaseVersion(stream.revision),undefined);
});
test("scoped stream validation retains cross-file evidence source checks",async t=>{
  const root=setup(t);
  for(const badSource of [false,true]){
    process.env.CIE_EVIDENCE_CORE_TRANSPORT="inline";
    const inline=await index(root);
    process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";
    const stream=await index(root);
    for(const batch of [inline,stream]){
      const source=batch.entities.find(e=>e.kind==="file"&&e.file==="b.ts")!;
      const subjectIds=new Set(batch.entities.filter(e=>e.file==="a.ts").map(e=>e.entityId));
      let changed=0;
      for(const row of batch.facts.filter(f=>subjectIds.has(f.subject)))for(const ev of row.evidence){
        if(ev.location.kind!=="CodeLocation")continue;
        ev.sourceId=source.file;
        ev.location={kind:"CodeLocation",span:{...source.spans[0],contentHash:badSource?"forged":source.spans[0].contentHash}};
        changed++;
      }
      assert.ok(changed>0);
    }
    const a=new Store(":memory:"),b=new Store(":memory:");
    try{
      if(badSource){
        assert.throws(()=>a.putBatch(inline),/EVIDENCE_CORE_INVALID/);
        assert.throws(()=>b.putBatch(stream),/EVIDENCE_CORE_INVALID/);
        assert.equal(b.revision(stream.revision),null);
      }else{
        a.putBatch(inline);b.putBatch(stream);
        assert.deepEqual(rows(a,inline.revision),rows(b,stream.revision));
      }
    }finally{a.db.close();b.db.close();}
  }
});
test("stream deltas equal clean full indexing and unchanged emits no stream",async t=>{
  const root=setup(t);process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";const worker=new WorkerClient(),store=new Store(":memory:"),clean=new Store(":memory:");t.after(()=>{worker.close();store.db.close();clean.db.close();});
  const first=await worker.index(root);store.putBatch(first);const base={revision:first.revision,analyzerVersion:first.analyzerVersion,digests:first.manifest!,evidenceCoreVersion:"4"};
  const unchanged=await worker.index(root,120000,undefined,base);assert.equal(unchanged.mode,"unchanged");assert.equal(coreStreamPath(unchanged),undefined);
  writeFileSync(join(root,"a.ts"),'export function first(){return 9;}\n');const delta=await worker.index(root,120000,undefined,base);assert.equal(delta.mode,"delta");store.putDelta(delta);
  const full=await worker.index(root);clean.putBatch(full);assert.deepEqual(rows(store,delta.revision),rows(clean,full.revision));assert.equal(graphDigest(store,delta.revision).digest,graphDigest(clean,full.revision).digest);
});
test("missing, duplicate, reordered and forged chunks atomically reject and clean up",async t=>{
  const root=setup(t);process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";const store=new Store(":memory:");t.after(()=>store.db.close());
  for(const fault of ["missing-footer","missing-scope","duplicate","reordered","forged-evidence","digest","wrong-digest","truncated"]){
    const batch=await index(root),path=coreStreamPath(batch)!;
    rewrite(path,records=>{switch(fault){case"missing-footer":return records.slice(0,-1);case"missing-scope":return records.filter((r:any)=>r.sequence!==1);case"duplicate":records.splice(2,0,records[1]);break;case"reordered":[records[1],records[2]]=[records[2],records[1]];break;case"forged-evidence":records[1].core.links[0].evidenceId="forged";break;case"digest":records[1].core.links[0].role="CONTEXT";break;}return records;});
    if(fault==="wrong-digest"){const lines=readFileSync(path,"utf8").trim().split("\n"),last=JSON.parse(lines.at(-1)!);last.sha256="0".repeat(64);lines[lines.length-1]=JSON.stringify(last);writeFileSync(path,lines.join("\n")+"\n");}
    if(fault==="truncated")writeFileSync(path,readFileSync(path).subarray(0,50));
    assert.throws(()=>store.putBatch(batch),/EVIDENCE_CORE_(STREAM_INVALID|INVALID)/,fault);assert.equal(store.revision(batch.revision),null);assert.ok(!existsSync(path));assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,0);
  }
});
test("optional invalid stream drops all metadata while resource exhaustion stays fatal",async t=>{
  const root=setup(t);process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";process.env.CIE_EVIDENCE_CORE_STRICT="0";const store=new Store(":memory:");t.after(()=>store.db.close());
  const batch=await index(root);rewrite(coreStreamPath(batch)!,r=>r.slice(0,-1));store.putBatch(batch);assert.ok(store.allFacts(batch.revision).length);assert.equal(store.evidenceCoreBaseVersion(batch.revision),undefined);assert.equal((store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,0);assert.ok(store.revision(batch.revision)!.diagnostics.some(d=>d.code==="EVIDENCE_CORE_REJECTED"));
  writeFileSync(join(root,"a.ts"),'export function first(){return 10;}\n');const next=await index(root);process.env.CIE_EVIDENCE_CORE_STREAM_MAX_BYTES="1";assert.throws(()=>store.putBatch(next),/EVIDENCE_CORE_RESOURCE_LIMIT/);assert.equal(store.revision(next.revision),null);
});
test("stream delta SQL failure rolls back copied metadata and preserves base",async t=>{
  const root=setup(t);process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";const worker=new WorkerClient(),store=new Store(":memory:");t.after(()=>{worker.close();store.db.close();});const first=await worker.index(root);store.putBatch(first);
  writeFileSync(join(root,"a.ts"),'export function first(){return 11;}\n');const delta=await worker.index(root,120000,undefined,{revision:first.revision,analyzerVersion:first.analyzerVersion,digests:first.manifest!,evidenceCoreVersion:"4"});
  store.db.exec("create trigger fail_stream before insert on evidence_core_coverage begin select raise(abort,'stream insertion failed');end;");assert.throws(()=>store.putDelta(delta),/stream insertion failed/);assert.equal(store.revision(delta.revision),null);assert.equal(store.evidenceCoreBaseVersion(first.revision),"4");
});
test("budget and transport flags reject invalid values in both runtimes",async t=>{
  const root=setup(t);
  for(const [key,value]of [["CIE_EVIDENCE_CORE_MAX_ROWS","0"],["CIE_EVIDENCE_CORE_MAX_BYTES","536870913"],["CIE_EVIDENCE_CORE_CHUNK_BYTES","-1"],["CIE_EVIDENCE_CORE_TRANSPORT","unknown"]]){
    process.env[key]=value;assert.throws(evidenceCoreConfig,/CONFIG/);await assert.rejects(index(root),/invalid CIE_EVIDENCE_CORE/);delete process.env[key];
  }
  process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";process.env.CIE_EVIDENCE_CORE_CHUNK_ROWS="1";await assert.rejects(index(root),/scope or revision row cap/);
});

test("another connection sees the revision only after all chunks commit",async t=>{
  const root=setup(t);process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";const store=new Store(join(root,"test.db")),observer=new Store(join(root,"test.db"));t.after(()=>{observer.db.close();store.db.close();});const batch=await index(root);let observations=0;
  store.db.function("observe_stream",()=>{assert.equal(observer.revision(batch.revision),null);observations++;return 1;});
  store.db.exec("create trigger observe_chunk before insert on evidence_core_coverage begin select observe_stream();end;");
  store.putBatch(batch);assert.equal(observations,2);assert.ok(observer.revision(batch.revision));
});
test("cancelling a worker removes incomplete stream files without publishing a revision",async t=>{
  const root=setup(t),script=join(root,"interrupted.mjs");
  writeFileSync(script,`#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';process.stdin.once('data',()=>{writeFileSync(join(tmpdir(),'cie-handle-'+process.pid+'-1.core.jsonl'),'{"kind":"header"}\\n');});setInterval(()=>{},1000);\n`);chmodSync(script,0o700);
  const worker=new WorkerClient(script),pid=(worker as any).child.pid,path=join(tmpdir(),`cie-handle-${pid}-1.core.jsonl`),store=new Store(":memory:");t.after(()=>{worker.close();store.db.close();rmSync(path,{force:true});});
  const result=worker.index(root).then(()=>null,(error:Error)=>error);
  const deadline=Date.now()+3000;while(!existsSync(path)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(existsSync(path));
  worker.abort();assert.match((await result)!.message,/cancelled/);
  const cleanupDeadline=Date.now()+3000;while(existsSync(path)&&Date.now()<cleanupDeadline)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(!existsSync(path));assert.equal((store.db.prepare("select count(*) n from revisions").get() as {n:number}).n,0);
});
test("combined copied and incoming stream metadata must fit the revision budget",async t=>{
  const root=setup(t);process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";const worker=new WorkerClient(),store=new Store(":memory:");t.after(()=>{worker.close();store.db.close();});const first=await worker.index(root);store.putBatch(first);
  const count=(store.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n;
  writeFileSync(join(root,"a.ts"),'export function first(){return 17;}\n');const delta=await worker.index(root,120000,undefined,{revision:first.revision,analyzerVersion:first.analyzerVersion,digests:first.manifest!,evidenceCoreVersion:"4"});
  process.env.CIE_EVIDENCE_CORE_STREAM_MAX_ROWS=String(count-1);
  assert.throws(()=>store.putDelta(delta),/EVIDENCE_CORE_RESOURCE_LIMIT/);assert.equal(store.revision(delta.revision),null);assert.ok(store.revision(first.revision));
});

test("process death during staging recovers without a partial revision",async t=>{
  const root=setup(t);process.env.CIE_EVIDENCE_CORE_TRANSPORT="stream";const script=join(root,"crash.mjs"),db=join(root,"crash.db"),mark=join(root,"stream-path.txt");
  const workerModule=new URL("../src/worker.ts",import.meta.url).href,storeModule=new URL("../src/store.ts",import.meta.url).href,streamModule=new URL("../src/evidence-core-stream.ts",import.meta.url).href;
  writeFileSync(script,`import {writeFileSync} from 'node:fs';import {WorkerClient} from ${JSON.stringify(workerModule)};import {Store} from ${JSON.stringify(storeModule)};import {coreStreamPath,attachCoreStream} from ${JSON.stringify(streamModule)};const w=new WorkerClient();const batch=await w.index(${JSON.stringify(root)});w.close();writeFileSync(${JSON.stringify(mark)},coreStreamPath(batch));const s=new Store(${JSON.stringify(db)});s.db.function('crash_stream',()=>{process.kill(process.pid,'SIGKILL');return 0;});s.db.exec("create trigger crash_stage before insert on evidence_core_coverage begin select crash_stream();end;");s.putBatch(batch);process.exit(99);`);
  const child=spawnSync(process.execPath,[script],{encoding:"utf8",timeout:15000});assert.equal(child.signal,"SIGKILL",child.stderr);const path=readFileSync(mark,"utf8");t.after(()=>rmSync(path,{force:true}));
  const recovered=new Store(db);try{assert.equal((recovered.db.prepare("select count(*) n from revisions").get() as {n:number}).n,0);assert.equal((recovered.db.prepare("select count(*) n from evidence_core_links").get() as {n:number}).n,0);assert.equal(Object.values(recovered.db.prepare("pragma integrity_check").get()!)[0],"ok");}finally{recovered.db.close();}
  if(process.platform==="linux"){
    const lease=readdirSync(tmpdir()).find(name=>name.startsWith(basename(path)+".lease-"));assert.ok(lease);
    renameSync(path,join(root,basename(path)));renameSync(join(tmpdir(),lease),join(root,lease));
    assert.equal(cleanupStaleCoreStreams(root),0,"recent crash handles are retained");
    assert.equal(cleanupStaleCoreStreams(root,Date.now()+CORE_STREAM_STALE_MS+1000),1);
    assert.ok(!existsSync(join(root,basename(path))));assert.ok(!existsSync(join(root,lease)));
  }
});

test("inline and stream revisions can alternate as compatible delta bases",async t=>{
  const root=setup(t),store=new Store(":memory:"),clean=new Store(":memory:");t.after(()=>{store.db.close();clean.db.close();});
  let base:import("@cie/schema").BaseRevision|undefined;
  for(const [i,transport]of ["inline","stream","inline"].entries()){
    process.env.CIE_EVIDENCE_CORE_TRANSPORT=transport;writeFileSync(join(root,"a.ts"),`export function first(){return ${50+i};}\n`);
    const worker=new WorkerClient();try{const batch=await worker.index(root,120000,undefined,base);if(base){assert.equal(batch.mode,"delta");store.putDelta(batch);}else store.putBatch(batch);base={revision:batch.revision,analyzerVersion:batch.analyzerVersion,digests:batch.manifest!,evidenceCoreVersion:store.evidenceCoreBaseVersion(batch.revision)};}finally{worker.close();}
  }
  const full=await index(root);clean.putBatch(full);assert.deepEqual(rows(store,base!.revision),rows(clean,full.revision));
});

test("repository-scoped chunks validate empty owner manifests atomically",t=>{
  const root=setup(t),revision="root-stream",scope={kind:"REPOSITORY" as const},manifest={"":"root"},input=evidenceCoreManifestInput(manifest),output=evidenceCoreIdentity("output",["root",[]]),id=evidenceCoreIdentity("run",["cie.rust.static","4","v1",scope,input,output]);
  const core={schema:"cie.evidence-core.batch.v1",producerRuns:[{id,producerId:"cie.rust.static",producerVersion:"4",analyzerVersion:"v1",revision,scope,status:"PARTIAL",inputDigest:input,outputDigest:output}],links:[],coverage:[{id:evidenceCoreIdentity("coverage",[id,"static.observations"]),producerRunId:id,revision,scope,domain:"static.observations",status:"PARTIAL",exclusions:["reflection","dynamic dispatch","external dependencies","async delivery","generated or excluded sources"],unresolved:["No closed-world completeness claim; parser diagnostics remain authoritative"]}]};
  const path=join(root,"root-metadata.jsonl");writeFileSync(path,[{kind:"header",schema:"cie.evidence-core.stream.v1",revision},{kind:"chunk",sequence:0,scope:"",core},{kind:"footer",chunks:1,sha256:""}].map(r=>JSON.stringify(r)).join("\n")+"\n");rewrite(path,r=>r);
  const batch:import("@cie/schema").AnalysisBatch={revision,repoRoot:root,gitHead:null,analyzerVersion:"v1",entities:[],facts:[],relationships:[],diagnostics:[],manifest};attachCoreStream(batch,path);
  const store=new Store(":memory:");try{store.putBatch(batch);assert.equal(store.evidenceCoreBaseVersion(revision),"4");assert.ok(!existsSync(path));}finally{store.db.close();}
});
