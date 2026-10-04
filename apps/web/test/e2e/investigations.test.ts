import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT, startServer } from "./harness.ts";

test("investigation board: create, pause, resume, run checks, inspect evidence, poll new observations and reopen", { skip: !existsSync(CHROME), timeout: 120_000 }, async () => {
  const server = await startServer(); let browser: Browser | undefined;
  try {
    const api = async (path: string, body: unknown) => {
      const r = await fetch(server.url + path, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }, body: JSON.stringify(body) });
      const result = await r.json() as any; assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
    };
    const repo = join(ROOT, "fixtures/payments-repo");
    await api("/api/v1/components/C04/ingestRepository", { repoPath: repo });
    const b = browser = await Browser.launch();
    const press = async (label: string) => { await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === ${JSON.stringify(label)} && !el.disabled`); await b.key("Enter"); };
    await b.goto(server.url);
    await b.waitFor(() => `Array.from(document.querySelectorAll('button')).some(b => b.textContent === 'Investigations' && !b.disabled)`);
    await press("Investigations");
    await b.waitFor(() => `!!document.querySelector('[role=dialog][aria-label=Investigations]')`);
    assert.equal(await b.eval(`document.activeElement.textContent`), "Close investigations");
    await b.tabTo(`el.id === 'investigation-question'`); await b.type("Why does createPayment fail?");
    await b.tabTo(`el.id === 'investigation-trace'`);
    await b.type(`FraudRejectedError: over limit\n    at checkFraud (${repo}/src/payments/fraud.ts:5:18)\n    at createPayment (${repo}/src/api/payments-controller.ts:6:11)`);
    await press("Create investigation");
    await b.waitFor(() => `document.querySelector('.investigation-status')?.textContent.startsWith('ready')`);
    const id = await b.eval<string>(`document.getElementById('investigation-select').value`);
    assert.ok(id.startsWith("inv:"));
    await press("Pause investigation");
    await b.waitFor(() => `document.querySelector('.investigation-status')?.textContent.startsWith('paused')`);
    await press("Resume investigation");
    await b.waitFor(() => `document.querySelector('.investigation-status')?.textContent.startsWith('ready')`);
    await press("Run next checks");
    await b.waitFor(() => `document.querySelectorAll('.investigation-hypotheses li').length >= 3`, 30_000);
    await b.waitFor(() => `document.querySelectorAll('.investigation-table tbody tr').length > 0`, 30_000);
    assert.match(await b.eval(`document.querySelector('.investigation-table').textContent`), /Supports|Contradicts|Inconclusive/);
    await b.tabTo(`el.tagName === 'BUTTON' && !!el.closest('.investigation-hypotheses')`); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('[aria-label="Hypothesis details"]')`);
    assert.match(await b.eval(`document.querySelector('[aria-label="Hypothesis details"]').textContent`), /Predictions.*Assumptions.*Basis evidence/s);
    await b.tabTo(`el.tagName === 'BUTTON' && !!el.closest('.investigation-table') && el.textContent.startsWith('ev:')`); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('[aria-label="Investigation evidence"] pre')`);
    assert.ok((await b.eval<string>(`document.querySelector('[aria-label="Investigation evidence"] pre').textContent`)).length > 0);
    // Changes from another client arrive in this open board without a refresh button.
    let snapshot = await api("/api/v2/components/C22/get", { investigationId: id });
    for (let i = 0; snapshot.execution === "RUNNING" && i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100)); snapshot = await api("/api/v2/components/C22/get", { investigationId: id });
    }
    await api("/api/v2/components/C22/attachEvidence", { investigationId: id, expectedVersion: snapshot.version, observation: { evidenceIds: [], description: "A second client reported a retry", sourceEventId: "browser-observation", kind: "USER_REPORT", outcome: "UNKNOWN" } });
    await b.waitFor(() => `document.querySelector('.investigation-table')?.textContent.includes('A second client reported a retry')`);
    assert.match(await b.eval(`document.querySelector('.investigation-table tbody tr:last-child').textContent`), /Not assessed/);
    await b.key("Escape");
    await b.waitFor(() => `!document.querySelector('[aria-label=Investigations][role=dialog]')`);
    assert.equal(await b.eval(`document.activeElement.textContent`), "Investigations");
    await b.goto(server.url); await press("Investigations");
    await b.waitFor(() => `document.querySelectorAll('#investigation-select option').length > 1`);
    await b.tabTo(`el.id === 'investigation-select'`); await b.key("Home"); await b.key("ArrowDown"); await b.key("Enter");
    await b.waitFor(() => `document.querySelector('.investigation-table')?.textContent.includes('A second client reported a retry')`);
    assert.equal(await b.eval(`document.getElementById('investigation-select').value`), id);
    // A failed/revoked detail read removes the previous matrix, then recovers on a successful poll.
    await b.eval(`window.__originalFetch = window.fetch; window.fetch = async (...args) => String(args[0]).endsWith('/C22/getDetails')
      ? new Response(JSON.stringify({ok: false, error: {code: 'FORBIDDEN', message: 'Access withdrawn'}}), {headers: {'content-type': 'application/json'}})
      : window.__originalFetch(...args)`);
    await b.waitFor(() => `document.querySelector('.investigation-panel [role=alert]')?.textContent === 'Access withdrawn'`);
    assert.equal(await b.eval(`document.querySelectorAll('.investigation-table').length`), 0);
    assert.equal(await b.eval(`document.querySelectorAll('[aria-label="Investigation evidence"]').length`), 0);
    await b.eval(`window.fetch = window.__originalFetch`);
    await b.waitFor(() => `!!document.querySelector('.investigation-table') && !document.querySelector('.investigation-panel [role=alert]')`);
    assert.deepEqual(b.console.filter((x) => x.startsWith("exception:")), []);
  } finally { browser?.close(); server.proc.kill(); }
});
