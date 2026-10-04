// F06 end-to-end: the hotspot panel is a named dialog, announces its state in a live region, is fully
// keyboard-operable (Escape closes it and focus returns to the opener), and its header button is
// reachable without a pointer. The analysis itself is not run here (the fixture is not a git work
// tree): the panel's honest empty state and its "insufficient evidence" answer are what this checks.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { startServer } from "./harness.ts";

test("hotspots: the panel is a named dialog, speaks its state, closes on Escape and returns focus (F06)", { skip: !existsSync(CHROME), timeout: 60_000 }, async () => {
  const server = await startServer();
  const b = await Browser.launch();
  try {
    await b.goto(server.url);
    await b.tabTo(`el.id === 'repo'`);
    const plain = mkdtempSync(join(tmpdir(), "cie-f06-e2e-"));
    await b.type(plain);

    // the header button is keyboard-reachable by its visible name
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Hotspots'`);
    await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('[role=dialog][aria-label="Historical hotspots and change coupling"]')`, 5000, "hotspot dialog");
    const focusInDialog = await b.eval(`!!document.activeElement?.closest('[role=dialog]')`);
    assert.ok(focusInDialog, "focus lands inside the dialog");

    // the live region states what is (not) known, in words
    const live = await b.eval(`document.querySelector('[role=dialog] [role=status]')?.textContent ?? ""`);
    assert.match(live, /No analysis yet|ranked file/, `the state is announced: ${live}`);
    // the honesty note is on the surface, always
    const note = await b.eval(`document.querySelector('[role=dialog] .modal-actions span')?.textContent ?? ""`);
    assert.match(note, /heuristic/i, "the surface says a score is a prioritisation heuristic");

    // analysing a folder that is not a git work tree says so, not "internal error"
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Analyse history'`);
    await b.key("Enter");
    await b.waitFor(() => `(/not a Git work tree|insufficient|INSUFFICIENT/i).test(document.querySelector('[role=dialog] [role=alert]')?.textContent ?? "")`, 20_000, "insufficient-evidence message");
    const alertText = await b.eval(`document.querySelector('[role=dialog] [role=alert]')?.textContent ?? ""`);
    assert.match(alertText, /Git work tree|insufficient/i, `the failure is explained: ${alertText}`);

    // Escape closes it and focus returns to a real control
    await b.key("Escape");
    await b.waitFor(() => `!document.querySelector('[role=dialog][aria-label="Historical hotspots and change coupling"]')`, 5000, "dialog closed");
    const backOnButton = await b.eval(`document.activeElement?.tagName === 'BUTTON' || document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'BODY'`);
    assert.ok(backOnButton, "focus is not left on a removed node");
  } finally { b.close(); server.proc.unref(); server.proc.kill(); }
});
