import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const REPO = process.env.GATE_REPO!, MINE = process.env.GATE_MINE!, THEIRS = process.env.GATE_THEIRS!, CAND = process.env.GATE_CANDIDATE!;
const open = async (page: Page, requestId: string) => {
  await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } }, [`cie.build.request.${REPO}`, requestId]);
  await page.goto("/"); await page.getByRole("button", { name: "Build feature" }).click();
  return page.getByRole("dialog", { name: "Build feature" });
};
const noSeriousViolations = async (page: Page, scope?: string) => {
  const r = await new AxeBuilder({ page }).include(scope ?? "body").analyze();
  const bad = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  test.info().annotations.push({ type: "axe", description: JSON.stringify({ total: r.violations.length, seriousOrCritical: bad.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), rules: r.passes.length }) });
  expect(bad.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} node(s))`)).toEqual([]);
};

test("the owner opens the request and walks Changes, Validate and Deliver; nothing is called verified", async ({ page, browser }) => {
  test.info().annotations.push({ type: "browser", description: `${browser.browserType().name()} ${browser.version()}` });
  const dialog = await open(page, MINE);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("navigation", { name: "Stages" }).getByRole("button", { name: /Changes/ }).click();
  await expect(dialog.getByRole("region", { name: "Changes stage" })).toBeVisible();
  await expect(dialog.getByText("src/export/csv.ts").locator("visible=true").first()).toBeVisible();
  await expect(dialog.getByText(CAND.split("/").pop()!.slice(0, 8), { exact: false }).locator("visible=true").first()).toBeVisible();
  await noSeriousViolations(page, '[role="dialog"]');
  for (const stage of ["Validate", "Deliver"]) {
    await dialog.getByRole("navigation", { name: "Stages" }).getByRole("button", { name: new RegExp(stage) }).click();
    await expect(dialog.getByRole("region", { name: `${stage} stage` })).toBeVisible();
    await noSeriousViolations(page, '[role="dialog"]');
  }
  // Without validation evidence the run is review-only: the dialog never says the change is verified.
  const text = (await dialog.innerText()).toLowerCase();
  expect(text).not.toMatch(/\bverified within scope\b/);
  expect(text).toMatch(/review|not validated|unvalidated|no evidence|incomplete/);
});

test("denial: another principal's request cannot be opened, and nothing of it is shown", async ({ page }) => {
  const dialog = await open(page, THEIRS);
  await expect(dialog).toBeVisible();
  const text = await dialog.innerText();
  expect(text).not.toContain("secret.ts"); expect(text).not.toContain("Someone else's private feature");
  // the refusal is the same sentence a request that never existed gets, so it does not reveal that the request exists
  const ghost = await open(await (await page.context().newPage()), "req:00000000000000000000ffff");
  expect(text.replace(THEIRS, "ID")).toContain("no such request ID"); expect((await ghost.innerText())).toContain("no such request req:00000000000000000000ffff");
});

test("keyboard only: the stage list is reachable by Tab and Escape closes the dialog", async ({ page }) => {
  const dialog = await open(page, MINE);
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null);
  expect(focused).toBe(true);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});
