import test from "node:test";
import assert from "node:assert/strict";
import { TableSpecSchema } from "@cie/schema";
import { compiledTable } from "./table-fixture.ts";
const ev=["ev:1"];
test("CRC responsibilities and collaborators are separate citation boundaries",()=>{
 const view=compiledTable("S20",{cards:[{className:"Service",evidenceIds:ev,responsibilities:[{text:"Submit",evidenceIds:ev},{text:"Invented responsibility",evidenceIds:[]}],collaborators:[{className:"Store",evidenceIds:["missing"]}]}]});
 assert.ok(TableSpecSchema.safeParse(view.table).success);const cells=view.table!.rows[0].cells;
 assert.equal(cells[0].text,"Submit");assert.equal(cells[1].status,"unknown");assert.deepEqual(cells[1].evidenceIds,[]);assert.ok(view.gaps.some(g=>g.includes("collaborators")));assert.doesNotMatch(view.nodes[0].notes!.join(" "),/Invented responsibility|Store/);
});
test("CRC parent declarations cannot borrow member evidence and duplicate class names are disclosed",()=>{
 const card={className:"Known",evidenceIds:ev,responsibilities:[],collaborators:[]};const view=compiledTable("S20",{cards:[{...card,className:"Unknown",evidenceIds:[],responsibilities:[{text:"Submit",evidenceIds:ev}]},card,{...card,responsibilities:[{text:"Replacement",evidenceIds:ev}]}]});
 assert.equal(view.table!.rows.length,1);assert.equal(view.table!.rows[0].label,"Known");assert.equal(view.table!.rows[0].cells[0].status,"unknown");assert.ok(view.gaps.some(g=>g.includes("Duplicate row")));assert.ok(view.gaps.some(g=>g.includes("Unknown was omitted")));
});
test("CRC cells preserve deduplicated lists and aggregate only supported entry citations",()=>{
 const view=compiledTable("S20",{cards:[{className:"Service",evidenceIds:ev,responsibilities:[{text:"Submit",evidenceIds:ev},{text:"Submit",evidenceIds:ev},{text:"Cancel",evidenceIds:ev}],collaborators:[{className:"Store",evidenceIds:ev}]}]});
 assert.equal(view.table!.rows[0].cells[0].text,"Submit\nCancel");assert.deepEqual(view.table!.rows[0].cells[0].evidenceIds,ev);assert.equal(view.table!.rows[0].cells[1].text,"Store");
});
test("metric metadata does not imply live values or validate uncited emitters",()=>{
 const view=compiledTable("S26",{metrics:[{id:"success",name:"payment.success",meaning:"Successful payment",evidenceIds:ev,emitters:[{label:"submit",evidenceIds:ev},{label:"fabricatedEmitter",evidenceIds:[]}]},{id:"retry",name:"payment.retry",evidenceIds:ev,emitters:[]}]});
 assert.ok(TableSpecSchema.safeParse(view.table).success);assert.equal(view.table!.rows[0].cells[1].text,"submit");assert.equal(view.table!.rows[1].cells[0].status,"unknown");assert.equal(view.table!.rows[1].cells[1].status,"unknown");assert.ok(view.gaps.some(g=>g.includes("no live values")));assert.ok(view.nodes.every(n=>n.displayMode==="INFERENCE"));assert.equal(view.edges.length,0);
});
test("uncited metric declarations are omitted even with a grounded emitter",()=>{
 const view=compiledTable("S26",{metrics:[{id:"ghost",name:"ghost.metric",evidenceIds:[],emitters:[{label:"submit",evidenceIds:ev}]}]});
 assert.equal(view.table!.rows.length,0);assert.ok(view.gaps.some(g=>g.includes("ghost.metric was omitted")));
});
test("transition citations cannot establish a missing state or event declaration",()=>{
 const view=compiledTable("S24",{states:[{id:"new",label:"New",evidenceIds:[]},{id:"done",label:"Done",evidenceIds:ev}],events:[{id:"submit",label:"Submit",evidenceIds:[]}],cells:[{stateId:"new",eventId:"submit",nextStateId:"done",evidenceIds:ev}]});
 assert.equal(view.table!.rows.length,1);assert.equal(view.table!.columns.length,0);assert.ok(view.gaps.some(g=>g.includes("State New")));assert.ok(view.gaps.some(g=>g.includes("Event Submit")));assert.ok(TableSpecSchema.safeParse(view.table).success);
});
test("a valid transition plus a fabricated target is not a conflicting outcome",()=>{
 const view=compiledTable("S24",{cells:[{stateId:"new",eventId:"new",nextStateId:"done",evidenceIds:ev},{stateId:"new",eventId:"new",nextStateId:"ghost",evidenceIds:ev}]});
 const cell=view.table!.rows[0].cells[0];assert.equal(cell.status,"interpreted");assert.equal(cell.text,"Done");assert.ok(view.gaps.some(g=>g.includes("unknown target")));
});
test("an ungrounded target remains unknown without borrowed row evidence",()=>{
 const view=compiledTable("S24",{states:[{id:"new",label:"New",evidenceIds:ev},{id:"done",label:"Done",evidenceIds:["missing"]}],cells:[{stateId:"new",eventId:"new",nextStateId:"done",evidenceIds:ev}]});
 assert.equal(view.table!.rows.length,1);assert.equal(view.table!.rows[0].cells[0].status,"unknown");assert.deepEqual(view.table!.rows[0].cells[0].evidenceIds,[]);
});
test("genuine forbidden and allowed transition alternatives stay conflicting",()=>{
 const view=compiledTable("S24",{cells:[{stateId:"new",eventId:"new",nextStateId:"done",isForbidden:true,evidenceIds:ev},{stateId:"new",eventId:"new",nextStateId:"done",evidenceIds:ev}]});
 assert.equal(view.table!.rows[0].cells[0].status,"conflict");assert.match(view.table!.rows[0].cells[0].text,/FORBIDDEN\? · Done \/ Done/);
});
test("offline CRC keeps unknown responsibilities empty and bounds large class inventories",async()=>{
 const { StubProvider }=await import("@cie/model");const { ChartOutputV2,SCHEMA_CHART_V2 }=await import("@cie/schema");const { erBundle }=await import("./er-fixture.ts");
 const bundle={...erBundle,entities:Array.from({length:80},(_,i)=>({entityId:`class:${i}`,kind:"class",name:`Service${i}`,file:"services.ts",spans:[]}))};
 const plan=ChartOutputV2.parse(await new StubProvider().generate({purpose:"CHART",schemaId:SCHEMA_CHART_V2,chartId:"S20",question:"CRC classes",bundle}));
 if(plan.chartId!=="S20")throw new Error("Wrong selected chart");assert.equal(plan.cards.length,60);assert.ok(plan.cards.every(card=>card.responsibilities.length===0 && card.collaborators.length===0));
});
test("offline metrics accept named declarations and reject telemetry values or malformed names",async()=>{
 const { StubProvider }=await import("@cie/model");const { ChartOutputV2,SCHEMA_CHART_V2 }=await import("@cie/schema");const { erBundle }=await import("./er-fixture.ts");
 const entries=[{predicate:"metric_declaration",value:"payment.success"},{predicate:"telemetry_value",value:42},{predicate:"metric_declaration",value:42},{predicate:"metric_declaration",value:" "},{predicate:"metric_runtime",value:"fabricated"}];
 const bundle={...erBundle,facts:entries.map((item,i)=>({id:`fact:${i}`,subject:"t:a",predicate:item.predicate,object:{kind:"ScalarValue",value:item.value,metricKind:"createCounter"},evidence:erBundle.evidence,resolution:"RESOLVED" as const}))};
 const plan=ChartOutputV2.parse(await new StubProvider().generate({purpose:"CHART",schemaId:SCHEMA_CHART_V2,chartId:"S26",question:"Metrics",bundle}));
 if(plan.chartId!=="S26")throw new Error("Wrong selected chart");assert.equal(plan.metrics.length,1);assert.equal(plan.metrics[0].name,"payment.success");assert.match(plan.caption,/No live values/);
});
