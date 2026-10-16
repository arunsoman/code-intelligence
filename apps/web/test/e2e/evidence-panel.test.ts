import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {test} from "node:test";
import {Browser,CHROME} from "./cdp.ts";
import {REPO,startServer} from "./harness.ts";
test("answers and charts expose partial provenance and open authorized source",{skip:!existsSync(CHROME),timeout:180000},async()=>{
  const browser=await Browser.launch();let server:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    server=await startServer({CIE_EVIDENCE_CORE_MODE:"on",CIE_EVIDENCE_CORE_STRICT:"1"});
    await browser.goto(server.url);
    await browser.tabTo("el.id === 'repo'");await browser.type(REPO);
    await browser.tabTo("el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'");await browser.key("Enter");
    await browser.waitFor(()=>`!document.getElementById('chat-input').disabled`,60000,"indexed repository");
    if(await browser.eval("document.getElementById('repo-section-body').hidden")){
      await browser.tabTo("el.getAttribute('aria-controls') === 'repo-section-body'");await browser.key("Enter");
    }
    await browser.waitFor(()=>`[...document.querySelectorAll('button')].some(el=>el.textContent.trim().startsWith('Build concept hierarchy')&&!el.disabled)`,60000,"hierarchy available");
    await browser.tabTo("el.tagName === 'BUTTON' && el.textContent.trim().startsWith('Build concept hierarchy') && !el.disabled");await browser.key("Enter");
    await browser.waitFor(()=>`/[1-9]\\d* hierarchy concepts/.test(document.querySelector('header')?.innerText??'')`,60000,"built hierarchy");
    await browser.tabTo("el.id === 'chat-input'");await browser.type("Explain this project, identify its riskiest module, and show me the tests covering it.");await browser.key("Enter");
    await browser.waitFor(()=>`!!document.querySelector('.messages .evidence-panel')&&!!document.querySelector('footer .evidence-panel')`,30000,"answer and chart evidence");
    await browser.tabTo("el.tagName === 'SUMMARY' && !!el.closest('.messages .evidence-panel')");await browser.key("Enter");
    const text=await browser.eval<string>("document.querySelector('.messages .evidence-panel').innerText");
    assert.match(text,/partial/);assert.match(text,/cie.rust.static v3/);assert.match(text,/does not prove/);assert.match(text,/reflection/);
    await browser.tabTo("el.tagName === 'BUTTON' && !!el.closest('.messages .evidence-panel')");await browser.key("Enter");
    await browser.waitFor(()=>`!!document.querySelector('.codecard pre code')`,10000,"evidence source opened");
    assert.ok((await browser.eval<string>("document.querySelector('.codecard pre code').textContent")).length>0);
    await browser.tabTo("el.tagName === 'BUTTON' && el.textContent.trim() === 'Show Tests'");await browser.key("Enter");
    await browser.waitFor(()=>`!!document.querySelector('footer .evidence-panel')`,10000,"evidence on alternate chart");
    assert.equal(browser.console.filter(line=>/TypeError|ReferenceError/.test(line)).length,0);
  }finally{browser.close();server?.proc.kill("SIGKILL");}
});
