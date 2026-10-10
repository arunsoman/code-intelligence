import { ChartOutputV2, type EvidenceBundle } from "@cie/schema";
import { compileChartPlan } from "../src/chart-creator.ts";
import { erBundle } from "./er-fixture.ts";
const ev=erBundle.evidence[0];
export const activityBundle: EvidenceBundle={...erBundle,entities:["request","check","save","fail"].map(name=>({entityId:name,kind:"method",name,file:`${name}.ts`,spans:[]})),relationships:[{id:"r1",from:"request",to:"check",kind:"calls",evidence:[ev],resolution:"STATIC_RESOLVED"},{id:"r2",from:"check",to:"save",kind:"calls",evidence:[ev],resolution:"STATIC_RESOLVED"},{id:"r3",from:"check",to:"fail",kind:"calls",evidence:[ev],resolution:"STATIC_RESOLVED"},{id:"r4",from:"save",to:"save",kind:"calls",evidence:[ev],resolution:"STATIC_RESOLVED"}]};
export function compiledActivity(extra: Record<string,unknown> = {}) {
 const plan=ChartOutputV2.parse({contractVersion:"chart.v2",chartId:"S2",chartType:"Activity",layout:"flow",caption:"Payment journey",nodes:[{entityId:"request",shape:"event",lane:"API",column:0,row:0,evidenceIds:["ev:1"]},{entityId:"check",shape:"decision",lane:"API",column:0,row:1,evidenceIds:["ev:1"]},{entityId:"save",shape:"process",lane:"Storage",column:1,row:2,evidenceIds:["ev:1"]},{entityId:"fail",shape:"process",lane:"API",column:0,row:2,evidenceIds:["ev:1"]}],edges:activityBundle.relationships.map(r=>({from:r.from,to:r.to,relationshipId:r.id,label:r.id==="r2" ? "sufficient" : r.id==="r3" ? "insufficient" : "",evidenceIds:["ev:1"]})),...extra});
 return compileChartPlan({plan,bundle:activityBundle,rev:{id:"rev",repoRoot:"/r",gitHead:null,createdAt:"t",analyzerVersion:"t",diagnostics:[],fileCount:4},question:"Activity",route:{source:"chosen",confidence:"high",form:"GeneratedChart",name:"Activity",because:"",alternatives:[]},chartId:"S2"}).view;
}
