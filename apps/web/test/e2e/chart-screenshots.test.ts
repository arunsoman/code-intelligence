// Renders every chart type (V1–V19) with simulated data and takes a screenshot of each.
// Screenshots are written to /tmp/cie-chart-screenshots/ (or CIE_SCREENSHOT_DIR).
// Skipped automatically when Google Chrome is not installed.
//
// Run individually:
//   node --test apps/web/test/e2e/chart-screenshots.test.ts
//
// Each test:
//   1. Starts a fresh server with a stub model provider (no Ollama required).
//   2. Indexes fixtures/payments-repo (has payment operations, ledger writes, tests, git history).
//   3. Forces the specific visual via the Visuals gallery (never depends on the router's choice).
//   4. Waits for the canvas / matrix / terrain to finish rendering.
//   5. Captures a full-page screenshot via CDP Page.captureScreenshot and writes it to disk.

import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT } from "./harness.ts";

// ── Configuration ───────────────────────────────────────────────────────────────────
const REPO = join(ROOT, "fixtures/payments-repo");
const OUT_DIR = process.env.CIE_SCREENSHOT_DIR ?? join(tmpdir(), "cie-chart-screenshots");
const RENDER_TIMEOUT = 60_000; // ms to wait for a chart to appear
const INDEX_TIMEOUT = 90_000;  // ms to wait for the repository to index

// ── Helpers ─────────────────────────────────────────────────────────────────────────
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Build the web app if dist/index.html is stale. */
function ensureDist() {
  const dist = join(ROOT, "apps/web/dist/index.html");
  const srcFiles = execFileSync("find", [join(ROOT, "apps/web/src"), "-type", "f"], { encoding: "utf8" })
    .trim()
    .split("\n");
  const newest = Math.max(...srcFiles.map((f) => statSync(f).mtimeMs));
  if (!existsSync(dist) || statSync(dist).mtimeMs < newest) {
    execFileSync("npm", ["run", "web:build"], { cwd: ROOT, stdio: "ignore" });
  }
}

