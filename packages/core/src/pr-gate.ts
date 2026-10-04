// C16 (F02): the quality gate. A policy is versioned, canonical JSON, hash-addressed and immutable once used; the evaluation
// of one policy against one exact evidence set is a pure, total function: every condition produces a result, no clock is read
// except the injected time, and the same inputs give the same binding hash on any machine. What is missing is stated: absence
// of evidence never passes a mandatory condition; a known failure (FAIL) is still reported when another analyzer did not finish.
// A waiver never resolves a finding and never hides it: it only changes who and until when.
import { createHash } from "node:crypto";
import { blank } from "./defect/source.ts";
import type {
  AnalyzerRecord, GateConditionOutcome, GateConditionResult, GateDecisionStatus, GateEvidence, GatePolicyBody,
  GatePolicyCondition, MissingDataPolicy, PrFinding, WaiverRecord,
} from "@cie/schema";
import { GatePolicySchema } from "@cie/schema";

// ---------------------------------------------------------------- canonical JSON and hashing

/** Keys sorted, arrays in order, no whitespace: the serialisation two machines agree on. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const policyHashOf = (body: GatePolicyBody) => "pol:" + sha256(canonicalJson(body)).slice(0, 16);
export const hashId = (prefix: string, parts: unknown[]) => `${prefix}:${sha256(canonicalJson(parts)).slice(0, 16)}`;

// ---------------------------------------------------------------- policy model

export type PolicyProblem = string;
/** Validate a policy document. A policy that names an unknown condition type is rejected here, never at evaluation time (§14). */
export function validatePolicy(x: unknown): { ok: true; body: GatePolicyBody; policyHash: string } | { ok: false; problems: PolicyProblem[] } {
  const parsed = GatePolicySchema.safeParse(x);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const body = parsed.data as GatePolicyBody;
  const problems: PolicyProblem[] = [];
  const ids = new Set<string>();
  for (const c of body.conditions) {
    if (ids.has(c.id)) problems.push(`condition id "${c.id}" is used twice`);
    ids.add(c.id);
    if (c.type === "REQUIRED_ANALYZERS" && !(c.analyzers ?? []).every((a) => /^[\w.-]+@\d+$/.test(a))) problems.push(`condition "${c.id}": analyzers must be "id@version"`);
    if (c.type === "COVERAGE_ON_CHANGED_LINES" && c.minimumPercent === undefined) problems.push(`condition "${c.id}": minimumPercent is required`);
    if (c.type === "BLAST_RADIUS" && c.informationalAboveDependents === undefined) problems.push(`condition "${c.id}": informationalAboveDependents is required`);
  }
  if (problems.length) return { ok: false, problems };
  return { ok: true, body, policyHash: policyHashOf(body) };
}

