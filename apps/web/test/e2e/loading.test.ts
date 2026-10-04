// While a question is in flight the canvas must say it is composing, never that the map is empty. Emulated latency
// holds the pending state so the test can look at what is drawn during the wait.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
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
  const port = 4980 + Math.floor(Math.random() * 9), url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [join(ROOT, "packages/core/src/server.ts")], { env: { ...process.env, PORT: String(port), CIE_DB: join(mkdtempSync(join(tmpdir(), "cie-load-")), "d.db"), CIE_PROVIDER: "stub", CIE_ROUTER: "off" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/healthz`)).ok) return { proc, url }; } catch { /* not up yet */ } await wait(100); }
  proc.kill(); throw new Error("server did not start");
}
const click = (b: Browser, label: string) => b.eval<boolean>(`(() => { const el = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) && !x.disabled); if (!el) return false; el.click(); return true; })()`);

test("while a question is pending the canvas composes a skeleton and never claims the map is empty", { skip: !existsSync(CHROME), timeout: 240_000 }, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await b.goto(server.url);
    await b.eval(`document.getElementById('repo').focus()`); await b.type(join(ROOT, "fixtures/payments-repo"));
    await click(b, "Index");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);

    // Hold the pending state so it can be inspected: four seconds of latency on every request.
    await b.send("Network.enable");
    await b.send("Network.emulateNetworkConditions", { offline: false, latency: 4000, downloadThroughput: -1, uploadThroughput: -1 });

    await b.eval(`document.getElementById('chat-input').focus()`); await b.type("Where is createPayment used?"); await b.key("Enter");
    await wait(700);

    const seen = await b.eval<{ composing: boolean; empty: boolean; canvasSkel: number; busy: number; stageBusy: string | null; send: { busy: string | null; spinner: boolean } }>(`(() => {
      const text = document.body.innerText;
      const sendBtn = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Send');
      return {
        composing: /Composing a map for your question/.test(text),
        empty: /empty on purpose|Ask a question to compose a map|Nothing shown yet/.test(text),
        canvasSkel: document.querySelectorAll('.canvas-skeleton').length,
        busy: document.querySelectorAll('.skeleton, [aria-busy="true"]').length,
        stageBusy: document.querySelector('.stage')?.getAttribute('aria-busy') ?? null,
        send: { busy: sendBtn?.getAttribute('aria-busy') ?? null, spinner: !!sendBtn?.querySelector('.spinner') },
      };
    })()`);
    assert.equal(seen.empty, false, "the empty-state copy is not shown while a question is being answered");
    assert.equal(seen.composing, true, "the canvas says it is composing the map");
    assert.ok(seen.canvasSkel > 0, "the canvas shows a skeleton placeholder");
    assert.ok(seen.busy > 0, "a skeleton or busy region exists in the page");
    assert.equal(seen.stageBusy, "true", "the region being replaced is marked aria-busy");
    assert.equal(seen.send.busy, "true", "the Send button announces it is busy");
    assert.equal(seen.send.spinner, true, "the Send button shows a spinner, not just a fade");
  } finally {
    await b.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
    b.close();
    server.proc.kill();
  }
});
