import { ChartOutputV2 } from "@cie/schema";
import { compileChartPlan } from "../src/chart-creator.ts";
import { erBundle } from "./er-fixture.ts";
export function compiledTable(chartId:"S11"|"S24"|"S25",extra:Record<string,unknown>={}) {
 const data=chartId==="S11"?{conditions:[{id:"outcome",label:"Balance sufficient",evidenceIds:["ev:1"]}],rules:[{id:"rule",values:{outcome:"yes"},outcome:"Reserve",outcomeEvidenceIds:["ev:1"],evidenceIds:["ev:1"],isCovered:true}]}:chartId==="S24"?{states:[{id:"new",label:"New",evidenceIds:["ev:1"]},{id:"done",label:"Done",evidenceIds:["ev:1"]}],events:[{id:"new",label:"Submit",evidenceIds:["ev:1"]},{id:"cancel",label:"Cancel",evidenceIds:["ev:1"]}],cells:[{stateId:"new",eventId:"new",nextStateId:"done",guard:"balance sufficient",evidenceIds:["ev:1"]}]}:{failures:[{id:"failure",label:"DB write fails",evidenceIds:["ev:1"],impact:{text:"Reservation lost",evidenceIds:["ev:1"]},compensation:{text:"Release balance",evidenceIds:["missing"]}}]};
 const plan=ChartOutputV2.parse({contractVersion:"chart.v2",chartId,chartType:"Table",layout:"network",nodes:[],edges:[],caption:"Table fixture",...data,...extra});
 return compileChartPlan({plan,bundle:erBundle,rev:{id:"rev",repoRoot:"/r",gitHead:null,createdAt:"t",analyzerVersion:"t",diagnostics:[],fileCount:2},question:"Table",route:{source:"chosen",confidence:"high",form:"GeneratedChart",name:"Table",because:"",alternatives:[]},chartId}).view;
}
