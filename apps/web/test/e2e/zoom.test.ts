// Local fisheye zoom in a real browser: the global camera, layout, and context stay unchanged.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT } from "./harness.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function start() {
  const dist = join(ROOT, "apps/web/dist/index.html");
  const newest = Math.max(...execFileSync("find", [join(ROOT, "apps/web/src"), "-type", "f"], { encoding: "utf8" }).trim().split("\n").map((f) => statSync(f).mtimeMs));
  if (!existsSync(dist) || statSync(dist).mtimeMs < newest) execFileSync("npm", ["run", "web:build"], { cwd: ROOT, stdio: "ignore" });
  const port = 4950 + Math.floor(Math.random() * 40), url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [join(ROOT, "packages/core/src/server.ts")], { env: { ...process.env, PORT: String(port), CIE_DB: join(mkdtempSync(join(tmpdir(), "cie-zoom-")), "d.db"), CIE_PROVIDER: "stub", CIE_ROUTER: "off" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/healthz`)).ok) return { proc, url }; } catch { /* not up yet */ } await wait(100); }
  proc.kill(); throw new Error("server did not start");
}
const click = (b: Browser, label: string) => b.eval<boolean>(`(() => { const el = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) && !x.disabled); if (!el) return false; el.click(); return true; })()`);

async function prepare(b: Browser, url: string) {
  await b.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
  await b.goto(url); await b.eval(`document.getElementById('repo').focus()`); await b.type(join(ROOT, "fixtures/payments-repo"));
  assert.ok(await click(b, "Index"));
  await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);
  await b.waitFor(() => `[...document.querySelectorAll('button')].some((x) => x.textContent.startsWith('Build concept hierarchy') && !x.disabled)`, 60_000);
  assert.ok(await click(b, "Build concept hierarchy"));
  await b.waitFor(() => `/[1-9]\\d* hierarchy concepts/.test(document.querySelector('header').innerText)`, 60_000);
  await b.eval(`document.getElementById('chat-input').focus()`); await b.type("how does createPayment work"); await b.key("Enter");
  await b.waitFor(() => `document.querySelector('.canvas')?._cyreg?.cy.nodes().length > 0 && document.querySelector('.canvas').getAttribute('aria-busy') === 'false'`, 30_000);
  await wait(200);
}
const graphSnapshot = (b: Browser) => b.eval(`(() => {
  const cy = document.querySelector('.canvas')._cyreg.cy;
  return { level: document.querySelector('[aria-label="Chart context level"]')?.value, zoom: cy.zoom(), pan: cy.pan(), nodes: cy.nodes().map((n) => ({id:n.id(),position:n.position()})), edges: cy.edges().map((e) => e.id()) };
})()`);
const lensPoint = (b: Browser) => b.eval<{ x: number; y: number }>(`(() => {
  const host = document.querySelector('.canvas'), cy = host._cyreg.cy, rect = host.getBoundingClientRect();
  const node = cy.nodes().filter((n) => !n.isParent() && n.renderedPosition().x > 0 && n.renderedPosition().y > 70 && n.renderedPosition().x < cy.width()-260 && n.renderedPosition().y < cy.height()-30)[0] || cy.nodes().filter((n)=>!n.isParent())[0];
  const p = node.renderedPosition(); return {x:rect.left+p.x,y:rect.top+p.y};
})()`);

test("fisheye wheel zoom leaves the chart camera, layout and global detail unchanged", { skip: !existsSync(CHROME), timeout: 180_000 }, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await prepare(b, server.url);
    const before = await graphSnapshot(b), point = await lensPoint(b);
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    const initial = await b.eval<number>(`Number(document.querySelector('.canvas').dataset.lensMagnification)`);
    for (let i = 0; i < 3; i++) await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -180 });
    await b.waitFor(() => `Number(document.querySelector('.canvas').dataset.lensMagnification) > ${initial}`, 5000);
    await wait(300);
    assert.deepEqual(await graphSnapshot(b), before);
    assert.equal(await b.eval(`getComputedStyle(document.querySelector('.canvas')).backgroundColor`), "rgb(11, 15, 23)");
    assert.ok(await b.eval(`document.querySelector('.fisheye-surface').width > 0`));
    await b.eval(`window.dispatchEvent(new CustomEvent('cie:lens-zoom',{detail:{direction:'out'}}))`);
    await wait(100);
    assert.deepEqual(await graphSnapshot(b), before);
    const radius = await b.eval<number>(`Number(document.querySelector('[aria-label="Lens radius"]').value)`);
    await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX: 0, deltaY: -180, modifiers: 8 });
    await b.waitFor(() => `Number(document.querySelector('[aria-label="Lens radius"]').value) > ${radius}`, 5000);
    assert.deepEqual(await graphSnapshot(b), before);
    const pinned = await click(b, "Pin lens"); assert.ok(pinned);
    await b.eval(`document.querySelector('.canvas').focus()`); await b.key("Escape");
    assert.equal(await b.eval(`document.querySelector('.canvas').dataset.lensPinned`), "false");
    const errors = b.console.filter((line) => /^exception|^error/.test(line)); assert.deepEqual(errors, []);
  } finally { b.close(); server.proc.kill(); }
});

test("lens expands only a hovered aggregate and keeps member selection linked to evidence", { skip: !existsSync(CHROME), timeout: 180_000 }, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await prepare(b, server.url);
    await b.eval(`(() => { const select = document.querySelector('[aria-label="Chart context level"]'); select.value = '1'; select.dispatchEvent(new Event('change',{bubbles:true})); })()`);
    await b.waitFor(() => `document.querySelector('[aria-label="Chart context level"]').value === '1' && document.querySelector('.canvas').getAttribute('aria-busy') === 'false'`, 15_000);
    await wait(300);
    const before = await graphSnapshot(b), point = await lensPoint(b);
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
    await b.waitFor(() => `document.querySelector('.canvas').dataset.lensExpanded.startsWith('agg:') && Number(document.querySelector('.canvas').dataset.lensChildren) > 0`, 5000);
    assert.deepEqual(await graphSnapshot(b), before);
    await click(b, "Pin lens");
    await b.waitFor(() => `document.querySelector('.canvas').dataset.lensExpanded.startsWith('agg:')`, 5000);
    const count = await b.eval<number>(`Number(document.querySelector('.canvas').dataset.lensChildren)`);
    const rows = Math.ceil(count / 2), stepY = Math.min(64, 242 * 1.2 / rows);
    const childPoint = { x: point.x - (count > 1 ? 84.65 : 0), y: point.y - (rows - 1) / 2 * stepY };
    const { data } = await b.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync('/tmp/cie-fisheye-local.png', Buffer.from(data, "base64"));
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...childPoint });
    await b.send("Input.dispatchMouseEvent", { type: "mousePressed", ...childPoint, button: "left", clickCount: 1 });
    await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...childPoint, button: "left", clickCount: 1 });
    await b.waitFor(() => `document.querySelector('.drawer') && /code|evidence|function|step/i.test(document.querySelector('.drawer').innerText)`, 5000);
    assert.equal((await graphSnapshot(b)).level, "1");
    assert.deepEqual(b.console.filter((line) => /^exception|^error/.test(line)), []);
  } finally { b.close(); server.proc.kill(); }
});


test("concept tree zoom and preview expansion leave the background tree unchanged", {skip: !existsSync(CHROME), timeout:180_000}, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await prepare(b, server.url);
    assert.ok(await click(b, "Browse concept hierarchy"));
    await b.waitFor(() => `document.querySelector('.tree-lens-stage .tnode') && document.querySelector('.tree-lens-stage .fisheye-surface')`, 15_000);
    await wait(300);
    const snapshot = () => b.eval(`(() => {const scroll = document.querySelector('.tree-scroll'), svg=scroll.querySelector('svg');return {nodes:[...svg.querySelectorAll('.tnode')].map(n=>({id:n.dataset.treeId,pos:n.getAttribute('transform'),expanded:n.getAttribute('aria-expanded')})),width:svg.getAttribute('width'),height:svg.getAttribute('height'),top:scroll.scrollTop,left:scroll.scrollLeft};})()`);
    const before = await snapshot();
    const point = await b.eval<{x:number;y:number}>(`(() => {const host=document.querySelector('.tree-lens-stage'),hr=host.getBoundingClientRect();const node=[...host.querySelectorAll('.tnode[aria-expanded]')].find(n=>{const r=n.getBoundingClientRect();return r.x>hr.x && r.right<hr.right-250 && r.y>hr.y && r.bottom<hr.bottom}) || host.querySelector('.tnode[aria-expanded]');const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await b.send("Input.dispatchMouseEvent", {type:"mouseMoved",...point});
    await b.waitFor(() => `document.querySelector('.tree-lens-stage').dataset.lensExpanded !== ''`,5000);
    await b.send("Input.dispatchMouseEvent",{type:"mouseWheel",...point,deltaX:0,deltaY:-180});
    await b.waitFor(() => `Number(document.querySelector('.tree-lens-stage').dataset.lensMagnification)>2.2`,5000);
    assert.deepEqual(await snapshot(),before);
    await b.eval(`document.querySelector('.tree-bar [aria-label="Zoom in"]').click()`);
    await wait(200); assert.deepEqual(await snapshot(),before);
    await b.eval(`document.querySelector('.tree-lens-stage .lens-controls button').click()`);
    await wait(100);
    const count = await b.eval<number>(`Number(document.querySelector('.tree-lens-stage').dataset.lensChildren)`);
    const rows = Math.ceil(count/2), stepY = Math.min(64,242*1.2/rows);
    const childPoint = {x:point.x-(count>1?84.65:0),y:point.y-(rows-1)/2*stepY};
    await b.send("Input.dispatchMouseEvent",{type:"mouseMoved",...childPoint});
    await b.send("Input.dispatchMouseEvent",{type:"mousePressed",...childPoint,button:"left",clickCount:1});
    await b.send("Input.dispatchMouseEvent",{type:"mouseReleased",...childPoint,button:"left",clickCount:1});
    await b.waitFor(() => `document.querySelector('.codepane h3') !== null`,5000);
    assert.deepEqual(await snapshot(),before);
    const {data} = await b.send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
    writeFileSync('/tmp/cie-fisheye-hierarchy.png',Buffer.from(data,'base64'));
    assert.deepEqual(b.console.filter(line=>/^exception|^error/.test(line)),[]);
  } finally {b.close();server.proc.kill();}
});
