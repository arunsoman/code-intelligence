// Task 2.K — the SECURITY and DEPENDENCY gates as an in-process driver for 2.J's `runCheck` hook (validation.ts), plus the
// helpers behind the C27/runSecurityValidation and C25/reviewDependencyDiff operations.
// The driver never executes candidate code. It reads the candidate's changed files (stored with the candidate) and answers
// in the runner's own vocabulary so 2.J's evidence, manifests and eligibility treat it like any other check:
//   PASS → PASSED / exit 0     BLOCKED → FAILED / exit 1     INCOMPLETE → INFRA_ERROR (a gap, never a pass)
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AuthorityConfig } from "./authority.ts";
import { asSet, canonHash, defineSchema, type Canon } from "./canon.ts";
import { reviewDependencies, type AdvisoryAdapter, type DependencyReport } from "./dependencies.ts";
import { buildProvenance, type ProvenanceRecord } from "./provenance.ts";
import { runSecurityScan, securityPolicyHash, type Finding, type ScanFile, type SecurityPolicy, type SecurityReport, type SecurityTools } from "./security.ts";
import { classifyTier } from "./tiers.ts";
import type { CandidateRecord, DependencyReview, FeatureRecord, RunResult, SecurityAssessment, Tier } from "./types.ts";
import type { ValidationCheck } from "./validation.ts";

export interface GateContext {
  candidate: CandidateRecord; request: FeatureRecord; repoRoot: string; auth: AuthorityConfig; policy: SecurityPolicy;
  tools?: SecurityTools; advisories?: AdvisoryAdapter[]; now?: string;
}
/** A driver returns a result for the checks it owns and `undefined` for any other, which then runs on the default runner. */
export type RunCheck = (check: ValidationCheck, root: string, signal?: AbortSignal) => Promise<RunResult | undefined>;

/** First driver that owns the check answers it. */
export const composeRunChecks = (...drivers: (RunCheck | undefined)[]): RunCheck => async (check, root, signal) => { for (const d of drivers) { if (!d) continue; const r = await d(check, root, signal); if (r) return r; } return undefined; };
export type SecurityGateReport = SecurityReport & { provenance: ProvenanceRecord };

const OMISSION = "static analysis runs in this process on the candidate's stored text; no candidate code is executed, installed or fetched";

export function tierOf(c: CandidateRecord): Tier {
  return classifyTier(c.mutations.flatMap((m) => [m.oldPath, m.newPath].filter((p): p is string => !!p).map((path) => ({ path, kind: m.kind })))).tier;
}
function changedFiles(c: CandidateRecord): ScanFile[] {
  const contents = c.contents ?? {}, base = c.baseContents ?? {};
  return Object.entries(contents).filter((e): e is [string, string] => e[1] !== null).map(([path, text]) => ({ path, text, base: base[path] ?? null })).sort((a, b) => a.path.localeCompare(b.path));
}

export async function dependencyGate(ctx: GateContext, signal?: AbortSignal): Promise<DependencyReport> {
  const contents = ctx.candidate.contents ?? {}, base = ctx.candidate.baseContents ?? {};
  const changedPaths = Object.keys({ ...contents, ...base }).filter((p) => /(^|\/)(package\.json|package-lock\.json)$/.test(p)).sort();
  const lockfileExists = existsSync(join(ctx.repoRoot, "package-lock.json")) || "package-lock.json" in contents;
  return reviewDependencies({ changedPaths, lockfileExists, policy: ctx.policy, advisories: ctx.advisories, signal,
    read: (path, side) => { const m = side === "base" ? base : contents; return path in m ? m[path] ?? null : null; } });
}

