import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StubProvider, modelEvidence } from "@cie/model";
import type { ModelRequest, ModelProvider } from "@cie/schema";
import { OPEN } from "../src/access.ts";
import { bindSubjects, investigate } from "../src/investigation.ts";
import { retrieveForQuestion } from "../src/retrieval.ts";
import { ctx, setup } from "./helpers.ts";

async function fixture(t: TestContext, model: ModelProvider = new StubProvider()) {
  const repo=mkdtempSync(join(tmpdir(),"cie-investigation-"));
  cpSync(resolve(import.meta.dirname,"../../../fixtures/sample-repo"),repo,{recursive:true});
  writeFileSync(join(repo,"agent.ts"),`import { executeChatPlan as execute } from './execution.js';
export function runChatAgent() { systemPrompt(); execute(); brief(); shadow(() => 1); }
function systemPrompt() { return 'prompt'; }
const brief = () => systemPrompt();
function shadow(systemPrompt: () => number) { return systemPrompt(); }
export function unrelatedGenerateProjectFlow() { return 'distractor'; }
export function dispatcher() { runChatAgent(); unrelatedGenerateProjectFlow(); }
`);
  writeFileSync(join(repo,"execution.ts"),`export function executeChatPlan() { return projectDescription(); }
function projectDescription() { return 'description'; }
`);
  const result=await setup(model,repo);
  t.after(()=>{result.worker.close();result.svc.store.db.close();rmSync(repo,{recursive:true,force:true});});
  const rev=result.svc.store.revision(result.revision)!;
  const entities=result.svc.store.entities(result.revision);
  const id=(name:string)=>entities.find(e=>e.name===name)!.entityId;
  return {...result,repo,rev,entities,id,resolveEvidence:(ev:Parameters<typeof result.svc.resolveEvidence>[1])=>result.svc.resolveEvidence(rev,ev)};
}

test("subject binding prefers the matching entry point over broad helper/file matches and preserves explicit seeds",async t=>{
  const f=await fixture(t);
  assert.deepEqual(bindSubjects(f.entities,"explain the flow","chat agent").roots,[f.id("runChatAgent")]);
  assert.deepEqual(bindSubjects(f.entities,"unrelated project flow",undefined,[f.id("runChatAgent")]).roots,[f.id("runChatAgent")]);
  assert.deepEqual(bindSubjects(f.entities,"Draw the UML sequence for runChatAgent calling its helpers").roots,[f.id("runChatAgent")]);
  assert.deepEqual(bindSubjects(f.entities,"Draw the UML sequence for AuthService.login").roots,[f.id("AuthService.login")]);
  assert.equal(bindSubjects(f.entities,"zebra migration").status,"unbound");
  const duplicate={...f.entities.find(e=>e.name==="runChatAgent")!,entityId:"function:other.ts#runChatAgent",file:"other.ts"};
  assert.equal(bindSubjects([...f.entities,duplicate],"runChatAgent").status,"ambiguous");
});

test("missing indexed calls are recovered from current direct bindings, including import aliases, without inventing callback edges",async t=>{
  const f=await fixture(t);
  f.svc.store.db.prepare("delete from relationships where revision=? and kind='calls'").run(f.revision);
  const r=investigate(f.svc.store,f.revision,"explain the chat agent flow",{subject:"chat agent",access:OPEN,resolveEvidence:f.resolveEvidence,budget:{maxMs:3000}});
  assert.equal(r.report.binding.status,"bound");
  const pair=(from:string,to:string)=>r.relationships.some(e=>e.from===f.id(from)&&e.to===f.id(to)&&e.kind==="calls");
  assert.ok(pair("runChatAgent","systemPrompt"));
  assert.ok(pair("runChatAgent","executeChatPlan"));
  assert.ok(pair("runChatAgent","brief"));
  assert.ok(pair("brief","systemPrompt"));
  assert.ok(pair("executeChatPlan","projectDescription"));
  assert.ok(!pair("shadow","systemPrompt"),"a shadowing callback parameter is not the same-file helper");
  assert.equal(r.report.outcome,"partial");
  assert.ok(r.report.counts.recoveredRelationships>=3);
  for(const edge of r.relationships.filter(r=>r.id.startsWith("recovered-call:")))assert.equal(f.resolveEvidence(edge.evidence[0]!).state,"CURRENT");
});

