import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser, chromeAvailable } from "../src/feature/browser-cdp.ts";
import { browserPlanProblems, cdpBrowserDriver, runBrowserJourneys, runBrowserValidation, type BrowserDriver, type BrowserJourney, type BrowserPlan } from "../src/feature/browser.ts";
import { browserRunCheck, loadBrowserPlan } from "../src/feature/browser-gate.ts";
import { ConfigError } from "../src/feature/config.ts";
import { LocalRunner } from "../src/feature/runner.ts";
import type { RunRequest, RunResult, Runner } from "../src/feature/types.ts";
import { captureOutcomes, type ValidationCheck } from "../src/feature/validation.ts";

const journey = (over: Partial<BrowserJourney> = {}): BrowserJourney => ({ id: "j1", acceptanceIds: ["ac1"], role: "member", locale: "en-US", viewport: { width: 1280, height: 800 }, path: "/", covers: ["KEYBOARD"],
  steps: [{ action: "TAB_TO", selector: "#a" }, { action: "PRESS", key: "Enter" }, { action: "ASSERT_TEXT", selector: "#out", text: "ok" }], ...over });
const plan = (over: Partial<BrowserPlan> = {}): BrowserPlan => ({ schemaVersion: 1, origin: "http://127.0.0.1:4000", journeys: [journey()], requiredRoles: [], requiredLocales: [], requiredViewports: [], requiredCoverage: [], timeoutMs: 30_000, ...over });
const check: ValidationCheck = { id: "browser", kind: "BROWSER", phase: "BROWSER", target: ".", acceptanceIds: ["ac1"], mandatory: true, expectedTests: [], report: "BROWSER_JSON", applicability: "APPLICABLE", baseline: false };

class FakeDriver implements BrowserDriver {
  log: string[] = []; a11y: string[] = []; asserts = true; fail?: string; closed = false;
  async configure(j: BrowserJourney) { this.log.push(`configure ${j.viewport.width}x${j.viewport.height} ${j.locale}`); }
  async goto(u: string) { this.log.push(`goto ${u}`); } async tabTo(s: string) { this.log.push(`tab ${s}`); if (this.fail === "tab") throw new Error("Tab never reached " + s); }
  async key(k: string, shift?: boolean) { this.log.push(`key ${k}${shift ? "+shift" : ""}`); } async type(t: string) { this.log.push(`type ${t}`); }
  async assert(s: { action: string; selector: string }) { this.log.push(`assert ${s.action} ${s.selector}`); return this.asserts; }
  async accessibility() { return this.a11y; } close() { this.closed = true; }
}

