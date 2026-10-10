import {test} from "node:test";
import assert from "node:assert/strict";
import {ResponseManifestSchema, CHART_REGISTRY} from "@cie/schema";
import {matchConcerns, type PlanningContext} from "../src/answer-planning.ts";
import {planResponse} from "../src/plugins/steps/index.ts";
import {bindSelectedChart, responsePortfolio} from "../src/response-portfolio.ts";
import {compiledTable} from "./table-fixture.ts";
const context=(question:string):PlanningContext=>({question,primaryCode:"S23",catalog:[],views:[],scope:"repository",availability:new Map()});
test("whole-word classification avoids incidental matches",()=>{
 for(const q of ["latest report", "clock skew", "database clock", "dataflow labels", "stylesheet colors"]){const matches=matchConcerns(q);assert.ok(!matches.some(m=>m.concern==="Quality"),q);assert.ok(!matches.some(m=>m.concern==="Concurrency"),q);}
 assert.deepEqual(matchConcerns("latest clock stylesheet report"),[]);
});
test("explicit query perspective follows mention order rather than object declaration order",()=>{
 const a=planResponse(context("Find failure recovery then data schema"));assert.equal(a.plan!.intent,"reliability");assert.deepEqual(a.plan!.concerns.slice(0,2),["Reliability","Data"]);assert.equal(a.plan!.classification!.basis,"keyword");
 const b=planResponse(context("Show data schema then failure recovery"));assert.equal(b.plan!.intent,"data");
 assert.equal(a.plan!.primaryCode,"S23");
});
test("named chart receives a bonus within its concern and explains why",()=>{
 const p=planResponse(context("Show data using a Data flow diagram"));assert.equal(p.plan!.supportingCodes[0],"S10");assert.ok(p.plan!.recommendations![0].reasons.some(r=>r.includes("named in the question")));
});
test("recommendations cover concerns, stay bounded and do not include unavailable views",()=>{
 const input=context("data schema, failure recovery, parallel threads, security tests");input.evidenceKinds={function:2};input.catalog=[{code:"V10",formId:"RaceWindow",name:"Race window",available:true}] as PlanningContext["catalog"];
 const p=planResponse(input).plan!;assert.equal(p.supportingCodes.length,3);assert.ok(!p.supportingCodes.includes("S9"));assert.ok(!p.supportingCodes.includes("S29"));assert.ok(p.supportingCodes.includes("V10"));assert.equal(new Set(p.supportingCodes).size,p.supportingCodes.length);assert.deepEqual(p.recommendations!.map(r=>r.code),p.supportingCodes);
});
test("catalog discovery order and repeated terms cannot destabilize ranking",()=>{
 const entries=[{code:"V10",formId:"RaceWindow",name:"Race window",available:true},{code:"V12",formId:"TestCoverage",name:"Test coverage",available:true}] as PlanningContext["catalog"];
 const a=context("parallel threads and test coverage"),b=context(a.question);a.catalog=entries;b.catalog=[...entries].reverse();assert.deepEqual(planResponse(a).plan,planResponse(b).plan);
 const p=planResponse(context("data data data data schema"));assert.deepEqual(p.plan!.classification!.matches.find(m=>m.concern==="Data")!.terms,["data","schema"]);
});
test("classification fallback is explicit and unknown preflight is not claimed as verified",()=>{
 const p=planResponse(context("Explain this"));assert.equal(p.plan!.classification!.basis,"primary-view");assert.equal(p.plan!.evidenceStatus,"not-checked");assert.ok(p.plan!.recommendations!.every(r=>r.reasons.some(s=>s.includes("has not been checked"))));
 const c=context("Explain this");c.primaryCode="unknown";assert.equal(planResponse(c).plan!.classification!.basis,"general");assert.deepEqual(c.plan!.supportingCodes,[]);
});
test("portfolio exposes recommendation reasons without replacing availability reasons",()=>{
 const m=responsePortfolio({views:[compiledTable("S11")],catalog:[],question:"Explain data schema and failure recovery"});assert.equal(m.policyVersion,"portfolio.v4");assert.ok(ResponseManifestSchema.safeParse(m).success);
 for(const r of m.plan!.recommendations!){const v=m.views.find(v=>v.code===r.code)!;assert.deepEqual(v.recommendation,{score:r.score,reasons:r.reasons});assert.match(v.reason!,/not been checked/);assert.equal(v.status,"available");assert.ok(v.relevant);}
 assert.equal(m.views[0].primary,true);assert.equal(m.views[0].code,"S11");
 const legacy={...m,policyVersion:"portfolio.v3",plan:undefined,views:m.views.map(({recommendation,...v})=>v)};assert.ok(ResponseManifestSchema.safeParse(legacy).success);
});
test("preferred candidates are registered requestable notations",()=>{
 for(const q of ["structure architecture","behavior flow","data schema","state lifecycle","failure recovery"]){const c=planResponse(context(q));for(const code of c.plan!.supportingCodes){assert.ok(CHART_REGISTRY[code as keyof typeof CHART_REGISTRY]);assert.equal(c.availability.get(code)!.available,true);}}
});

test("singular and plural architecture and rule nouns map consistently",()=>{for(const q of ["class", "classes", "repository", "repositories"]){assert.equal(matchConcerns(q)[0].concern,"Structure");}for(const q of ["branch", "branches"]){assert.equal(matchConcerns(q)[0].concern,"State and rules");}});


test("native gallery choices remain primary instead of becoming an on-demand duplicate tab", () => {
 const original={...compiledTable("S11"),formId:"TestConfidence" as const,params:{}};
 const selected=bindSelectedChart(original,"S5");
 const portfolio=responsePortfolio({views:[selected],catalog:[],question:"Show the test-guarantee matrix"});
 assert.equal(portfolio.views[0].code,"S5");
 assert.equal(portfolio.views.filter(view=>view.code==="S5").length,1);
 assert.equal(portfolio.views[0].primary,true);
 assert.deepEqual(original.params,{});
 assert.equal(bindSelectedChart(original,"S28"),original,"a different form is not mislabeled");
 assert.equal(bindSelectedChart(original,"unknown"),original);
 const conflicting={...original,params:{chartId:"S2"}};
 assert.equal(bindSelectedChart(conflicting,"S5"),conflicting,"existing contradictory compiler identity is not overwritten");
});