test("recovery feeds one shared, revision-bound model bundle and preserves subject seeds through hierarchy navigation",async t=>{
  const f=await fixture(t);
  assert.ok((await f.svc.buildConceptHierarchy(ctx(),{revision:f.revision})).ok);
  f.svc.store.db.prepare("delete from relationships where revision=? and kind='calls'").run(f.revision);
  const r=retrieveForQuestion(f.svc.store,f.revision,"explain runChatAgent flow",{forModel:true,scope:"subject",subject:"runChatAgent",extraSeeds:[f.id("runChatAgent")],access:OPEN,resolveEvidence:f.resolveEvidence,tokenBudget:12000});
  assert.ok(r.bundle.entities.some(e=>e.entityId===f.id("runChatAgent")));
  assert.ok(!r.bundle.entities.some(e=>e.entityId===f.id("unrelatedGenerateProjectFlow")), "caller context must not expand into unrelated branches");
  assert.ok(r.bundle.relationships.some(r=>r.from===f.id("runChatAgent")&&r.to===f.id("executeChatPlan")));
  assert.equal(r.bundle.investigation?.revision,f.revision);
  const payload=modelEvidence({purpose:"CHART",bundle:r.bundle});
  assert.deepEqual(payload.investigation?.binding,r.bundle.investigation?.binding);
  assert.ok(!("timings" in payload.investigation!), "timing noise must not invalidate the chart cache");
  assert.equal(r.bundle.tokenEstimate,Math.ceil(JSON.stringify(payload).length/4));
  assert.ok(r.bundle.tokenEstimate<=12000);
  const repeated=retrieveForQuestion(f.svc.store,f.revision,"explain runChatAgent flow",{forModel:true,scope:"subject",subject:"runChatAgent",extraSeeds:[f.id("runChatAgent")],access:OPEN,resolveEvidence:f.resolveEvidence,tokenBudget:12000});
  assert.equal(repeated.bundle.id,r.bundle.id,"same evidence keeps the chart cache identity despite different timings");
});

test("stale source is not promoted to a recovered edge and denied targets stay out of diagnostics",async t=>{
  const f=await fixture(t);
  f.svc.store.db.prepare("delete from relationships where revision=? and kind='calls'").run(f.revision);
  writeFileSync(join(f.repo,"agent.ts"),"export function runChatAgent() { executeChatPlan(); }\n");
  const r=investigate(f.svc.store,f.revision,"runChatAgent flow",{access:OPEN,resolveEvidence:f.resolveEvidence,budget:{maxMs:3000}});
  assert.equal(r.relationships.filter(r=>r.id.startsWith("recovered-call:")).length,0);
  assert.ok(r.report.gaps.some(g=>g.code==="SOURCE_STALE"));
  const access={prefixes:["execution.ts"],denied:(file:string)=>file==="execution.ts",deniedEntity:(id:string)=>id.includes("execution.ts")};
  const hidden=investigate(f.svc.store,f.revision,"executeChatPlan flow",{access,resolveEvidence:f.resolveEvidence});
  assert.equal(hidden.report.binding.status,"unbound");
  assert.ok(!JSON.stringify(hidden).includes("function:execution.ts"));
});

test("bounded investigation reports exhaustion and ambiguous subjects do not acquire guessed roots",async t=>{
  const f=await fixture(t);
  const r=investigate(f.svc.store,f.revision,"runChatAgent flow",{access:OPEN,resolveEvidence:f.resolveEvidence,budget:{maxEntities:1,maxSourceFiles:0,maxMs:3000}});
  assert.ok(r.report.gaps.some(g=>g.code==="BUDGET_EXHAUSTED"));
  assert.ok(r.seeds.length<=1);
  const unbound=investigate(f.svc.store,f.revision,"nothingLikeThis flow",{access:OPEN,resolveEvidence:f.resolveEvidence});
  assert.equal(unbound.report.outcome,"unbound");
  assert.equal(unbound.relationships.length,0);
});

test("source recovery does not turn strings, comments, mutable functions or callbacks into verified edges",async t=>{
  const f=await fixture(t);
  writeFileSync(join(f.repo,"agent.ts"),`export function runChatAgent() { const text = "neverCalled()"; /* neverCalled(); */ stable(); changed(); external.send(); [1].map(() => neverCalled()); }
function stable() { return 1; }
function changed() { return 1; }
changed = () => 2;
function neverCalled() { return 0; }
`);
  const indexed=await f.svc.ingestRepository(ctx(),{repoPath:f.repo});assert.ok(indexed.ok);
  const revision=indexed.value.id,rev=f.svc.store.revision(revision)!;
  f.svc.store.db.prepare("delete from relationships where revision=? and kind='calls'").run(revision);
  const r=investigate(f.svc.store,revision,"runChatAgent flow",{access:OPEN,resolveEvidence:ev=>f.svc.resolveEvidence(rev,ev),budget:{maxMs:3000}});
  const recovered=r.relationships.filter(e=>e.id.startsWith("recovered-call:"));
  assert.ok(recovered.some(e=>e.to.endsWith("#stable")));
  assert.ok(!recovered.some(e=>e.to.endsWith("#changed")||e.to.endsWith("#neverCalled")));
  assert.equal(r.report.outcome,"partial");
});

