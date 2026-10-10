import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { REPO, startServer } from "./harness.ts";
import { createWorkspace, updateTab } from "../../src/response-workspace.ts";
import { encodeCheckpoint } from "../../src/workspace-checkpoint.ts";
import type { ResponseManifest, ViewSpec } from "@cie/schema";
test("refresh regenerates the active chart and retains parent navigation without saved source specs",{skip:!existsSync(CHROME),timeout:120000},async()=>{
 const server=await startServer(),b=await Browser.launch();
 try {
  const api=async(component:string,op:string,body:object)=>{const r=await fetch(`${server.url}/api/v1/components/${component}/${op}`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":crypto.randomUUID()},body:JSON.stringify(body)});const result=await r.json() as any;assert.equal(result.ok,true,JSON.stringify(result));return result.value;};
  const revision=(await api("C04","ingestRepository",{repoPath:REPO})).id;
  const job=await api("C07","enqueue",{kind:"concept-hierarchy",revision});
  let state=job.state;
  for(let i=0;i<200 && !["SUCCEEDED","FAILED","CANCELLED"].includes(state);i++){await new Promise(r=>setTimeout(r,50));state=(await api("C07","getJob",{jobId:job.id})).state;}
  assert.equal(state,"SUCCEEDED");
  const built=await api("C19","ask",{revision,question:"Show component structure",chartCode:"S23",form:"GeneratedChart",scope:"repository"}) as {manifest:ResponseManifest;view:ViewSpec;claims:never[]};
  let workspace=createWorkspace(built.manifest,[built]);workspace=updateTab(workspace,workspace.activeId,{ui:{selection:[],cellSelection:[],level:2,drawMode:"graph",terrainWeights:{}}});
  const checkpoint=encodeCheckpoint(workspace,{ancestors:[workspace],truncated:false})!;
  await b.goto(server.url,`localStorage.setItem('cie-chat-session','recovery-test');if(!sessionStorage.getItem('recovery-seeded')){sessionStorage.setItem('cie-response:recovery-test:${revision}',${JSON.stringify(checkpoint)});sessionStorage.setItem('recovery-seeded','yes');}window.__asks=0;const originalFetch=window.fetch;window.fetch=(url,options)=>{if(String(url).endsWith('/C19/ask'))window.__asks++;return originalFetch(url,options);};`);
  await b.waitFor(()=>"!!document.querySelector('.response-tabs [aria-selected=true]') && !!document.querySelector('[role=application]')",30000);
  await b.waitFor(()=>"document.querySelector('.response-workspace-bar').textContent.includes('Highlight response evidence')",30000);
  assert.ok(await b.eval("window.__asks > 0"));
  assert.equal(await b.eval("document.querySelector('.response-tabs [aria-selected=true]').id"),`tab-${workspace.activeId}`);
  await b.send("Page.reload");
  await b.waitFor(()=>"window.__asks > 0 && document.querySelector('.response-workspace-bar')?.textContent.includes('Highlight response evidence')",30000);
  await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Back to parent'");assert.equal(await b.eval("document.activeElement.disabled"),false);await b.key("Enter");
  await b.waitFor(()=>"document.querySelector('.response-workspace-bar')?.textContent.includes('Highlight response evidence')",30000);
  assert.ok(!b.console.some(line=>line.startsWith("exception:")),b.console.join("\n"));
 }finally{await b.close();server.proc.kill();}
});
