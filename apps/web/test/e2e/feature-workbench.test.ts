import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { REPO, startServer } from "./harness.ts";

test("feature wizard builds from an agreed plan, imports candidate-bound local failures, and resumes its saved job", { skip: !existsSync(CHROME), timeout: 120000 }, async () => {
  const server = await startServer(), b = await Browser.launch();
  try {
    await fetch(`${server.url}/api/v1/components/C04/ingestRepository`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ repoPath: REPO }) });
    const script = `
    localStorage.setItem('cie.build.request.'+${JSON.stringify(REPO)},'feature-test');
    window.__featureOps=[];window.__feature={stage:'PLAN',workspaceVersion:1,contractVersion:1,requestId:'feature-test',mode:'BUILD_PREVIEW',state:'CONTRACTING',blockers:[],runningJobIds:[],review:{prompt:'Add a CSV export',requirements:[{id:'R1',text:'Members export CSV',status:'ACTIVE',type:'FUNCTIONAL',origin:'USER',source:{locator:'prompt'},conditions:[]}],criteria:[{id:'AC1',requirementIds:['R1'],scenario:'Member downloads CSV',expectedOutcome:'A CSV header is returned',mandatory:true,oracleOrigin:'USER_EXAMPLE',validationKinds:['UNIT']}],questions:[],decisions:[],tasks:[],files:[],fileCounts:{},results:[],gaps:[]}};
    window.__reports=[];window.__runs=[];
    const originalFetch=window.fetch;
    window.fetch=async(url,options)=>{const op=String(url).split('/').pop(),payload=options?.body?JSON.parse(options.body):{};let value;
      if(op==='openFeatureWorkspace') value={status:'COMPLETE',value:window.__feature,evidenceIds:[],diagnostics:[]};
      else if(op==='featureSetupCheck')value={ready:true,items:[{id:'STACK',state:'READY',detail:'Node test fixture'}]};
      else if(op==='getFeatureWorkbench')value={reports:window.__reports,runs:window.__runs};
      else if(op==='buildFeatureCandidate'){window.__featureOps.push({op,payload});window.__feature={...window.__feature,stage:'VALIDATE',workspaceVersion:window.__feature.workspaceVersion+1,candidateHash:'candidate-1',candidateStatus:'MATERIALIZED'};value={jobId:'job-feature'};}
      else if(op==='getJob' && payload.jobId==='job-feature'){window.__featureOps.push({op,payload});value={id:'job-feature',state:'SUCCEEDED',kind:'feature-build',phase:'finished',message:'Checks passed within the recorded scope',params:{},createdAt:new Date().toISOString()};}
      else if(op==='importFeatureTestReport'){window.__featureOps.push({op,payload});const saved={id:'report-1',report:payload.report,trust:'EXTERNAL_UNVERIFIED',importedAt:new Date().toISOString()};window.__reports=[saved];value=saved;}
      else if(op==='advanceWizard'){window.__feature={...window.__feature,stage:payload.targetStage,workspaceVersion:window.__feature.workspaceVersion+1};value={status:'COMPLETE',value:window.__feature,evidenceIds:[],diagnostics:[]};}
      else return originalFetch(url,options);
      return new Response(JSON.stringify({ok:true,value,metadata:{requestId:'ui-test',completeness:'COMPLETE',warnings:[]}}),{headers:{'content-type':'application/json'}});
    };`;
    await b.goto(server.url, script);
    await b.tabTo("el.tagName==='SUMMARY' && el.textContent==='Work'"); await b.key("Enter");
    await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Build feature'"); await b.key("Enter");
    await b.waitFor(() => "document.querySelector('.bf-workbench')?.textContent.includes('Build and test feature')");
    await b.tabTo("el.tagName==='INPUT' && el.type==='checkbox' && el.parentElement.textContent.includes('synthetic')"); await b.key(" ");
    await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Build and test feature'"); await b.key("Enter");
    await b.waitFor(() => "document.querySelector('.bf-workbench')?.textContent.includes('Tests failed on your machine?')");
    assert.equal(await b.eval("window.__featureOps.find(x=>x.op==='buildFeatureCandidate').payload.syntheticTestData"), true);
    await b.tabTo("el.tagName==='SUMMARY' && el.textContent==='Tests failed on your machine?'"); await b.key("Enter");
    const report = { format: "feature-test-report.v1", requestId: "feature-test", candidateHash: "candidate-1", baseRevision: "base", command: "npm test", environment: "developer laptop", exitCode: 1, failures: [{ name: "CSV", message: "Missing header" }], output: "diagnostic" };
    await b.tabTo("el.tagName==='TEXTAREA' && el.parentElement.textContent.includes('paste report')");
    await b.send("Input.insertText", { text: JSON.stringify(report) });
    await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Import local results'"); await b.key("Enter");
    await b.waitFor(() => "window.__featureOps.some(x=>x.op==='importFeatureTestReport')");
    await b.waitFor(() => "[...document.querySelectorAll('button')].some(x=>x.textContent==='Repair from local failures, then test' && !x.disabled)");
    await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Repair from local failures, then test'"); await b.key("Enter");
    await b.waitFor(() => "window.__featureOps.filter(x=>x.op==='buildFeatureCandidate').length===2");
    assert.equal(await b.eval("window.__featureOps.filter(x=>x.op==='buildFeatureCandidate')[1].payload.reportId"), "report-1");
    await b.send("Emulation.setDeviceMetricsOverride", { width: 700, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.equal(await b.eval("document.querySelector('.bf-dialog').getBoundingClientRect().width <= 700"), true);
    assert.equal(await b.eval("document.querySelector('.bf-dialog').scrollWidth <= document.querySelector('.bf-dialog').clientWidth"), true);
    const shot = await b.send("Page.captureScreenshot", { format: "png" });
    if (process.env.CIE_FEATURE_SCREENSHOT) writeFileSync(process.env.CIE_FEATURE_SCREENSHOT, Buffer.from(shot.data, "base64"));
    assert.ok(!b.console.some((line) => line.startsWith("exception:")), b.console.join("\n"));
    // Closing/reopening must find the same durable request and job rather than create a new feature.
    await b.tabTo("el.tagName==='BUTTON' && el.getAttribute('aria-label')==='Close Build feature'"); await b.key("Enter");
    await b.waitFor(() => "!document.querySelector('.bf-dialog')");
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.tabTo("el.tagName==='SUMMARY' && el.textContent==='Work'"); await b.key("Enter");
    await b.tabTo("el.tagName==='BUTTON' && el.textContent==='Build feature'"); await b.key("Enter");
    await b.waitFor(() => "document.querySelector('.bf-workbench')?.textContent.includes('Checks passed within the recorded scope')");
    assert.equal(await b.eval("window.__featureOps.filter(x=>x.op==='buildFeatureCandidate').length"), 2);
  } finally { await b.close(); server.proc.kill(); }
});
