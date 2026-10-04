// Semantic zoom in a real browser (issue: text unreadable before the level changes, new levels outside the viewport, forms that never aggregate).
// Sweeps the wheel in both directions over a map that has levels and over a form that has none, reading the camera after every step.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT } from "./harness.ts";

const FONT = 11, HARD_MIN = 9, AGGREGATE_BELOW = 10;
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
/** What the camera sees now, and what the page says about it. */
const probe = (b: Browser) => b.eval<{ level: string; zoom: number; fontPx: number; nodes: number; inView: number; drawingPct: number; hint: string; offscreenTold: number }>(`(() => {
  const cy = document.querySelector('.canvas')._cyreg.cy, w = cy.width(), h = cy.height();
  const nodes = cy.nodes().filter((n) => !n.isParent());
  const boxes = nodes.map((n) => n.renderedBoundingBox());
  const inView = boxes.filter((b) => !(b.x2 <= 0 || b.x1 >= w || b.y2 <= 0 || b.y1 >= h)).length;
  let pct = 100; if (boxes.length) { const x1 = Math.min(...boxes.map((b) => b.x1)), y1 = Math.min(...boxes.map((b) => b.y1)), x2 = Math.max(...boxes.map((b) => b.x2)), y2 = Math.max(...boxes.map((b) => b.y2)); const a = (x2 - x1) * (y2 - y1); const ix = Math.max(0, Math.min(x2, w) - Math.max(x1, 0)), iy = Math.max(0, Math.min(y2, h) - Math.max(y1, 0)); pct = a > 0 ? Math.round(100 * ix * iy / a) : 100; }
  const hint = document.querySelector('.canvas-hint')?.innerText ?? '';
  const told = /(\\d+) of \\d+ element/.exec(hint);
  return { level: (document.body.innerText.match(/L\\d · [A-Za-z ]+/) ?? [''])[0], zoom: cy.zoom(), fontPx: ${FONT} * cy.zoom(), nodes: nodes.length, inView, drawingPct: pct, hint, offscreenTold: told ? Number(told[1]) : 0 };
})()`);
const wheel = async (b: Browser, dy: number, ticks = 3) => { for (let i = 0; i < ticks; i++) { await b.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 480, deltaX: 0, deltaY: dy }); await wait(30); } };
const lvl = (s: string) => Number(/L(\d)/.exec(s)?.[1] ?? -1);

