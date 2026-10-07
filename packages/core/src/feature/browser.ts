// 2.L: bounded, declarative interaction journeys. Reports include assertions, omissions and
// every planned journey. Screenshots may accompany evidence but cannot constitute a pass.
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { rawHash } from "./canon.ts";
import type { Runner, RunResult } from "./types.ts";
export type BrowserStep =
  | { action: "TAB_TO"; selector: string }
  | { action: "PRESS"; key: "Tab" | "Enter" | "Escape" | " " | "ArrowDown" | "ArrowUp"; shift?: boolean }
  | { action: "TYPE"; text: string }
  | { action: "ASSERT_TEXT"; selector: string; text: string }
  | { action: "ASSERT_FOCUS"; selector: string }
  | { action: "ASSERT_DISABLED"; selector: string }
  | { action: "ASSERT_ABSENT"; selector: string };
export type BrowserJourney = { id: string; acceptanceIds: string[]; role: string; locale: string; viewport: { width: number; height: number }; path: string; steps: BrowserStep[]; covers: ("KEYBOARD" | "ERROR" | "LOCALIZATION" | "RESPONSIVE")[] };
export type BrowserPlan = { schemaVersion: 1; origin: string; journeys: BrowserJourney[]; requiredRoles: string[]; requiredLocales: string[]; requiredViewports: { width: number; height: number }[]; requiredCoverage: BrowserJourney["covers"]; timeoutMs: number };
export type BrowserReport = { schemaVersion: 1; complete: boolean; planHash: string; outcomes: { name: string; state: "PASS" | "FAIL" | "NOT_RUN" | "INFRA_ERROR"; role: string; locale: string; viewport: BrowserJourney["viewport"]; interactions: number; assertions: number; accessibilityChecked: boolean; gaps: string[] }[]; gaps: string[] };
export interface BrowserDriver {
  configure(journey: BrowserJourney): Promise<void>; goto(url: string): Promise<void>; tabTo(selector: string): Promise<void>;
  key(key: string, shift?: boolean): Promise<void>; type(text: string): Promise<void>;
  assert(step: Extract<BrowserStep, { action: "ASSERT_TEXT" | "ASSERT_FOCUS" | "ASSERT_DISABLED" | "ASSERT_ABSENT" }>): Promise<boolean>;
  accessibility(): Promise<string[]>; close(): void;
}
export function browserPlanProblems(plan: BrowserPlan): string[] {
  const gaps: string[] = [];
  let origin: URL; try { origin = new URL(plan.origin); if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password || origin.origin !== plan.origin) gaps.push("origin must be an explicit HTTP(S) origin without credentials or path"); } catch { gaps.push("invalid browser origin"); }
  if (plan.schemaVersion !== 1 || !Number.isSafeInteger(plan.timeoutMs) || plan.timeoutMs < 1 || plan.timeoutMs > 300000) gaps.push("invalid browser schema or deadline");
  if (!plan.journeys.length || plan.journeys.length > 50 || new Set(plan.journeys.map((j) => j.id)).size !== plan.journeys.length) gaps.push("journeys must be nonempty and unique (limit 50)");
  for (const j of plan.journeys) {
    let leaves = !j.path.startsWith("/"); try { if (!leaves) leaves = new URL(j.path, plan.origin).origin !== plan.origin; } catch { leaves = true; } // an unresolvable origin is already reported above (issue #83)
    if (leaves) gaps.push(`${j.id}: navigation leaves the allowed origin`);
    if (!j.role || !j.locale || !j.acceptanceIds.length || !j.steps.length || j.steps.length > 100 || ![j.viewport.width, j.viewport.height].every((n) => Number.isSafeInteger(n) && n >= 240 && n <= 4096)) gaps.push(`${j.id}: missing role, criterion, locale, steps or valid viewport`);
    if (!j.steps.some((s) => ["PRESS", "TYPE", "TAB_TO"].includes(s.action)) || !j.steps.some((s) => s.action.startsWith("ASSERT_"))) gaps.push(`${j.id}: needs actual interaction and an assertion`);
  }
  for (const r of plan.requiredRoles) if (!plan.journeys.some((j) => j.role === r)) gaps.push(`missing role ${r}`);
  for (const locale of plan.requiredLocales) if (!plan.journeys.some((j) => j.locale === locale)) gaps.push(`missing locale ${locale}`);
  for (const v of plan.requiredViewports) if (!plan.journeys.some((j) => j.viewport.width === v.width && j.viewport.height === v.height)) gaps.push(`missing viewport ${v.width}x${v.height}`);
  for (const c of plan.requiredCoverage) if (!plan.journeys.some((j) => j.covers.includes(c))) gaps.push(`missing ${c} journey`);
  return gaps;
}
export async function runBrowserJourneys(factory: () => Promise<BrowserDriver>, plan: BrowserPlan, signal?: AbortSignal): Promise<BrowserReport> {
  const gaps = browserPlanProblems(plan); const deadline = Date.now() + plan.timeoutMs;
  const report: BrowserReport = { schemaVersion: 1, complete: false, planHash: rawHash(JSON.stringify(plan)), gaps, outcomes: [] };
  for (const journey of plan.journeys) {
    const outcome: BrowserReport["outcomes"][number] = { name: journey.id, state: "NOT_RUN", role: journey.role, locale: journey.locale, viewport: journey.viewport, interactions: 0, assertions: 0, accessibilityChecked: false, gaps: [] };
    report.outcomes.push(outcome);
    if (gaps.length || signal?.aborted || Date.now() >= deadline) { outcome.gaps.push(gaps.length ? "browser plan incomplete" : "browser budget exhausted or cancelled"); continue; }
    let driver: BrowserDriver | undefined;
    try {
      driver = await factory(); await driver.configure(journey); await driver.goto(new URL(journey.path, plan.origin).href);
      for (const step of journey.steps) {
        if (signal?.aborted || Date.now() >= deadline) throw new Error("browser budget exhausted or cancelled");
        if (step.action === "TAB_TO") { await driver.tabTo(step.selector); outcome.interactions++; }
        else if (step.action === "PRESS") { await driver.key(step.key, step.shift); outcome.interactions++; }
        else if (step.action === "TYPE") { await driver.type(step.text); outcome.interactions++; }
        else { outcome.assertions++; if (!await driver.assert(step)) throw new Error(`${step.action} failed`); }
      }
      outcome.gaps.push(...await driver.accessibility()); outcome.accessibilityChecked = true;
      outcome.state = outcome.gaps.length ? "FAIL" : "PASS";
    } catch (error) { outcome.state = driver ? "FAIL" : "INFRA_ERROR"; outcome.gaps.push(error instanceof Error ? error.message.slice(0, 300) : "browser infrastructure error"); }
    finally { driver?.close(); }
  }
  report.complete = !gaps.length && report.outcomes.every((o) => o.state !== "NOT_RUN" && o.state !== "INFRA_ERROR" && o.interactions > 0 && o.assertions > 0 && o.accessibilityChecked);
  return report;
}

