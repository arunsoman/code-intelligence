// 2.J: evidence is scoped to a check, target and complete execution identity. Missing work
// remains in the population. A waiver changes publication policy, never a test's result.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RoleRunRecord } from "../execution.ts";
import { makeScratch, removeScratch, safeJoin, walkFiles } from "../isolated-exec.ts";
import { applyCandidateToDir, copyTreeKeepLinks } from "./tree.ts";
import { canonHash, contentRoot, defineSchema, entriesFromDirectory, parseStrictJson, rawHash, type Canon } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import { classifyTier } from "./tiers.ts";
import type { CandidateRecord, DecisionRecord, EvidenceRecord, FeatureContract, FeatureRecord, FeatureStore, PublicationDecision, RunManifest, Runner, RunResult, ValidationKind, ValidationResult, ValidationStatus } from "./types.ts";

export type CheckPhase = "BUILD" | "STATIC_SECURITY" | "TARGETED" | "REGRESSION" | "BROWSER" | "PERFORMANCE";
export type CheckOutcome = { name: string; state: "PASS" | "FAIL" | "SKIP" | "TODO" | "FLAKY" | "NOT_RUN" | "TIMEOUT" | "INFRA_ERROR" };
export type ValidationCheck = {
  id: string; kind: ValidationKind; phase: CheckPhase; target: string; acceptanceIds: string[]; mandatory: boolean;
  argv?: string[]; fullSuiteArgv?: string[]; expectedTests: string[]; report: "EXIT" | "NODE_TEST" | "BROWSER_JSON";
  applicability: "APPLICABLE" | "NOT_APPLICABLE"; rationale?: string; baseline: boolean;
};
export type ValidationPlan = {
  schemaVersion: 1; contractHash: string; targets: string[]; checks: ValidationCheck[]; coverageKnown: boolean;
  environment: { hash: string; fidelity: "REPRESENTATIVE" | "PARTIAL" | "UNKNOWN"; configHash: string; migrationHash: string; dependencies: "AVAILABLE" | "MISSING" | "UNKNOWN" };
  testData: { kind: "SYNTHETIC" | "AUTHORIZED_REDACTED" | "PROTECTED" | "UNKNOWN"; fixtureHash: string; generatorHash: string; seed: string; authorizationRef?: string };
  workloadHash: string; toolchainHash: string; performanceApplicable: boolean;
};
export type BaselineHealth = "HEALTHY" | "PREEXISTING_FAILURE" | "FLAKY" | "ENVIRONMENT_MISMATCH" | "NOT_RUN";
export type ValidationEvidence = {
  planHash: string; checkId: string; phase: CheckPhase; baselineHealth: BaselineHealth; outcomes: CheckOutcome[];
  roleRuns: RoleRunRecord[]; runState: string; environmentHash: string; fixtureHash: string; workloadHash: string;
  isolationOmissions: string[]; reportComplete: boolean;
};
export const validationHash = (schema: string, value: unknown): string => canonHash(defineSchema<Canon>(schema, "1", (x) => x), parseStrictJson(JSON.stringify(value)));
export const validationPlanHash = (p: ValidationPlan): string => validationHash("pf.ValidationPlan", p);
const phases: CheckPhase[] = ["BUILD", "STATIC_SECURITY", "TARGETED", "REGRESSION", "BROWSER", "PERFORMANCE"];
const assertPlan = (plan: ValidationPlan): void => {
  if (plan.schemaVersion !== 1 || !plan.checks.length || plan.checks.length > 200 || new Set(plan.checks.map((c) => c.id)).size !== plan.checks.length || new Set(plan.targets).size !== plan.targets.length) throw new FeatureError("INVALID_SCHEMA", "validation needs unique checks and targets (at most 200 checks)");
  for (const c of plan.checks) if (!c.id || !phases.includes(c.phase) || !c.target || (c.applicability === "NOT_APPLICABLE" && !c.rationale?.trim()) || c.argv?.some((v) => typeof v !== "string" || v.includes("\0"))) throw new FeatureError("INVALID_SCHEMA", `invalid validation check ${c.id}`);
};

