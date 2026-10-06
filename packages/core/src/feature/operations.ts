// Task 3.S — operational readiness (PF-048, PF-049) and the release plan (PF-049), plus the schema-only production-anomaly checklist (PF-050).
// Everything here reads the candidate's stored text; nothing is executed. The checks are STATIC PATTERNS on the lines the candidate ADDED
// and say so (`basis`): they find a missing signal or a logged secret, they cannot prove production behaviour.
//   * T0 (documentation only) is NOT_APPLICABLE with its rationale; anything else is applicable.
//   * A sensitive field written to a log is BLOCKING. Missing metrics, limits, retry/timeout or release-plan fields are GAPS (never a pass).
//   * The release plan is never invented: suggestReleasePlan fills only what the change itself shows; owners, thresholds and windows stay missing.
//   * A revert is a NEW candidate plan (planRevert), never an undo of the old one, and it refuses when the live files no longer match.
import { existsSync, readFileSync } from "node:fs";
import { sha256, safeJoin } from "../isolated-exec.ts";
import { classifyTier } from "./tiers.ts";
import type { RunCheck } from "./gates.ts";
import { toRunResult } from "./gates.ts";
import type { CandidateRecord, FeatureRecord, Id, InvestigationPlan, OperationalAssessment, Outcome, ReleasePlan, Tier } from "./types.ts";
import type { FeatureEdit } from "./candidate.ts";
import { validationHash } from "./validation.ts";

type Check = NonNullable<OperationalAssessment["checks"]>[number];
const isTest = (p: string) => /(^|\/)(tests?|__tests__|spec)\//i.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
const isDoc = (p: string) => /\.(md|mdx|txt|rst|adoc)$|(^|\/)docs?\//i.test(p);
const isCode = (p: string) => /\.[cm]?[jt]sx?$|\.(py|go|rs|java|rb)$/.test(p) && !isTest(p) && !isDoc(p);

