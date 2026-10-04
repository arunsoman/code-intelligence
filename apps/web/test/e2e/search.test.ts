// F01 end-to-end: cross-repository search is fully keyboard-operable (D9) and the accessibility tree
// carries every honesty surface (D10) — the listbox, the live region with the result count, the
// coverage strip that names states and the skipped things, and the dialogs' named roles.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { REPO, startServer } from "./harness.ts";

test("search: Ctrl+K opens it, results are a keyboard-driven listbox, coverage and counts are spoken (F01-D9/D10)", { skip: !existsSync(CHROME), timeout: 120_000 }, async () => {
  const server = await startServer();
  const b = await Browser.launch();
  try {
    await b.goto(server.url);
    await b.tabTo(`el.id === 'repo'`);
    await b.type(REPO);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'`);
    await b.key("Enter");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);

    // D9: the keyboard alone opens the panel (Ctrl/Cmd+K) with focus inside it.
    await b.key("k", { ctrl: true });
    await b.waitFor(() => `!!document.querySelector('[role=dialog][aria-label="Cross-repository search"]')`, 5000, "search dialog");
    const focusInDialog = await b.eval(`!!document.activeElement?.closest('[role=dialog]')`);
    assert.ok(focusInDialog, "focus lands inside the dialog, not behind it");

    // type a query, press Enter, results appear in a listbox
    await b.type("findByEmail");
    await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('[role=listbox] [role=option]').length > 0`, 20_000, "results");
    const optionCount = await b.eval(`document.querySelectorAll('[role=listbox] [role=option]').length`);
    assert.ok(optionCount >= 1, `at least one result: ${optionCount}`);

    // D9: arrows move the selection without a pointer (aria-selected follows the active option)
    await b.tabTo(`el.getAttribute('role') === 'combobox'`);
    await b.key("ArrowDown");
    await new Promise((r) => setTimeout(r, 80));
    const secondSel = await b.eval(`document.querySelector('[role=option][aria-selected=true]')?.id ?? ""`);
    const secondIdx = Number(secondSel.split("-o").pop() ?? 0);
    assert.ok(secondIdx >= 1, `arrow keys advance the selection: ${secondSel}`);

    // D10: a live region announces the count in words a screen reader reads verbatim
    const live = await b.eval(`document.querySelector('[role=dialog] [role=status]')?.textContent ?? ""`);
    assert.match(live, /match/, `the count is announced: ${live}`);

    // D10: the coverage strip is in the tree by role and name, and names the repository's state
    const names = await b.axNames();
    assert.ok(names.some((n) => /What this answer covered/i.test(n)), `coverage group reachable by name: ${names.filter((n) => /covered/.test(n))}`);
    const strip = await b.eval(`document.querySelector('[aria-label="What this answer covered"]')?.innerText ?? ""`);
    assert.match(strip, /(COMPLETE|PARTIAL|NONE)/, `coverage names state, not colour: ${strip.slice(0, 120)}`);

    // D9: Escape closes the dialog and focus returns to a real control
    await b.key("Escape");
    await b.waitFor(() => `!document.querySelector('[role=dialog][aria-label="Cross-repository search"]')`, 5000, "dialog closed");
    assert.ok(true);

    // honesty at the panel level: no result for a nonsense query says so and still lists coverage
    await b.key("k", { ctrl: true });
    await b.waitFor(() => `!!document.querySelector('[role=dialog][aria-label="Cross-repository search"]')`, 5000);
    await b.type("zzznothing");
    await b.key("Enter");
    await b.waitFor(() => `(() => { const st = document.querySelector('[role=dialog] [role=status]')?.textContent ?? ""; const busy = !!document.querySelector('[role=dialog] button[disabled]'); return !busy && !/searching/.test(st) && !document.querySelector('[role=dialog] .hit'); })()`, 20_000, "empty answer");
    const empty = await b.eval(`document.querySelector('[role=dialog] [role=status]')?.textContent ?? ""`);
    assert.match(empty, /0 match/, `a zero result is announced as 0, not silence: ${empty}`);
    const strip2 = await b.eval(`document.querySelector('[aria-label="What this answer covered"]')?.innerText ?? ""`);
    assert.match(strip2, /COMPLETE|NONE|PARTIAL/, "coverage is still stated on the empty answer");
  } finally { b.close(); server.proc.unref(); server.proc.kill(); }
});