test("AT-14 plan validation: origin, navigation, journeys, interaction and assertion, ranges and every required role, locale, viewport and coverage", () => {
  assert.deepEqual(browserPlanProblems(plan()), []);
  const has = (p: BrowserPlan, re: RegExp) => assert.ok(browserPlanProblems(p).some((x) => re.test(x)), `${re} in ${JSON.stringify(browserPlanProblems(p))}`);
  has(plan({ origin: "ftp://x" }), /explicit HTTP\(S\) origin/); has(plan({ origin: "http://u:p@127.0.0.1" }), /without credentials/); has(plan({ origin: "http://127.0.0.1:4000/app" }), /without credentials or path/); has(plan({ origin: "nope" }), /invalid browser origin/);
  has(plan({ timeoutMs: 0 }), /invalid browser schema or deadline`?|deadline/); has(plan({ timeoutMs: 400_000 }), /deadline/); has(plan({ journeys: [] }), /nonempty and unique/); has(plan({ journeys: [journey(), journey()] }), /nonempty and unique/);
  has(plan({ journeys: [journey({ path: "//evil.example/x" })] }), /leaves the allowed origin/); has(plan({ journeys: [journey({ path: "x" })] }), /leaves the allowed origin/);
  has(plan({ journeys: [journey({ role: "" })] }), /missing role, criterion, locale, steps or valid viewport/); has(plan({ journeys: [journey({ acceptanceIds: [] })] }), /missing role/); has(plan({ journeys: [journey({ viewport: { width: 100, height: 800 } })] }), /valid viewport/);
  has(plan({ journeys: [journey({ steps: [{ action: "ASSERT_TEXT", selector: "#a", text: "x" }] })] }), /needs actual interaction and an assertion/); has(plan({ journeys: [journey({ steps: [{ action: "PRESS", key: "Enter" }] })] }), /needs actual interaction/);
  has(plan({ requiredRoles: ["admin"] }), /missing role admin/); has(plan({ requiredLocales: ["de-DE"] }), /missing locale de-DE/); has(plan({ requiredViewports: [{ width: 375, height: 667 }] }), /missing viewport 375x667/); has(plan({ requiredCoverage: ["ERROR"] }), /missing ERROR journey/);
  assert.deepEqual(browserPlanProblems(plan({ requiredRoles: ["member"], requiredLocales: ["en-US"], requiredViewports: [{ width: 1280, height: 800 }], requiredCoverage: ["KEYBOARD"] })), []);
});

test("PF-025 journeys: every step is real input, a failed assertion or accessibility gap is FAIL, infrastructure is INFRA_ERROR, and complete needs interactions plus assertions plus an accessibility check", async () => {
  const d = new FakeDriver();
  const ok = await runBrowserJourneys(async () => d, plan());
  assert.deepEqual(d.log, ["configure 1280x800 en-US", "goto http://127.0.0.1:4000/", "tab #a", "key Enter", "assert ASSERT_TEXT #out"]); assert.ok(d.closed);
  assert.deepEqual([ok.complete, ok.outcomes[0]!.state, ok.outcomes[0]!.interactions, ok.outcomes[0]!.assertions, ok.outcomes[0]!.accessibilityChecked], [true, "PASS", 2, 1, true]);
  assert.match(ok.planHash, /^[0-9a-f]{64}$/);
  const bad = new FakeDriver(); bad.asserts = false; const failed = await runBrowserJourneys(async () => bad, plan());
  assert.deepEqual([failed.complete, failed.outcomes[0]!.state], [false, "FAIL"]); assert.match(failed.outcomes[0]!.gaps[0]!, /ASSERT_TEXT failed/); assert.ok(bad.closed, "the browser is closed even when the journey fails");
  const a11y = new FakeDriver(); a11y.a11y = ["2 interactive accessibility nodes have no name"]; const gap = await runBrowserJourneys(async () => a11y, plan());
  assert.equal(gap.outcomes[0]!.state, "FAIL"); assert.equal(gap.outcomes[0]!.accessibilityChecked, true); assert.match(gap.outcomes[0]!.gaps[0]!, /no name/);
  const noTab = new FakeDriver(); noTab.fail = "tab"; assert.match((await runBrowserJourneys(async () => noTab, plan())).outcomes[0]!.gaps[0]!, /Tab never reached #a/);
  const infra = await runBrowserJourneys(async () => { throw new Error("Chrome did not start"); }, plan());
  assert.deepEqual([infra.complete, infra.outcomes[0]!.state], [false, "INFRA_ERROR"]); assert.match(infra.outcomes[0]!.gaps[0]!, /Chrome did not start/);
  const incompletePlan = await runBrowserJourneys(async () => new FakeDriver(), plan({ requiredRoles: ["admin"] }));
  assert.deepEqual([incompletePlan.complete, incompletePlan.outcomes[0]!.state, incompletePlan.outcomes[0]!.gaps[0]], [false, "NOT_RUN", "browser plan incomplete"], "a plan with gaps runs nothing and says so");
  const ac = new AbortController(); ac.abort(); const aborted = await runBrowserJourneys(async () => new FakeDriver(), plan(), ac.signal); assert.deepEqual([aborted.complete, aborted.outcomes[0]!.state], [false, "NOT_RUN"]);
  const two = await runBrowserJourneys(async () => new FakeDriver(), plan({ journeys: [journey(), journey({ id: "j2", role: "admin" })] })); assert.deepEqual(two.outcomes.map((o) => o.name), ["j1", "j2"]);
});

test("a screenshot or an exit code is never a browser pass: 2.J accepts only a complete report with interactions, assertions and an accessibility check", async () => {
  const report = await runBrowserJourneys(async () => new FakeDriver(), plan());
  const run = (stdout: string): RunResult => ({ status: "PASSED", exitCode: 0, stdout, stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } });
  assert.deepEqual(captureOutcomes(run(JSON.stringify(report)), check), { outcomes: [{ name: "j1", state: "PASS" }], complete: true });
  const screenshotOnly = { ...report, outcomes: [{ ...report.outcomes[0]!, interactions: 0 }] }; assert.equal(captureOutcomes(run(JSON.stringify(screenshotOnly)), check).complete, false);
  const noA11y = { ...report, outcomes: [{ ...report.outcomes[0]!, accessibilityChecked: false }] }; assert.equal(captureOutcomes(run(JSON.stringify(noA11y)), check).complete, false);
  assert.equal(captureOutcomes(run("exit 0, screenshot saved to /tmp/x.png"), check).complete, false); assert.equal(captureOutcomes(run(JSON.stringify({ ...report, complete: false })), check).complete, false);
});

test("the CDP adapter configures viewport and locale, turns assertions into page queries, and reports unnamed controls, overflow and a missing language", async () => {
  const sent: [string, any][] = []; const evals: string[] = [];
  const fake = { send: async (m: string, p?: object) => { sent.push([m, p]); return m === "Accessibility.getFullAXTree" ? { nodes: [{ role: { value: "button" }, name: { value: "" } }, { role: { value: "textbox" }, name: { value: "Name" } }, { ignored: true, role: { value: "button" }, name: { value: "" } }] } : {}; },
    goto: async () => {}, eval: async (e: string) => { evals.push(e); return e.includes("scrollWidth") ? { overflow: true, lang: false } : true; }, tabTo: async () => {}, key: async () => {}, type: async () => {}, close: () => {} };
  const d = cdpBrowserDriver(fake as any); await d.configure(journey({ viewport: { width: 375, height: 667 }, locale: "de-DE" }));
  assert.deepEqual(sent[0], ["Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 1, mobile: true }]); assert.deepEqual(sent[1], ["Emulation.setLocaleOverride", { locale: "de-DE" }]);
  for (const action of ["ASSERT_TEXT", "ASSERT_FOCUS", "ASSERT_DISABLED", "ASSERT_ABSENT"] as const) assert.equal(await d.assert({ action, selector: "#x", text: "t" } as any), true);
  assert.ok(evals[0]!.includes("includes(") && evals[1]!.includes("activeElement") && evals[2]!.includes("disabled === true") && evals[3]!.includes("!el"));
  assert.deepEqual(await d.accessibility(), ["1 interactive accessibility nodes have no name", "page overflows the viewport", "document language is missing"]);
});

test("runBrowserValidation: the local runner is refused, an audited runner gets the worker with the origin as the only network grant, and the plan file is removed", async () => {
  const root = mkdtempSync(join(tmpdir(), "pf-bv-")); const local = await runBrowserValidation(new LocalRunner(), root, plan());
  assert.equal(local.status, "REFUSED"); assert.match(local.reason!, /audited container\/VM runner/);
  assert.equal((await runBrowserValidation(new LocalRunner(), root, plan({ origin: "nope" }))).status, "REFUSED");
  let seen: RunRequest | undefined; let files: string[] = [];
  const audited: Runner = { isolation: "CONTAINER", omissions: [], async run(req) { seen = req; files = readdirSync(root).filter((f) => f.startsWith(".pf-browser-")); return { status: "PASSED", exitCode: 0, stdout: "{}", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } }; } };
  const r = await runBrowserValidation(audited, root, plan()); assert.equal(r.status, "PASSED");
  assert.equal(files.length, 1, "the plan file existed during the run"); assert.deepEqual(readdirSync(root).filter((f) => f.startsWith(".pf-browser-")), [], "and is gone afterwards");
  assert.deepEqual(seen!.capabilities.network, { allow: ["http://127.0.0.1:4000", "http://127.0.0.1"] }); assert.match(seen!.argv[1]!, /browser-worker\.ts$/);
});

test(".cie/browser.json is strict and the gate driver names why a BROWSER check is incomplete", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pf-bp-")); assert.equal(loadBrowserPlan(repo), null);
  const w = (o: unknown) => { mkdirSync(join(repo, ".cie"), { recursive: true }); writeFileSync(join(repo, ".cie", "browser.json"), typeof o === "string" ? o : JSON.stringify(o)); };
  w(plan()); assert.deepEqual(loadBrowserPlan(repo), plan());
  for (const bad of ["{", [], { ...plan(), extra: 1 }, { ...plan(), schemaVersion: 2 }, { ...plan(), origin: 5 }, { ...plan(), journeys: "x" }, { ...plan(), timeoutMs: "1" }, { ...plan(), requiredCoverage: ["VISUAL"] }, { ...plan(), requiredViewports: [{ width: "1" }] },
    { ...plan(), journeys: [{ ...journey(), extra: 1 }] }, { ...plan(), journeys: [{ ...journey(), steps: [{ action: "CLICK", selector: "#a" }] }] }, { ...plan(), journeys: [{ ...journey(), steps: [{ action: "PRESS", key: "F5" }] }] },
    { ...plan(), journeys: [{ ...journey(), steps: [{ action: "TYPE" }] }] }, { ...plan(), journeys: [{ ...journey(), steps: [{ action: "TAB_TO" }] }] }, { ...plan(), journeys: [{ ...journey(), steps: [{ action: "ASSERT_TEXT", selector: "#a" }] }] }, { ...plan(), journeys: [{ ...journey(), covers: ["X"] }] }, { ...plan(), journeys: [{ id: "j" }] }]) {
    w(bad); assert.throws(() => loadBrowserPlan(repo), ConfigError, JSON.stringify(bad).slice(0, 90)); }
  const audited: Runner = { isolation: "CONTAINER", omissions: ["shared kernel"], run: async () => ({ status: "PASSED", exitCode: 0, stdout: "{}", stderr: "", truncated: false, isolation: "CONTAINER", omissions: [], usage: { wallMs: 1 } }) };
  const root = mkdtempSync(join(tmpdir(), "pf-bv2-"));
  assert.equal(await browserRunCheck(repo, audited)({ ...check, kind: "UNIT" }, root), undefined, "other kinds are not owned");
  w("{"); assert.match((await browserRunCheck(repo, audited)(check, root))!.reason!, /browser plan is invalid: .*valid JSON/);
  const none = mkdtempSync(join(tmpdir(), "pf-bp0-")); const noPlan = (await browserRunCheck(none, audited)(check, root))!; assert.deepEqual([noPlan.status, noPlan.reason], ["INFRA_ERROR", "no browser journeys are declared for this repository (.cie/browser.json)"]);
  w(plan()); const noRunner = (await browserRunCheck(repo)(check, root))!; assert.match(noRunner.reason!, /no audited container or VM runner is configured/);
  assert.equal((await browserRunCheck(repo, audited)(check, root))!.status, "PASSED", "with a plan and an audited runner the check runs");
  assert.equal((await browserRunCheck(repo, new LocalRunner())(check, root))!.status, "REFUSED", "the local runner is refused, not trusted");
});

const PAGE = `<!doctype html><html lang="en"><head><title>t</title></head><body><label>Name <input id="name"></label>
<button id="go" onclick="document.getElementById('out').textContent='Hello '+document.getElementById('name').value">Greet</button><button id="off" disabled>Off</button><p id="out"></p></body></html>`;
const BAD = `<!doctype html><html><body><button id="b"></button><div style="width:2000px">wide</div></body></html>`;

test("AT-14/AT-84 against a real Chrome: keyboard-only journeys pass, and unnamed controls, missing language and overflow are caught", { skip: !chromeAvailable(), timeout: 120_000 }, async () => {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(req.url === "/bad" ? BAD : PAGE); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r)); const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const good = journey({ id: "greet", path: "/", steps: [{ action: "TAB_TO", selector: "#name" }, { action: "TYPE", text: "Ada" }, { action: "TAB_TO", selector: "#go" }, { action: "PRESS", key: "Enter" }, { action: "ASSERT_TEXT", selector: "#out", text: "Hello Ada" }, { action: "ASSERT_DISABLED", selector: "#off" }, { action: "ASSERT_ABSENT", selector: "#missing" }], viewport: { width: 1024, height: 768 } });
    const ok = await runBrowserJourneys(async () => cdpBrowserDriver(await Browser.launch()), plan({ origin, journeys: [good], requiredCoverage: ["KEYBOARD"] }));
    assert.deepEqual(ok.gaps, []); assert.deepEqual(ok.outcomes.map((o) => [o.state, o.interactions, o.assertions, o.accessibilityChecked, o.gaps]), [["PASS", 4, 3, true, []]]); assert.equal(ok.complete, true);
    const wrong = journey({ id: "wrong", steps: [{ action: "TAB_TO", selector: "#go" }, { action: "PRESS", key: "Enter" }, { action: "ASSERT_TEXT", selector: "#out", text: "Goodbye" }] });
    const failed = await runBrowserJourneys(async () => cdpBrowserDriver(await Browser.launch()), plan({ origin, journeys: [wrong] })); assert.deepEqual([failed.complete, failed.outcomes[0]!.state], [false, "FAIL"]);
    const bad = journey({ id: "bad", path: "/bad", viewport: { width: 400, height: 700 }, steps: [{ action: "TAB_TO", selector: "#b" }, { action: "ASSERT_FOCUS", selector: "#b" }] });
    const gaps = await runBrowserJourneys(async () => cdpBrowserDriver(await Browser.launch()), plan({ origin, journeys: [bad] }));
    assert.equal(gaps.outcomes[0]!.state, "FAIL"); assert.deepEqual(gaps.outcomes[0]!.gaps.sort(), ["1 interactive accessibility nodes have no name", "document language is missing", "page overflows the viewport"]);
  } finally { srv.close(); }
});

test("the e2e Chrome helper is not a hidden dependency: its path is overridable and its absence is detectable", () => {
  assert.equal(typeof chromeAvailable(), "boolean"); assert.ok(existsSync("/") && typeof process.env.CIE_CHROME !== "number");
});
