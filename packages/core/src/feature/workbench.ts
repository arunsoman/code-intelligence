import { randomUUID } from "node:crypto";
import { FeatureTestReportSchema, type FeatureTestReport } from "@cie/schema";
import { readFileSync } from "node:fs";
import { policyFor } from "../access.ts";
import { isTestPath } from "../execution.ts";
import { safeJoin } from "../isolated-exec.ts";
import type { Store } from "../store.ts";
import { materializeCandidate, refreshStaleness, type FeatureEdit } from "./candidate.ts";
import { rawHash, parseStrictJson } from "./canon.ts";
import { FeatureError } from "./errors.ts";
import { toFeatureEdits } from "./generate.ts";
import { passesThroughLink } from "./tree.ts";
import { snapshotOf } from "./intake.ts";
import { transition } from "./lifecycle.ts";
import type { ContextArtifact, PlannedEdit } from "./model.ts";
import { contextFor, validationPlanFor } from "./pipeline.ts";
import { applyDeclarations } from "./declarations.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { AuthorityConfig } from "./authority.ts";
import type { CandidateRecord, EvidenceRecord, FeatureRecord, Runner } from "./types.ts";
import { defaultValidationPlan, runFeatureValidation, validationPlanHash } from "./validation.ts";

export type ImportedTestReport = { id: string; importedAt: string; report: FeatureTestReport; trust: "EXTERNAL_UNVERIFIED" };
export type BuildRun = {
  id: string; jobId: string; contractHash: string; baseRevision: string; sourceCandidateHash?: string; reportId?: string;
  phase: "GENERATING" | "VALIDATING" | "REPAIRING" | "FINISHED" | "STOPPED";
  maxRepairs: number; repairs: number; candidateHash?: string; evidenceIds: string[]; detail: string; startedAt: string; updatedAt: string;
};
export type WorkbenchState = { reports: ImportedTestReport[]; runs: BuildRun[] };
const empty = (): WorkbenchState => ({ reports: [], runs: [] });
export function importTestReport(fs: SqliteFeatureStore, request: FeatureRecord, input: unknown): ImportedTestReport {
  if (Buffer.byteLength(JSON.stringify(input) ?? "") > 64000) throw new FeatureError("RESOURCE_LIMIT", "Report must be at most 64 KB");
  const parsed = FeatureTestReportSchema.safeParse(input);
  if (!parsed.success) throw new FeatureError("INVALID_SCHEMA", parsed.error.issues[0]?.message ?? "Invalid test report");
  const report = parsed.data;
  const candidate = fs.getCandidateByBinding(report.candidateHash);
  if (report.requestId !== request.requestId || candidate?.requestId !== request.requestId) throw new FeatureError("NOT_FOUND", "Report does not belong to this request and candidate");
  if (candidate.status !== "MATERIALIZED" || request.workspace.candidateHash !== report.candidateHash || candidate.binding.contractHash !== request.contract?.hash || candidate.binding.baseCommitHash !== report.baseRevision) throw new FeatureError("STALE_REVISION", "Report must name the current candidate and its exact base revision");
  const state = request.workbench ?? empty();
  const id = `local-report:${rawHash(JSON.stringify(report))}`;
  const existing = state.reports.find((r) => r.id === id); if (existing) return existing;
  if (state.reports.length >= 16) throw new FeatureError("RESOURCE_LIMIT", "This request already has 16 imported reports; start a new request");
  const saved: ImportedTestReport = { id, report, importedAt: new Date().toISOString(), trust: "EXTERNAL_UNVERIFIED" };
  fs.updateRequest(request.requestId, request.version, { ...request, workbench: { ...state, reports: [...state.reports, saved] } });
  return saved;
}