/** Adapt the existing CDP harness shape. User input is dispatched as keyboard events, never DOM clicks. */
export function cdpBrowserDriver(browser: { send(method: string, params?: object): Promise<any>; goto(url: string): Promise<void>; eval<T = any>(expr: string): Promise<T>; tabTo(test: string): Promise<void>; key(key: string, o?: { shift?: boolean }): Promise<void>; type(text: string): Promise<void>; close(): void }): BrowserDriver {
  return {
    async configure(j) { await browser.send("Emulation.setDeviceMetricsOverride", { ...j.viewport, deviceScaleFactor: 1, mobile: j.viewport.width < 600 }); await browser.send("Emulation.setLocaleOverride", { locale: j.locale }); },
    goto: (url) => browser.goto(url), tabTo: (selector) => browser.tabTo(`el.matches(${JSON.stringify(selector)})`),
    key: (key, shift) => browser.key(key, { shift }), type: (text) => browser.type(text), close: () => browser.close(),
    assert: (step) => browser.eval(`(() => { const el = document.querySelector(${JSON.stringify(step.selector)}); return ${step.action === "ASSERT_ABSENT" ? "!el" : step.action === "ASSERT_FOCUS" ? "el === document.activeElement" : step.action === "ASSERT_DISABLED" ? "!!el && el.disabled === true" : `!!el && el.textContent.includes(${JSON.stringify(step.action === "ASSERT_TEXT" ? step.text : "")})`}; })()`),
    async accessibility() {
      const { nodes } = await browser.send("Accessibility.getFullAXTree");
      const unnamed = nodes.filter((n: any) => !n.ignored && ["button", "textbox", "combobox", "link", "checkbox"].includes(n.role?.value) && !n.name?.value).length;
      const layout = await browser.eval<{ overflow: boolean; lang: boolean }>(`({ overflow: document.documentElement.scrollWidth > window.innerWidth + 1, lang: !!document.documentElement.lang })`);
      return [...(unnamed ? [`${unnamed} interactive accessibility nodes have no name`] : []), ...(layout.overflow ? ["page overflows the viewport"] : []), ...(!layout.lang ? ["document language is missing"] : [])];
    },
  };
}

/** A browser must run in the same audited container/VM boundary as the generated app. */
export async function runBrowserValidation(runner: Runner, root: string, plan: BrowserPlan, signal?: AbortSignal): Promise<RunResult> {
  const refusal = (reason: string): RunResult => ({ status: "REFUSED", reason, exitCode: null, stdout: "", stderr: "", truncated: false, isolation: runner.isolation, omissions: [...runner.omissions], usage: { wallMs: 0 } });
  const problems = browserPlanProblems(plan); if (problems.length) return refusal(problems.join("; "));
  if (runner.isolation === "LOCAL_PERMISSION_MODEL") return refusal("browser validation requires a configured audited container/VM runner; the local runner cannot isolate browser processes and loopback networking");
  const file = join(root, `.pf-browser-${Date.now()}.json`); writeFileSync(file, JSON.stringify(plan));
  const worker = fileURLToPath(new URL("./browser-worker.ts", import.meta.url));
  try { return await runner.run({ cwd: root, argv: [process.execPath, worker, file], capabilities: { commands: [[process.execPath, worker]], readRoots: [root, fileURLToPath(new URL(".", import.meta.url))], writeRoots: [root], network: { allow: [plan.origin, "http://127.0.0.1"] }, secretRefs: [], limits: { wallMs: plan.timeoutMs, cpuMs: plan.timeoutMs, memoryBytes: 1073741824, outputBytes: 1048576, processes: 64 } } }, signal); }
  finally { rmSync(file, { force: true }); }
}
