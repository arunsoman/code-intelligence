// A whole investigation done with the keyboard alone, in a real browser against a real server: index a repository, ask, move around the
// map, select, ask about the selection, open evidence, confirm a claim, save, and read the map back as text. No pointer event is
// sent, and the page counts any that arrive.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { POINTER_GUARD, REPO, startServer } from "./harness.ts";

test("keyboard-only complete investigation: index, ask, navigate, select, ask about the selection, read the evidence, confirm, save and read the map as text, without one pointer event", { skip: !existsSync(CHROME), timeout: 120_000 }, async () => {
  const server = await startServer();
  const b = await Browser.launch();
  try {
    await b.goto(server.url, POINTER_GUARD);
    // 1. Index: Tab to the path field, type, Tab on to Index, Enter.
    await b.tabTo(`el.id === 'repo'`);
    await b.type(REPO);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'`);
    await b.key("Enter");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000, "the repository to be indexed");
    // 2. Ask.
    await b.tabTo(`el.id === 'chat-input'`);
    await b.type("show me how authentication works");
    await b.key("Enter");
    await b.waitFor(() => `document.querySelector('[role=application]')?.getAttribute('aria-label')?.length > 20 && document.querySelectorAll('.elements li').length > 2`, 30_000, "the map to be composed");
    const caption = await b.eval(`document.querySelector('[role=application]').getAttribute('aria-label')`);
    assert.match(caption, /^Map\. .{10,}/);
    // 3. Move around the map with the arrow keys; Enter opens an element and its evidence.
    await b.tabTo(`el.getAttribute('role') === 'application'`);
    await b.key("ArrowRight");
    await b.waitFor(() => `/Focused|focus|fact|inference|hypothesis|fog/i.test(document.querySelector('[role=status]').textContent)`, 5000, "the first focused element to be announced");
    const first = await b.eval(`document.querySelector('[role=status]').textContent`);
    await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.drawer figure.evidence').length > 0 && !!document.querySelector('.drawer h2')`, 10_000, "the evidence drawer");
    const drawerTitle = await b.eval(`document.querySelector('.drawer h2').textContent`);
    assert.ok(drawerTitle.length > 0);
    assert.ok(await b.eval(`/\\.ts:\\d+/.test(document.querySelector('.drawer').innerText)`), "the evidence names a file and line");
    // 4. Select two elements: Space toggles, arrows move.
    await b.tabTo(`el.getAttribute('role') === 'application'`);
    await b.key("Home");
    await b.key(" ");
    await b.key("End");
    await b.key(" ");
    await b.waitFor(() => `/\\((2|3|4) selected\\)/i.test(document.querySelector('.side').innerText)`, 5000, "two elements to be selected");
    const selected = await b.eval(`(document.querySelector('.side').innerText.match(/\\((\\d+) selected\\)/i) || [])[1]`);
    assert.ok(Number(selected) >= 2);
    // 5. Ask about the selection: the referents are announced as a group and the answer is an explanation with claims.
    await b.tabTo(`el.id === 'chat-input'`);
    assert.ok(await b.eval(`!!document.querySelector('[role=group][aria-label^="Selected elements"]')`), "the selection is a named group next to the message box");
    await b.type("how are these connected?");
    await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.drawer article.claim').length > 0`, 30_000, "the explanation");
    assert.ok(await b.eval(`/Explanation/.test(document.querySelector('.drawer h2').textContent)`));
    assert.ok(await b.eval(`document.querySelector('.drawer article.claim .badge').textContent !== 'Fact'`), "a model claim is not shown as fact");
    // 6. Confirm the first claim: Tab to Confirm, Enter, type why, Enter.
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Confirm' && !!el.closest('.drawer')`);
    await b.key("Enter");
    await b.tabTo(`el.tagName === 'INPUT' && /^v-/.test(el.id)`);
    await b.type("checked the call site by hand");
    await b.key("Enter");
    await b.waitFor(() => `/Confirmed by you/.test(document.querySelector('.drawer').innerText)`, 10_000, "the confirmation");
    assert.ok(await b.eval(`/Confirmed by you/.test(document.querySelector('.drawer article.claim .badge').textContent)`));
    // 7. Save the investigation by name.
    await b.tabTo(`el.id === 'wsn'`);
    await b.type("keyboard investigation");
    await b.tabTo(`el.tagName === 'BUTTON' && /^Save/.test(el.textContent.trim())`);
    await b.key("Enter");
    await b.waitFor(() => `[...document.querySelectorAll('.workspaces li')].some((li) => /keyboard investigation/.test(li.textContent))`, 10_000, "the saved investigation to be listed");
    // 8. Read the whole map as text: O opens the outline dialog, Escape closes it.
    await b.tabTo(`el.getAttribute('role') === 'application'`);
    await b.key("o");
    await b.waitFor(() => `!!document.querySelector('[role=dialog] ul.outline li')`, 5000, "the text outline");
    const outline = await b.eval(`[...document.querySelectorAll('[role=dialog] ul.outline li')].map((li) => li.textContent.trim())`);
    assert.ok(outline.length >= 3 && outline.every((t: string) => t.length > 0));
    await b.key("Escape");
    await b.waitFor(() => `!document.querySelector('[role=dialog]')`, 3000, "the outline to close");
    // Nothing in that whole journey was a pointer event, and the page did not throw.
    assert.equal(await b.eval(`window.__pointer`), 0, "no pointer event reached the page");
    assert.deepEqual(b.console.filter((l) => /^exception|^error/.test(l)), []);
    void first;
  } finally { b.close(); server.proc.kill("SIGKILL"); }
});

test("the pointer guard works: a single real mouse press is counted, so a zero in the keyboard test means something", { skip: !existsSync(CHROME), timeout: 60_000 }, async () => {
  const server = await startServer();
  const b = await Browser.launch();
  try {
    await b.goto(server.url, POINTER_GUARD);
    assert.equal(await b.eval(`window.__pointer`), 0);
    await b.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 50, y: 50, button: "left", clickCount: 1 });
    await b.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 50, y: 50, button: "left", clickCount: 1 });
    assert.ok((await b.eval(`window.__pointer`)) >= 2);
  } finally { b.close(); server.proc.kill("SIGKILL"); }
});
