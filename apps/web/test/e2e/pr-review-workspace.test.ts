import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { REPO, startServer } from "./harness.ts";
test("PR review shares its head across tabs, previews fixes, and publishes only after explicit confirmation", { skip: !existsSync(CHROME), timeout: 120000 }, async () => {
 const server=await startServer();const b=await Browser.launch();
 try {
  await fetch(`${server.url}/api/v1/components/C04/ingestRepository`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify({repoPath:REPO})});
  const head="abcdef1234";
  const view={analysisId:"review-test",state:"DECIDED",repoRoot:REPO,headHash:head,baseHash:"base",pr:{repositoryId:"owner/repo",prNumber:42,forge:"github"},findings:{introduced:[{findingId:"finding",ruleId:"R-TEST",severity:"medium",path:"src/ledger.ts",line:3,summary:"Check the ledger",counterArgument:"",disposition:"OPEN"}],existing:[],resolvedByChange:[],detectorCandidates:[]},analyzers:[],baseline:{mode:"REANALYZED"},waivers:[],disclosure:["Static analysis."]};
  const suggestion={id:"fix",findingId:"finding",headHash:head,path:"src/ledger.ts",startLine:3,endLine:3,expected:"return old;",replacement:"return checked;",state:"PREPARED",checks:[{name:"types",outcome:"PASSED",detail:"No new diagnostics"}]};
  const summary={counts:{files:2,added:1,modified:1,deleted:0,testFiles:1},highImpact:[],readingOrder:[{path:"src/ledger.ts",note:"Start here",why:[{name:"DEPENDED_ON",value:2}]}],description:null,budget:{truncated:false}};
  await b.goto(server.url,`window.__reviewOps=[];const originalFetch=window.fetch;window.fetch=async (url,options)=>{const op=String(url).split('/').pop();const payload=options?.body?JSON.parse(options.body):{};const values={getPrAnalysis:{analysis:${JSON.stringify(view)},history:[]},getImpactReport:{headHash:${JSON.stringify(head)},summary:${JSON.stringify(summary)},surfaced:[],fog:[]},getSuggestions:{suggestions:[${JSON.stringify(suggestion)}]},getFeedbackState:{labels:{total:0,useful:0,noise:0},mutes:{active:[]}},runPrCommand:{headHash:${JSON.stringify(head)},kind:'HELP',claims:[{class:'FOG',text:'Commands for this indexed head.',evidence:[]}],gaps:[]},publishSuggestion:{suggestion:${JSON.stringify(suggestion)}}};if(op in values){window.__reviewOps.push({op,payload});return new Response(JSON.stringify({ok:true,value:values[op],metadata:{}}),{headers:{'content-type':'application/json'}});}return originalFetch(url,options);};`);
  await b.waitFor(()=>"document.querySelector('header').textContent.includes('rev ')");
  await b.tabTo("el.tagName==='SUMMARY' && el.textContent.trim()==='Work'");await b.key("Enter");
  await b.tabTo("el.tagName==='BUTTON' && el.textContent.trim()==='Pull requests'");await b.key("Enter");
  await b.tabTo("el.id==='pr-num'");await b.type("42");await b.tabTo("el.tagName==='BUTTON' && el.textContent.trim()==='Refresh'");await b.key("Enter");
  await b.waitFor(()=>"!!document.querySelector('.pr-tabs')");
  await b.waitFor(()=>"document.querySelector('.pr-review-workspace').textContent.includes('Start here')");
  await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Conversation'");await b.key("Enter");
  await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Ask'");await b.key("Enter");
  await b.waitFor(()=>"document.querySelector('.pr-thread').textContent.includes('Commands for this indexed head.')");
  assert.equal(await b.eval("window.__reviewOps.find(x=>x.op==='runPrCommand').payload.analysisId"),"review-test");
  await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Validated fixes'");await b.key("Enter");
  assert.match(await b.eval("document.querySelector('.pr-diff-grid').textContent"),/return old;.*return checked;/s);
  await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Review publication…'");await b.key("Enter");
  assert.equal(await b.eval("window.__reviewOps.filter(x=>x.op==='publishSuggestion').length"),0);
  await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Confirm publication'");await b.key("Enter");
  await b.waitFor(()=>"window.__reviewOps.some(x=>x.op==='publishSuggestion')");
  assert.equal(await b.eval("window.__reviewOps.filter(x=>x.op==='publishSuggestion').length"),1);
  await b.send("Emulation.setDeviceMetricsOverride",{width:700,height:900,deviceScaleFactor:1,mobile:false});
  assert.equal(await b.eval("getComputedStyle(document.querySelector('.pr-diff-grid')).gridTemplateColumns.split(' ').length"),1);
  assert.ok(!b.console.some(line=>line.startsWith("exception:")),b.console.join("\n"));
 } finally {await b.close();server.proc.kill();}
});