export async function securityGate(ctx: GateContext, signal?: AbortSignal): Promise<SecurityGateReport> {
  const tier = tierOf(ctx.candidate);
  const scan = await runSecurityScan({ files: changedFiles(ctx.candidate), tier, policy: ctx.policy, tools: ctx.tools, auth: ctx.auth, requester: ctx.request.createdBy, now: ctx.now, signal });
  const dep = await dependencyGate(ctx, signal);
  const kindOf = new Map(ctx.candidate.mutations.flatMap((m) => [[m.newPath, m.kind], [m.oldPath, m.kind]] as const).filter((e): e is [string, typeof ctx.candidate.mutations[number]["kind"]] => !!e[0]));
  const provenance = buildProvenance({
    bindingHash: ctx.candidate.bindingHash, invocationIds: ctx.candidate.invocationIds, policy: ctx.policy,
    files: [...new Set([...Object.keys(ctx.candidate.contents ?? {})])].sort().map((path) => ({ path, kind: kindOf.get(path) ?? "MODIFIED", text: ctx.candidate.contents?.[path] ?? null, base: ctx.candidate.baseContents?.[path] ?? null })),
    dependencies: dep.added.map((p) => ({ name: p.name, version: p.version, source: !p.resolved || ctx.policy.trustedRegistries.some((t) => p.resolved!.startsWith(t)) ? "REGISTRY" as const : "OTHER" as const, resolved: p.resolved })),
    similarityConfigured: false,
  });
  const gaps = [...scan.gaps];
  if (ctx.policy.requireSimilarityCheck) gaps.push("no code-similarity source is configured, so copied code without a licence marker is not detected");
  const provBlocking = provenance.findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH");
  const blocking = [...scan.blocking, ...provBlocking];
  const status: SecurityReport["status"] = blocking.length ? "BLOCKED" : gaps.length ? "INCOMPLETE" : "PASS";
  return { ...scan, findings: [...scan.findings, ...provenance.findings], gaps, blocking, status, provenance };
}

const findingLine = (f: Finding): string => `${f.rule} ${f.severity} ${f.path}${f.line ? `:${f.line}` : ""} — ${f.message}${f.cls === "SECRET" && f.excerpt ? ` [${f.excerpt}]` : ""}`;

export function toRunResult(status: "PASS" | "BLOCKED" | "INCOMPLETE", report: unknown, reasons: string[]): RunResult {
  return {
    status: status === "PASS" ? "PASSED" : status === "BLOCKED" ? "FAILED" : "INFRA_ERROR", exitCode: status === "PASS" ? 0 : status === "BLOCKED" ? 1 : null,
    stdout: JSON.stringify(report).slice(0, 400_000), stderr: "", truncated: false, isolation: "LOCAL_PERMISSION_MODEL", omissions: [OMISSION], usage: { wallMs: 0 },
    ...(reasons.length ? { reason: reasons.slice(0, 6).join("; ") } : {}),
  };
}

/** Handles SECURITY and DEPENDENCY checks and nothing else. */
export function gateRunCheck(ctx: GateContext): RunCheck {
  return async (check, root, signal) => {
    const t0 = Date.now();
    const done = (r: RunResult): RunResult => ({ ...r, usage: { wallMs: Date.now() - t0 } });
    if (check.kind === "SECURITY") { const r = await securityGate(ctx, signal); return done(toRunResult(r.status, r, r.status === "BLOCKED" ? r.blocking.map(findingLine) : r.gaps)); }
    if (check.kind === "DEPENDENCY") { const r = await dependencyGate(ctx, signal); return done(toRunResult(r.status, r, r.status === "BLOCKED" ? r.findings.filter((f) => f.severity === "CRITICAL" || f.severity === "HIGH").map(findingLine) : r.gaps)); }
    void root;
    return undefined;
  };
}

// ------------------------------------------------------------------------------------------------ operation views

const ScannerPlan = defineSchema<{ policy: string; tools: string[]; advisories: string[] }>("pf.ScannerPlan", "1", (p) => ({ policy: p.policy, tools: asSet(p.tools) as Canon, advisories: asSet(p.advisories) as Canon }));
/** What a caller must quote back to run the scan: the policy and the tools that will run. A changed policy makes the old hash stale. */
export const scannerPlanHashOf = (policy: SecurityPolicy, tools?: SecurityTools, advisories?: AdvisoryAdapter[]): string =>
  canonHash(ScannerPlan, { policy: securityPolicyHash(policy), tools: (tools?.sast ?? []).map((t) => `${t.name}@${t.version}`), advisories: (advisories ?? []).map((a) => a.name) });

export function securityAssessment(r: SecurityGateReport, id: string): SecurityAssessment {
  return { schemaVersion: 1, id, status: r.status, findings: [...r.blocking.map(findingLine), ...r.findings.filter((f) => !r.blocking.includes(f)).map(findingLine), ...r.suppressed.map((s) => `SUPPRESSED ${findingLine(s)} (by ${s.suppression.owner}: ${s.suppression.reason})`), ...r.gaps.map((g) => `GAP ${g}`)] };
}
export function dependencyReview(r: DependencyReport, id: string): DependencyReview {
  return { schemaVersion: 1, id, status: r.status, findings: [...r.findings.map(findingLine), ...r.gaps.map((g) => `GAP ${g}`)] };
}