/** Repairs are proposed against candidate bytes, but every exported patch remains cumulative against the ORIGINAL base. */
export function cumulativeEdits(candidate: CandidateRecord, edits: FeatureEdit[], context: ContextArtifact[]): FeatureEdit[] {
  if (Object.entries(candidate.entries ?? {}).some(([p, e]) => e && (e.kind !== "TEXT" || e.mode !== (candidate.baseEntries?.[p]?.mode ?? "100644"))) || Object.values(candidate.baseEntries ?? {}).some((e) => e && e.kind !== "TEXT")) throw new FeatureError("BLOCKED", "Automatic repair currently supports text candidates without binary, symlink or mode changes");
  const contents = { ...candidate.contents }; const base = { ...candidate.baseContents };
  const metadata = new Map(candidate.mutations.map((m) => [m.newPath ?? m.oldPath!, m.requirementIds]));
  const groups = new Map<string, FeatureEdit[]>();
  for (const e of edits) {
    if (!(e.op === "CREATE_FILE" || e.op === "DELETE_FILE" || e.op === "REPLACE_SPAN")) throw new FeatureError("BLOCKED", "Repair supports exact text edits only");
    if (isTestPath(e.file)) throw new FeatureError("BLOCKED", "Automatic repair cannot change tests, including tests added by the candidate. Review expected behavior separately.");
    groups.set(e.file, [...(groups.get(e.file) ?? []), e]);
    metadata.set(e.file, [...new Set([...(metadata.get(e.file) ?? []), ...(e.requirementIds ?? [])])]);
  }
  for (const [path, group] of groups) {
    const text = Object.hasOwn(contents, path) ? contents[path] : context.find((c) => c.ref.locator === path)?.text;
    if (!Object.hasOwn(base, path)) base[path] = text ?? null;
    if (group.length === 1 && group[0].op === "CREATE_FILE") {
      if (text != null) throw new FeatureError("STALE_REVISION", "Repair creates an existing file");
      contents[path] = group[0].content; continue;
    }
    if (typeof text !== "string") throw new FeatureError("BLOCKED", "Repair target was not supplied in context");
    const bytes = Buffer.from(text);
    for (const e of group) if ((e.op !== "REPLACE_SPAN" && e.op !== "DELETE_FILE") || e.baseHash !== rawHash(bytes)) throw new FeatureError("STALE_REVISION", "Repair target bytes changed");
    if (group.some((e) => e.op === "DELETE_FILE")) {
      if (group.length !== 1) throw new FeatureError("INVALID_SCHEMA", "Deletion cannot overlap another edit");
      contents[path] = null; continue;
    }
    const spans = group.filter((e) => e.op === "REPLACE_SPAN").sort((a, b) => b.start - a.start);
    let result = bytes, boundary = bytes.length;
    for (const e of spans) {
      if (e.start < 0 || e.end > boundary || e.end < e.start || bytes.subarray(e.start, e.end).toString("utf8") !== e.expected) throw new FeatureError("INVALID_SCHEMA", "Repair contains overlapping or mismatched spans");
      result = Buffer.concat([result.subarray(0, e.start), Buffer.from(e.newText), result.subarray(e.end)]); boundary = e.start;
    }
    contents[path] = result.toString("utf8");
  }
  return Object.keys(contents).sort().flatMap((file): FeatureEdit[] => {
    const before = base[file], after = contents[file], common = { file, why: "Cumulative feature candidate with tests preserved", requirementIds: metadata.get(file) ?? [] };
    if (before === after) return [];
    if (before == null && after != null) return [{ ...common, op: "CREATE_FILE", content: after }];
    if (before != null && after == null) return [{ ...common, op: "DELETE_FILE", baseHash: rawHash(before) }];
    return [{ ...common, op: "REPLACE_SPAN", baseHash: rawHash(before!), start: 0, end: Buffer.byteLength(before!), expected: before!, newText: after! }];
  });
}