test("answer and chart requests share recovered evidence and unsupported exclusivity is rejected",async t=>{
  const requests:ModelRequest[]=[],stub=new StubProvider();
  const model:ModelProvider={name:"spy",model:"test",hosted:false,async generate(req){
    requests.push(req);
    if(req.purpose==="SOURCE_OVERVIEW"){
      const root=req.bundle.investigation!.binding.roots[0]!;
      const excerpt=req.bundle.facts.find(f=>f.subject===root&&f.predicate==="source_excerpt")!;
      return {statements:[{text:"The only chat-pipeline function is executeChatPlan.",entityIds:[root],evidenceIds:[excerpt.evidence[0]!.id]}],limits:["A complete call-flow diagram cannot be drawn from this sample."]};
    }
    return stub.generate(req);
  }};
  const f=await fixture(t,model);
  assert.ok((await f.svc.buildConceptHierarchy(ctx(),{revision:f.revision})).ok);
  f.svc.store.db.prepare("delete from relationships where revision=? and kind='calls'").run(f.revision);
  const response=await f.svc.ask(ctx(),{question:"Explain the runChatAgent call flow",subject:"runChatAgent",revision:f.revision,chartCode:"S28",scope:"subject"});
  assert.ok(response.ok, JSON.stringify(response));
  assert.match(response.value.view.answer ?? "",/runChatAgent/);
  assert.doesNotMatch(response.value.view.answer ?? "",/only chat|cannot be drawn/);
  const answer=requests.find(r=>r.purpose==="SOURCE_OVERVIEW")!,chart=requests.find(r=>r.purpose==="CHART")!;
  assert.ok(answer&&chart);
  assert.equal(answer.bundle.id,chart.bundle.id);
  assert.ok(chart.bundle.relationships.some(r=>r.from.endsWith("#runChatAgent")&&r.to.endsWith("#executeChatPlan")));
  assert.ok(response.value.view.evidenceInvestigation);
  assert.equal(response.metadata.completeness,"PARTIAL");
});

test("token trimming reports omitted investigated context and retains the bound entry point",async t=>{
  const f=await fixture(t);
  const r=retrieveForQuestion(f.svc.store,f.revision,"runChatAgent flow",{forModel:true,scope:"subject",subject:"runChatAgent",resolveEvidence:f.resolveEvidence,tokenBudget:1000});
  assert.ok(r.bundle.entities.some(e=>e.entityId===f.id("runChatAgent")));
  assert.equal(r.bundle.investigation?.outcome,"partial");
  assert.ok(r.bundle.investigation?.gaps.some(g=>g.code==="CONTEXT_OMITTED"));
});

test("snapshot collection is chart-independent, survives trimming, and persists without exposing denied entities",async t=>{
  const f=await fixture(t);
  const options={forModel:true,subject:'runChatAgent',resolveEvidence:f.resolveEvidence};
  const first=retrieveForQuestion(f.svc.store,f.revision,'runChatAgent flow',{...options,tokenBudget:100000});
  const second=retrieveForQuestion(f.svc.store,f.revision,'runChatAgent flow',{...options,tokenBudget:150,requireKinds:['class','method']});
  assert.equal(first.snapshot.id,second.snapshot.id);
  assert.ok(second.snapshot.bundle.entities.length>second.bundle.entities.length);
  assert.ok(second.bundle.projection!.omittedEntityIds.length>0);
  assert.ok(second.snapshot.findings.some(f=>f.kind==='relationship'));
  assert.ok(second.snapshot.findings.every(f=>f.evidenceIds.length>0));
  const persisted=f.svc.store.db.prepare('select json from query_evidence_snapshots where id=?').get(second.snapshot.id) as {json:string};
  assert.equal(JSON.parse(persisted.json).id,second.snapshot.id);
  const denied=retrieveForQuestion(f.svc.store,f.revision,'runChatAgent flow',{...options,access:{...OPEN,deniedEntity:(id,getFile)=>(getFile?.(id) ?? /^[a-z]+:([^#]+)/.exec(id)?.[1])==='execution.ts'}});
  assert.ok(!denied.snapshot.bundle.entities.some(e=>e.file==='execution.ts'));
  assert.ok(!JSON.stringify(denied.snapshot.findings).includes('function:execution.ts'));
});

test('canonical findings exclude unresolved records and non-current evidence',async t=>{
  const { collectSnapshot }=await import('../src/evidence-snapshot.ts');
  const f=await fixture(t);
  const r=retrieveForQuestion(f.svc.store,f.revision,'runChatAgent flow',{forModel:true,subject:'runChatAgent',resolveEvidence:f.resolveEvidence});
  const copy=structuredClone(r.snapshot.bundle);
  copy.relationships.forEach(edge=>{edge.resolution='UNRESOLVED';});
  copy.facts.forEach(fact=>{fact.resolution='UNRESOLVED';});
  assert.equal(collectSnapshot('flow',copy).findings.length,0);
  const stale=structuredClone(r.snapshot.bundle);
  stale.evidence.forEach(ev=>{ev.state='STALE';});
  assert.equal(collectSnapshot('flow',stale).findings.length,0);
});