test("semantic zoom: levels change before text is unreadable, content stays in view, the page tells the truth about what is off-screen, and nothing flickers", { skip: !existsSync(CHROME), timeout: 240_000 }, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await b.goto(server.url);
    await b.eval(`document.getElementById('repo').focus()`); await b.type(join(ROOT, "fixtures/payments-repo"));
    await click(b, "Index");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);
    await b.eval(`document.getElementById('chat-input').focus()`); await b.type("how does createPayment work"); await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.elements li').length > 0`, 30_000); await wait(1500);

    const start = await probe(b);
    assert.ok(start.fontPx >= AGGREGATE_BELOW, `a new view starts with readable labels (${start.fontPx.toFixed(1)} px at ${start.level})`);
    assert.ok(start.drawingPct >= 99 && start.offscreenTold === 0, "and is not cropped");

    const sweep = async (dy: number, steps: number) => {
      const rows: { level: number; px: number; pct: number; inView: number; nodes: number; told: number; hint: string }[] = [];
      let prev = await probe(b);
      for (let i = 0; i < steps; i++) {
        await wheel(b, dy); await wait(450);
        const p = await probe(b);
        rows.push({ level: lvl(p.level), px: p.fontPx, pct: p.drawingPct, inView: p.inView, nodes: p.nodes, told: p.offscreenTold, hint: p.hint });
        // text: readable, or not drawn (and the page says so); never drawn too small
        if (p.fontPx < HARD_MIN) assert.match(p.hint, /Labels are hidden/, `step ${i}: ${p.fontPx.toFixed(1)} px and no notice that labels are hidden`);
        // truthfulness: the number the page reports equals the number of elements actually outside the viewport
        assert.equal(p.offscreenTold, p.nodes - p.inView, `step ${i}: the page says ${p.offscreenTold} off-screen, ${p.nodes - p.inView} are`);
        if (lvl(p.level) !== lvl(prev.level)) {
          // a level change: the labels come back readable and the new content is in view (or the page says what is not)
          assert.ok(p.fontPx >= AGGREGATE_BELOW || p.fontPx >= HARD_MIN && lvl(p.level) === 0, `step ${i}: after the switch to ${p.level} labels are ${p.fontPx.toFixed(1)} px`);
          assert.ok(p.inView >= 1, `step ${i}: nothing of ${p.level} is in view`);
          assert.ok(p.drawingPct >= 80 || p.offscreenTold > 0 || p.hint !== "", `step ${i}: only ${p.drawingPct}% of ${p.level} is in view and the page does not say so`);
        }
        prev = p;
      }
      return rows;
    };

    const out = await sweep(240, 30);
    const levelsOut = out.map((r) => r.level);
    assert.deepEqual(levelsOut, [...levelsOut].sort((a, c) => c - a), `zooming out only ever goes to coarser levels (no flicker): ${levelsOut.join(" ")}`);
    assert.ok(new Set(levelsOut).size >= 2, "zooming out changed the level at least once");
    assert.ok(Math.min(...out.map((r) => r.px)) >= HARD_MIN || out.every((r) => r.px >= HARD_MIN || /Labels are hidden/.test(r.hint)), "no label was drawn below the hard minimum");

    const inn = await sweep(-240, 45);
    const levelsIn = inn.map((r) => r.level);
    assert.deepEqual(levelsIn, [...levelsIn].sort((a, c) => a - c), `zooming in only ever goes to finer levels: ${levelsIn.join(" ")}`);
    assert.ok(new Set(levelsIn).size >= 2, "zooming in changed the level at least once");
  } finally { b.close(); server.proc.kill(); }
});

test("a form with no levels keeps one drawing and stops drawing labels that are too small to read, saying so; Bring into view fits everything", { skip: !existsSync(CHROME), timeout: 180_000 }, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await b.goto(server.url);
    await b.eval(`document.getElementById('repo').focus()`); await b.type(join(ROOT, "fixtures/payments-repo"));
    await click(b, "Index");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);
    await click(b, "Visuals"); await wait(500);
    await b.eval(`(() => { const card = [...document.querySelectorAll('[role=dialog] li, [role=dialog] article, [role=dialog] section')].filter((x) => x.innerText.includes('Ownership') && x.querySelector('button')).sort((p, q) => p.innerText.length - q.innerText.length)[0]; [...card.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Show').click(); })()`);
    await b.waitFor(() => `document.querySelectorAll('.elements li').length > 0`, 30_000); await wait(1500);
    assert.equal(lvl((await probe(b)).level), -1, "this form has no level stepper");
    assert.equal(await b.eval(`document.querySelector('.canvas')._cyreg.cy.nodes().filter((n) => !n.isParent())[0].pstyle('min-zoomed-font-size').value`), HARD_MIN, "labels below the hard minimum are not drawn");
    const before = await probe(b);
    for (let i = 0; i < 40; i++) { await wheel(b, 240); await wait(60); }
    await wait(500);
    const small = await probe(b);
    assert.ok(small.fontPx < HARD_MIN, `zoomed far out (${small.fontPx.toFixed(1)} px)`);
    assert.match(small.hint, /Labels are hidden/);
    assert.equal(small.nodes, before.nodes, "nothing was aggregated or dropped");
    // pan far away: the page counts what is off-screen, then Bring into view fits it
    await b.eval(`document.querySelector('.canvas')._cyreg.cy.panBy({ x: 2000, y: 0 }); 0`); await wait(400);
    const lost = await probe(b);
    assert.ok(lost.offscreenTold > 0 && lost.offscreenTold === lost.nodes - lost.inView, `${lost.offscreenTold} told, ${lost.nodes - lost.inView} actually off-screen`);
    assert.ok(await click(b, "Bring into view"));
    await wait(900);
    const back = await probe(b);
    assert.equal(back.nodes - back.inView, 0, "everything is in view again");
    assert.equal(back.offscreenTold, 0);
  } finally { b.close(); server.proc.kill(); }
});
