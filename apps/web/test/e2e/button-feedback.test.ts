// Buttons must look different idle, hovered and pressed, and must show a pending state while they start work.
// Technique from the issue: crop the button face and compare the PNG bytes, so the regression cannot return.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const port = 4960 + Math.floor(Math.random() * 20), url = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, [join(ROOT, "packages/core/src/server.ts")], { env: { ...process.env, PORT: String(port), CIE_DB: join(mkdtempSync(join(tmpdir(), "cie-btn-")), "d.db"), CIE_PROVIDER: "stub", CIE_ROUTER: "off" }, stdio: "ignore" });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${url}/healthz`)).ok) return { proc, url }; } catch { /* not up yet */ } await wait(100); }
  proc.kill(); throw new Error("server did not start");
}

/** SHA-256 of the PNG bytes for a clip of the viewport, so only the button's own pixels are compared. */
async function faceHash(b: Browser, clip: { x: number; y: number; width: number; height: number }) {
  const shot = await b.send("Page.captureScreenshot", { format: "png", clip: { ...clip, scale: 2 } });
  return createHash("sha256").update(Buffer.from(shot.data as string, "base64")).digest("hex").slice(0, 16);
}

test("buttons show idle, hover and pressed as three different images, and a pending spinner while they work", { skip: !existsSync(CHROME), timeout: 240_000 }, async () => {
  const server = await start(), b = await Browser.launch();
  try {
    await b.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await b.goto(server.url);
    await b.eval(`document.getElementById('repo').focus()`); await b.type(join(ROOT, "fixtures/payments-repo"));
    const rect = () => b.eval<{ x: number; y: number; width: number; height: number }>(`(() => { const el = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Index'); const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
    // Do not index yet: give the pointer a moment away from the button so the idle crop is really idle.
    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 4, y: 4 }); await wait(300);
    const box = await rect();
    const idle = await faceHash(b, box);

    await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + box.width / 2, y: box.y + box.height / 2 }); await wait(300);
    const hover = await faceHash(b, box);

    await b.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 }); await wait(300);
    const pressed = await faceHash(b, box);
    await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: box.x + box.width / 2, y: box.y + box.height / 2 });

    assert.notEqual(hover, idle, "the button looks different when the pointer is over it");
    assert.notEqual(pressed, idle, "the button looks different while it is held down");
    assert.notEqual(pressed, hover, "hover and pressed are distinct");

    // Clicking Index starts a background job: the button must announce it, keep its label, and not just fade.
    await b.eval(`[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Index').click()`);
    await b.waitFor(() => `!!document.querySelector('button[aria-busy="true"] .spinner')`, 15_000, "the pending Index button");
    const pending = await b.eval<{ text: string; opacity: string; busy: string; spin: string }>(`(() => {
      const el = document.querySelector('button[aria-busy="true"]');
      return { text: el.textContent.trim(), opacity: getComputedStyle(el).opacity, busy: el.getAttribute('aria-busy'), spin: getComputedStyle(el.querySelector('.spinner')).animationName };
    })()`);
    assert.equal(pending.text, "Index", "the pending label is unchanged, so the layout does not jump");
    assert.equal(pending.opacity, "1", "the pending button is not merely faded");
    assert.equal(pending.busy, "true");
    assert.notEqual(pending.spin, "none", "the spinner is animated by default");

    // Reduced motion must stop the animation but keep the affordance.
    await b.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    const reduced = await b.eval<string>(`getComputedStyle(document.querySelector('button[aria-busy="true"] .spinner')).animationName`);
    assert.equal(reduced, "none", "prefers-reduced-motion stops the spinner animation");
  } finally {
    b.close();
    server.proc.kill();
  }
});
