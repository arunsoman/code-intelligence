// After a re-index started inside the Insights drawer, closing and reopening it must show the revision the
// re-index produced, not the one the drawer first loaded (issue #50).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Browser, CHROME } from "./cdp.ts";
import { ROOT, startServer } from "./harness.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" }).trim();

test("the Insights drawer shows the revision a re-index produced after it is reopened", { skip: !existsSync(CHROME), timeout: 240_000 }, async () => {
  // A real repository with real commits, so the drawer's header names a commit that can change.
  const dir = mkdtempSync(join(tmpdir(), "cie-reindex-"));
  execFileSync("cp", ["-R", join(ROOT, "fixtures/security-repo") + "/.", dir]);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "first");
  const first = git(dir, "rev-parse", "HEAD");

  const server = await startServer(), b = await Browser.launch();
  try {
    await b.goto(server.url);
    await b.tabTo(`el.id === 'repo'`); await b.type(dir);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Index'`); await b.key("Enter");
    await b.waitFor(() => `/rev \\S+ · \\d+ files/.test(document.querySelector('header').innerText)`, 60_000, "the repository to be indexed");
    const revBefore = (await b.eval<string>(`document.querySelector('header').innerText.match(/rev (\\S+)/)[1]`));
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Insights'`); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('[role=dialog][aria-label=Insights]')`, 3000);
    await b.waitFor(() => `document.querySelector('.i-fact.mono')?.innerText.includes(${JSON.stringify(first.slice(0, 8))})`, 8000, "the drawer to show the first commit");

    // Commit a change while the drawer is open, then re-index from inside it.
    writeFileSync(join(dir, "src/api/handlers.ts"), `${execFileSync("cat", [join(dir, "src/api/handlers.ts")], { encoding: "utf8" })}\n// changed for the re-index test\n`);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "second");
    const second = git(dir, "rev-parse", "HEAD");
    assert.notEqual(first, second);

    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Re-index' && !el.disabled`); await b.key("Enter");
    await b.waitFor(() => `/New index ready/.test(document.querySelector('[role=dialog][aria-label=Insights]').innerText)`, 120_000, "the re-index to finish");
    // The app must have refreshed, so the new revision is available to reopen on.
    await b.waitFor(() => `document.querySelector('header').innerText.match(/rev (\\S+)/)[1] !== ${JSON.stringify(revBefore)}`, 30_000, "the app header to move to the new revision");

    await b.eval(`document.querySelector('[role=dialog][aria-label=Insights] button[aria-label="Close the insights panel"]').click()`);
    await b.waitFor(() => `!document.querySelector('[role=dialog][aria-label=Insights]')`, 3000);
    await b.tabTo(`el.tagName === 'BUTTON' && el.textContent.trim() === 'Insights'`); await b.key("Enter");
    await b.waitFor(() => `!!document.querySelector('[role=dialog][aria-label=Insights]')`, 3000);
    await b.waitFor(() => `document.querySelector('.i-fact.mono')?.innerText.includes(${JSON.stringify(second.slice(0, 8))})`, 8000, "the reopened drawer to show the new commit");
    assert.ok(!(await b.eval<boolean>(`document.querySelector('.i-fact.mono').innerText.includes(${JSON.stringify(first.slice(0, 8))})`)), "the drawer no longer shows the old commit");
  } finally {
    b.close();
    server.proc.kill("SIGKILL");
    execFileSync("rm", ["-rf", dir]);
    await wait(10);
  }
});
