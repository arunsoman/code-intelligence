// The policy matrix must get the panel's remaining height, not two rows squeezed by the text around it.
// Measured in a real browser: the share of the stage the matrix scroll region occupies, that the surrounding
// "what this means" list and the symbol key start collapsed, and that no column header is truncated.
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
  const port = 4990 + Math.floor(Math.random() * 9), url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [join(ROOT, "packages/core/src/server.ts")], { env: { ...process.env, PORT: String(port), CIE_DB: join(mkdtempSync(join(tmpdir(), "cie-matrix-")), "d.db"), CIE_PROVIDER: "stub", CIE_ROUTER: "off" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/healthz`)).ok) return { proc, url }; } catch { /* not up yet */ } await wait(100); }
  proc.kill(); throw new Error("server did not start");
}
const click = (b: Browser, label: string) => b.eval<boolean>(`(() => { const el = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) && !x.disabled); if (!el) return false; el.click(); return true; })()`);

test("the policy matrix gets the remaining height, its key and explanation start collapsed, and headers are not truncated", { skip: !existsSync(CHROME), timeout: 240_000 }, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await b.goto(server.url);
    await b.eval(`document.getElementById('repo').focus()`); await b.type(join(ROOT, "fixtures/payments-repo"));
    await click(b, "Index");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);
    // Force the form through the catalogue, so the test does not depend on the router's choice.
    await click(b, "Visuals");
    await b.waitFor(() => `document.querySelectorAll('.gallery li').length > 0`, 15_000, "the visuals gallery");
    await b.eval(`(() => { const li = [...document.querySelectorAll('.gallery li')].find((x) => /Policy enforcement map/.test(x.innerText)); if (!li) return false; const btn = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Show'); btn.click(); return true; })()`);
    await b.waitFor(() => `!!document.querySelector('.matrix table')`, 30_000, "the policy matrix");
    await wait(500);

    const m = await b.eval<{ share: number; scrollH: number; rows: number; consequencesOpen: boolean; keyOpen: boolean; keyItems: number; truncated: number }>(`(() => {
      const stage = document.querySelector('.stage');
      const scroll = document.querySelector('.matrix-scroll');
      const rows = document.querySelectorAll('.matrix tbody tr').length;
      const consequences = document.querySelector('.consequences');
      const key = document.querySelector('.matrix-key details');
      const truncated = [...document.querySelectorAll('.matrix .colhead .lbl')].filter((el) => el.scrollWidth > el.clientWidth + 1).length;
      return { share: scroll.clientHeight / stage.clientHeight, scrollH: scroll.clientHeight, rows, consequencesOpen: !!consequences && consequences.open, keyOpen: !!key && key.open, keyItems: document.querySelectorAll('.matrix-key > ul li').length, truncated };
    })()`);
    // The matrix takes the panel's remaining height: it is the majority of the stage, not a third.
    assert.ok(m.share >= 0.55, `matrix occupies ${Math.round(m.share * 100)}% of the stage (was about a third)`);
    assert.ok(m.scrollH >= 300, `matrix scroll region is ${m.scrollH}px tall, enough for several rows`);
    assert.ok(m.rows >= 3, `the matrix has ${m.rows} rows`);
    // The explanation and the full symbol key are available but do not permanently take space.
    assert.equal(m.consequencesOpen, false, "\"What this means\" starts collapsed");
    assert.equal(m.keyOpen, false, "the full symbol key starts collapsed");
    assert.ok(m.keyItems >= 2, "a compact key is still visible without opening the disclosure");
    assert.equal(m.truncated, 0, "no column header is truncated");
  } finally {
    b.close();
    server.proc.kill();
  }
});