export type BuildDeps = {
  fs: SqliteFeatureStore; store: Store; auth: AuthorityConfig; runner: Runner;
  propose: (input: { context: ContextArtifact[]; actor: string; feedback?: unknown; signal?: AbortSignal }) => Promise<{ edits: PlannedEdit[]; invocationIds: string[] }>;
  runCheckFor?: (candidate: CandidateRecord, request: FeatureRecord) => Parameters<typeof runFeatureValidation>[0]["runCheck"];
  checkpoint: () => void; progress: (phase: string, message: string) => void;
};
export async function buildAndRepair(d: BuildDeps, actor: string, input: { requestId: string; jobId: string; candidateHash?: string; reportId?: string; maxRepairs: number; wallMs: number; syntheticTestData?: boolean; signal?: AbortSignal }): Promise<BuildRun> {
  if (!Number.isSafeInteger(input.maxRepairs) || input.maxRepairs < 0 || input.maxRepairs > 3 || !Number.isSafeInteger(input.wallMs) || input.wallMs < 1000 || input.wallMs > 1800000) throw new FeatureError("INVALID_SCHEMA", "Invalid build budget");
  const req = () => { const r = d.fs.getRequest(input.requestId); if (!r || r.createdBy !== actor) throw new FeatureError("NOT_FOUND", "No such feature request"); return r; };
  let rec = req();
  if (!rec.contract || rec.mode === "PLAN" || rec.blockers.length) throw new FeatureError("BLOCKED", "Agree the requirements and resolve open questions before building");
  const initialHash = rec.contract.hash;
  refreshStaleness({ fs: d.fs, store: d.store, auth: d.auth }, actor, rec.requestId);
  rec = req();
  let candidate = input.candidateHash ? d.fs.getCandidateByBinding(input.candidateHash) ?? undefined : undefined;
  if (input.candidateHash && (!candidate || candidate.requestId !== rec.requestId || candidate.status !== "MATERIALIZED" || rec.workspace.candidateHash !== candidate.bindingHash)) throw new FeatureError("STALE_REVISION", "Repair must start from the current candidate");
  if (!input.candidateHash && rec.workspace.candidateHash) throw new FeatureError("STALE_REVISION", "A candidate already exists; repair it instead");
  const report = input.reportId ? rec.workbench?.reports.find((r) => r.id === input.reportId) : undefined;
  if (input.reportId && (!report || report.report.candidateHash !== candidate?.bindingHash || report.report.exitCode === 0)) throw new FeatureError("STALE_REVISION", "Select a failing report for the current candidate");
  if ((rec.workbench?.runs.length ?? 0) >= 32) throw new FeatureError("RESOURCE_LIMIT", "This request reached its 32-run limit");
  let run: BuildRun = { id: `build:${randomUUID()}`, jobId: input.jobId, contractHash: initialHash, baseRevision: rec.source.commitHash, sourceCandidateHash: candidate?.bindingHash, reportId: input.reportId,
    phase: "GENERATING", maxRepairs: input.maxRepairs, repairs: 0, candidateHash: candidate?.bindingHash, evidenceIds: [], detail: "Preparing the agreed feature", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const save = (phase: BuildRun["phase"], detail: string) => {
    d.checkpoint(); input.signal?.throwIfAborted(); const r = req();
    if (r.contract?.hash !== initialHash || ["CANCELLED", "FAILED"].includes(r.state)) throw new FeatureError("STALE_REVISION", "The request changed during the build");
    run = { ...run, phase, detail, updatedAt: new Date().toISOString() };
    const state = r.workbench ?? empty();
    d.fs.updateRequest(r.requestId, r.version, { ...r, workbench: { ...state, runs: [...state.runs.filter((v) => v.id !== run.id), run] } });
    d.progress(phase.toLowerCase(), detail);
  };
  const deadline = Date.now() + input.wallMs;
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(input.wallMs)]) : AbortSignal.timeout(input.wallMs);
  const context = () => {
    const r = req(), policy = policyFor(d.store, r.repositoryId);
    if (candidate && Object.keys(candidate.contents ?? {}).some((p) => policy.denied(p))) throw new FeatureError("FORBIDDEN", "Candidate access changed");
    const paths = [...new Set([...Object.keys(candidate?.contents ?? {}), ...contextFor(r, 12, 24000, d.store).map((c) => c.ref.locator)])];
    const out: ContextArtifact[] = []; let bytes = 0;
    for (const path of paths) {
      if (policy.denied(path) || passesThroughLink(r.repositoryId, path)) continue;
      let text: string | null | undefined;
      if (candidate && Object.hasOwn(candidate.contents ?? {}, path)) text = candidate.contents![path];
      else { try { text = readFileSync(safeJoin(r.repositoryId, path), "utf8"); } catch { continue; } }
      if (text == null || Buffer.byteLength(text) > 24000 || bytes + Buffer.byteLength(text) > 40000 || out.length >= 16) continue;
      bytes += Buffer.byteLength(text); out.push({ ref: { artifactId: `file:${path}`, locator: path, version: "1", contentHash: rawHash(text) }, text });
    }
    return out;
  };
  const generate = async (feedback?: unknown) => {
    signal.throwIfAborted(); const before = req().workspace.candidateHash; const ctx = context();
    const proposed = await d.propose({ context: ctx, actor, feedback, signal });
    d.checkpoint(); signal.throwIfAborted();
    if (req().workspace.candidateHash !== before || req().contract?.hash !== initialHash) throw new FeatureError("STALE_REVISION", "Candidate changed while generation was running");
    const edits = toFeatureEdits(proposed.edits, ctx);
    if (!edits.length) throw new FeatureError("BLOCKED", "The model proposed no changes; inspect the plan or failure details");
    const all = candidate ? cumulativeEdits(candidate, edits, ctx) : edits;
    candidate = materializeCandidate({ fs: d.fs, store: d.store, auth: d.auth }, actor, { requestId: rec.requestId, snapshot: snapshotOf(d.store, rec.repositoryId), edits: all, invocationIds: [...(candidate?.invocationIds ?? []), ...proposed.invocationIds], idempotencyKey: `${run.id}:${run.repairs}` }).candidate;
    run.candidateHash = candidate.bindingHash;
  };
  try {
    save("GENERATING", candidate ? "Preparing candidate repair" : "Building the agreed feature");
    if (!candidate) await generate();
    let feedback: unknown = report ? { provenance: "EXTERNAL_UNVERIFIED", report: { ...report.report, failures: report.report.failures.slice(0, 10).map((f) => ({ name: f.name, message: f.message.slice(0, 800) })), output: report.report.output.slice(0, 4000) }, omittedFailures: Math.max(0, report.report.failures.length - 10) } : undefined;
    if (feedback && run.maxRepairs > 0) { run.repairs++; save("REPAIRING", `Repair ${run.repairs}/${run.maxRepairs}: imported local failures`); await generate(feedback); }
    for (;;) {
      signal.throwIfAborted(); save("VALIDATING", "Running required baseline and candidate checks");
      const current = req();
      if (current.state === "IMPLEMENTING") transition(d.fs, current.requestId, current.version, "VALIDATING", actor, "Build wizard validation");
      const currentPlan = req().validationPlan;
      let plan = currentPlan?.contractHash === candidate!.binding.contractHash ? currentPlan : defaultValidationPlan(req(), candidate!);
      if (input.syntheticTestData) {
        const declared = applyDeclarations(d.fs, d.auth, actor, rec.requestId, { testData: { kind: "SYNTHETIC" } }, "User confirmed that the feature checks use synthetic test fixtures in the wizard");
        plan = { ...plan, testData: validationPlanFor(req(), candidate!, declared.effective).testData };
      }
      const evidence = await runFeatureValidation({ store: d.fs, runner: d.runner, runCheck: d.runCheckFor?.(candidate!, req()), beforeSave: d.checkpoint }, { candidateId: candidate!.id, plan, actor, wallMs: Math.max(1, deadline - Date.now()), signal });
      run.evidenceIds = evidence.map((e) => e.id);
      const failures = evidence.filter((e) => e.results.some((r) => r.status === "FAIL"));
      if (!failures.length) {
        const incomplete = evidence.some((e) => e.results.some((r) => !["PASS", "PASS_UNREVIEWED_ORACLE", "NOT_APPLICABLE"].includes(r.status)));
        save("FINISHED", incomplete ? "Checks are incomplete or blocked. Inspect Tests before delivery." : "Checks passed. Delivery still evaluates coverage, expected outcomes and required approvals."); return run;
      }
      // Infrastructure and pre-existing baseline failures need environment/behavior decisions, not speculative edits.
      if (failures.some((e) => e.validation?.baselineHealth !== "HEALTHY" || !["BUILD", "TYPECHECK", "UNIT", "INTEGRATION"].includes(e.kind))) { save("STOPPED", "Failures require baseline, environment or policy review; automatic repair stopped"); return run; }
      if (run.repairs >= run.maxRepairs) { save("STOPPED", `Repair budget exhausted (${run.maxRepairs}). The remaining failures are available in Tests.`); return run; }
      feedback = failures.slice(0, 8).map((e) => ({ check: e.validation?.checkId, kind: e.kind, results: e.results.slice(0, 8), outcomes: e.validation?.outcomes.slice(0, 16), output: e.validation?.diagnosticOutput?.slice(0, 1500) }));
      run.repairs++; save("REPAIRING", `Repair ${run.repairs}/${run.maxRepairs}: candidate checks failed`); await generate(feedback);
    }
  } catch (error) {
    // Keep the last persisted checkpoint on cancellation/lost ownership. Resume starts a fresh bounded run from that exact candidate.
    if (!signal.aborted) { try { save("STOPPED", (error as Error).message); } catch { /* another owner or changed contract */ } }
    throw error;
  }
}

