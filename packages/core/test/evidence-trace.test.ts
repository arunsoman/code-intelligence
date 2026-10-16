import {test} from "node:test";
import assert from "node:assert/strict";
import {appendFileSync,mkdtempSync,readFileSync,writeFileSync,unlinkSync,symlinkSync,mkdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setup,ctx,copyFixture} from "./helpers.ts";
import {bundleFor} from "../src/retrieval.ts";
import {traceBundle,traceEntities,viewEvidence} from "../src/evidence-trace.ts";
import {collectSnapshot} from "../src/evidence-snapshot.ts";
import {toolByName,type ToolEnv} from "../src/chat-tools.ts";
import {policyFor} from "../src/access.ts";
import type {ViewSpec} from "@cie/schema";
test("producer trails, legacy citations, freshness and access are independently enforced",async t=>{
  const before={...process.env};Object.assign(process.env,{CIE_EVIDENCE_CORE_MODE:"on",CIE_EVIDENCE_CORE_STRICT:"1"});
  t.after(()=>{process.env.CIE_EVIDENCE_CORE_MODE=before.CIE_EVIDENCE_CORE_MODE??"off";if(before.CIE_EVIDENCE_CORE_STRICT===undefined)delete process.env.CIE_EVIDENCE_CORE_STRICT;else process.env.CIE_EVIDENCE_CORE_STRICT=before.CIE_EVIDENCE_CORE_STRICT;});
  const root=copyFixture(),{svc,worker,revision}=await setup(undefined,root);t.after(()=>{worker.close();svc.store.db.close();});
  const entity=svc.store.entities(revision).find(e=>e.kind==="method"&&e.name.includes("login"))!;assert.ok(entity);
  const rev=svc.store.revision(revision)!,bundle=bundleFor(svc.store,revision,[entity.entityId]),resolve=(ev:any)=>svc.resolveEvidence(rev,ev);
  const trace=traceBundle(svc.store,bundle,resolve);
  assert.equal(trace.coverage,"PARTIAL");assert.equal(trace.provenance,"AVAILABLE");assert.ok(trace.items.length);
  assert.ok(trace.items.some(i=>i.sources.some(s=>s.producer?.id==="cie.rust.static"&&s.producer.version==="4")));
  assert.ok(trace.limitations.some(l=>l.includes("reflection")));
  const fact=bundle.facts.find(f=>f.evidence.some(e=>e.location.kind==="CodeLocation"))!;
  const limited=traceBundle(svc.store,{...bundle,relationships:[],facts:Array.from({length:100},(_,i)=>({...fact,id:`derived:${i}`}))},resolve);
  assert.equal(limited.items.length,40);assert.ok(limited.truncated);
  const env={svc,rev,ctx:ctx(),access:policyFor(svc.store,root),seen:new Map(),results:[],warnings:[]} as ToolEnv;
  const text=await toolByName.get("evidence_of")!.run!(env,{entity:entity.entityId});assert.match(text,/Coverage: PARTIAL/);assert.match(text,/cie.rust.static v4/);
  assert.equal(env.sourceReads?.size??0,0);assert.equal(env.irReads?.size??0,0,"provenance does not count as reading a body");
  const snapshot=collectSnapshot("How does login work?",bundle);svc.store.saveEvidenceSnapshot(snapshot);
  const view:ViewSpec={id:"v",version:1,revision,taskId:"t",formId:"SemanticMap",caption:"",question:snapshot.question,level:0,nodes:[],edges:[],groups:[],legend:[],gaps:[],cameraPolicy:{behavior:"PRESERVE"},evidenceProjection:{snapshotId:snapshot.id,omittedEntityIds:[],omittedRelationshipIds:[],omittedFactIds:[]}};
  viewEvidence(svc.store,view,resolve);assert.equal(view.evidenceTrace?.snapshotId,snapshot.id);assert.deepEqual(view.evidenceTrace?.items,trace.items,"chart notation does not replace the collection");
  for(const mode of ["off","shadow"]){process.env.CIE_EVIDENCE_CORE_MODE=mode;const legacy=traceBundle(svc.store,bundle,resolve);assert.equal(legacy.provenance,"UNAVAILABLE");assert.ok(legacy.items.length);assert.ok(legacy.items.every(i=>i.sources.every(s=>!s.producer)));}
  process.env.CIE_EVIDENCE_CORE_MODE="on";
  svc.store.denyPath(root,entity.file);assert.deepEqual(traceBundle(svc.store,bundle,resolve).items,[]);svc.store.denyPath(root,entity.file,false);
  appendFileSync(join(root,entity.file),"\n// source changed after indexing\n");assert.deepEqual(traceBundle(svc.store,bundle,resolve).items,[]);
  svc.store.setRevoked(root,true);assert.deepEqual(traceBundle(svc.store,bundle,resolve).items,[]);
});
test("source inspection refuses same-content symlinks outside or into denied files",async t=>{
  const root=copyFixture(),outside=mkdtempSync(join(tmpdir(),"cie-trace-outside-"));t.after(()=>rmSync(outside,{recursive:true,force:true}));
  const {svc,worker,revision}=await setup(undefined,root);t.after(()=>{worker.close();svc.store.db.close();});
  const entity=svc.store.entities(revision).find(e=>e.kind==="method"&&e.name.includes("login"))!,path=join(root,entity.file),source=readFileSync(path),rev=svc.store.revision(revision)!;
  const bundle=bundleFor(svc.store,revision,[entity.entityId]);mkdirSync(join(root,"denied"));
  for(const target of [join(outside,"outside.ts"),join(root,"denied","secret.ts")]){
    writeFileSync(target,source);unlinkSync(path);symlinkSync(target,path);svc.store.denyPath(root,"denied");
    assert.deepEqual(traceBundle(svc.store,bundle,e=>svc.resolveEvidence(rev,e)).items,[]);
    const code=svc.entityCode(ctx(),{revision,entityId:`file:${entity.file}`});assert.ok(code.ok);assert.equal(code.value.text,"");assert.ok(["WITHHELD","UNAVAILABLE"].includes(code.value.state));
    unlinkSync(path);writeFileSync(path,source);
  }
});
test("ask and conversation expose evidence without promoting answer validation",async t=>{
  const {svc,worker,revision}=await setup();t.after(()=>{worker.close();svc.store.db.close();});
  const chart=await svc.ask(ctx(),{question:"Show AuthService",revision,form:"SemanticMap"});assert.ok(chart.ok);assert.equal(chart.value.view.evidenceTrace?.coverage,"PARTIAL");assert.ok(chart.value.view.evidenceTrace?.items.length);
  const result=await svc.converse(ctx(),{text:"Explain this project, identify its riskiest module, and show me the tests covering it.",revision});assert.ok(result.ok);
  assert.ok(["analysis","view"].includes(result.value.kind));assert.equal(result.value.evidenceTrace?.coverage,"PARTIAL");assert.ok(result.value.evidenceTrace?.items.length);
  if(result.value.kind==="analysis")assert.ok(result.value.results.filter(r=>r.view).every(r=>r.view!.evidenceTrace?.revision===revision));
});
