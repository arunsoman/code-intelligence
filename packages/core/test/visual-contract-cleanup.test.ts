import {test} from "node:test";
import assert from "node:assert/strict";
import {TableSpecSchema,ChartOutputV2} from "@cie/schema";
import {compiledTable} from "./table-fixture.ts";
import {erBundle} from "./er-fixture.ts";
import {compileChartPlan} from "../src/chart-creator.ts";
test("idempotency uses operation/scenario cells with explicit unknown concurrency",()=>{const v=compiledTable("S14"),t=v.table!;assert.ok(TableSpecSchema.safeParse(t).success);assert.equal(t.rows.length,1);assert.equal(t.columns.length,2);assert.match(t.rows[0].cells[0].text,/Idempotent\?.*state-exists check.*batchId/);assert.equal(t.rows[0].cells[1].status,"unknown");assert.deepEqual(t.rows[0].cells[1].evidenceIds,[]);assert.equal(v.edges.length,0);assert.ok(v.gaps.some(g=>g.includes("concurrent duplicate")));});
test("idempotency preserves conflicting outcomes without silently choosing a guarantee",()=>{const cells=[{operationId:"reserve",scenarioId:"reserve",outcome:"idempotent",evidenceIds:["ev:1"]},{operationId:"reserve",scenarioId:"reserve",outcome:"rejected",evidenceIds:["ev:1"]}];const c=compiledTable("S14",{cells}).table!.rows[0].cells[0];assert.equal(c.status,"conflict");assert.match(c.text,/Idempotent\?.*Rejected\?/);});
test("idempotency rejects stale assertions and duplicate axes and discloses missing references",()=>{const v=compiledTable("S14",{scenarios:[{id:"same",label:"Same"},{id:"same",label:"Duplicate"}],cells:[{operationId:"reserve",scenarioId:"same",outcome:"idempotent",evidenceIds:["missing"]},{operationId:"ghost",scenarioId:"same",outcome:"rejected",evidenceIds:["ev:1"]}]});assert.equal(v.table!.columns.length,1);assert.equal(v.table!.rows[0].cells[0].status,"unknown");assert.ok(v.gaps.some(g=>g.includes("Duplicate scenario")));assert.ok(v.gaps.some(g=>g.includes("missing operation")));});
test("model-projected reliability connections never upgrade citations to runtime guarantees",()=>{
 const plan=ChartOutputV2.parse({contractVersion:"chart.v2",chartId:"S13",chartType:"Outbox topology",caption:"Writes",layout:"flow",nodes:[],edges:[],elements:[{id:"writer",label:"Writer",kind:"writer",evidenceIds:["ev:1"]},{id:"store",label:"Store",kind:"outboxStore",evidenceIds:["ev:1"]}],flows:[{from:"writer",to:"store",kind:"transactionalWrite",isAtomic:true,evidenceIds:["ev:1"]}]});
 const v=compileChartPlan({plan,bundle:erBundle,rev:{id:"rev",repoRoot:"/r",gitHead:null,createdAt:"t",analyzerVersion:"t",diagnostics:[],fileCount:2},question:"Outbox",route:{source:"chosen",confidence:"high",form:"GeneratedChart",name:"Outbox",because:"",alternatives:[]},chartId:"S13"}).view;
 assert.equal(v.edges.length,1);assert.equal(v.edges[0].displayMode,"INFERENCE");assert.ok(v.gaps.some(g=>g.includes("atomicity")));assert.ok(v.legend.every(l=>l.label!=="Transactional write"));
});
test("offline idempotency output remains schema-valid on large repositories without inventing replay guarantees",async()=>{
 const {StubProvider}=await import("../../model/src/stub.ts");const {SCHEMA_CHART_V2}=await import("@cie/schema");
 const bundle={...erBundle,entities:Array.from({length:80},(_,i)=>({entityId:`f:${i}`,kind:"function",name:`operation${i}`,file:"ops.ts",spans:[]}))};
 const plan=ChartOutputV2.parse(await new StubProvider().generate({purpose:"CHART",schemaId:SCHEMA_CHART_V2,question:"Idempotency",bundle,chartId:"S14"}));
 if(plan.chartId!=="S14")throw new Error("Wrong chart");assert.equal(plan.operations.length,40);assert.equal(plan.scenarios.length,3);assert.equal(plan.cells.length,120);assert.ok(plan.cells.every(c=>c.outcome==="unknown" && c.evidenceIds.length===0));assert.ok(plan.scenarios.every(s=>s.label.includes("unverified")));
});