const globRule = (pattern: string, ruleId: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\[\]]/g, "\\$&").replace(/\*/g, ".*")}$`).test(ruleId);
const ruleSelectorMatches = (selectors: string[] | undefined, ruleId: string) =>
  (selectors && selectors.length ? selectors : ["*"]).some((s) => s === "*" || s === ruleId || (s.includes("*") && globRule(s, ruleId)));

// ---------------------------------------------------------------- evidence, evaluation

export interface EvaluateRefs {
  baseHash: string; headHash: string; mergeBaseHash: string; analyzerSetHash: string;
  evaluatedAt: string; decisionId?: string;
}

const missing = (c: GatePolicyCondition): NonNullable<MissingDataPolicy> => c.onMissing ?? "INCOMPLETE";
const severityOf: Record<string, number> = { high: 3, medium: 2, low: 1 };

interface RawResult { outcome: GateConditionOutcome; reason: string; evidenceIds: string[]; waiverId?: string }

/** One evaluator per condition type. Each may return INCOMPLETE: nothing here invents evidence that is not there. */
const EVALUATORS: Record<GatePolicyCondition["type"], (c: GatePolicyCondition, e: GateEvidence, refs: EvaluateRefs) => RawResult> = {
  NEW_FINDINGS: (c, e, refs) => {
    const fs = e.findings;
    if (!fs) return { outcome: "INCOMPLETE", reason: "no findings evidence was produced for this analysis", evidenceIds: ["findings:none"] };
    const wantSev = c.severity ?? ["high"];
    // A finding whose disposition is WAIVED counts again the moment its waiver is out of effect (§7.9): the gate
    // never carries an expired exception forward by mistake. Dismissals (with their audited rationale) do not count.
    const covered = (f: PrFinding): boolean =>
      (e.waivers ?? []).some((w) => waiverCovers(w, refs.evaluatedAt) && waiverScopeCovers(w, f, refs.decisionId ?? ""));
    const offending = fs.filter((f) => f.introduced && (f.disposition === "OPEN" || (f.disposition === "WAIVED" && !covered(f))) && wantSev.includes(f.severity) && ruleSelectorMatches(c.ruleSelectors ?? ["*"], f.ruleId));
    if (!offending.length) {
      const analysed = e.analyzers.filter((a) => a.state === "COMPLETE").reduce((n, a) => n + a.coverage.analyzedFiles, 0);
      return { outcome: "PASSED", reason: analysed ? `No new findings at or above ${wantSev.join("/")} in ${analysed} analysed file(s); existing findings are not introduced by this PR.` : "No new findings at or above the severities this condition counts.", evidenceIds: [] };
    }
    const shown = offending.slice(0, 5);
    const more = offending.length - shown.length;
    return {
      outcome: "FAILED",
      reason: `${offending.length} new finding(s) at or above ${wantSev.join("/")}${more > 0 ? ` (showing ${shown.length}; ${more} more evaluated but not shown)` : ""}: ${shown.map((f) => `${f.ruleId} ${f.path}${f.line ? ":" + f.line : ""}${more || shown.length < offending.length ? "…" : ""}`).join("; ")}`,
      evidenceIds: offending.map((f) => f.fingerprint),
    };
  },
  REQUIRED_ANALYZERS: (c, e) => {
    const want = c.analyzers ?? [];
    if (!want.length) return { outcome: "INCOMPLETE", reason: "the condition names no analyzers", evidenceIds: [] };
    const byId = new Map(e.analyzers.map((a) => [`${a.id}@${a.version}`, a]));
    const incomplete: string[] = [], evidenceIds: string[] = [];
    for (const id of want) {
      const a = byId.get(id);
      if (!a) { incomplete.push(`${id} is not available on this installation`); continue; }
      evidenceIds.push(`${a.id}@${a.version}`);
      if (a.state === "PARTIAL") incomplete.push(`${id} finished only partially (${a.coverage.analyzedFiles} of ${a.coverage.analyzedFiles + a.coverage.skippedFiles} files${a.coverage.reason ? `; ${a.coverage.reason}` : ""})`);
      else if (a.state === "TIMED_OUT") incomplete.push(`${id} timed out after ${Math.round((a.wallMs ?? 0) / 1000)} s`);
      else if (a.state === "UNAVAILABLE") incomplete.push(`${id} is unavailable${a.reason ? `: ${a.reason}` : ""}`);
      else if (a.state === "FAILED") incomplete.push(`${id} failed`);
    }
    if (incomplete.length) return { outcome: "INCOMPLETE", reason: `Mandatory analyzer did not finish → the gate cannot pass until it completes: ${incomplete.join("; ")}.`, evidenceIds };
    return { outcome: "PASSED", reason: `${want.length} required analyzer(s) finished`, evidenceIds };
  },
  TESTS_NOT_LOST: (c, e) => {
    const ti = e.testImpact;
    if (!ti) return { outcome: "INCOMPLETE", reason: "the analysis could not say which tests reach the changed code (structural reachability was not computed)", evidenceIds: ["test-impact:none"] };
    if (!ti.lost.length) return { outcome: "PASSED", reason: `No tests lost: ${ti.unchanged} reaching test(s) unchanged, ${ti.gained} gained. Structural (static reachability) evidence: it does not say the tests ran.`, evidenceIds: [] };
    const shown = ti.lost.slice(0, 5);
    return { outcome: "FAILED", reason: `${ti.lost.length} test(s) that reached changed code at base no longer reach it: ${shown.join(", ")}${ti.lost.length > shown.length ? ` and ${ti.lost.length - shown.length} more` : ""}.`, evidenceIds: ti.lost.slice(0, 20) };
  },
  COVERAGE_ON_CHANGED_LINES: (c, e) => {
    const cov = e.coverage;
    if (!cov || cov.percent === null) return { outcome: "INCOMPLETE", reason: cov?.disclosure ? `no coverage evidence: ${cov.disclosure}` : "no coverage evidence was produced for the head", evidenceIds: [cov?.artifactHash ?? "coverage:none"] };
    if (cov.executableChangedLines < (c.minimumExecutableLines ?? 5))
      return { outcome: "NOT_APPLICABLE", reason: `Only ${cov.executableChangedLines} executable changed line(s); the policy requires at least ${c.minimumExecutableLines ?? 5} for a coverage number, so none is claimed.`, evidenceIds: cov.artifactHash ? [cov.artifactHash] : [] };
    const min = c.minimumPercent ?? 0;
    const ev = [cov.artifactHash || `coverage:${cov.source}`];
    if ((cov.percent ?? 0) < min) return { outcome: "FAILED", reason: `${cov.percent}% of ${cov.executableChangedLines} executable changed line(s) covered (policy requires ≥ ${min}%; from ${cov.source} artifacts${cov.disclosure ? ` — ${cov.disclosure}` : ""}).`, evidenceIds: ev };
    return { outcome: "PASSED", reason: `${cov.percent}% of ${cov.executableChangedLines} executable changed line(s) covered (policy requires ≥ ${min}%; from ${cov.source} artifacts${cov.disclosure ? ` — ${cov.disclosure}` : ""}).`, evidenceIds: ev };
  },
  ORACLE_PRESERVED: (c, e) => {
    const o = e.oracle;
    if (!o) return { outcome: "INCOMPLETE", reason: "the oracle-preservation detector did not run", evidenceIds: ["oracle:none"] };
    if (!o.headChangesTests) return { outcome: "PASSED", reason: "The PR changes no test files, so assertions could not have weakened.", evidenceIds: [] };
    if (o.candidates <= o.reviewed) return { outcome: "PASSED", reason: `${o.reviewed} assertion-level change(s) to test files were reviewed and accepted as legitimate property changes. The detector is a candidate-finder, not a proof: it misses weakening phrasings it has no rule for.`, evidenceIds: [] };
    const open = o.candidates - o.reviewed;
    const when = c.onUnreviewed ?? "FAILED";
    return { outcome: when === "INCOMPLETE" ? "INCOMPLETE" : "FAILED", reason: `${open} un-reviewed assertion-level test change(s) (removed or loosened assertion, skipped test). Detector candidates with a stated limitation: a person must decide whether the property legitimately changed.`, evidenceIds: [] };
  },
  DEPENDENCY_POLICY: (c, e) => {
    const d = e.dependencies;
    if (!d || !d.policyRef) return { outcome: "INCOMPLETE", reason: `the dependency policy ${c.ref ?? "(unnamed)"} was not evaluated: no licence-dependency evidence was produced`, evidenceIds: ["dependency-policy:none"] };
    if (d.policyRef !== c.ref) return { outcome: "INCOMPLETE", reason: `the evidence was produced for ${d.policyRef}, not for ${c.ref}; it is not usable here`, evidenceIds: [] };
    if (!d.violations.length) return { outcome: "PASSED", reason: `No dependency violates ${d.policyRef}.`, evidenceIds: [] };
    return { outcome: "FAILED", reason: `${d.violations.length} dependency violation(s) against ${d.policyRef}: ${d.violations.slice(0, 3).join("; ")}${d.violations.length > 3 ? " and others" : ""}.`, evidenceIds: d.violations.map((v) => `dep:${v}`) };
  },
  BLAST_RADIUS: (c, e) => {
    const b = e.blastRadius;
    if (!b) return { outcome: "INCOMPLETE", reason: "the affected-neighbourhood was not computed", evidenceIds: ["blast-radius:none"] };
    const above = c.informationalAboveDependents ?? Number.MAX_SAFE_INTEGER;
    if (b.dependents > above) return { outcome: "PASSED", reason: `${b.dependents} dependents exceed the informational threshold (${above}); noted, not blocking.`, evidenceIds: ["blast-radius"] };
    return { outcome: "PASSED", reason: `${b.dependents} dependents (threshold ${above}).`, evidenceIds: ["blast-radius"] };
  },
};

/** Is the waiver in effect at `evaluatedAt`, and does it cover this outcome? */
export function waiverCovers(w: WaiverRecord, at: string): boolean {
  if (w.revokedAt) return false;
  return Date.parse(w.expiresAt) > Date.parse(at);
}
/** Does the waiver's scope cover this finding? (CONDITION_ONCE needs the decision that was granted for.) */
export function waiverScopeCovers(w: WaiverRecord, f: PrFinding, decisionId: string): boolean {
  if (w.scopeKind === "FINDING_FINGERPRINT") return w.scope.fingerprint === f.fingerprint;
  if (w.scopeKind === "RULE_IN_PATH") return w.scope.ruleId === f.ruleId && w.scope.path === f.path;
  return w.scopeKind === "CONDITION_ONCE" && w.scope.decisionId === decisionId;
}

function applyWaivers(c: GatePolicyCondition, r: RawResult, e: GateEvidence, refs: EvaluateRefs): RawResult {
  if (r.outcome !== "FAILED") return r;
  const waivers = (e.waivers ?? []).filter((w) => waiverCovers(w, refs.evaluatedAt));
  if (!waivers.length) return r;
  const offenders = (e.findings ?? []).filter((f) => r.evidenceIds.includes(f.fingerprint));
  const decisionId = refs.decisionId ?? "";
  const covers = (w: WaiverRecord, f: PrFinding): boolean => waiverScopeCovers(w, f, decisionId);
  // The waivers stack: the condition is waived when every offending finding is covered by some active waiver (§7.9).
  const used: WaiverRecord[] = [];
  const covered = new Set<string>();
  for (const w of waivers) for (const f of offenders) if (!covered.has(f.fingerprint) && covers(w, f)) { covered.add(f.fingerprint); used.push(w); }
  if (offenders.length && covered.size === offenders.length) {
    const primary = used[0];
    const until = waivers.map((w) => w.expiresAt).sort()[0];
    const approvers = [...new Set(used.flatMap((u) => u.approver ? [u.approver] : []))].join(", ");
    return { outcome: "WAIVED", reason: `All ${offenders.length} offending finding(s) are waived by ${[...new Set(used.map((u) => u.id))].join(", ")}${approvers ? `, approved by ${approvers}` : ""}, until ${until.slice(0, 10)}, “${primary.rationale}”). They stay visible below.`, evidenceIds: offenders.map((f) => f.fingerprint), waiverId: primary.id };
  }
  return r;
}

/** The exceptions (waivers) relied on, and the earliest expiry among them: the decision has that long to live. */
function exceptionsInEffect(e: GateEvidence, at: string): { ids: string[]; validUntil?: string; waivers: WaiverRecord[] } {
  const active = (e.waivers ?? []).filter((w) => waiverCovers(w, at));
  if (!active.length) return { ids: [], waivers: [] };
  return { ids: active.map((w) => w.id), validUntil: active.map((w) => w.expiresAt).sort()[0], waivers: active };
}

export function coverageSummaryHash(e: GateEvidence): string {
  const c = e.coverage;
  return sha256(canonicalJson(c ? { source: c.source, executable: c.executableChangedLines, covered: c.covered, percent: c.percent, head: c.artifactHead ?? null } : null)).slice(0, 16);
}

/** SHA-256 over the canonical serialisation of everything a decision covers (§6.1). A decision is valid only for the exact set it hashes. */
export function bindingHashOf(policy: GatePolicyBody, e: GateEvidence, refs: EvaluateRefs): string {
  const exc = exceptionsInEffect(e, refs.evaluatedAt);
  return "bind:" + sha256(canonicalJson({
    baseHash: refs.baseHash, headHash: refs.headHash, mergeBaseHash: refs.mergeBaseHash,
    policyHash: policyHashOf(policy), analyzerSetHash: refs.analyzerSetHash,
    evidenceArtifactHashes: [...new Set([...(e.analyzers.map((a) => `${a.id}@${a.version}:${a.state}`)), ...(e.coverage?.artifactHash ? [e.coverage.artifactHash] : []), ...(e.testsRun ? [e.testsRun.headHash] : [])])].sort(),
    runManifestIds: (e.oracle?.headChangesTests ? ["oracle-detector"] : []).sort(),
    coverageSummaryHash: coverageSummaryHash(e),
    exceptionsInEffect: exc.ids.sort(),
  })).slice(0, 32);
}

export interface Decision { status: GateDecisionStatus; results: GateConditionResult[]; bindingHash: string; evaluatedAt: string; validUntil?: string; exceptionsUsed: string[] }

/**
 * Deterministic, side-effect-free, total. FAIL dominates INCOMPLETE: a known failure is reported even if another analyzer
 * did not finish. Waivers turn FAILED → WAIVED only for the scope they name; onMissing mapping then applies to incompleteness.
 */
export function evaluate(policy: GatePolicyBody, e: GateEvidence, refs: EvaluateRefs): Decision {
  const results: GateConditionResult[] = [];
  for (const c of policy.conditions) {
    let r = EVALUATORS[c.type](c, e, refs);
    if (r.outcome === "FAILED") r = applyWaivers(c, r, e, refs);
    if (r.outcome === "INCOMPLETE") {
      const when = missing(c);
      if (when === "FAIL") r = { ...r, outcome: "FAILED", reason: `${r.reason} The policy asks that missing data fail the condition.` };
      else if (when === "IGNORE_WITH_DISCLOSURE") r = { ...r, outcome: "PASSED", reason: `${r.reason} Disclosed: the condition was not evaluated, not passed.` };
      // when === "INCOMPLETE": stays INCOMPLETE
    }
    results.push({ id: c.id, type: c.type, blocking: c.blocking !== false, outcome: r.outcome, reason: r.reason, evidenceIds: r.evidenceIds, ...(r.waiverId ? { waiverId: r.waiverId } : {}) });
  }
  const blockingFailed = results.some((r) => r.blocking && r.outcome === "FAILED");
  const blockingIncomplete = results.some((r) => r.blocking && r.outcome === "INCOMPLETE");
  const status: GateDecisionStatus = blockingFailed ? "FAIL" : blockingIncomplete ? "INCOMPLETE" : "PASS";
  const exc = exceptionsInEffect(e, refs.evaluatedAt);
  return { status, results, bindingHash: bindingHashOf(policy, e, refs), evaluatedAt: refs.evaluatedAt, ...(exc.validUntil ? { validUntil: exc.validUntil } : {}), exceptionsUsed: exc.ids };
}

/** The banner's honest words (§12.2): PASS is never "safe". */
export function gateBannerCopy(d: Decision, policy: GatePolicyBody): string {
  const pName = `${policy.policyId} v${policy.version}`;
  if (d.status === "PASS") return `No blocking condition failed under policy ${pName}. This is not a statement that the change is safe or verified.`;
  if (d.status === "FAIL") {
    const failed = d.results.filter((r) => r.blocking && r.outcome === "FAILED");
    return `${failed.length} blocking condition(s) failed under policy ${pName}: ${failed.map((f) => f.id).join(", ")}.`;
  }
  const incomplete = d.results.filter((r) => r.blocking && r.outcome === "INCOMPLETE");
  return `Cannot decide under policy ${pName}: ${incomplete.map((f) => f.id).join(", ")} did not finish. Nothing is claimed.`;
}

// ---------------------------------------------------------------- finding fingerprints (§7.4)

export interface FingerprintInput { ruleId: string; canonicalEntityId: string | null; anchorSource?: string; anchor: string; occurrenceIndex: number; fallbackPath?: string }
/** The matched construct with comments and string contents blanked and ALL whitespace gone: any reformat (line breaks,
 * alignment, tabs) yields the same anchor, while a different construct — or a comma more — does not. */
export function normalizeAnchor(s: string, lang: "ts" | "rust" | "java" | "go" | "python" = "ts"): string {
  return blank(s, lang).replace(/\s+/g, "");
}
/**
 * Rename- and move-stable: rule + canonical identity + normalized anchor + which occurrence within the entity. Line numbers are
 * NOT part of it. Without a canonical identity (a file-level finding) it falls back to (path, anchor, occurrence).
 */
export function findingFingerprint(i: FingerprintInput): string {
  const entity = i.canonicalEntityId ? `canon:${i.canonicalEntityId}` : `path:${i.fallbackPath ?? ""}`;
  return "fp:" + sha256(canonicalJson([i.ruleId, entity, normalizeAnchor(i.anchor), i.occurrenceIndex])).slice(0, 24);
}

/** Baseline match (§7.3): head findings matched to base findings by fingerprint; leftovers on each side are reported. */
export function matchBaselines(head: PrFinding[], base: PrFinding[]): { head: PrFinding[]; resolvedByChange: PrFinding[] } {
  const baseByFp = new Map<string, PrFinding>();
  for (const f of base) baseByFp.set(f.fingerprint, f); // same fingerprint twice at base keeps the first
  const headByFp = new Set(head.map((f) => f.fingerprint));
  const matched = head.map((f) => {
    const hit = baseByFp.get(f.fingerprint);
    return hit ? { ...f, introduced: false, baselineFindingId: hit.findingId } : { ...f, introduced: true };
  });
  const resolvedByChange = base.filter((f) => !headByFp.has(f.fingerprint)).map((f) => ({ ...f, introduced: false, disposition: "RESOLVED_BY_CHANGE" as const, baselineFindingId: f.findingId }));
  return { head: matched, resolvedByChange };
}

// ---------------------------------------------------------------- waiver validation

export function validateWaiver(x: {
  scopeKind: string; scope?: unknown; rationale?: unknown; expiresAt?: unknown; policy?: GatePolicyBody;
}): { ok: true } | { ok: false; error: string } {
  if (!["FINDING_FINGERPRINT", "RULE_IN_PATH", "CONDITION_ONCE"].includes(x.scopeKind)) return { ok: false, error: "scopeKind is not one of FINDING_FINGERPRINT, RULE_IN_PATH, CONDITION_ONCE" };
  const s = (x.scope ?? {}) as Record<string, unknown>;
  if (x.scopeKind === "FINDING_FINGERPRINT" && typeof s.fingerprint !== "string") return { ok: false, error: "a FINDING_FINGERPRINT waiver names a fingerprint" };
  if (x.scopeKind === "RULE_IN_PATH" && (typeof s.ruleId !== "string" || typeof s.path !== "string")) return { ok: false, error: "a RULE_IN_PATH waiver names a rule and a path" };
  if (x.scopeKind === "CONDITION_ONCE" && typeof s.decisionId !== "string") return { ok: false, error: "a CONDITION_ONCE waiver names a decision" };
  if (typeof x.rationale !== "string" || x.rationale.trim().length < 3) return { ok: false, error: "a waiver needs a rationale" };
  if (typeof x.expiresAt !== "string" || !Number.isFinite(Date.parse(x.expiresAt))) return { ok: false, error: "a waiver needs an expiry date" };
  if (x.policy) {
    const maxDays = x.policy.exceptions?.maxDurationDays ?? 90;
    const lifeDays = (Date.parse(x.expiresAt) - Date.now()) / 86_400_000;
    if (lifeDays > maxDays) return { ok: false, error: `a waiver may last at most ${maxDays} day(s) under this policy` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- gate summary rendering (C20)

/** The forge description: rule ids, paths and line numbers only — never code text (§10.4). */
export function gateStatusDescription(v: { status: GateDecisionStatus; policy: { policyId: string; version: number }; conditions: GateConditionResult[]; counts: { newFindings: number; waived: number } }): string {
  const mark = v.status === "PASS" ? "✓ PASS" : v.status === "FAIL" ? "✗ FAIL" : "◔ INCOMPLETE";
  const interesting = v.conditions.filter((c) => c.outcome !== "PASSED").slice(0, 2);
  const detail = interesting.length ? ` — ${interesting.map((c) => c.outcome === "WAIVED" ? `${c.id} waived` : `${c.id}`).join(", ")}` : "";
  const counts = v.counts.newFindings ? ` · ${v.counts.newFindings} new finding(s)` : "";
  return `${mark} (${v.policy.policyId} v${v.policy.version})${detail}${counts}`.slice(0, 140);
}

/** The updatable PR comment: a summary table with the "what this does not tell you" disclosure (§12.2). */
export function gateCommentText(view: {
  headHash: string; policy: { policyId: string; version: number };
  decision?: { status: GateDecisionStatus; bindingHash: string; evaluatedAt: string; validUntil?: string; conditions: { id: string; outcome: GateConditionOutcome; blocking: boolean; reason: string; waiverId?: string }[] };
  introduced: { ruleId: string; severity: string; path: string; line: number | null; summary: string; disclaimer?: string }[];
  existing: { ruleId: string; path: string; line: number | null }[];
  resolvedByChange: number;
  analyzers: { id: string; version: string; state: string; coverage: { analyzedFiles: number; skippedFiles: number } }[];
  disclosure: string[];
  analysisId: string;
}): string {
  const out: string[] = [];
  const d = view.decision;
  const introduced = view.introduced;
  out.push(`<!-- cie-gate:pr-comment -->`, `## CIE quality gate — bound to head \`${view.headHash.slice(0, 7)}\``, "");
  const verdict = !d ? `No gate policy applies to this repository. Findings are shown without a decision.`
    : `**${d.status === "PASS" ? "PASS" : d.status === "FAIL" ? "FAIL" : "INCOMPLETE"}** — ${d.status === "PASS" ? `no blocking condition failed under policy ${view.policy.policyId} v${view.policy.version}. Not a safety certificate.` : d.status === "FAIL" ? "at least one blocking condition failed under the policy." : "no gate claim is made: evidence this policy requires did not finish. See below."}`;
  out.push(verdict);
  out.push("", `### Conditions (policy ${view.policy.policyId} v${view.policy.version})`, "", "| Condition | Outcome | Reason |", "|---|---|---|");
  for (const c of d?.conditions ?? []) out.push(`| ${c.id}${c.blocking ? "" : " (not blocking)"} | ${c.outcome}${c.waiverId ? " (waiver)" : ""} | ${c.reason.replace(/\|/g, "\\|")} |`);
  out.push("", `### Introduced by this PR (${introduced.length})`);
  if (introduced.length) for (const f of introduced) out.push(`- **${f.ruleId}** (${f.severity}) at \`${f.path}${f.line ? ":" + f.line : ""}\` — ${f.summary} ${f.disclaimer ?? "A finding is a candidate from static analysis."}`);
  else out.push("None introduced by this PR. (Existing findings in touched files are listed below; *no findings* is not *safe*.)");
  out.push("", `### Not introduced by this PR (${view.existing.length})`, ...(view.existing.slice(0, 10).map((f) => `- ${f.ruleId} \`${f.path}${f.line ? ":" + f.line : ""}\``)), ...(view.existing.length > 10 ? [`- … ${view.existing.length - 10} more`] : []));
  out.push("", `Resolved by this change: ${view.resolvedByChange}.`);
  out.push("", `### Analyzers`, ...view.analyzers.map((a) => `- ${a.id}@${a.version} ${a.state} — analysed ${a.coverage.analyzedFiles} file(s), skipped ${a.coverage.skippedFiles}`));
  out.push("", "### What this does not tell you", ...view.disclosure.map((x) => `- ${x}`), `- The full review page for this analysis is on CIE (\`${view.analysisId}\`). Findings there are candidates until the alarm gate is satisfied.`);
  return out.join("\n");
}