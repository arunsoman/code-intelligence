import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT } from "./harness.ts";

type Box = { id: string; x1: number; y1: number; x2: number; y2: number };
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 - .5 && a.x2 > b.x1 + .5 && a.y1 < b.y2 - .5 && a.y2 > b.y1 + .5;
test("G6 renders real class compartments, variable cards, UML relations and nested boundaries", { skip: !existsSync(CHROME), timeout: 90_000 }, async () => {
  const server = await createServer({ configFile: false, root: join(ROOT, "apps/web"), plugins: [react()], server: { host: "127.0.0.1", port: 0 } });
  await server.listen(); const b = await Browser.launch();
  try {
    const address = server.httpServer!.address(); if (!address || typeof address === "string") throw new Error("No Vite address");
    await b.goto(`http://127.0.0.1:${address.port}/test/e2e/g6-notation.html`);
    const ready = () => b.waitFor(() => `document.querySelector('.g6-canvas')?.getAttribute('aria-busy')==='false' && Number(document.querySelector('.g6-canvas')?.dataset.nodeCount)>0`, 30_000);
    await ready();
    const assertNoOverlap = async () => { const boxes = JSON.parse(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodeBounds`)) as Box[]; for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.equal(overlaps(boxes[i], boxes[j]), false, `${boxes[i].id} overlaps ${boxes[j].id}`); return boxes; };
    const cards = await assertNoOverlap();
    assert.ok(cards.find(b => b.id === "Account")!.y2 - cards.find(b => b.id === "Account")!.y1 > cards.find(b => b.id === "Wallet")!.y2 - cards.find(b => b.id === "Wallet")!.y1, "more members produce a taller card");
    const out = process.env.CIE_SCREENSHOT_DIR ?? "/tmp/cie-g6-notation"; mkdirSync(out, { recursive: true });
    const capture = async (name: string) => { const shot = await b.send("Page.captureScreenshot", { format: "png" }); writeFileSync(join(out, name), Buffer.from(shot.data, "base64")); };
    await capture("related-classes.png");
    await b.eval(`document.querySelector('.g6-canvas').focus()`); await b.key("Home"); await b.key("Enter");
    assert.equal(await b.eval(`document.querySelector('[aria-label="Evidence action"]').textContent`), "Account");
    await b.key("e"); await b.waitFor(() => `document.querySelector('.g6-canvas').dataset.lensActive==='true'`);
    const target = await b.eval(`document.querySelector('.g6-canvas').dataset.lensTarget`);
    await b.key("]"); await b.waitFor(() => `Number(document.querySelector('.g6-canvas').dataset.lensPage)===1`);
    assert.equal(await b.eval(`document.querySelector('.g6-canvas').dataset.lensTarget`), target, "paging retains captured identity");
    await capture("class-member-lens.png"); await b.key("Escape");
    await b.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Class grid').click()`); await ready();
    await assertNoOverlap();
    const points = JSON.parse(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.nodePositions`));
    assert.ok(new Set(points.map((p: {x:number}) => Math.round(p.x))).size > 1, "class grid uses multiple columns");
    assert.ok(new Set(points.map((p: {y:number}) => Math.round(p.y))).size > 1, "class grid uses multiple rows");
    await capture("class-grid.png");
    await b.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Architecture').click()`); await ready();
    const nodes = await assertNoOverlap(), groups = JSON.parse(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.groupBounds`)) as Box[];
    const services = groups.find(g => g.id === "services")!, storage = groups.find(g => g.id === "storage")!, system = groups.find(g => g.id === "system")!;
    assert.equal(overlaps(services, storage), false, "sibling architecture boundaries do not overlap");
    const contains = (outer: Box, inner: Box) => outer.x1 <= inner.x1 && outer.y1 <= inner.y1 && outer.x2 >= inner.x2 && outer.y2 >= inner.y2;
    for (const node of nodes) assert.ok(contains(node.id === "Database" ? storage : services, node), `${node.id} is contained in its boundary`);
    assert.ok(contains(system, services) && contains(system, storage), "nested system boundary contains both groups");
    await capture("nested-architecture.png");
    for (const mode of ["Packages", "Communication"]) {
      await b.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='${mode}').click()`); await ready();
      await assertNoOverlap();
      await b.eval(`document.querySelector('.g6-canvas').focus()`); await b.key("Home"); await b.key("Enter");
      assert.equal(await b.eval(`document.querySelector('[aria-label="Evidence action"]').textContent`), mode === "Packages" ? "payments" : "API");
      await capture(`${mode.toLowerCase()}.png`);
    }
    const messages = JSON.parse(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.edgeRoutes`));
    assert.deepEqual(messages.map((m: {label:string}) => m.label), ["1. reserve()", "2. reservation", "3. commit()", "4. committed"]);
    assert.equal(messages.length, 4, "parallel and return messages retain separate identities");
    assert.ok(new Set(messages.slice(0, 3).map((m: {curveOffset:number}) => m.curveOffset)).size > 1, "parallel messages use distinct routes");
    for(const mode of ["sequence","replay","er","lifecycle"]) {
      await b.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='${mode}').click()`);await ready();
      await capture(`${mode}.png`);
      await b.eval(`document.querySelector('.g6-canvas').focus()`);await b.key("Home");await b.key("Enter");
      assert.ok(await b.eval(`document.querySelector('[aria-label="Evidence action"]').textContent.length>0`));
      if(mode==="er") {const links=JSON.parse(await b.eval<string>(`document.querySelector('.g6-canvas').dataset.edgeRoutes`));assert.equal(links[0].type,"cie-er-link");assert.equal(links[0].sourceCardinality,"N?");assert.equal(links[0].targetCardinality,"1?");}
      if(mode==="sequence"||mode==="replay") {
        await b.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='${mode==="sequence"?"Message table":"Table view"}').click()`);
        assert.ok(await b.eval(`document.querySelector('.sequence-table tbody tr').textContent.length>0`));
        await b.eval(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Close table').click()`);
      }
    }
    assert.equal(b.console.filter(line => /exception:|\[g6-render\]/.test(line)).length, 0, b.console.join("\n"));
  } finally { await b.close(); await server.close(); }
});
