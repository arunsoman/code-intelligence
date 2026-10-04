// Opening the gaps / left-out disclosures must not resize the canvas or push the map off-screen (#52).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT, startServer } from "./harness.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("opening the gaps and left-out panels leaves the canvas height and the map unchanged", { skip: !existsSync(CHROME), timeout: 180_000 }, async () => {
  const server = await startServer(), b = await Browser.launch();
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await b.goto(server.url);
    await b.tabTo(`el.id === 'repo'`); await b.type(join(ROOT, "fixtures/payments-repo"));
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'`); await b.key("Enter");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000, "the repository to be indexed");
    await b.tabTo(`el.id === 'chat-input'`); await b.type("give me an overview of the whole project"); await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.footer-toggle').length >= 1`, 30_000, "the gaps and left-out toggles");
    await wait(800);

    const probe = () => b.eval<{ stage: number; hint: string; panel: boolean; panelBottom: number; footerTop: number; maxH: string; overflow: string; expanded: string[] }>(`(() => {
      const stage = document.querySelector('.stage'), footer = document.querySelector('footer'), panel = document.querySelector('.footer-panel');
      const cs = panel ? getComputedStyle(panel) : null;
      return {
        stage: stage.clientHeight,
        hint: document.querySelector('.canvas-hint')?.innerText ?? '',
        panel: !!panel,
        panelBottom: panel ? Math.round(panel.getBoundingClientRect().bottom) : 0,
        footerTop: Math.round(footer.getBoundingClientRect().top),
        maxH: cs?.maxHeight ?? '', overflow: cs?.overflowY ?? '',
        expanded: [...document.querySelectorAll('.footer-toggle')].map((x) => x.getAttribute('aria-expanded') ?? ''),
      };
    })()`);
    const before = await probe();
    assert.equal(before.panel, false, "nothing is open at the start");

    const click = (i: number) => b.eval(`document.querySelectorAll('.footer-toggle')[${i}].click()`);
    await click(0); await wait(300);
    const afterGaps = await probe();
    assert.equal(afterGaps.panel, true, "the gaps panel opens");
    assert.equal(afterGaps.stage, before.stage, "opening the gaps panel does not change the canvas height");
    assert.equal(afterGaps.hint, before.hint, "and does not change what the map reports about itself");
    assert.ok(afterGaps.panelBottom <= afterGaps.footerTop + 1, "the panel sits above the footer, out of flow");
    assert.match(afterGaps.maxH, /px$/, "the panel is height-bounded");
    assert.equal(afterGaps.overflow, "auto", "and scrolls inside its own region");

    await click(1); await wait(300);
    const afterBoth = await probe();
    assert.equal(afterBoth.stage, before.stage, "opening the left-out panel too still does not resize the canvas");
    assert.equal(afterBoth.hint, before.hint, "the map is unchanged while both are open");
    assert.ok(afterBoth.panelBottom <= afterBoth.footerTop + 1, "still out of flow with both open");

    await click(0); await click(1); await wait(300);
    const afterClose = await probe();
    assert.equal(afterClose.panel, false, "closing both removes the panel");
    assert.equal(afterClose.stage, before.stage, "and the canvas was never resized");
    assert.deepEqual(afterClose.expanded, ["false", "false"], "the toggles report they are collapsed");
  } finally {
    b.close();
    server.proc.kill("SIGKILL");
  }
});
