import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Browser, CHROME } from "./cdp.ts";
import { startServer, REPO } from "./harness.ts";

// A real indexed repository and provider-produced plan, not injected SVG markup.
test("sequence SVG supports evidence, captured hover, keyboard and tab camera restoration", { skip: !existsSync(CHROME), timeout: 120_000 }, async () => {
  const server=await startServer({ CIE_PROVIDER: "stub", CIE_ROUTER: "off" });
  const b=await Browser.launch();
  const click=(label:string)=>b.eval(`(() => { const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})&&!e.disabled); if(!e) throw new Error('Missing button'); e.click(); })()`);
  try {
    await b.goto(server.url);
    await b.eval("document.getElementById('repo').focus()");await b.type(REPO);await click("Index");
    await b.waitFor(()=>`/rev \\S+ · \\d+ files/.test(document.querySelector('header')?.innerText ?? '')`,60_000);
    await b.waitFor(()=>`[...document.querySelectorAll('button')].some(e=>e.textContent.trim().startsWith('Build concept hierarchy')&&!e.disabled)`,60_000);
    await click("Build concept hierarchy");await b.waitFor(()=>`/[1-9]\\d* hierarchy concepts/.test(document.querySelector('header')?.innerText ?? '')`,60_000);
    await click("Visuals");await b.waitFor(()=>`!!document.querySelector('.gallery')`);
    await b.eval(`(() => { const li=[...document.querySelectorAll('.gallery li')].find(e=>e.querySelector('strong')?.innerText==='UML sequence diagram'); const inp=li.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(inp,'Draw a sequence diagram for AuthService.login');inp.dispatchEvent(new Event('input',{bubbles:true})); const button=[...li.querySelectorAll('button')].find(e=>e.textContent.trim()==='Show'); button.click(); })()`);
    await b.waitFor(()=>`document.querySelectorAll('[data-sequence-element="message"]').length>0`,30_000);
    assert.ok(await b.eval(`document.querySelectorAll('.sequence-lifeline').length >= 2`));
    assert.match(await b.eval(`document.querySelector('.sequence-notice').innerText`),/inferred/);
    await b.tabTo(`el.getAttribute('data-sequence-element') === 'participant'`);
    await b.waitFor(()=>`!!document.querySelector('.sequence-preview')`,5_000);
    const label=await b.eval<string>(`document.activeElement.getAttribute('aria-label').replace(/^Participant /,'').replace(/\. Inspect source evidence\.$/,'')`);
    assert.ok((await b.eval<string>(`document.querySelector('.sequence-preview').textContent`)).includes(label));
    await b.key("Escape");await b.key("Enter");
    await b.waitFor(()=>`document.querySelectorAll('.drawer figure.evidence').length>0`,10_000);
    await b.eval(`document.querySelector('.sequence-canvas').focus()`);
    await b.key("ArrowDown");
    const camera=await b.eval<string>(`document.querySelector('.sequence-canvas > g').getAttribute('transform')`);
    const sequenceTab=await b.eval<string>(`document.querySelector('[role=tab][aria-selected=true]').id`);
    const other=await b.eval<string>(`[...document.querySelectorAll('[role=tab]')].find(e=>e.id!==${JSON.stringify(sequenceTab)})?.id`);
    assert.ok(other,"response has a supporting tab");
    await b.eval(`document.getElementById(${JSON.stringify(other)}).click()`);
    await b.waitFor(()=>`document.getElementById(${JSON.stringify(other)})?.getAttribute('aria-selected')==='true'`);
    await b.eval(`document.getElementById(${JSON.stringify(sequenceTab)}).click()`);
    await b.waitFor(()=>`!!document.querySelector('.sequence-canvas')`);
    assert.equal(await b.eval(`document.querySelector('.sequence-canvas > g').getAttribute('transform')`),camera);
    const bounds=await b.eval<{x:number;y:number}>(`(() => { const r=document.querySelector('[data-sequence-element="participant"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await b.send("Input.dispatchMouseEvent",{type:"mouseMoved",...bounds});
    await b.waitFor(()=>`!!document.querySelector('.sequence-preview')`,5_000);
    assert.equal(b.console.filter(line=>line.startsWith("exception:")).length,0);
  } finally { await b.close();server.proc.kill("SIGKILL"); }
});
