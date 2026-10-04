// What a screen reader is given: the browser's own computed accessibility tree for the running app. This proves the summaries exist
// and are reachable by role and name; it does not replace listening to a real screen reader, which is recorded as a separate item.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { toSymbolLevel } from "./levels.ts";
import { REPO, startServer } from "./harness.ts";

test("screen-reader summaries: the map has a name and a description, every control has an accessible name, changes are announced in a live region, and the whole map can be read as a list with each element's state in words", { skip: !existsSync(CHROME), timeout: 120_000 }, async () => {
  const server = await startServer();
  const b = await Browser.launch();
  try {
    await b.goto(server.url);
    await b.tabTo(`el.id === 'repo'`); await b.type(REPO);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'`); await b.key("Enter");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000);
    await b.tabTo(`el.id === 'chat-input'`); await b.type("show me how authentication works"); await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.elements li').length > 2`, 30_000);
    await toSymbolLevel(b);
    await b.key("ArrowRight");

    const { nodes } = await b.send("Accessibility.getFullAXTree");
    const live = nodes.filter((n: any) => !n.ignored);
    const named = (role: string) => live.filter((n: any) => n.role?.value === role);
    // The map: an application region with its caption as the name and the key help as its description.
    const app = named("application")[0];
    assert.ok(app, "the map is exposed as an application region");
    assert.match(app.name.value, /^Map\. .{10,}/);
    assert.ok(app.description?.value && /arrow/i.test(app.description.value), `the map has a description of how to use it: ${app.description?.value}`);
    // Every interactive thing is named.
    const interactive = live.filter((n: any) => ["button", "textbox", "checkbox", "link", "combobox", "application"].includes(n.role?.value));
    const unnamed = interactive.filter((n: any) => !(n.name?.value ?? "").trim()).map((n: any) => n.role.value);
    assert.deepEqual(unnamed, [], "no unnamed control");
    assert.ok(interactive.length >= 10);
    // Live regions: the log of the conversation and the status line that announces focus and selection.
    assert.ok(live.some((n: any) => n.role?.value === "log" && /Conversation history/.test(n.name?.value ?? "")));
    const status = live.find((n: any) => n.role?.value === "status");
    assert.ok(status, "a status region exists");
    const announced = await b.eval(`document.querySelector('[role=status]').textContent`);
    assert.match(announced, /(fact|inference|hypothesis|fog)/i, "the focused element is announced with its state in words, not colour");
    assert.match(announced, /(outgoing|incoming)/, "and its links");
    // Landmarks and headings give the page a structure to jump around by.
    assert.ok(named("complementary").length >= 2 && named("main").length === 1 && named("banner").length === 1);
    assert.ok(named("heading").length >= 5);
    // The text outline: the whole map as a list with one entry per element, each saying what it is and how sure the map is of it.
    await b.key("o");
    await b.waitFor(() => `!!document.querySelector('[role=dialog] ul.outline li')`, 5000);
    const tree = await b.send("Accessibility.getFullAXTree");
    const dialog = tree.nodes.find((n: any) => !n.ignored && n.role?.value === "dialog");
    assert.ok(dialog, "the outline is a dialog");
    const items = tree.nodes.filter((n: any) => !n.ignored && n.role?.value === "listitem");
    const text = await b.eval(`[...document.querySelectorAll('[role=dialog] ul.outline li')].map((li) => li.textContent.trim())`);
    assert.ok(text.length >= 3);
    assert.ok(text.every((t: string) => /(fact|inference|hypothesis|fog)/i.test(t)), "every entry states its epistemic status in words");
    assert.ok(items.length >= text.length);
    // Evidence is reachable as text with its location, and a claim states what it is.
    await b.key("Escape");
    await b.tabTo(`el.getAttribute('role') === 'application'`); await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.drawer figure.evidence').length > 0`, 10_000);
    const fig = (await b.send("Accessibility.getFullAXTree")).nodes.filter((n: any) => !n.ignored && n.role?.value === "figure");
    assert.ok(fig.length > 0 && fig.every((f: any) => /\.ts:\d+/.test(f.name?.value ?? "")), "evidence figures are named by file and line");
    const regions = (await b.send("Accessibility.getFullAXTree")).nodes.filter((n: any) => !n.ignored && n.role?.value === "group" && /^Code (of|from) /.test(n.name?.value ?? ""));
    assert.ok(regions.length > 0, "the code itself is a named, focusable group");
  } finally { b.close(); server.proc.kill("SIGKILL"); }
});
