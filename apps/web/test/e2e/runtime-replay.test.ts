import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT, startServer } from "./harness.ts";

test("recorded replay scrubs with keyboard, preserves the map, and high contrast persists", { skip: !existsSync(CHROME), timeout: 120_000 }, async () => {
  const server = await startServer();
  let browser: Browser | undefined;
  try {
    const api = async (component: string, op: string, body: unknown) => {
      const r = await fetch(`${server.url}/api/v1/components/${component}/${op}`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      const result = await r.json() as any;
      assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
    };
    const revision = (await api("C04", "ingestRepository", { repoPath: join(ROOT, "fixtures/payments-repo") })).id;
    const t = Date.now() - 60_000;
    await api("C24", "ingest", { envelope: {
      id: "replay-browser", sourceId: "test", codeRevision: revision,
      window: { from: t, to: t + 5000 }, backendHandle: "test://replay", signalKind: "trace", samplingRate: 0.5,
      spans: [0, 1].map((i) => ({ traceId: "trace", spanId: `s${i}`, name: "fraud", startMs: t + 1000 + i * 1000, endMs: t + 1050 + i * 1000, file: "src/payments/fraud.ts", line: 5, fn: "checkFraud", error: i === 1 })),
    } });
    const b = browser = await Browser.launch();
    await b.goto(server.url);
    await b.waitFor(() => `document.querySelector('header').innerText.includes('rev ')`);
    await b.tabTo(`el.id === 'chat-input'`); await b.type("What has been going wrong lately?"); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('.runtime-replay')`, 30_000);
    assert.match(await b.eval(`document.querySelector('.epistemic-summary').textContent`), /Inference/);
    await b.tabTo(`el.tagName === 'SUMMARY' && el.textContent === 'Replay recorded runtime'`); await b.key("Enter");
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent === 'Load replay'`); await b.key("Enter");
    await b.waitFor(() => `document.querySelector('.replay-result')?.textContent.includes('0 attributed span(s)')`);
    await b.tabTo(`el.id === 'replay-cursor'`); await b.key("End");
    await b.waitFor(() => `document.querySelector('.replay-result')?.textContent.includes('2 attributed span(s)')`);
    assert.match(await b.eval(`document.querySelector('.replay-result').textContent`), /1 error\(s\).*sampled/is);
    const cy = `document.querySelector('.canvas')._cyreg.cy`;
    assert.ok(await b.eval(`${cy}.nodes('.replay-error').length > 0`));
    const camera = await b.eval(`({zoom: ${cy}.zoom(), pan: ${cy}.pan(), positions: ${cy}.nodes().map(n => ({id: n.id(), pos: n.position()}))})`);
    await b.key("Home");
    await b.waitFor(() => `document.querySelector('.replay-result')?.textContent.includes('0 attributed span(s)')`);
    assert.equal(await b.eval(`${cy}.nodes('.replay-observed').length`), 0);
    assert.deepEqual(await b.eval(`({zoom: ${cy}.zoom(), pan: ${cy}.pan(), positions: ${cy}.nodes().map(n => ({id: n.id(), pos: n.position()}))})`), camera);
    // An older replay response must not overwrite a newer cursor.
    await b.eval(`window.__originalFetch = window.fetch; window.__delayed = false; window.fetch = async (...args) => {
      if (String(args[0]).endsWith('/C24/replay') && !window.__delayed) {
        window.__delayed = true; const response = await window.__originalFetch(...args);
        await new Promise(resolve => setTimeout(resolve, 700)); return response;
      }
      return window.__originalFetch(...args);
    }`);
    await b.key("End");
    await b.waitFor(() => `window.__delayed`);
    await b.key("Home");
    await b.waitFor(() => `document.querySelector('.replay-result')?.textContent.includes('0 attributed span(s)')`);
    await b.eval(`new Promise(resolve => setTimeout(resolve, 850))`);
    assert.match(await b.eval(`document.querySelector('.replay-result').textContent`), /0 attributed span\(s\)/);
    await b.eval(`window.fetch = window.__originalFetch`);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent === 'Play replay'`); await b.key("Enter");
    await b.waitFor(() => `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Pause replay')`);
    await b.key("Enter");
    await b.waitFor(() => `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Play replay')`);
    // Failed requests clear the previous frame and offer a fresh load.
    await b.eval(`window.fetch = async (...args) => String(args[0]).endsWith('/C24/replay')
      ? new Response(JSON.stringify({ok: false, error: {message: 'Replay unavailable'}}), {headers: {'content-type': 'application/json'}})
      : window.__originalFetch(...args)`);
    await b.tabTo(`el.id === 'replay-cursor'`); await b.key("End");
    await b.waitFor(() => `document.querySelector('.runtime-replay [role=alert]')?.textContent === 'Replay unavailable'`);
    assert.equal(await b.eval(`${cy}.nodes('.replay-observed').length`), 0);
    await b.eval(`window.fetch = window.__originalFetch`);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent === 'Load replay'`); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('.replay-result')`);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent === 'High contrast'`); await b.key("Enter");
    await b.waitFor(() => `document.documentElement.dataset.contrast === 'high'`);
    assert.equal(await b.eval(`getComputedStyle(document.documentElement).getPropertyValue('--ink').trim()`), "#000000");
    await b.goto(server.url);
    await b.waitFor(() => `document.documentElement.dataset.contrast === 'high'`);
    assert.equal(await b.eval(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'High contrast').getAttribute('aria-pressed')`), "true");
    assert.deepEqual(b.console.filter((x) => x.startsWith("exception:")), []);
  } finally { browser?.close(); server.proc.kill(); }
});