export function validationReport(fs: SqliteFeatureStore, request: FeatureRecord, candidate: CandidateRecord) {
  const plan = request.validationPlan ?? defaultValidationPlan(request, candidate);
  const hash = validationPlanHash(plan);
  return { format: "feature-validation-report.v1", requestId: request.requestId, candidateHash: candidate.bindingHash, baseRevision: candidate.binding.baseCommitHash,
    diffHash: candidate.binding.diffHash, exports: (candidate.exports ?? []).map((e) => ({ id: e.id, format: e.format, patchArtifactHash: e.patchArtifactHash, eligibility: e.eligibility, label: e.label })),
    candidateContentHash: candidate.binding.candidateContentHash, patchBasis: "REPLACEMENT_AGAINST_ORIGINAL_BASE", validationPlanHash: hash,
    checks: fs.listEvidence(candidate.id).filter((e) => !e.verdict).map((e: EvidenceRecord) => ({ id: e.id, kind: e.kind, current: e.manifest.harnessHash === hash && candidate.status === "MATERIALIZED" && request.workspace.candidateHash === candidate.bindingHash && request.contract?.hash === e.manifest.contractHash,
      manifest: e.manifest, toolVersions: e.toolVersions, results: e.results, validation: e.validation })),
    commands: plan.checks.map((c) => ({ id: c.id, argv: c.argv, baseline: c.baseline, applicability: c.applicability })),
    importedReports: (request.workbench?.reports ?? []).filter((r) => r.report.candidateHash === candidate.bindingHash).map((r) => ({ id: r.id, trust: r.trust })),
    limitation: "Passing recorded checks is not a guarantee that the feature is bug-free. Imported reports never satisfy validation gates." };
}
export function parseReportText(text: string): unknown { return parseStrictJson(text); }