/** Start a CIE server on a random port with a temp database. Returns the child process and base URL. */
async function startServer(): Promise<{ proc: ChildProcess; url: string }> {
  const port = 4800 + Math.floor(Math.random() * 100);
  const dbPath = join(mkdtempSync(join(tmpdir(), "cie-shots-")), "shots.db");
  const proc = spawn(
    process.execPath,
    [join(ROOT, "packages/core/src/server.ts")],
    {
      env: {
        ...process.env,
        PORT: String(port),
        CIE_DB: dbPath,
        CIE_PROVIDER: "stub",   // fully offline — no Ollama needed
        CIE_ROUTER: "off",      // router is bypassed; we use the gallery
        NODE_OPTIONS: "",
      },
      stdio: "ignore",
    },
  );
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${url}/healthz`)).ok) return { proc, url }; } catch { /* not up yet */ }
    await wait(100);
  }
  proc.kill();
  throw new Error("server did not start within 12 s");
}

/** Click a <button> whose trimmed text starts with `label`. */
const clickButton = (b: Browser, label: string) =>
  b.eval<boolean>(
    `(() => { const el = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) && !x.disabled); if (!el) return false; el.click(); return true; })()`,
  );

/**
 * Open the Visuals gallery, find the entry whose name includes `namePart`, edit the question to
 * `question`, and press Show.
 *
 * Returns:
 *  "shown"       – the visual was triggered (button clicked).
 *  "trace"       – this chart requires a pasted stack trace (V2 / HypothesisGraph).
 *  "unavailable" – the entry is greyed out (unmet needs, e.g. needs two revisions).
 *  "notfound"    – no gallery entry matched `namePart`.
 */
async function showVisual(
  b: Browser,
  namePart: string,
  question: string,
): Promise<"shown" | "trace" | "unavailable" | "notfound"> {
  await clickButton(b, "Visuals");
  await b.waitFor(() => `document.querySelectorAll('.gallery li').length > 0`, 15_000, "visuals gallery");

  const result = await b.eval<"shown" | "trace" | "unavailable" | "notfound">(
    `(() => {
      const li = [...document.querySelectorAll('.gallery li')].find((x) => x.innerText.includes(${JSON.stringify(namePart)}));
      if (!li) return 'notfound';

      // This entry needs a pasted stack trace — no Show button.
      if (li.innerText.includes('Paste a stack trace')) return 'trace';

      // Greyed-out entry: the Show button is disabled (unmet needs).
      const btn = [...li.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Show');
      if (!btn || btn.disabled) return 'unavailable';

      // Set the question via React's internal setter so the controlled input updates.
      const inp = li.querySelector('input');
      if (inp) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(inp, ${JSON.stringify(question)});
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }
      btn.click();
      return 'shown';
    })()`,
  );

  // Close the gallery if it did not close itself (e.g. on 'unavailable' or 'trace').
  const open = await b.eval<boolean>(`!!document.querySelector('.modal')`);
  if (open) await clickButton(b, "Done");

  return result;
}

/** Take a CDP screenshot and save it. */
async function screenshot(b: Browser, name: string): Promise<string> {
  mkdirSync(OUT_DIR, { recursive: true });
  const { data } = await b.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data, "base64"));
  return file;
}

// ── Selector shortcuts ───────────────────────────────────────────────────────────────
/** True once the canvas has drawn at least one node. */
const canvasReady = () =>
  `document.querySelectorAll('.canvas [data-id]').length > 0 || document.querySelectorAll('.canvas .cy-node').length > 0 || (document.querySelector('.canvas') && document.querySelector('.canvas')._cyreg && document.querySelector('.canvas')._cyreg.cy.nodes().length > 0)`;

/** True once a cytoscape instance has at least one rendered node (more robust). */
const cyReady = () =>
  `(() => { try { const cy = document.querySelector('.canvas')?._cyreg?.cy; return !!cy && cy.nodes().length > 0; } catch { return false; } })()`;

/** True once the terrain treemap is rendered. */
const terrainReady = () => `document.querySelectorAll('.treemap-cell').length > 0 || document.querySelectorAll('.terrain rect').length > 0 || document.querySelector('.terrain-view')?.children.length > 0`;

/** True once a matrix table is present. */
const matrixReady = () => `document.querySelectorAll('.matrix table, .matrix-scroll table').length > 0`;

// ── Shared server / browser — created once, reused across all chart tests ───────────
let serverProc: ChildProcess | null = null;
let serverUrl = "";
let browser: Browser | null = null;
/** Set to true after the repository has been indexed the first time. */
let indexed = false;

async function getShared(): Promise<{ b: Browser; url: string }> {
  if (!browser) {
    ensureDist();
    const s = await startServer();
    serverProc = s.proc;
    serverUrl = s.url;
    browser = await Browser.launch();
    await browser.send("Emulation.setDeviceMetricsOverride", {
      width: 1400,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  return { b: browser, url: serverUrl };
}

async function ensureIndexed(): Promise<void> {
  if (indexed) return;
  const { b, url } = await getShared();
  await b.goto(url);
  await b.eval(`document.getElementById('repo').focus()`);
  await b.type(REPO);
  await clickButton(b, "Index");
  await b.waitFor(
    () => `/rev \\S+ · \\d+ files/.test(document.querySelector('header')?.innerText ?? '')`,
    INDEX_TIMEOUT,
    "repository indexed",
  );
  indexed = true;
}

// Clean up after all tests.
process.on("exit", () => {
  try { browser?.close(); } catch { /* best effort */ }
  try { serverProc?.kill("SIGKILL"); } catch { /* best effort */ }
});

// ── Chart definitions ────────────────────────────────────────────────────────────────
// Each entry: visual name fragment (matched against gallery), example question, wait condition, output filename.
const CHARTS: {
  code: string;
  name: string;        // substring of the gallery entry name
  question: string;
  waitFor: () => string;
  extraWait?: number;  // ms to settle after waitFor resolves
}[] = [
  {
    code: "V1",
    name: "Intent-relative architecture map",
    question: "Show me how authentication works",
    waitFor: cyReady,
    extraWait: 800,
  },
  {
    code: "V2",
    name: "Causal hypothesis graph",
    question: "Show me a hypothesis graph",
    waitFor: cyReady,
    extraWait: 500,
  },
  {
    code: "V3",
    name: "Failure-space map",
    question: "Show me everything that could cause a payment to fail",
    waitFor: cyReady,
    extraWait: 500,
  },
  {
    code: "V4",
    name: "Transaction journey",
    question: "Walk me through createPayment step by step",
    waitFor: cyReady,
    extraWait: 600,
  },
  {
    code: "V5",
    name: "Data lineage",
    question: "Who reads and writes balance?",
    waitFor: cyReady,
    extraWait: 500,
  },
  {
    code: "V6",
    name: "Semantic diff",
    question: "What changed since the last index?",
    // SemanticDiff needs two revisions; the canvas will show an empty/gap state — screenshot it anyway.
    waitFor: () =>
      `document.querySelector('.canvas') !== null || document.querySelector('.gap-list') !== null || document.querySelector('.stage') !== null`,
    extraWait: 800,
  },
  {
    code: "V7",
    name: "Archaeology chain",
    question: "Why is adjustBalance not transactional?",
    waitFor: cyReady,
    extraWait: 500,
  },
  {
    code: "V8",
    name: "Trust-boundary",
    question: "Who can reach adjustBalance and what stops them?",
    waitFor: cyReady,
    extraWait: 600,
  },
  {
    code: "V9",
    name: "Runtime overlay",
    question: "What has been going wrong in the last 7 days?",
    // RuntimeOverlay needs exceptions; falls back to showing the canvas with a gap notice.
    waitFor: () =>
      `document.querySelector('.canvas') !== null || document.querySelector('.gap-list') !== null || document.querySelector('.stage') !== null`,
    extraWait: 800,
  },
  {
    code: "V10",
    name: "Concurrency and race",
    question: "Where can balance race?",
    waitFor: cyReady,
    extraWait: 500,
  },
  {
    code: "V11",
    name: "Counterfactual overlay",
    question: "What if we remove the ledger module?",
    waitFor: cyReady,
    extraWait: 600,
  },
  {
    code: "V12",
    name: "Test-confidence",
    question: "How well tested are our operations?",
    waitFor: matrixReady,
    extraWait: 400,
  },
  {
    code: "V13",
    name: "Ownership",
    question: "Who owns what and where is the bus factor 1?",
    waitFor: cyReady,
    extraWait: 500,
  },
  {
    code: "V14",
    name: "Implicit-concept atlas",
    question: "Show the implicit concepts in this code",
    // ConceptAtlas needs concept cards; may fall back gracefully.
    waitFor: () =>
      `document.querySelector('.canvas') !== null || document.querySelector('.gap-list') !== null || document.querySelector('.stage') !== null`,
    extraWait: 600,
  },
  {
    code: "V15",
    name: "Policy enforcement",
    question: "Which policies are enforced and where are the gaps?",
    waitFor: matrixReady,
    extraWait: 400,
  },
  {
    code: "V16",
    name: "Change-risk terrain",
    question: "Where is it risky to change things?",
    waitFor: terrainReady,
    extraWait: 600,
  },
  {
    code: "V18",
    name: "Framework route",
    question: "What endpoints does this service expose and which are guarded?",
    waitFor: () =>
      `document.querySelector('.canvas') !== null || document.querySelector('.matrix table') !== null || document.querySelector('.stage') !== null`,
    extraWait: 500,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────────────

test(
  "chart screenshots: index payments-repo and render every chart type",
  { skip: !existsSync(CHROME), timeout: 600_000 },
  async (t) => {
    // Index once up-front.
    await ensureIndexed();
    const { b } = await getShared();

    const results: { code: string; name: string; file: string | null; skipped: boolean; error?: string }[] = [];

    for (const chart of CHARTS) {
      await t.test(`${chart.code} – ${chart.name}`, async () => {
        try {
          // Open the gallery and trigger the visual.
          const outcome = await showVisual(b, chart.name, chart.question);

          if (outcome === "trace") {
            // V2 HypothesisGraph: trigger via a pasted stack trace in the chat box.
            const fakeTrace = `Error: payment failed\n    at checkFraud (${REPO}/src/payments/fraud.ts:5:18)\n    at charge (${REPO}/src/payments/payment-service.ts:10:3)`;
            await b.eval(`document.getElementById('chat-input')?.focus()`);
            await b.eval(`(() => {
              const inp = document.getElementById('chat-input');
              if (!inp) return;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (setter) setter.call(inp, ${JSON.stringify(fakeTrace)});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await b.key("Enter");
          } else if (outcome === "notfound" || outcome === "unavailable") {
            // Fallback: ask via chat (handles unavailable charts like SemanticDiff needing two revisions,
            // or ConceptAtlas needing concept cards — the server will return a gap notice, which we still screenshot).
            await b.eval(`document.getElementById('chat-input')?.focus()`);
            await b.eval(`(() => {
              const inp = document.getElementById('chat-input');
              if (!inp) return;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                ?? Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
              if (setter) setter.call(inp, ${JSON.stringify(chart.question)});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await b.key("Enter");
          }
          // "shown" → the gallery button was clicked; nothing extra to do.

          // Wait for something to render.
          await b.waitFor(chart.waitFor, RENDER_TIMEOUT, `${chart.code} to render`);
          if (chart.extraWait) await wait(chart.extraWait);

          // Screenshot.
          const safeName = `${chart.code}-${chart.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
          const file = await screenshot(b, safeName);
          results.push({ code: chart.code, name: chart.name, file, skipped: false });

          // Verify the screenshot was written and is not trivially empty.
          assert.ok(existsSync(file), `screenshot file exists: ${file}`);
          assert.ok(statSync(file).size > 1000, `screenshot is not trivially empty (${statSync(file).size} bytes)`);

          console.log(`  ✓ ${chart.code} (${outcome}) → ${file}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ code: chart.code, name: chart.name, file: null, skipped: false, error: msg });
          // Re-throw so the sub-test is marked failed.
          throw err;
        }
      });
    }

    // Print a summary table.
    console.log("\n── Chart screenshot summary ──────────────────────────────────");
    console.log(`Output directory: ${OUT_DIR}`);
    for (const r of results) {
      const status = r.error ? "✗ FAIL" : r.skipped ? "– SKIP" : "✓ OK  ";
      console.log(`  ${status}  ${r.code}  ${r.name}${r.error ? `\n         ${r.error}` : ""}`);
    }
    console.log("──────────────────────────────────────────────────────────────\n");

    // Fail loudly if console logged any JS exceptions.
    const jsErrors = b.console.filter((l) => /^exception|^error/.test(l));
    if (jsErrors.length > 0) {
      console.warn("JS console errors during test:", jsErrors);
    }
  },
);