/** Parses the entire bounded runner output. A zero exit without a complete test population is not a pass. */
export function captureOutcomes(run: RunResult, check: ValidationCheck): { outcomes: CheckOutcome[]; complete: boolean } {
  const outcomes: CheckOutcome[] = []; const text = run.stdout + "\n" + run.stderr;
  if (check.report === "NODE_TEST") {
    for (const line of text.split("\n")) {
      const tap = /^\s*(not ok|ok)\s+\d+\s*-?\s*(.*?)(?:\s+#\s*(SKIP|TODO)(?:\s.*)?)?$/i.exec(line);
      const spec = /^\s*(✔|✖|﹣|↓)\s+(.+?)(?:\s+\(.*?\))?$/.exec(line);
      if (tap) outcomes.push({ name: tap[2].trim(), state: tap[3]?.toUpperCase() === "SKIP" ? "SKIP" : tap[3]?.toUpperCase() === "TODO" ? "TODO" : tap[1] === "ok" ? "PASS" : "FAIL" });
      else if (spec) outcomes.push({ name: spec[2].trim(), state: spec[1] === "✔" ? "PASS" : spec[1] === "✖" ? "FAIL" : spec[1] === "﹣" ? "TODO" : "SKIP" });
    }
  } else if (check.report === "EXIT" && (run.status === "PASSED" || run.status === "FAILED")) outcomes.push({ name: check.id, state: run.status === "PASSED" ? "PASS" : "FAIL" }); // a clean non-zero exit is a complete FAIL (issue #81)
  // Browser reports are validated by the browser harness, not an exit code or a screenshot.
  else if (check.report === "BROWSER_JSON") {
    try {
      const report = JSON.parse(run.stdout);
      if (report.schemaVersion === 1 && report.complete === true && Array.isArray(report.outcomes)) for (const o of report.outcomes) {
        if (typeof o.name !== "string" || !["PASS", "FAIL", "SKIP", "TODO", "FLAKY", "NOT_RUN", "TIMEOUT", "INFRA_ERROR"].includes(o.state) || !Number.isInteger(o.interactions) || o.interactions < 1 || o.accessibilityChecked !== true) throw new Error("incomplete browser journey");
        outcomes.push({ name: o.name, state: o.state });
      }
    } catch { return { outcomes, complete: false }; }
  }
  const names = new Set(outcomes.map((o) => o.name));
  for (const name of check.expectedTests) if (!names.has(name)) outcomes.push({ name, state: "NOT_RUN" });
  const summary = /(?:#|ℹ) tests (\d+)/.exec(text);
  // Nested TAP suites can have parent results; require at least the declared population and all named expected tests.
  const complete = !run.truncated && outcomes.length > 0 && !outcomes.some((o) => o.state === "NOT_RUN") && (check.report !== "NODE_TEST" || (!!summary && Number(summary[1]) > 0 && names.size >= Number(summary[1])));
  return { outcomes, complete };
}
function runStatus(run: RunResult, outcomes: CheckOutcome[], complete: boolean): ValidationStatus {
  if (run.violations?.length || outcomes.some((o) => o.state === "FAIL") || run.status === "FAILED") return "FAIL";
  if (run.status !== "PASSED" || !complete || outcomes.some((o) => o.state !== "PASS")) return "INCOMPLETE";
  return "PASS";
}
export function classifyBaseline(run: RunResult | undefined, outcomes: CheckOutcome[], complete: boolean): BaselineHealth {
  if (!run) return "NOT_RUN";
  if (outcomes.some((o) => o.state === "FLAKY")) return "FLAKY";
  if (["INFRA_ERROR", "REFUSED", "TIMEOUT", "RESOURCE_LIMIT", "CANCELLED"].includes(run.status) || !complete) return "ENVIRONMENT_MISMATCH";
  return run.status === "FAILED" || outcomes.some((o) => o.state === "FAIL") ? "PREEXISTING_FAILURE" : "HEALTHY";
}
const dataAllowed = (p: ValidationPlan) => p.testData.kind === "SYNTHETIC" || (p.testData.kind === "AUTHORIZED_REDACTED" && !!p.testData.authorizationRef);
const role = (r: RunResult, outcomes: CheckOutcome[], which: RoleRunRecord["role"]): RoleRunRecord => ({ role: which, mandatory: true,
  status: r.status === "PASSED" ? "PASSED" : r.status === "FAILED" ? "FAILED" : r.status === "CANCELLED" ? "CANCELLED" : r.status === "TIMEOUT" || r.status === "RESOURCE_LIMIT" ? "BUDGET_STOPPED" : "INFRA_FAILED",
  passed: outcomes.filter((o) => o.state === "PASS").length, failed: outcomes.filter((o) => o.state === "FAIL").length,
  outcomes: outcomes.map((o) => ({ name: o.name, state: ["PASS", "FAIL", "SKIP", "TODO", "FLAKY"].includes(o.state) ? o.state as "PASS" | "FAIL" | "SKIP" | "TODO" | "FLAKY" : "SKIP" })),
  output: "Raw output retained by hash; see full outcome population.", omissions: r.omissions });

export type ValidationDependencies = { store: FeatureStore; runner: Runner; /** Trusted project-specific driver (e.g. 2.L) using the same Runner boundary. */ runCheck?: (check: ValidationCheck, root: string, signal?: AbortSignal) => Promise<RunResult | undefined>; /** Called before every evidence write; throw to stop (e.g. a fenced-out job). */ beforeSave?: () => void };
export async function runFeatureValidation(d: ValidationDependencies, i: { candidateId: string; plan: ValidationPlan; actor: string; wallMs: number; signal?: AbortSignal }): Promise<EvidenceRecord[]> {
  assertPlan(i.plan);
  if (!Number.isSafeInteger(i.wallMs) || i.wallMs < 1 || i.wallMs > 1800000) throw new FeatureError("INVALID_SCHEMA", "validation wall budget is out of range");
  const candidate = d.store.getCandidate(i.candidateId); const request = candidate && d.store.getRequest(candidate.requestId);
  if (!candidate || !request || request.createdBy !== i.actor) throw new FeatureError("NOT_FOUND", "no such candidate");
  if (!request.contract || i.plan.contractHash !== request.contract.hash || candidate.binding.contractHash !== request.contract.hash || candidate.status !== "MATERIALIZED" || request.workspace.candidateHash !== candidate.bindingHash) throw new FeatureError("STALE_REVISION", "validation requires the current contract and candidate");
  const deadline = Date.now() + i.wallMs; const planHash = validationPlanHash(i.plan); const records: EvidenceRecord[] = [];
  const root = makeScratch("pf-validation-base-");
  let baseReady = false; let blockedAt = Number.POSITIVE_INFINITY; // earliest phase index with a mandatory non-pass (issue #82)
  try {
    // Copy/hash operations never execute repository code. Check both roots before any runner call.
    try { copyTreeKeepLinks(request.repositoryId, root); baseReady = contentRoot(entriesFromDirectory(root, { exclude: [] })) === candidate.binding.baseContentHash; } catch { baseReady = false; }
    for (const check of [...i.plan.checks].sort((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase))) {
      const startedAt = new Date().toISOString(); const runId = `run:${randomUUID()}`;
      let status: ValidationStatus = "INCOMPLETE"; let baselineHealth: BaselineHealth = "NOT_RUN";
      let run: RunResult | undefined; let outcomes: CheckOutcome[] = check.expectedTests.map((name) => ({ name, state: "NOT_RUN" }));
      let complete = false; const gaps: string[] = []; const roleRuns: RoleRunRecord[] = [];
      const fresh = d.store.getCandidate(candidate.id); const reqNow = d.store.getRequest(request.requestId)!;
      if (fresh?.status !== "MATERIALIZED" || reqNow.contract?.hash !== candidate.binding.contractHash || reqNow.workspace.candidateHash !== candidate.bindingHash || ["CANCELLED", "FAILED"].includes(reqNow.state)) { status = "STALE"; gaps.push("candidate or contract changed during validation"); }
      else if (!dataAllowed(i.plan)) gaps.push("test data is protected or lacks recorded synthetic/authorized provenance");
      else if (!baseReady) { status = "STALE"; gaps.push("base content no longer matches the candidate binding"); }
      else if (i.signal?.aborted || Date.now() >= deadline) gaps.push(i.signal?.aborted ? "validation cancelled" : "validation budget exhausted");
      else if (check.applicability === "NOT_APPLICABLE") { status = "NOT_APPLICABLE"; gaps.push(check.rationale!); }
      else if (phases.indexOf(check.phase) > blockedAt) { status = "NOT_RUN"; gaps.push("earlier mandatory stage did not pass"); }
      else if (!check.argv && !d.runCheck) gaps.push("validation adapter unavailable");
      else {
        const scratch = makeScratch("pf-validation-check-");
        try {
          const runAt = async (path: string): Promise<RunResult> => {
            if (d.runCheck) { const handled = await d.runCheck(check, path, i.signal); if (handled) return handled; } // undefined: this driver does not own the check, so the default runner does
            const argv = !i.plan.coverageKnown && check.phase === "REGRESSION" ? check.fullSuiteArgv : check.argv;
            if (!argv?.length) return { status: "REFUSED", exitCode: null, stdout: "", stderr: "", truncated: false, isolation: d.runner.isolation, omissions: [...d.runner.omissions], usage: { wallMs: 0 }, reason: "unknown regression coverage requires a full-suite command" };
            return d.runner.run({ cwd: path, argv, capabilities: { commands: [argv], readRoots: [path], writeRoots: [path], network: "DENY", secretRefs: [], limits: { wallMs: Math.max(1, deadline - Date.now()), outputBytes: 1048576, memoryBytes: 536870912, cpuMs: i.wallMs, processes: 32 } } }, i.signal);
          };
          if (check.baseline) {
            copyTreeKeepLinks(root, scratch); const baseline = await runAt(scratch); const capture = captureOutcomes(baseline, check);
            baselineHealth = classifyBaseline(baseline, capture.outcomes, capture.complete); roleRuns.push(role(baseline, capture.outcomes, "BASELINE"));
            rmSync(scratch, { recursive: true, force: true }); mkdirSync(scratch);
          }
          copyTreeKeepLinks(root, scratch);
          applyCandidateToDir(scratch, candidate);
          if (contentRoot(entriesFromDirectory(scratch, { exclude: [] })) !== candidate.binding.candidateContentHash) { status = "STALE"; gaps.push("materialized candidate content does not match binding"); }
          else if (Date.now() >= deadline || i.signal?.aborted) gaps.push("budget exhausted or cancelled after baseline; candidate not run");
          else {
            run = await runAt(scratch); const capture = captureOutcomes(run, check); outcomes = capture.outcomes; complete = capture.complete;
            status = runStatus(run, outcomes, complete); roleRuns.push(role(run, outcomes, check.phase === "BUILD" || check.phase === "STATIC_SECURITY" ? "STATIC_CHECK" : "CANDIDATE_SUITE"));
            if (run.reason) gaps.push(run.reason);
            if (!complete) gaps.push("outcome population is incomplete");
            if (outcomes.some((o) => ["SKIP", "TODO", "FLAKY", "NOT_RUN"].includes(o.state))) gaps.push("skipped, todo, flaky or unexecuted cases remain unvalidated");
          }
        } catch { gaps.push("validation infrastructure failed"); status = "INCOMPLETE"; }
        finally { removeScratch(scratch); }
      }
      const latest = d.store.getCandidate(candidate.id); const current = d.store.getRequest(request.requestId)!;
      if (latest?.status !== "MATERIALIZED" || current.contract?.hash !== candidate.binding.contractHash || current.workspace.candidateHash !== candidate.bindingHash || ["CANCELLED", "FAILED"].includes(current.state)) { status = "STALE"; gaps.push("result became stale before persistence"); }
      if (check.mandatory && !["PASS", "NOT_APPLICABLE"].includes(status)) blockedAt = Math.min(blockedAt, phases.indexOf(check.phase));
      const manifest: RunManifest = { id: runId, contractHash: candidate.binding.contractHash, contentHash: candidate.binding.candidateContentHash,
        buildHash: validationHash("pf.BuildScope", i.plan.targets), harnessHash: planHash, fixtureHash: i.plan.testData.fixtureHash, workloadHash: i.plan.workloadHash,
        environmentHash: i.plan.environment.hash, toolchainHash: i.plan.toolchainHash, oracleHash: candidate.binding.candidateOracleHash,
        outcomesArtifactHash: validationHash("pf.OutcomePopulation", { outcomes, roleRuns, stdoutHash: rawHash(run?.stdout ?? ""), stderrHash: rawHash(run?.stderr ?? "") }),
        generationProvenanceHash: candidate.binding.generationProvenanceHash, modelIdentityHashes: [], startedAt, completedAt: new Date().toISOString(), exitStatus: run?.status ?? status, isolation: run?.isolation ?? d.runner.isolation };
      const results = (check.acceptanceIds.length ? check.acceptanceIds : [undefined]).map((acceptanceId): ValidationResult => {
        const criterion = request.contract!.acceptance.find((a) => a.id === acceptanceId);
        const oracleStatus = status === "PASS" && criterion?.oracleOrigin === "GENERATED_UNREVIEWED" ? "PASS_UNREVIEWED_ORACLE" : status;
        return { id: `result:${randomUUID()}`, checkId: check.id, acceptanceId, kind: check.kind, target: check.target, runManifestId: runId, status: oracleStatus, evidenceIds: [], gaps: [...gaps], baselineHealth, runState: run?.status ?? (i.signal?.aborted ? "CANCELLED" : status), ...(status === "NOT_APPLICABLE" ? { notApplicableRationale: check.rationale } : {}) };
      });
      const record: EvidenceRecord = { schemaVersion: 1, id: `evidence:${randomUUID()}`, requestId: request.requestId, candidateId: candidate.id, bindingHash: candidate.bindingHash, kind: check.kind, manifest, results,
        toolVersions: { node: process.version }, coverage: { state: complete ? "COMPLETE_WITHIN_SCOPE" : "PARTIAL", gaps }, outcomeRef: manifest.outcomesArtifactHash, createdAt: manifest.completedAt!,
        validation: { planHash, checkId: check.id, phase: check.phase, baselineHealth, outcomes, roleRuns, runState: run?.status ?? status, environmentHash: i.plan.environment.hash, fixtureHash: i.plan.testData.fixtureHash, workloadHash: i.plan.workloadHash, isolationOmissions: run?.omissions ?? [...d.runner.omissions], reportComplete: complete } };
      for (const r of results) r.evidenceIds = [record.id];
      d.beforeSave?.();
      d.store.putEvidence(record, { schemaVersion: 1, eventId: randomUUID(), requestId: request.requestId, type: "ValidationCompleted", actor: i.actor, producer: "C27", requirementIds: [], decisionIds: [], after: candidate.bindingHash, result: status === "PASS" ? "OK" : "BLOCKED", rationale: `${check.id}: ${status}`, at: record.createdAt }); records.push(record);
    }
    const current = d.store.getRequest(request.requestId)!;
    d.store.updateRequest(current.requestId, current.version, { ...current, validationPlan: i.plan, workspace: { ...current.workspace, validationSummaryRef: records.at(-1)?.id, workspaceVersion: current.workspace.workspaceVersion + 1 } });
    return records;
  } finally { removeScratch(root); }
}

/** Pure single eligibility authority. The full plan is evaluated even for a subset/rerun of evidence. */
export function computeEligibility(i: { request: FeatureRecord; candidate: CandidateRecord; plan: ValidationPlan; evidence: EvidenceRecord[]; decisions?: DecisionRecord[]; now?: string; purpose?: string; unresolvedFindingIds?: string[]; /** 3.U: model identities behind the generation that have no passing builder evaluation (see builder-eval.ts). */ unevaluatedModels?: string[]; /** Gaps another module computed (declarations whose authority is gone or missing, D001); reported verbatim and never a pass. */ externalGaps?: string[] }): PublicationDecision {
  const { request, candidate: c, plan } = i; const contract = request.contract; const reasons: string[] = []; let blocked = false; let stale = false;
  const block = (s: string) => { reasons.push(s); blocked = true; }; const gap = (s: string) => reasons.push(s);
  try { assertPlan(plan); } catch { block("validation plan is invalid"); }
  if (!contract || contract.hash !== c.binding.contractHash || plan.contractHash !== contract.hash || c.status !== "MATERIALIZED" || request.workspace.candidateHash !== c.bindingHash || c.requestId !== request.requestId) { block("contract/candidate identity is stale"); stale = true; }
  if (["CANCELLED", "FAILED"].includes(request.state)) block(`request is ${request.state}`);
  if (request.blockers.length || i.unresolvedFindingIds?.length) block("unresolved findings or questions");
  if (!dataAllowed(plan)) block("test data lacks authorization or synthetic provenance");
  if (c.oracleState === "PROPERTY_CHANGE_PENDING_REVIEW" || (c.binding.originalOracleHash !== c.binding.candidateOracleHash && !c.binding.propertyChangeReviewId)) block("original oracle changed without property-change review");
  if (c.mutations.some((m) => m.attribution !== "COMPLETE")) gap("mutation attribution is incomplete");
  for (const m of i.unevaluatedModels ?? []) gap(`builder not evaluated: ${m}`);
  for (const g of i.externalGaps ?? []) gap(g);
  if (plan.environment.fidelity !== "REPRESENTATIVE" || plan.environment.dependencies !== "AVAILABLE") gap("environment fidelity or dependencies are incomplete");
  const tier = classifyTier(c.mutations.flatMap((m) => [m.oldPath, m.newPath].filter((p): p is string => !!p).map((path) => ({ path, kind: m.kind })))).tier;
  const mandatoryKinds: ValidationKind[] = tier === "T0" ? ["SECURITY"] : ["BUILD", "UNIT", "SECURITY", "DEPENDENCY", "OPERATIONAL"];
  if (c.mutations.some((m) => /\.(tsx|jsx|html|css)$/.test(m.newPath ?? m.oldPath ?? ""))) mandatoryKinds.push("BROWSER");
  if (plan.performanceApplicable || tier === "T2") mandatoryKinds.push("PERFORMANCE");
  for (const kind of mandatoryKinds) if (!plan.checks.some((ch) => ch.kind === kind && ch.mandatory && ch.applicability === "APPLICABLE")) gap(`mandatory ${kind} gate is missing or inapplicable`);
  if (tier !== "T0") {
    if (!plan.targets.length) gap("no build targets declared");
    for (const target of plan.targets) if (!plan.checks.some((ch) => ch.kind === "BUILD" && ch.target === target && ch.mandatory && ch.applicability === "APPLICABLE")) gap(`build target ${target} is not covered`);
    if (!plan.checks.some((ch) => ch.phase === "REGRESSION" && ch.mandatory && ch.applicability === "APPLICABLE")) gap("affected regression suite missing");
  }
  if (tier === "T2" && (!contract?.releasePlan?.revertRunbook || !contract.releasePlan.stopCriteria)) gap("release/revert plan is incomplete");
  if (tier === "T2" && contract?.releasePlan && !contract.releasePlan.confirmedBy) gap("the release plan is a draft: no principal with release authority has confirmed it");
  const planHash = validationPlanHash(plan);
  for (const criterion of contract?.acceptance.filter((a) => a.mandatory) ?? []) {
    if (!criterion.validationKinds.length) gap(`${criterion.id}: no validation kinds declared`);
    for (const kind of criterion.validationKinds) if (!plan.checks.some((ch) => ch.mandatory && ch.kind === kind && ch.acceptanceIds.includes(criterion.id))) gap(`${criterion.id}: ${kind} is not mapped to a check`);
    if (criterion.oracleOrigin === "GENERATED_UNREVIEWED") gap(`${criterion.id}: generated oracle is unreviewed`);
  }
  const activeWaivers = (i.decisions ?? []).filter((d) => d.kind === "WAIVER" && d.requestId === request.requestId && d.contractVersion === request.contractVersion && !!d.authorityBindingId && !!d.waiver && d.waiver.expiresAt > (i.now ?? new Date().toISOString()) && !(i.decisions ?? []).some((other) => other.supersedesId === d.id));
  for (const check of plan.checks.filter((ch) => ch.mandatory)) {
    const matches = i.evidence.filter((e) => e.requestId === request.requestId && e.candidateId === c.id && e.bindingHash === c.bindingHash && e.validation?.checkId === check.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const e = matches[0];
    if (!e) { gap(`${check.id}: NOT_RUN`); continue; }
    const m = e.manifest;
    if (m.contractHash !== c.binding.contractHash || m.contentHash !== c.binding.candidateContentHash || m.harnessHash !== planHash || m.environmentHash !== plan.environment.hash || m.fixtureHash !== plan.testData.fixtureHash || m.workloadHash !== plan.workloadHash || m.toolchainHash !== plan.toolchainHash || m.oracleHash !== c.binding.candidateOracleHash || m.generationProvenanceHash !== c.binding.generationProvenanceHash || m.buildHash !== validationHash("pf.BuildScope", plan.targets) || !m.completedAt) { gap(`${check.id}: STALE evidence identity`); stale = true; continue; }
    const applicable = check.applicability === "APPLICABLE";
    if (!applicable) { if (!check.rationale?.trim() || e.results.some((r) => r.status !== "NOT_APPLICABLE" || !r.notApplicableRationale)) gap(`${check.id}: inapplicability needs rationale`); continue; }
    if (!e.results.length || check.acceptanceIds.some((id) => !e.results.some((r) => r.acceptanceId === id))) gap(`${check.id}: criterion outcomes missing`);
    if (!e.validation?.reportComplete || e.validation.outcomes.some((o) => o.state !== "PASS")) gap(`${check.id}: outcome population has gaps or non-passes`);
    if (check.baseline && e.validation?.baselineHealth !== "HEALTHY") gap(`${check.id}: baseline ${e.validation?.baselineHealth ?? "UNKNOWN"}; preexisting failures are separate`);
    for (const r of e.results) {
      if (r.runManifestId !== m.id || r.target !== check.target || r.kind !== check.kind) { gap(`${check.id}: result binding mismatch`); continue; }
      if (r.status !== "PASS") {
        const waivers = activeWaivers.filter((d) => d.waiver!.criteria.includes(r.acceptanceId ?? check.id));
        if (r.status === "FAIL" && !waivers.length) block(`${check.id}: FAIL`); else gap(`${check.id}: ${r.status}${waivers.length ? ` (waived by ${waivers.map((d) => d.id).join(", ")}; remains unvalidated)` : ""}`);
      }
    }
  }
  const eligibility: PublicationDecision["eligibility"] = blocked ? "BLOCKED" : reasons.length ? "REVIEW_ONLY_INCOMPLETE" : "VERIFIED_WITHIN_SCOPE";
  const evidenceSetHash = validationHash("pf.EvidenceSet", [...i.evidence].sort((a, b) => a.id.localeCompare(b.id)));
  const payload = { purpose: i.purpose ?? "REVIEW", contractHash: contract?.hash ?? "", patchBindingHash: c.bindingHash, evidenceSetHash,
    authorityScopeHash: validationHash("pf.ValidationAuthority", { policy: contract?.authorityPolicyHash ?? "", waivers: activeWaivers }), manifestHash: planHash,
    status: stale ? "STALE" as const : blocked ? "BLOCK" as const : reasons.length ? "INCOMPLETE" as const : "ALLOW" as const, eligibility, reasons: [...new Set(reasons)] };
  return { ...payload, id: validationHash("pf.PublicationDecision", payload) };
}

/** Default Node/npm plan. Absent specialized adapters remain explicit mandatory gaps. */
export function defaultValidationPlan(request: FeatureRecord, candidate: CandidateRecord): ValidationPlan {
  const files = walkFiles(request.repositoryId, (p) => /(^|\/)package\.json$/.test(p), 10000);
  const targets = files.map((p) => p.replace(/\/?package\.json$/, "") || ".");
  const checks: ValidationCheck[] = [];
  for (const file of files) {
    const target = file.replace(/\/?package\.json$/, "") || "."; let pkg: any = {};
    try { pkg = JSON.parse(readFileSync(safeJoin(request.repositoryId, file), "utf8")); } catch { /* no invented build command */ }
    const argv = (name: string) => pkg.scripts?.[name] ? ["npm", "--prefix", target, "run", name] : undefined;
    checks.push({ id: `build:${target}`, kind: "BUILD", phase: "BUILD", target, acceptanceIds: [], mandatory: true, argv: argv("build"), expectedTests: [], report: "EXIT", applicability: "APPLICABLE", baseline: true });
    checks.push({ id: `tests:${target}`, kind: "UNIT", phase: "REGRESSION", target, acceptanceIds: request.contract?.acceptance.filter((a) => a.validationKinds.includes("UNIT")).map((a) => a.id) ?? [], mandatory: true, argv: argv("test"), fullSuiteArgv: argv("test"), expectedTests: [], report: "NODE_TEST", applicability: "APPLICABLE", baseline: true });
  }
  for (const kind of ["SECURITY", "DEPENDENCY", "OPERATIONAL", "BROWSER", "PERFORMANCE"] as const) checks.push({ id: kind.toLowerCase(), kind, phase: kind === "BROWSER" ? "BROWSER" : kind === "PERFORMANCE" ? "PERFORMANCE" : "STATIC_SECURITY", target: ".", acceptanceIds: [], mandatory: true, expectedTests: [], report: kind === "BROWSER" ? "BROWSER_JSON" : "EXIT", applicability: "APPLICABLE", baseline: false });
  return { schemaVersion: 1, contractHash: candidate.binding.contractHash, targets, checks, coverageKnown: false, environment: { hash: rawHash(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch })), fidelity: "UNKNOWN", configHash: "UNKNOWN", migrationHash: "UNKNOWN", dependencies: "UNKNOWN" }, testData: { kind: "UNKNOWN", fixtureHash: "UNKNOWN", generatorHash: "UNKNOWN", seed: "UNKNOWN" }, workloadHash: "UNKNOWN", toolchainHash: request.source.toolchainHash, performanceApplicable: true };
}
