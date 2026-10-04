// The screens for the components that used to be API-only, driven by keyboard in a real browser against a real server.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT, startServer } from "./harness.ts";

const REPO = join(ROOT, "fixtures/security-repo");
const text = (b: Browser, sel: string) => b.eval<string>(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ""`);
// Tabs use roving focus: Tab reaches the selected one, the arrow keys move between them.
async function tab(b: Browser, id: string) { await b.tabTo(`el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true'`); for (let i = 0; i < 9 && (await b.eval(`document.activeElement.id`)) !== `tab-${id}`; i++) { await b.key("ArrowRight"); await new Promise((r) => setTimeout(r, 60)); } await b.waitFor(() => `document.querySelector('[role=tabpanel]')?.getAttribute('aria-labelledby') === 'tab-${id}'`, 3000, `tab ${id}`); }
const press = async (b: Browser, label: string) => { await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === ${JSON.stringify(label)} && !el.disabled`); await b.key("Enter"); };

test("insights screens: security, configuration, identity, changes, runtime, sources, team and evaluation each show real data, labelled with how sure it is", { skip: !existsSync(CHROME), timeout: 180_000 }, async () => {
  const server = await startServer();
  const b = await Browser.launch();
  try {
    await b.goto(server.url);
    await b.tabTo(`el.id === 'repo'`); await b.type(REPO);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'`); await b.key("Enter");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);
    await b.tabTo(`el.id === 'chat-input'`); await b.type("how does registering a user work"); await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.elements li').length > 0`, 30_000);
    await press(b, "Insights");
    await b.waitFor(() => `!!document.querySelector('[role=dialog][aria-label=Insights]')`, 3000);
    // Security
    await b.waitFor(() => `!!document.getElementById('tab-security')`, 3000);
    await b.tabTo(`el.id === 'pols'`); await press(b, "Analyze");
    await b.waitFor(() => `document.querySelectorAll('[role=tabpanel] .card').length >= 3`, 15_000, "findings");
    const sec = await text(b, "[role=tabpanel]");
    assert.match(sec, /No finding does not mean safe/); assert.match(sec, /Counter-argument/); assert.match(sec, /State change without an authorisation check/);
    assert.ok(!/alarm \(gate satisfied\)/.test(sec), "nothing is an alarm before the gate");
    // The list is focusable; the arrow keys move the selection and the summary reads out in the detail pane.
    // The opening selection is set by an effect after the rows render, so wait for it before seeking rows.
    await b.waitFor(() => `!!document.querySelector('[role=option][aria-selected=true]') && !!document.querySelector('[role=tabpanel] .i-detail')`, 8000, "initial selection and detail pane");
    await b.tabTo(`el.getAttribute('role') === 'listbox' && el.getAttribute('aria-label') === 'Security findings by rule'`);
    const detailHas = (re: RegExp) => b.eval(`new RegExp(${JSON.stringify(re.source)}).test(document.querySelector('[role=tabpanel] .i-detail')?.innerText ?? "")`);
    for (let i = 0; i < 4 && !(await detailHas(/registerUser logs req\.body\.email, req\.body\.password/)); i++) { await b.key("ArrowDown"); await new Promise((r) => setTimeout(r, 150)); }
    assert.ok(await detailHas(/registerUser logs req\.body\.email, req\.body\.password/), "the PII finding is reachable by keys and its summary reads out");
    for (let i = 0; i < 5 && !(await detailHas(/deleteAccountHandler reaches removeAccount/)); i++) { await b.key("ArrowUp"); await new Promise((r) => setTimeout(r, 150)); }
    assert.ok(await detailHas(/deleteAccountHandler reaches removeAccount/), "the authorisation finding is reachable by keys");
    await press(b, "Start confirmation");
    await b.waitFor(() => `!!document.querySelector('[role=tabpanel] .card [role=status]')`, 8000, "gate result");
    await tab(b, "config");
    await b.waitFor(() => `/Routes/.test(document.querySelector('[role=tabpanel]').innerText)`, 8000);
    assert.match(await text(b, "[role=tabpanel]"), /not evidence of what is deployed or enabled anywhere/);
    await tab(b, "identity");
    await b.waitFor(() => `/Identity proposals/.test(document.querySelector('[role=tabpanel]').innerText)`, 8000);
    assert.match(await text(b, "[role=tabpanel]"), /name alone never merges/);
    await tab(b, "changes");
    await b.waitFor(() => `/Only one revision is indexed|Compare against/.test(document.querySelector('[role=tabpanel]').innerText)`, 8000);
    assert.match(await text(b, "[role=tabpanel]"), /never says what caused it/);
    await tab(b, "runtime");
    await press(b, "Ingest and attribute");
    await b.waitFor(() => `/Fog:/.test(document.querySelector('[role=tabpanel]').innerText)`, 10_000, "attribution");
    const rt = await text(b, "[role=tabpanel]");
    assert.match(rt, /not exact|exact/); assert.match(rt, /Quality:/);
    await tab(b, "sources");
    await b.waitFor(() => `/No external source has been connected|Credentials never enter the browser/.test(document.querySelector('[role=tabpanel]').innerText)`, 5000);
    await tab(b, "team");
    await b.waitFor(() => `/Sharing never grants access to code/.test(document.querySelector('[role=tabpanel]').innerText)`, 5000);
    await press(b, "Turn on team features for me");
    await b.waitFor(() => `/Team features are on for you/.test(document.querySelector('[role=tabpanel]').innerText)`, 8000);
    // The controls are laid out and labelled: a switch, and a visible label for every field (not placeholder-only).
    assert.ok(await b.eval(`(() => { const panel = document.querySelector('[role=tabpanel]'); const labelled = (id) => { const el = panel.querySelector('label[for="' + id + '"]'); return !!el && el.textContent.trim().length > 0 && !el.classList.contains('sr'); }; return !!panel.querySelector('[role=switch]') && labelled('pname') && labelled('deny') && labelled('wssel'); })()`), "team panel: a switch and visible labels for each field");
    await b.tabTo(`el.id === 'pname'`); await b.eval(`document.getElementById('pname').select()`); await b.type("bea");
    await press(b, "Add person");
    await b.waitFor(() => `/bea added\\. They have no access/.test(document.querySelector('[role=tabpanel]').innerText)`, 8000);
    await press(b, "Share the current map as a new investigation");
    await b.waitFor(() => `!!document.getElementById('who')`, 8000, "shared investigation");
    // Sharing with someone who cannot read the code is refused, in words.
    await b.tabTo(`el.id === 'who'`); await b.eval(`(() => { const s = document.getElementById('who'); s.value = 'bea'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await press(b, "Share");
    await b.waitFor(() => `/sharing cannot give it to them/.test(document.querySelector('[role=tabpanel]').innerText)`, 8000, "refusal");
    await tab(b, "evaluation");
    await b.waitFor(() => `/Model in use/.test(document.querySelector('[role=tabpanel]').innerText)`, 8000);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Run now'`); await b.key("Enter");
    await b.waitFor(() => `/Precision \\d+%/.test(document.querySelector('[role=tabpanel]').innerText)`, 30_000, "a suite run");
    const ev = await text(b, "[role=tabpanel]");
    assert.match(ev, /not expert-validated/); assert.match(ev, /\(\d+–\d+%, n=\d+\)/, "metrics carry intervals");
    // Arrow keys move between tabs, Escape closes.
    await b.tabTo(`el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true'`);
    await b.key("ArrowLeft");
    await b.waitFor(() => `document.activeElement.id === 'tab-team'`, 3000, "focus to move to the Team tab");
    await b.key("Escape");
    await b.waitFor(() => `!document.querySelector('[role=dialog][aria-label=Insights]')`, 3000);
    assert.deepEqual(b.console.filter((l) => /^exception|^error/.test(l)), []);
  } finally { b.close(); server.proc.kill("SIGKILL"); }
});
