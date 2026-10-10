import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { CHART_REGISTRY } from "@cie/schema";
import { StubProvider } from "@cie/model";
import { retrieveForQuestion } from "../src/retrieval.ts";
import { chartCreatorRequest, compileChartPlan } from "../src/chart-creator.ts";
import { setup } from "./helpers.ts";
const fixture=resolve(import.meta.dirname,"../../../fixtures/native-tables-repo");
test("repository-wide chart kinds independently retrieve metric emitters without lexical matches",async()=>{
 const {svc,worker,revision}=await setup(undefined,fixture);
 try {
  const descriptor=CHART_REGISTRY.S26;
  const result=retrieveForQuestion(svc.store,revision,"zznonmatchingqueryzz",{maxNodes:0,forModel:true,tokenBudget:20000,requireKinds:descriptor.requiredKinds,requireAcrossRepositoryKinds:descriptor.requiredAcrossRepository});
  assert.equal(descriptor.requiredKinds.length,0);assert.ok(result.bundle.facts.some(f=>f.predicate==="metric_declaration"));
  assert.ok(result.bundle.entities.some(e=>e.name==="PaymentService.submit"));assert.ok(result.bundle.entities.some(e=>e.name==="PaymentService.retry"));
  const generated=await new StubProvider().generate(chartCreatorRequest("Metrics",result.bundle,"S26"));
  const {ChartOutputV2}=await import("@cie/schema");const plan=ChartOutputV2.parse(generated);
  const view=compileChartPlan({plan,bundle:result.bundle,rev:svc.store.revision(revision)!,question:"Metrics",chartId:"S26",route:{source:"chosen",confidence:"high",form:"GeneratedChart",name:"Metrics",because:"",alternatives:[]}}).view;
  assert.deepEqual(view.table!.rows.map(r=>r.label).sort(),["payment.retried","payment.submitted"]);assert.ok(view.table!.rows.every(r=>r.cells[1].evidenceIds.length>0));
 } finally {worker.close();}
});
test("repository-wide top-up respects ignored emitters and never brings back their facts",async()=>{
 const {svc,worker,revision}=await setup(undefined,fixture);
 try {
  const ignored=new Set(svc.store.factsByPredicate(revision,"metric_declaration").map(f=>f.subject));
  const result=retrieveForQuestion(svc.store,revision,"zznonmatchingqueryzz",{maxNodes:0,forModel:true,requireAcrossRepositoryKinds:["method"],ignored});
  assert.ok(result.bundle.entities.some(e=>e.kind==="method"));assert.ok(result.bundle.entities.every(e=>!ignored.has(e.entityId)));assert.equal(result.bundle.facts.filter(f=>f.predicate==="metric_declaration").length,0);
 } finally {worker.close();}
});
test("repository-wide top-up remains subject to the model token budget",async()=>{
 const {svc,worker,revision}=await setup(undefined,fixture);
 try {
  const result=retrieveForQuestion(svc.store,revision,"zznonmatchingqueryzz",{maxNodes:0,forModel:true,tokenBudget:1,requireAcrossRepositoryKinds:["method"]});
  assert.equal(result.bundle.entities.filter(e=>e.kind==="method").length,0);assert.equal(result.bundle.facts.filter(f=>f.predicate==="metric_declaration").length,0);assert.ok(result.hidden.some(h=>h.reason.includes("token budget")));
 } finally {worker.close();}
});
test("repository-wide top-up cannot bypass denied source access",async()=>{
 const {svc,worker,revision}=await setup(undefined,fixture);
 try {
  const result=retrieveForQuestion(svc.store,revision,"zznonmatchingqueryzz",{maxNodes:0,forModel:true,requireAcrossRepositoryKinds:["method"],access:{prefixes:["src"],denied:()=>true,deniedEntity:()=>true}});
  assert.equal(result.bundle.entities.length,0);assert.equal(result.bundle.facts.length,0);assert.equal(result.bundle.evidence.length,0);assert.doesNotMatch(JSON.stringify(result.bundle),/PaymentService|payment\.submitted|payment\.retried/);
 } finally {worker.close();}
});
