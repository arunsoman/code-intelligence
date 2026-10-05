// Task 2.L — declared journeys and the BROWSER gate driver for 2.J's runCheck hook (PF-025; AT-14, AT-84).
// A journey plan lives in `<repo>/.cie/browser.json`. The browser only ever runs inside an audited container or VM runner (see
// runBrowserValidation); with no plan, no such runner, or an incomplete report the check is INCOMPLETE, never PASS. A screenshot
// is never evidence by itself: a pass needs real interactions, assertions and an accessibility check (validation.captureOutcomes).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./config.ts";
import { runBrowserValidation, type BrowserJourney, type BrowserPlan, type BrowserStep } from "./browser.ts";
import type { RunCheck } from "./gates.ts";
import type { RunResult, Runner } from "./types.ts";

const ACTIONS = new Set(["TAB_TO", "PRESS", "TYPE", "ASSERT_TEXT", "ASSERT_FOCUS", "ASSERT_DISABLED", "ASSERT_ABSENT"]);
const COVERS = new Set(["KEYBOARD", "ERROR", "LOCALIZATION", "RESPONSIVE"]);
const KEYS = new Set(["Tab", "Enter", "Escape", " ", "ArrowDown", "ArrowUp"]);
const TOP = ["schemaVersion", "origin", "journeys", "requiredRoles", "requiredLocales", "requiredViewports", "requiredCoverage", "timeoutMs"];
const JOURNEY = ["id", "acceptanceIds", "role", "locale", "viewport", "path", "steps", "covers"];

const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const only = (o: Record<string, unknown>, keys: string[], what: string) => { for (const k of Object.keys(o)) if (!keys.includes(k)) throw new ConfigError(`${what}: unknown key ${k}`); };

/** `.cie/browser.json`, or null when the repository declares no journeys. Unknown keys and malformed steps are rejected, not ignored. */
export function loadBrowserPlan(repoRoot: string): BrowserPlan | null {
  const file = join(repoRoot, ".cie", "browser.json");
  if (!existsSync(file)) return null;
  let raw: any; try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new ConfigError(".cie/browser.json is not valid JSON"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(".cie/browser.json must be an object");
  only(raw, TOP, "browser plan");
  if (raw.schemaVersion !== 1) throw new ConfigError("browser plan schemaVersion must be 1");
  if (typeof raw.origin !== "string") throw new ConfigError("browser plan origin must be a string");
  for (const k of ["requiredRoles", "requiredLocales"]) if (!isStrs(raw[k] ?? [])) throw new ConfigError(`${k} must be a list of strings`);
  if (!Array.isArray(raw.requiredViewports ?? []) || !(raw.requiredViewports ?? []).every((v: any) => v && Number.isInteger(v.width) && Number.isInteger(v.height))) throw new ConfigError("requiredViewports must be a list of { width, height }");
  if (!isStrs(raw.requiredCoverage ?? []) || !(raw.requiredCoverage ?? []).every((c: string) => COVERS.has(c))) throw new ConfigError("requiredCoverage may contain only KEYBOARD, ERROR, LOCALIZATION, RESPONSIVE");
  if (!Number.isInteger(raw.timeoutMs)) throw new ConfigError("timeoutMs must be an integer");
  if (!Array.isArray(raw.journeys)) throw new ConfigError("journeys must be a list");
  const journeys = raw.journeys.map((j: any, n: number): BrowserJourney => {
    if (!j || typeof j !== "object") throw new ConfigError(`journey ${n} must be an object`);
    only(j, JOURNEY, `journey ${j.id ?? n}`);
    if (typeof j.id !== "string" || typeof j.role !== "string" || typeof j.locale !== "string" || typeof j.path !== "string" || !isStrs(j.acceptanceIds) || !j.viewport || !Number.isInteger(j.viewport.width) || !Number.isInteger(j.viewport.height)) throw new ConfigError(`journey ${j.id ?? n} is missing id, role, locale, path, acceptanceIds or viewport`);
    if (!isStrs(j.covers ?? []) || !(j.covers ?? []).every((c: string) => COVERS.has(c))) throw new ConfigError(`journey ${j.id}: covers may contain only KEYBOARD, ERROR, LOCALIZATION, RESPONSIVE`);
    if (!Array.isArray(j.steps)) throw new ConfigError(`journey ${j.id}: steps must be a list`);
    for (const [i, s] of j.steps.entries()) {
      if (!s || !ACTIONS.has(s.action)) throw new ConfigError(`journey ${j.id} step ${i}: unknown action`);
      if (s.action === "PRESS" && !KEYS.has(s.key)) throw new ConfigError(`journey ${j.id} step ${i}: key must be one of Tab, Enter, Escape, Space, ArrowDown, ArrowUp`);
      if (s.action === "TYPE" && typeof s.text !== "string") throw new ConfigError(`journey ${j.id} step ${i}: TYPE needs text`);
      if (["TAB_TO", "ASSERT_TEXT", "ASSERT_FOCUS", "ASSERT_DISABLED", "ASSERT_ABSENT"].includes(s.action) && typeof s.selector !== "string") throw new ConfigError(`journey ${j.id} step ${i}: ${s.action} needs a selector`);
      if (s.action === "ASSERT_TEXT" && typeof s.text !== "string") throw new ConfigError(`journey ${j.id} step ${i}: ASSERT_TEXT needs text`);
    }
    return { id: j.id, acceptanceIds: j.acceptanceIds, role: j.role, locale: j.locale, viewport: j.viewport, path: j.path, steps: j.steps as BrowserStep[], covers: j.covers ?? [] };
  });
  return { schemaVersion: 1, origin: raw.origin, journeys, requiredRoles: raw.requiredRoles ?? [], requiredLocales: raw.requiredLocales ?? [], requiredViewports: raw.requiredViewports ?? [], requiredCoverage: raw.requiredCoverage ?? [], timeoutMs: raw.timeoutMs };
}

const incomplete = (reason: string, runner?: Runner): RunResult => ({ status: "INFRA_ERROR", exitCode: null, stdout: "", stderr: "", truncated: false, isolation: runner?.isolation ?? "LOCAL_PERMISSION_MODEL", omissions: [...(runner?.omissions ?? [])], usage: { wallMs: 0 }, reason });

/** Owns BROWSER checks only. Without journeys or an audited runner the check is a gap, with the reason named. */
export function browserRunCheck(repoRoot: string, runner?: Runner): RunCheck {
  return async (check, root, signal) => {
    if (check.kind !== "BROWSER") return undefined;
    let plan: BrowserPlan | null;
    try { plan = loadBrowserPlan(repoRoot); } catch (e) { return incomplete(`browser plan is invalid: ${(e as Error).message}`, runner); }
    if (!plan) return incomplete("no browser journeys are declared for this repository (.cie/browser.json)", runner);
    if (!runner) return incomplete("no audited container or VM runner is configured for browser validation", runner);
    return runBrowserValidation(runner, root, plan, signal);
  };
}
