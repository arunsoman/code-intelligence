import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Browser, CHROME } from "./cdp.ts";
import { startServer, REPO } from "./harness.ts";

// A real indexed repository and provider-produced plan, not injected SVG markup.
test("sequence G6 supports evidence, captured hover, keyboard and tab camera restoration", { skip: !existsSync(CHROME), timeout: 120_000 }, async () => {
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
    await b.waitFor(()=>`document.querySelector('.g6-canvas')?.dataset.chartId==='S28' && document.querySelector('.g6-canvas')?.getAttribute('aria-busy')==='false'`,30_000);
    assert.match(await b.eval(`document.querySelector('.sequence-notice').innerText`),/inferred/);
    await b.eval(`document.querySelector('.g6-canvas').focus()`);await b.key("Home");await b.key("Enter");
    await b.waitFor(()=>`document.querySelectorAll('.drawer figure.evidence').length>0`,10_000);
    await b.eval(`document.querySelector('.g6-canvas').focus()`);await b.key("+");
    const camera=await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodePositions`);
    const sequenceTab=await b.eval<string>(`document.querySelector('[role=tab][aria-selected=true]').id`);
    const other=await b.eval<string>(`[...document.querySelectorAll('[role=tab]')].find(e=>e.id!==${JSON.stringify(sequenceTab)})?.id`);
    assert.ok(other);await b.eval(`document.getElementById(${JSON.stringify(other)}).click()`);
    await b.waitFor(()=>`document.getElementById(${JSON.stringify(other)})?.getAttribute('aria-selected')==='true' && !document.querySelector('.canvas[aria-busy="true"]')`);
    await b.eval(`document.getElementById(${JSON.stringify(sequenceTab)}).click()`);
    await b.waitFor(()=>`document.querySelector('.g6-canvas')?.dataset.chartId==='S28' && document.querySelector('.g6-canvas')?.getAttribute('aria-busy')==='false'`);
    const restored=JSON.parse(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodePositions`));
    for(const previous of JSON.parse(camera)){const now=restored.find((n:{id:string})=>n.id===previous.id);assert.ok(now);assert.ok(Math.abs(now.x-previous.x)<.5&&Math.abs(now.y-previous.y)<.5);}
    await b.eval(`document.querySelector('.g6-canvas').focus()`);await b.key("Home");await b.key("e");
    await b.waitFor(()=>`document.querySelector('.g6-canvas').dataset.lensActive==='true'`,5_000);
    const zoom=await b.eval(`document.querySelector('.g6-canvas').dataset.zoom`);
    await b.key("+");assert.equal(await b.eval(`document.querySelector('.g6-canvas').dataset.zoom`),zoom,"lens blocks zoom");
    await b.key("Escape");
    await click("Message table");assert.ok(await b.eval(`document.querySelectorAll('.sequence-table tbody tr').length>0`));
    await b.eval(`document.querySelector('.sequence-table tbody button').click()`);
    await b.waitFor(()=>`document.querySelectorAll('.drawer figure.evidence').length>0`);
    assert.equal(b.console.filter(line=>line.startsWith("exception:")).length,0);
  } finally { await b.close();server.proc.kill("SIGKILL"); }
});