const ENDPOINT = /\b(app|router|server|api|fastify)\.(get|post|put|patch|delete|all|use|route)\s*\(|@(Get|Post|Put|Patch|Delete)\s*\(|export\s+(async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\b/;
const JOBLIKE = /\b(setInterval|cron|schedule\s*\(|enqueue|queue\.|\bworker\b|consumer|subscribe\s*\()/i;
const EXTERNAL = /\b(fetch|axios|got)\s*\(|\bhttps?\.request\s*\(/;
const SIGNAL = /\b(metrics?\.|counter\(|histogram\(|gauge\(|statsd|prometheus|otel|tracer\.|span\(|logger\.(info|warn|error)|log\.(info|warn|error)|console\.(info|warn|error))/i;
const LIMIT = /rate.?limit|throttle|\blimit\s*[:=(]|maxRows|max_rows|pageSize|page_size|\.slice\(\s*0\s*,|\btake\(|LIMIT\s+\d|maxBytes|body.?limit/i;
const RESILIENCE = /retry|retries|backoff|dead.?letter|dlq|timeout|maxAttempts|idempot/i;
const TIMEOUT = /timeout|AbortSignal|signal\s*:/i;
const LOGCALL = /\b(console|logger|log)\.\w+\s*\(/;
const SENSITIVE = /\b(password|passwd|secret|token|api[_-]?key|authorization|cookie|ssn|cardnumber|card_number|cvv)\b/i;

/** The code outside string literals, keeping only `${...}` interpolations from template literals, so "token expired" is not "logs a token". */
export function executablePart(line: string): string {
  let out = "", i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "'" || c === '"') { const q = c; i++; while (i < line.length && line[i] !== q) i += line[i] === "\\" ? 2 : 1; i++; out += " "; }
    else if (c === "`") { i++; while (i < line.length && line[i] !== "`") { if (line[i] === "$" && line[i + 1] === "{") { let d = 1; i += 2; while (i < line.length && d) { if (line[i] === "{") d++; else if (line[i] === "}") d--; if (d) out += line[i]; i++; } out += " "; } else i += line[i] === "\\" ? 2 : 1; } i++; }
    else { out += c; i++; }
  }
  return out;
}

type Added = { path: string; lines: string[]; text: string };
export function addedLines(c: CandidateRecord): Added[] {
  const contents = c.contents ?? {}, base = c.baseContents ?? {}; const out: Added[] = [];
  for (const [path, text] of Object.entries(contents)) {
    if (text === null || !isCode(path)) continue;
    const had = new Set((base[path] ?? "").split("\n"));
    out.push({ path, text, lines: text.split("\n").filter((l) => l.trim() && !had.has(l)) });
  }
  return out;
}
export const tierOfCandidate = (c: CandidateRecord): Tier => classifyTier(c.mutations.flatMap((m) => [m.oldPath, m.newPath].filter((p): p is string => !!p).map((path) => ({ path, kind: m.kind })))).tier;

/** What a release plan must say at each tier. Missing items are listed; nothing is defaulted. */
export function releasePlanProblems(plan: ReleasePlan | undefined, tier: Tier): string[] {
  if (tier === "T0") return [];
  if (!plan) return [tier === "T2" ? "no release plan (flag or kill switch, revert runbook, stop criteria, observation window, operator)" : "no operational note (how this is rolled back)"];
  // D001: the requester drafts; until a principal bound for release scope confirms it, it is a draft and not a decision.
  const draft = plan.confirmedBy ? [] : [`the ${tier === "T2" ? "release plan" : "operational note"} is a draft: no principal with release authority has confirmed it`];
  if (plan.applicability === "NOT_APPLICABLE") return [...(plan.rationale?.trim() && tier === "T1" ? [] : [tier === "T2" ? "a T2 change cannot declare its release plan not applicable" : "release plan marked not applicable without a rationale"]), ...draft];
  const need: [keyof ReleasePlan, string][] = tier === "T2"
    ? [["revertRunbook", "revert runbook"], ["stopCriteria", "stop criteria"], ["observationWindow", "observation window"], ["operator", "operator"]]
    : [["revertRunbook", "revert runbook"]];
  const out = need.filter(([k]) => { const v = plan[k]; return Array.isArray(v) ? !v.length : !String(v ?? "").trim(); }).map(([, l]) => `release plan lacks a ${l}`);
  if (tier === "T2" && !plan.flagStrategy?.trim() && !plan.killSwitch?.trim()) out.push("release plan lacks a flag strategy or kill switch");
  return [...draft, ...out];
}

/** Facts only: the revert note and the data-recovery limit can be derived from the change; thresholds, windows and owners cannot. */
export function suggestReleasePlan(c: CandidateRecord): ReleasePlan {
  const data = c.mutations.flatMap((m) => [m.oldPath, m.newPath]).filter((p): p is string => !!p && /(^|\/)(migrations?|schema|db|prisma|sql)(\/|\.|$)|\.(sql|prisma)$/i.test(p));
  return {
    applicability: "APPLICABLE",
    revertRunbook: "Create a revert candidate against the then-current code (planRevert), validate it and publish it as a new draft PR; the revert is a new change, not an undo.",
    dataRecoveryLimits: data.length ? `schema or data files changed (${[...new Set(data)].join(", ")}); reverting the code does not undo data changes` : "no schema or data files changed by this candidate",
  };
}

export interface OperationalReport { applicability: "APPLICABLE" | "NOT_APPLICABLE"; rationale?: string; tier: Tier; checks: Check[]; gaps: string[]; blocking: string[]; status: "PASS" | "INCOMPLETE" | "BLOCKED" | "NOT_APPLICABLE" }

export function operationalReadiness(c: CandidateRecord, request: FeatureRecord): OperationalReport {
  const tier = tierOfCandidate(c);
  if (tier === "T0") return { applicability: "NOT_APPLICABLE", rationale: "documentation-only change: no runtime behaviour to operate", tier, checks: [], gaps: [], blocking: [], status: "NOT_APPLICABLE" };
  const files = addedLines(c); const checks: Check[] = [];
  const surf = (re: RegExp) => files.filter((f) => f.lines.some((l) => re.test(executablePart(l)) || re.test(l))).map((f) => f.path);
  const endpoints = surf(ENDPOINT), jobs = surf(JOBLIKE), externals = surf(EXTERNAL);
  const add = (id: string, state: Check["state"], detail: string, basis: Check["basis"], paths: string[] = []) => checks.push({ id, state, detail, basis, paths });
  const hasIn = (paths: string[], re: RegExp) => paths.filter((p) => !re.test(files.find((f) => f.path === p)!.text));
  add("SURFACE", "PASS", endpoints.length || jobs.length || externals.length ? `adds ${[endpoints.length && "endpoint", jobs.length && "job/queue", externals.length && "external call"].filter(Boolean).join(", ")} code` : "adds no endpoint, job, queue or external call", "STATIC_PATTERN", [...new Set([...endpoints, ...jobs, ...externals])]);
  const surfaces = [...new Set([...endpoints, ...jobs, ...externals])];
  const noSignal = hasIn(surfaces, SIGNAL);
  add("METRICS", !surfaces.length ? "NOT_APPLICABLE" : noSignal.length ? "GAP" : "PASS", !surfaces.length ? "no new surface to observe" : noSignal.length ? "new surface without a log, metric or trace signal" : "each new surface emits a signal", "STATIC_PATTERN", noSignal);
  const leaks = files.flatMap((f) => f.lines.filter((l) => LOGCALL.test(l) && SENSITIVE.test(executablePart(l))).map(() => f.path));
  add("LOG_REDACTION", leaks.length ? "BLOCKING" : "PASS", leaks.length ? "a log call includes a sensitive field (password, token, secret, key, authorization, cookie, card)" : "no log call includes a sensitive field", "STATIC_PATTERN", [...new Set(leaks)]);
  const noLimit = hasIn(endpoints, LIMIT);
  add("ABUSE_LIMITS", !endpoints.length ? "NOT_APPLICABLE" : noLimit.length ? "GAP" : "PASS", !endpoints.length ? "no new endpoint" : noLimit.length ? "new endpoint with no visible rate limit or size cap" : "each new endpoint shows a limit", "STATIC_PATTERN", noLimit);
  const noRes = hasIn(jobs, RESILIENCE);
  add("QUEUE_SIGNALS", !jobs.length ? "NOT_APPLICABLE" : noRes.length ? "GAP" : "PASS", !jobs.length ? "no new job or queue code" : noRes.length ? "new job or queue code with no retry, timeout, dead-letter or idempotency handling" : "job code shows retry/timeout handling", "STATIC_PATTERN", noRes);
  const noTo = hasIn(externals, TIMEOUT);
  add("EXTERNAL_TIMEOUT", !externals.length ? "NOT_APPLICABLE" : noTo.length ? "GAP" : "PASS", !externals.length ? "no new external call" : noTo.length ? "external call without a visible timeout" : "external calls show a timeout", "STATIC_PATTERN", noTo);
  const rp = releasePlanProblems(request.contract?.releasePlan, tier);
  add("RELEASE_PLAN", rp.length ? "GAP" : "PASS", rp.length ? rp.join("; ") : `release plan is sufficient for ${tier}`, "DECLARED");
  const blocking = checks.filter((k) => k.state === "BLOCKING").map((k) => `${k.id}: ${k.detail} (${k.paths.join(", ")})`);
  const gaps = checks.filter((k) => k.state === "GAP").map((k) => `${k.id}: ${k.detail}${k.paths.length ? ` (${k.paths.join(", ")})` : ""}`);
  return { applicability: "APPLICABLE", tier, checks, gaps, blocking, status: blocking.length ? "BLOCKED" : gaps.length ? "INCOMPLETE" : "PASS" };
}

export function operationalAssessment(r: OperationalReport, id: string): OperationalAssessment {
  return { schemaVersion: 1, id, status: r.status, gaps: [...r.blocking.map((b) => `BLOCKING ${b}`), ...r.gaps], checks: r.checks, blocking: r.blocking, tier: r.tier, rationale: r.rationale };
}

/** Owns OPERATIONAL checks for 2.J's driver hook; any other check runs elsewhere. */
export function operationalRunCheck(candidate: CandidateRecord, request: FeatureRecord): RunCheck {
  return async (check) => {
    if (check.kind !== "OPERATIONAL") return undefined;
    const r = operationalReadiness(candidate, request);
    if (r.status === "NOT_APPLICABLE") return { ...toRunResult("PASS", r, []), reason: r.rationale };
    return toRunResult(r.status === "PASS" ? "PASS" : r.status === "BLOCKED" ? "BLOCKED" : "INCOMPLETE", r, r.status === "BLOCKED" ? r.blocking : r.gaps);
  };
}

// ------------------------------------------------------------------------------------------------ revert as a new candidate

/** Edits that would undo `c` on the CURRENT tree at `liveRoot`. Any file that no longer matches what the candidate produced is a conflict. */
export function planRevert(c: CandidateRecord, liveRoot: string): { edits: FeatureEdit[]; conflicts: string[] } {
  const contents = c.contents ?? {}, base = c.baseContents ?? {}; const edits: FeatureEdit[] = [], conflicts: string[] = [];
  const live = (p: string): string | null => { try { return existsSync(safeJoin(liveRoot, p)) ? readFileSync(safeJoin(liveRoot, p), "utf8") : null; } catch { return null; } };
  const why = "revert of a feature candidate";
  for (const m of c.mutations) {
    if (m.kind === "RENAMED") {
      const cur = live(m.newPath!);
      if (cur === null || live(m.oldPath!) !== null || cur !== contents[m.newPath!]) conflicts.push(`${m.newPath} no longer matches the renamed file`);
      else edits.push({ op: "RENAME_FILE", from: m.newPath!, to: m.oldPath!, baseHash: sha256(cur), why });
      continue;
    }
    const p = (m.newPath ?? m.oldPath)!; const cur = live(p);
    if (m.kind === "ADDED") { if (cur !== contents[p]) conflicts.push(`${p} was changed or removed after the candidate was applied`); else edits.push({ op: "DELETE_FILE", file: p, baseHash: sha256(cur!), why }); }
    else if (m.kind === "DELETED") { if (cur !== null) conflicts.push(`${p} exists again; a clean revert needs a person`); else edits.push({ op: "CREATE_FILE", file: p, content: base[p] ?? "", why }); }
    else if (cur !== contents[p]) conflicts.push(`${p} was changed after the candidate was applied`);
    else edits.push({ op: "REPLACE_SPAN", file: p, baseHash: sha256(cur!), start: 0, end: Buffer.byteLength(cur!), expected: cur!, newText: base[p] ?? "", why });
  }
  return { edits: conflicts.length ? [] : edits, conflicts };
}

// ------------------------------------------------------------------------------------------------ post-deploy (schema only, PF-050)

export type PostDeployEvidence = { deploymentId: Id; observedAt: string; signal: string; value: number; unit: string; window: string; source: string };
export function validatePostDeployEvidence(e: unknown): string[] {
  const o = (e ?? {}) as Record<string, unknown>; const out: string[] = [];
  for (const k of ["deploymentId", "observedAt", "signal", "unit", "window", "source"]) if (typeof o[k] !== "string" || !o[k]) out.push(`${k} is required`);
  if (typeof o.value !== "number" || !Number.isFinite(o.value)) out.push("value must be a finite number");
  if (typeof o.observedAt === "string" && Number.isNaN(Date.parse(o.observedAt))) out.push("observedAt must be a timestamp");
  return out;
}
/** No telemetry is connected in slice 1: this is a checklist, and says so. */
export function anomalyChecklist(i: { requestId: Id; deploymentId: Id; evidenceIds: Id[] }): Outcome<InvestigationPlan> {
  const steps = ["Confirm the deployed version matches the validated candidate binding", "Compare the observed signals with the release plan's stop criteria", "If a stop criterion is met, use the kill switch or flag, then plan a revert candidate", "Record the observation as post-deploy evidence (deploymentId, signal, value, unit, window, source)"];
  return { status: "PARTIAL", value: { schemaVersion: 1, id: validationHash("pf.InvestigationPlan", { r: i.requestId, d: i.deploymentId, e: [...i.evidenceIds].sort() }), steps }, evidenceIds: i.evidenceIds, diagnostics: ["no production telemetry is connected: this is a checklist, not an investigation"] };
}
