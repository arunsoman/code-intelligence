import { ChartOutputV2 } from "@cie/schema";
import { compileChartPlan } from "../src/chart-creator.ts";
import { erBundle } from "./er-fixture.ts";
export function compiledState(extra: Record<string,unknown> = {}) {
 const plan=ChartOutputV2.parse({ contractVersion:"chart.v2",chartId:"S3",chartType:"State",layout:"network",caption:"Payment lifecycle",nodes:[],edges:[],states:[{id:"open",label:"Open",isInitial:true,evidenceIds:["ev:1"]},{id:"closed",label:"Closed",isFinal:true,evidenceIds:["ev:1"]}],transitions:[{from:"open",to:"closed",trigger:"post",guard:"balance sufficient",evidenceIds:["ev:1"]},{from:"open",to:"closed",trigger:"cancel",evidenceIds:["ev:1"]},{from:"closed",to:"closed",trigger:"post",isIdempotentReplay:true,evidenceIds:["ev:1"]},{from:"closed",to:"open",trigger:"reopen",isForbidden:true,evidenceIds:["ev:1"]}],...extra });
 return compileChartPlan({plan,bundle:erBundle,rev:{id:"rev",repoRoot:"/r",gitHead:null,createdAt:"t",analyzerVersion:"t",diagnostics:[],fileCount:1},question:"State",route:{source:"chosen",confidence:"high",form:"GeneratedChart",name:"State",because:"",alternatives:[]},chartId:"S3"}).view;
}
