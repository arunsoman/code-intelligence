import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { REPO, startServer } from "./harness.ts";

test("compound chat displays its combined answer and lets the user reopen every analysis", { skip: !existsSync(CHROME), timeout: 180_000 }, async () => {
  const server = await startServer(), b = await Browser.launch();
  try {
    await b.goto(server.url);
    await b.tabTo("el.id === 'repo'"); await b.type(REPO);
    await b.tabTo("el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'"); await b.key("Enter");
    await b.waitFor(() => `!document.getElementById('chat-input').disabled`, 60_000, "indexed repository");
    if (await b.eval("document.getElementById('repo-section-body').hidden")) {
      await b.tabTo("el.getAttribute('aria-controls') === 'repo-section-body' && el.getAttribute('aria-expanded') === 'false'"); await b.key("Enter");
    }
    await b.waitFor(() => `[...document.querySelectorAll('button')].some(el => el.textContent.trim().startsWith('Build concept hierarchy') && !el.disabled)`, 60_000, "hierarchy build available");
    await b.tabTo("el.tagName === 'BUTTON' && el.textContent.trim().startsWith('Build concept hierarchy') && !el.disabled"); await b.key("Enter");
    await b.waitFor(() => `/[1-9]\\d* hierarchy concepts/.test(document.querySelector('header')?.innerText ?? '')`, 60_000, "built concept hierarchy");
    await b.tabTo("el.id === 'chat-input'");
    await b.type("Explain this project, identify its riskiest module, and show me the tests covering it."); await b.key("Enter");
    await b.waitFor(() => `document.querySelectorAll('.chat-results button').length === 3`, 30_000, "three analysis views");
    const answer = await b.eval<string>("document.querySelector('.messages').innerText");
    assert.match(answer, /Project overview/); assert.match(answer, /Highest-ranked source file/); assert.match(answer, /No measured line coverage/);
    await b.tabTo("el.textContent === 'Show Tests'"); await b.key("Enter");
    await b.waitFor(() => `document.querySelector('.caption').textContent.includes('Tests for')`, 10_000, "tests view");
    assert.match(await b.eval<string>("document.querySelector('.caption').textContent"), /Tests for/);
    assert.match(await b.eval<string>("document.querySelector('.response-tabs [aria-selected=true]').textContent"), /Test/);
    await b.tabTo("el.textContent === 'Show Change risk'"); await b.key("Enter");
    await b.waitFor(() => `document.querySelector('.caption').textContent.includes('Change-risk terrain')`, 10_000, "risk view");
    assert.match(await b.eval<string>("document.querySelector('.banner.ok')?.textContent ?? ''"), /Showing Change risk/);
    await b.tabTo("el.textContent === 'Show Project overview'"); await b.key("Enter");
    await b.waitFor(() => `document.querySelector('.caption').textContent.includes('Explain this project')`, 10_000, "overview view");
    await b.tabTo("el.classList.contains('canvas') && el.getAttribute('role') === 'application'"); await b.key("Home"); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('aside.right .drawer h2')`, 10_000, "chart element details");
    assert.match(await b.eval<string>("document.querySelector('.sr[role=status]')?.textContent ?? ''"), /Selected (?:the group .*opened its .* member elements|.*opened its code and evidence details)/);
    assert.equal(await b.eval("document.querySelectorAll('.chat-results button').length"), 3);
    assert.ok((await b.axNames()).some((n) => n.includes("Show Tests")));
  } finally { b.close(); server.proc.kill("SIGKILL"); }
});
