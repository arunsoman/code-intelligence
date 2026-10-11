import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Browser, CHROME } from "./cdp.ts";
import { startServer, ROOT } from "./harness.ts";

test("G6 call and dependency graphs retain captured hover, zoom, keyboard evidence and selection", { skip: !existsSync(CHROME), timeout: 150_000 }, async () => {
  const server = await startServer({ CIE_PROVIDER: "stub", CIE_ROUTER: "off" }), b = await Browser.launch();
  const click = (label: string) => b.eval(`(() => { const button=[...document.querySelectorAll('button')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})&&!e.disabled); if(!button) throw new Error('Missing '+${JSON.stringify(label)}); button.click(); })()`);
  try {
    await b.goto(server.url); await b.eval("document.getElementById('repo').focus()"); await b.type(join(ROOT, "fixtures/payments-repo")); await click("Index");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header')?.innerText ?? '')`, 60_000);
    await b.waitFor(() => `[...document.querySelectorAll('button')].some(e=>e.textContent.trim().startsWith('Build concept hierarchy')&&!e.disabled)`, 60_000);
    await click("Build concept hierarchy"); await b.waitFor(() => `/[1-9]\\d* hierarchy concepts/.test(document.querySelector('header')?.innerText ?? '')`, 60_000);
    for (const [name, question] of [["Call graph", "Draw the call graph rooted at reserve"], ["Dependency / module graph", "Draw the module dependencies in this repository"]]) {
      await click("Visuals"); await b.waitFor(() => `!!document.querySelector('.gallery')`);
      await b.eval(`(() => { const li=[...document.querySelectorAll('.gallery li')].find(e=>e.querySelector('strong')?.innerText===${JSON.stringify(name)}); const input=li.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(question)});input.dispatchEvent(new Event('input',{bubbles:true}));[...li.querySelectorAll('button')].find(e=>e.textContent.trim()==='Show').click(); })()`);
      await b.waitFor(() => `document.querySelector('.g6-canvas')?.dataset.chartId==='${name.startsWith("Call") ? "S21" : "S23"}' && Number(document.querySelector('.g6-canvas')?.dataset.nodeCount)>0 && document.querySelector('.g6-canvas').getAttribute('aria-busy')==='false' && !document.querySelector('.stage[aria-busy="true"]')`, 60_000);
      const zoom = await b.eval<number>(`Number(document.querySelector('.g6-canvas').dataset.zoom)`);
      await b.eval(`document.querySelector('.g6-canvas').focus()`); await b.key("+");
      await b.waitFor(() => `Number(document.querySelector('.g6-canvas').dataset.zoom)>${zoom}`, 5000);
      await b.key("Home"); await b.key(" ");
      await b.waitFor(() => `/1 SELECTED/.test(document.body.innerText)`, 5000);
      await b.key("Enter"); await b.waitFor(() => `document.querySelectorAll('.drawer figure.evidence').length>0`, 10_000);
      await b.eval(`document.querySelector('.g6-canvas').focus()`); await b.key("Escape");
      const point = await b.eval<{ x: number; y: number }>(`(() => { const host=document.querySelector('.g6-canvas'), r=host.getBoundingClientRect();const pts=JSON.parse(host.dataset.nodePositions);const p=pts.find(p=>p.x>30&&p.x<r.width-30&&p.y>30&&p.y<r.height-60);if(!p)throw new Error('No visible node');return {x:r.x+p.x,y:r.y+p.y}; })()`);
      const positions = await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodePositions`);
      await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
      await b.waitFor(() => `document.querySelector('.g6-canvas').dataset.lensActive==='true'`, 5000);
      const lensTarget = await b.eval<string>(`document.querySelector('.g6-canvas').dataset.lensTarget`);
      assert.ok(lensTarget); assert.equal(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodePositions`), positions);
      const activeZoom = await b.eval<number>(`Number(document.querySelector('.g6-canvas').dataset.zoom)`);
      await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -100 });
      assert.equal(await b.eval<number>(`Number(document.querySelector('.g6-canvas').dataset.zoom)`), activeZoom);
      const out = process.env.CIE_SCREENSHOT_DIR ?? "/tmp/cie-g6"; mkdirSync(out, { recursive: true });
      await b.eval(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
      assert.equal(await b.eval(`document.querySelector('.g6-canvas').dataset.lensActive`), "true");
      assert.ok(await b.eval(`(() => {const canvas=document.querySelector('.g6-canvas .fisheye-surface');return canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data.some((v,i)=>i%4===3&&v>0);})()`), "lens paints visible content, not just an active flag");
      const shot = await b.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(out, `${name.startsWith("Call") ? "call" : "dependency"}-lens.png`), Buffer.from(shot.data, "base64"));
      await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 5, y: 5 });
      await b.waitFor(() => `document.querySelector('.g6-canvas').dataset.lensActive==='false'`, 5000);
      const saved = await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodePositions`);
      await b.eval(`document.querySelector('.response-tabs [role=tab][aria-selected=false]').click()`);
      await b.waitFor(() => `!document.querySelector('.g6-canvas') && !document.querySelector('.stage[aria-busy="true"]') && !document.querySelector('.chip.busy')`, 30_000);
      await b.eval(`[...document.querySelectorAll('.response-tabs [role=tab]')].find(e=>e.textContent.startsWith(${JSON.stringify(name)})).click()`);
      await b.waitFor(() => `document.querySelector('.g6-canvas')?.getAttribute('aria-busy')==='false' && Number(document.querySelector('.g6-canvas')?.dataset.nodeCount)>0`, 30_000);
      const restored = JSON.parse(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodePositions`));
      for (const previous of JSON.parse(saved)) { const now = restored.find((n: {id:string}) => n.id === previous.id); assert.ok(now); assert.ok(Math.abs(now.x - previous.x) < .5 && Math.abs(now.y - previous.y) < .5, "tab restores the graph camera"); }
    }
    assert.equal(b.console.filter(line => /exception:|\[g6-render\]/.test(line)).length, 0, b.console.join("\n"));
  } finally { await b.close(); server.proc.kill(); }
});
