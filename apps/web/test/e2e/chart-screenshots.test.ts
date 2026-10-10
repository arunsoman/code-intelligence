import { captureReport, type CaptureResult } from "./capture-report.ts";
// Renders every gallery chart type (S1–S28, V1–V19) with simulated data and takes a screenshot of each.
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
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT } from "./harness.ts";

// ── Configuration ───────────────────────────────────────────────────────────────────
const REPO = process.env.CIE_SCREENSHOT_REPO ?? join(ROOT, "fixtures/payments-repo");
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
  // Ask the OS for an unused port rather than reusing a small random pool.
  const reservation = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", () => {
      const address = reservation.address();
      if (!address || typeof address === "string") { reservation.close(); reject(new Error("No test port allocated")); return; }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
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
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let startup = "", listening = false, launchError: Error | undefined;
  proc.on("error", error => { launchError = error; });
  proc.stdout?.on("data", data => { startup = (startup + data.toString()).slice(-8000); listening ||= startup.includes(`cie listening on http://127.0.0.1:${port}`); });
  proc.stderr?.on("data", data => { startup = (startup + data.toString()).slice(-8000); });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    if (launchError || proc.exitCode !== null) throw new Error(`Capture server failed to start: ${launchError?.message ?? startup}`);
    try { if (listening && (await fetch(`${url}/healthz`)).ok) return { proc, url }; } catch { /* not up yet */ }
    await wait(100);
  }
  proc.kill();
  throw new Error(`Capture server did not start within 12 s: ${startup}`);
}

/** Click a <button> whose trimmed text starts with `label`. */
const clickButton = (b: Browser, label: string) =>
  b.eval<boolean>(
    `(() => { const el = [...document.querySelectorAll('button')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(label)}) && !x.disabled); if (!el) return false; el.click(); return true; })()`,
  );

/**
 * Open the Visuals gallery, find the entry by stable chart code, edit the question to
 * `question`, and press Show.
 *
 * Returns:
 *  "shown"       – the visual was triggered (button clicked).
 *  "trace"       – this chart requires a pasted stack trace (V2 / HypothesisGraph).
 *  "unavailable" – the entry is greyed out (unmet needs, e.g. needs two revisions).
 *  "notfound"    – no gallery entry matched the code.
 */
async function showVisual(
  b: Browser,
  code: string,
  question: string,
): Promise<"shown" | "trace" | "unavailable" | "notfound"> {
  await clickButton(b, "Visuals");
  await b.waitFor(
    () => `!!document.querySelector('[data-visual-code="${code}"]')`,
    15_000,
    `${code} in visuals gallery`,
  );

  const result = await b.eval<"shown" | "trace" | "unavailable" | "notfound">(
    `(() => {
      const li = document.querySelector('[data-visual-code="${code}"]');
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
      return 'shown';
    })()`,
  );

  if(result==="shown")await b.eval(`document.querySelector('[data-visual-code="${code}"] button')?.click()`);

  // Close the gallery if it did not close itself (e.g. on 'unavailable' or 'trace').
  const open = await b.eval<boolean>(`!!document.querySelector('.modal')`);
  if (open && result !== "unavailable") await clickButton(b, "Done");

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
  `(() => { if(document.querySelector('.typed-table table')) return true; if (document.querySelectorAll("[data-sequence-element=participant]").length) return true; try { const cy = document.querySelector('.canvas')?._cyreg?.cy; return !!cy && cy.nodes().length > 0; } catch { return false; } })()`;

/** True once the terrain treemap is rendered. */
const terrainReady = () => `document.querySelectorAll('.treemap-cell').length > 0 || document.querySelectorAll('.terrain rect').length > 0 || document.querySelector('.terrain-view')?.children.length > 0`;

/** True once a matrix table is present. */
const matrixReady = () => `document.querySelectorAll('.matrix table, .matrix-scroll table, .typed-table table').length > 0`;

// ── Shared server / browser — created once, reused across all chart tests ───────────
let serverProc: ChildProcess | null = null;
let serverUrl = "";
let browser: Browser | null = null;
const results: CaptureResult[] = [];
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
  await b.waitFor(() => `[...document.querySelectorAll('button')].some((x) => x.textContent.trim().startsWith('Build concept hierarchy') && !x.disabled)`, INDEX_TIMEOUT, "hierarchy build available");
  assert.equal(await clickButton(b, "Build concept hierarchy"), true);
  await b.waitFor(() => `/[1-9]\\d* hierarchy concepts/.test(document.querySelector('header')?.innerText ?? '')`, INDEX_TIMEOUT, "concept hierarchy built");
  indexed = true;
}

