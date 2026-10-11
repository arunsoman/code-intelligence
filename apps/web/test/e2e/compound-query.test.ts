import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, cpSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Browser, CHROME } from './cdp.ts';
import { startServer, REPO } from './harness.ts';

test('compound membership is readable, inspectable and reused by a supporting chart tab', {skip:!existsSync(CHROME),timeout:150_000},async()=>{
  const repo=mkdtempSync(join(tmpdir(),'cie-compound-browser-'));cpSync(REPO,repo,{recursive:true});
  writeFileSync(join(repo,'comparison.ts'),`export function leftFlow(){commonHelper();leftHelper();}
export function rightFlow(){commonHelper();rightHelper();}
function commonHelper(){return 1;} function leftHelper(){return 2;} function rightHelper(){return 3;}`);
  const server=await startServer({CIE_PROVIDER:'stub',CIE_ROUTER:'off'}),b=await Browser.launch();
  const click=(label:string)=>b.eval(`(()=>{const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})&&!e.disabled);if(!button)throw new Error('Missing button '+${JSON.stringify(label)});button.click();})()`);
  try{
    await b.goto(server.url);
    await b.eval(`(()=>{window.__asks=[];const original=window.fetch;window.fetch=async(input,init)=>{const response=await original(input,init);if(String(input).includes('/C19/ask')){window.__asks.push({body:JSON.parse(init.body),result:await response.clone().json()});}return response;};})()`);
    await b.eval("document.getElementById('repo').focus()");await b.type(repo);await click('Index');
    await b.waitFor(()=>`/rev \\S+ · \\d+ files/.test(document.querySelector('header')?.innerText??'')`,60_000);
    await b.waitFor(()=>`[...document.querySelectorAll('button')].some(e=>e.textContent.trim().startsWith('Build concept hierarchy')&&!e.disabled)`,60_000);
    await click('Build concept hierarchy');await b.waitFor(()=>`/[1-9]\\d* hierarchy concepts/.test(document.querySelector('header')?.innerText??'')`,60_000);
    await click('Visuals');await b.waitFor(()=>`!!document.querySelector('.gallery')`);
    const question='functions called by both leftFlow and rightFlow';
    await b.eval(`(()=>{const li=[...document.querySelectorAll('.gallery li')].find(e=>e.querySelector('strong')?.innerText==='Call graph');const input=li.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(question)});input.dispatchEvent(new Event('input',{bubbles:true}));[...li.querySelectorAll('button')].find(e=>e.textContent.trim()==='Show').click();})()`);
    await b.waitFor(()=>`document.querySelector('.compound-query-panel summary')?.textContent.includes('1 supported')`,40_000);
    assert.ok((await b.eval<string>(`document.querySelector('.conversation')?.innerText ?? document.body.innerText`)).includes('Supported matches (1): commonHelper'));
    const rows=await b.eval<string[]>(`[...document.querySelectorAll('.compound-query-panel tbody tr')].map(r=>r.innerText)`);
    assert.ok(rows.some(r=>r.includes('commonHelper')&&r.match(/Supported/g)?.length===3));
    assert.ok(rows.some(r=>r.includes('leftHelper')&&r.includes('Unknown')));
    if(process.env.CIE_SCREENSHOT_DIR){
      mkdirSync(process.env.CIE_SCREENSHOT_DIR,{recursive:true});
      const {data}=await b.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      writeFileSync(join(process.env.CIE_SCREENSHOT_DIR,'compound-query.png'),Buffer.from(data,'base64'));
    }
    await b.eval(`document.querySelector('[aria-label="Inspect call evidence for commonHelper"]').click()`);
    await b.waitFor(()=>`document.querySelectorAll('.drawer figure.evidence').length>0`,10_000);
    const first=await b.eval<{body:{question:string};result:{value:{manifest:{snapshotId:string}}}}>(`window.__asks.find(a=>a.result.ok && !a.body.snapshotId)`);
    assert.match(first.result.value.manifest.snapshotId,/^snapshot:[a-f0-9]{64}$/);
    await click('All views');
    await b.eval(`(()=>{const tab=[...document.querySelectorAll('[role="tab"]')].find(e=>e.textContent.includes('UML sequence diagram')&&!e.disabled);if(!tab)throw new Error('Missing sequence tab');tab.click();})()`);
    await b.waitFor(()=>`window.__asks.some(a=>a.body.chartCode==='S28' && a.result.ok) && !document.querySelector('.stage[aria-busy="true"]')`,40_000);
    const second=await b.eval<{body:{question:string;snapshotId:string};result:{value:{manifest:{snapshotId:string}}}}>(`window.__asks.find(a=>a.body.chartCode==='S28' && a.result.ok)`);
    assert.equal(second.body.question,question);assert.equal(second.body.snapshotId,first.result.value.manifest.snapshotId);
    assert.equal(second.result.value.manifest.snapshotId,first.result.value.manifest.snapshotId);
    assert.ok((await b.eval<string>(`document.querySelector('.compound-query-panel summary').textContent`)).includes('1 supported'));
    assert.equal(b.console.filter(line=>line.startsWith('exception:')).length,0);
  }finally{await b.close();server.proc.kill('SIGKILL');rmSync(repo,{recursive:true,force:true});}
});
