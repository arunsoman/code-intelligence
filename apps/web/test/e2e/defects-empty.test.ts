// The Defects panel's empty state must read as a row inside the list column, not bare text at the dialog edge (#51).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT, startServer } from "./harness.ts";

test("the Defects empty state stays inside the list column, inset like the rows, at every width", { skip: !existsSync(CHROME), timeout: 180_000 }, async () => {
  const server = await startServer(), b = await Browser.launch();
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await b.goto(server.url);
    await b.tabTo(`el.id === 'repo'`); await b.type(join(ROOT, "fixtures/security-repo"));
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'`); await b.key("Enter");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000, "the repository to be indexed");
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Defects'`); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('.defect.dialog')`, 5000);
    await b.waitFor(() => `!!document.querySelector('.d-empty')`, 8000, "the empty state (nothing has been analysed yet)");

    for (const w of [1920, 1400, 1200, 900, 800, 700, 520]) {
      await b.send("Emulation.setDeviceMetricsOverride", { width: w, height: 900, deviceScaleFactor: 1, mobile: false });
      await new Promise((r) => setTimeout(r, 120));
      const m = await b.eval<{ text: string; empty: { l: number; r: number }; list: { l: number; r: number }; padL: number; pageOverflow: number }>(`(() => {
        const box = (el) => { const r = el.getBoundingClientRect(); return { l: Math.round(r.left), r: Math.round(r.right) }; };
        const e = document.querySelector('.d-empty'), l = document.querySelector('.d-list');
        return { text: e.innerText.slice(0, 40), empty: box(e), list: box(l), padL: parseFloat(getComputedStyle(e).paddingLeft), pageOverflow: document.documentElement.scrollWidth - innerWidth };
      })()`);
      assert.match(m.text, /No candidates are recorded/, `at ${w}px the empty state is the expected message`);
      assert.ok(m.empty.l >= m.list.l, `at ${w}px the empty text starts inside the list column (${m.empty.l} >= ${m.list.l})`);
      assert.ok(m.empty.r <= m.list.r + 1, `at ${w}px the empty text ends inside the list column (${m.empty.r} <= ${m.list.r})`);
      assert.ok(m.padL >= 6, `at ${w}px the empty state is inset like a row (padding-left ${m.padL}px)`);
      assert.ok(m.pageOverflow <= 0, `at ${w}px nothing overflows the page (${m.pageOverflow}px)`);
    }
    // The right pane still explains the empty detail pane.
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 900, deviceScaleFactor: 1, mobile: false });
    await b.waitFor(() => `/Select a finding|Click a finding/.test(document.querySelector('.d-detail')?.innerText ?? "")`, 3000, "the detail placeholder");
  } finally {
    b.close();
    server.proc.kill("SIGKILL");
  }
});