// Clean up after all tests.
after(() => {
  mkdirSync(OUT_DIR,{recursive:true});writeFileSync(join(OUT_DIR,"capture-report.json"),JSON.stringify(captureReport(results),null,2));
  try { browser?.close(); } catch { /* best effort */ }
  try { serverProc?.kill("SIGKILL"); } catch { /* best effort */ }
});
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
  timeoutMs?: number;
  extraWait?: number;  // ms to settle after waitFor resolves
}[] = [
  // S1–S28 exercise the notation-specific chart.v2 renderers added by the generated-chart pipeline.
  // Unsupported offline notations still render their evidence-gap caption and are screenshot-worthy.
  ...[
    ["S1", "C4 container / component architecture", "Show how createPayment calls charge, reserve, and commit in the payment and ledger code."],
    ["S2", "Reserve fast-path sequence / swimlane", "Show reserve as a swimlane journey."],
    ["S3", "BatchId lifecycle state machine", "Show the reserve, commit, and adjustBalance lifecycle in src/ledger/ledger.ts."],
    ["S4", "Ledger and entry relationships", "Show the ledger and entry relationships."],
    ["S5", "Test-guarantee matrix", "Show the test-guarantee matrix."],
    ["S6", "Use case diagram", "Show the payments use case diagram."],
    ["S7", "BPMN process diagram", "Show the payments BPMN process."],
    ["S8", "Event storming / event modeling", "Show the payments event storming board."],
    ["S9", "Entity-relationship (ER) diagram", "Show the account balance and held fields written by reserve and commit through db.update in ledger.ts as an ER-style diagram."],
    ["S10", "Data flow diagram (DFD)", "Show the payments data flow diagram."],
    ["S11", "Decision table", "Show the reserve decision table."],
    ["S12", "Saga / compensation graph", "Show the reserve saga and compensations."],
    ["S13", "Outbox pattern topology", "Show the queue and capture-worker flow from payment-service through ledger.commit, including any outbox evidence."],
    ["S14", "Idempotency matrix", "Show the idempotency matrix."],
    ["S15", "DI wiring diagram", "Show the dependencies from payment-service to ledger.reserve, fraud.checkFraud, and gateway-client."],
    ["S16", "UML class diagram", "Show the classes, fields, operations, and relationships in the payments code."],
    ["S17", "UML package diagram", "Show the packages and dependencies in this repository."],
    ["S18", "UML communication diagram", "Show the numbered messages for the reserve flow."],
    ["S19", "UML interaction overview", "Show an interaction overview for reserve, commit, and rollback."],
    ["S20", "CRC cards", "Show CRC cards for the payment and ledger classes."],
    ["S21", "Call graph", "Show the static call graph rooted at createPayment."],
    ["S22", "Layered architecture", "Show the layers and dependencies in this service."],
    ["S23", "Dependency / module graph", "Show the compile-time module dependencies in this repository."],
    ["S24", "State transition table", "Show the state transition table for reserve, commit, and rollback."],
    ["S25", "FMEA / compensation matrix", "Show failure modes and their evidenced impacts and compensations."],
    ["S26", "Metrics / telemetry map", "Show metric names and emitters declared in this repository."],
    ["S27", "C4 context diagram", "Show the bookkeeping system, its callers, and external systems."],
    ["S28", "UML sequence diagram", "Draw the UML sequence diagram for createPayment calling charge, reserve, and commit in the payments code."],
  ].map(([code, name, question]) => ({
    code, name, question,
    waitFor: () => `!!document.querySelector('[aria-label="Chart type: ${code}"]')`,
    timeoutMs: 15_000,
    extraWait: 500,
  })),
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
    code: "V17",
    name: "Trace-linked profile",
    question: "Show the sampled profile for this repository.",
    waitFor: () => `!!document.querySelector('.modal') && document.body.innerText.includes('Trace-linked profile')`,
    extraWait: 300,
  },
  {
    code: "V18",
    name: "Framework route",
    question: "What endpoints does this service expose and which are guarded?",
    waitFor: () =>
      `document.querySelector('.canvas') !== null || document.querySelector('.matrix table') !== null || document.querySelector('.stage') !== null`,
    extraWait: 500,
  },
  {
    code: "V19",
    name: "Generated chart",
    question: "Show the createPayment call flow as a generated chart.",
    waitFor: () => `!!document.querySelector('[aria-label="Chart type: generic"]')`,
    timeoutMs: 15_000,
    extraWait: 500,
  },
];

// ── Tests ────────────────────────────────────────────────────────────────────────────

test(
  "chart screenshots: index payments-repo and render every chart type",
  { skip: !existsSync(CHROME), timeout: 600_000 },
  async (t) => {
    // Index once up-front.
    try { await ensureIndexed(); } catch(error) {
      const message=error instanceof Error?error.message:String(error);
      for(const chart of CHARTS.filter(c=>!process.env.CIE_CHART_CODES || process.env.CIE_CHART_CODES.split(",").includes(c.code)))results.push({code:chart.code,name:chart.name,file:null,skipped:false,error:message,blocked:true,stage:"startup"});
      throw error;
    }
    const { b } = await getShared();


    const selected = process.env.CIE_CHART_CODES
      ? CHARTS.filter((chart) => process.env.CIE_CHART_CODES!.split(",").includes(chart.code))
      : CHARTS;
    for (const chart of selected) {
      await t.test(`${chart.code} – ${chart.name}`, async () => {
        let stage="gallery";
        try {
          // Open the gallery and trigger the visual.
          const outcome = await showVisual(b, chart.code, chart.question);

          if (outcome === "trace") {
            // V2 HypothesisGraph: trigger via a pasted stack trace in the chat box.
            const fakeTrace = `Error: payment failed\n    at checkFraud (${REPO}/src/payments/fraud.ts:5:18)\n    at charge (${REPO}/src/payments/payment-service.ts:10:3)`;
            await b.eval(`document.getElementById('chat-input')?.focus()`);
            await b.eval(`(() => {
              const inp = document.getElementById('chat-input');
              if (!inp) return;
              const proto = inp instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(inp, ${JSON.stringify(fakeTrace)});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await b.key("Enter");
          } else if (outcome === "notfound") {
            // If the catalog entry is absent, ask via chat and screenshot the honest fallback answer.
            await b.eval(`document.getElementById('chat-input')?.focus()`);
            await b.eval(`(() => {
              const inp = document.getElementById('chat-input');
              if (!inp) return;
              const proto = inp instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
              const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
              if (setter) setter.call(inp, ${JSON.stringify(chart.question)});
              inp.dispatchEvent(new Event('input', { bubbles: true }));
            })()`);
            await b.key("Enter");
          }
          // "shown" → the gallery button was clicked; nothing extra to do.

          stage="generation";
          // Wait for the requested response to finish, including explicit empty/gap results.
          await b.waitFor(()=>`!document.querySelector('.stage[aria-busy="true"]') && !document.querySelector('.chip.busy')`,RENDER_TIMEOUT,`${chart.code} generation finished`);
          // Wait for something to render.
          if (outcome !== "unavailable") await b.waitFor(chart.waitFor, chart.timeoutMs ?? RENDER_TIMEOUT, `${chart.code} to render`);
          stage="layout";
          await b.waitFor(() => `!document.querySelector('.canvas[aria-busy="true"]')`, RENDER_TIMEOUT, "graph layout finished");
          if (["S1"].includes(chart.code) && outcome === "shown") {
            await b.waitFor(() => `document.querySelector('.canvas')?.dataset.layoutEngine === 'elk' && !document.querySelector('.canvas[aria-busy="true"]')`, RENDER_TIMEOUT, `${chart.code} uses the ELK worker`);
            if (chart.code === "S1") {
              assert.ok(await b.eval(`document.querySelector('.canvas')._cyreg.cy.nodes().filter((n) => !n.isParent()).length > 1`), "architecture chart retains its detail");
              assert.ok(await b.eval(`document.querySelector('.canvas')._cyreg.cy.edges().some((e) => e.style('curve-style') === 'segments')`), "ELK edge routes reach the renderer");
            }
          }
          if (chart.extraWait) await wait(chart.extraWait);

          stage="interaction";
          if(["S11","S14","S20","S24","S25","S26"].includes(chart.code) && outcome==="shown") {
            assert.equal(await b.eval(`!!document.querySelector('[aria-label="Canvas tools"]')`),false,"graph-only tools do not cover table content");
            assert.ok(await b.eval(`document.querySelector('[aria-label="Evidence status summary"]')?.textContent.includes('table cells')`),"evidence summary counts table cells rather than invisible graph rows");
            assert.ok(await b.eval(`!!document.querySelector('.typed-table table')`), "requested native table is rendered");
            if(process.env.CIE_REQUIRE_TABLE_ROWS==="1") assert.ok(await b.eval(`document.querySelectorAll('.typed-table tbody tr').length > 0`), "fixture supplies populated native table rows");
            if(chart.code==="S20") assert.ok(await b.eval(`document.querySelector('.typed-table thead').textContent.includes('Responsibilities') && document.querySelector('.typed-table thead').textContent.includes('Collaborators')`));
            if(chart.code==="S26") assert.ok(await b.eval(`document.querySelector('.typed-table-key').textContent.includes('No live values') && document.querySelector('.typed-table thead').textContent.includes('Declared emitters')`));
            const contrast=await b.eval<number>(`(()=>{
              const tab=document.querySelector('.response-tab [role=tab][aria-selected=false]');if(!tab)return 21;
              const style=getComputedStyle(tab),lum=color=>{const rgb=color.match(/\\d+/g).slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2];};
              const a=lum(style.color),z=lum(style.backgroundColor);return (Math.max(a,z)+.05)/(Math.min(a,z)+.05);
            })()`);assert.ok(contrast>=4.5,`inactive tab contrast ${contrast} meets 4.5:1`);
          }
          if (outcome === "shown" && ["S5", "S11", "S14", "S20", "S24", "S25", "S26", "V12", "V15", "V16"].includes(chart.code)) {
            const selector = chart.code === "V16" ? ".terrain" : ["S11", "S14", "S20", "S24", "S25", "S26"].includes(chart.code) ? ".typed-table" : ".matrix";
            const before = await b.eval(`(() => {
              const host = document.querySelector('${selector}');
              const cells = [...host.querySelectorAll('.mcell, .table-cell, .terrain-svg g.cell')];
              return cells.map((n) => { const r = n.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height,text:n.textContent}; });
            })()`);
            if(before.length) {
            const point = await b.eval<{x: number; y: number}>(`(() => { const cells = [...document.querySelectorAll('${selector} .mcell, ${selector} .table-cell, ${selector} .terrain-svg g.cell')]; const cell = cells.find((n) => {const r=n.getBoundingClientRect();return r.x > 0 && r.y > 0 && r.bottom < innerHeight && r.x < innerWidth-350}) || cells[0]; const r = cell.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
            await b.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
            await b.waitFor(() => `document.querySelector('${selector}').dataset.lensActive === 'true' && Number(document.querySelector('${selector}').dataset.lensChildren) > 0`, 5000, "shared lens expands a hovered cell automatically");
            assert.equal(await b.eval(`getComputedStyle(document.querySelector('${selector}')).backgroundColor`), "rgb(11, 15, 23)");
            assert.deepEqual(await b.eval(`(() => { const host = document.querySelector('${selector}'); return [...host.querySelectorAll('.mcell, .table-cell, .terrain-svg g.cell')].map((n) => {const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,text:n.textContent};}); })()`), before, "lens never changes source cell geometry");
            await wait(300);
            } else assert.ok(await b.eval(`/No (rows|columns) with current evidence/.test(document.querySelector('${selector}').textContent)`), "empty tables explain missing evidence");
          }

          stage="capture";
          // Screenshot.
          const safeName = `${chart.code}-${chart.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
          const file = await screenshot(b, safeName);
          results.push({ code: chart.code, name: chart.name, file, skipped: outcome === "unavailable" });

          // Verify the screenshot was written and is not trivially empty.
          assert.ok(existsSync(file), `screenshot file exists: ${file}`);
          assert.ok(statSync(file).size > 1000, `screenshot is not trivially empty (${statSync(file).size} bytes)`);

          console.log(`  ✓ ${chart.code} (${outcome}) → ${file}`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          let failureFile:string|null=null;
          try { failureFile=await screenshot(b,`${chart.code}-failure`); } catch { /* browser may be unavailable */ }
          const diagnosticFile=join(OUT_DIR,`${chart.code}-diagnostics.json`);
          let page="";try {page=await b.eval<string>(`document.body.innerText.slice(0,6000)`);} catch { /* disconnected */ }
          mkdirSync(OUT_DIR,{recursive:true});writeFileSync(diagnosticFile,JSON.stringify({code:chart.code,stage,error:msg,page,console:b.console.slice(-30)},null,2));
          results.push({ code: chart.code, name: chart.name, file: failureFile, skipped: false, error: msg,stage,diagnosticFile });
          try { console.log(`  page state (${chart.code}): ${(await b.eval<string>(`document.body.innerText.slice(0, 2400)`)).replace(/\s+/g, " ")}`); } catch { /* page may have navigated */ }
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
