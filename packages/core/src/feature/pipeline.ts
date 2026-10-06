// Wave 4 — the pipeline driver (plan 4.1). Until now each step existed on its own; this runs them in order, moves the request through its
// states, stops at the first thing a person must decide, and records every step so a result can be audited.
//
//   submit → discover → normalise → (constraints, conflicts) → clarify → overlap → impact → plan → [generate edits] → candidate
//          → validate (plan, runner, gates) → eligibility → export patch → [publish draft PR]
//
// Rules this file enforces, none of them new:
//   * The driver never answers a question for a person. An open question stops it (NEEDS_ANSWER) unless the caller supplied that answer.
//   * Anything the eligibility function does not allow is not called verified. The driver reports the function's own word.
//   * A step that throws FeatureError stops the run with that message (BLOCKED); anything else is a bug and propagates.
//   * Generation is a hook: this module runs scripted generators in tests and the model adapter in production (adapterEdits below).
import { readFileSync } from "node:fs";
import { safeJoin, walkFiles } from "../isolated-exec.ts";
import { loadFeatureConfig } from "./config.ts";
import { authorize, type AuthorityConfig } from "./authority.ts";
import { rawHash } from "./canon.ts";
import { materializeCandidate, type CandidateScope, type FeatureEdit } from "./candidate.ts";
import { confirmAcceptance } from "./acceptance.ts";
import { assessFeatureImpact, planClarifications } from "./clarify.ts";
import { checkRequirementConstraints, detectSemanticConflicts, type FindingProposer } from "./conflicts.ts";
import { contractHashOf, recordDecision, reviseContract } from "./decisions.ts";
import { FeatureError } from "./errors.ts";
import type { RunCheck } from "./gates.ts";
import { toFeatureEdits } from "./generate.ts";
import { discoverFeatureContext, submitFeature, snapshotOf } from "./intake.ts";
import { transition } from "./lifecycle.ts";
import type { ContextArtifact, FeatureModelAdapter } from "./model.ts";
import { alreadySupported, compareRequestedBehaviour, findRelatedCapabilities, overlapPolicyHash, verifyOverlap } from "./overlap.ts";
import { exportFeaturePatch, EXPORT_FORMATS, exportPolicyHash } from "./patch-export.ts";
import { planFeatureChange, planReuseChange } from "./plan.ts";
import { publishFeaturePR, type PublishDeps } from "./publish.ts";
import { normalizeRequirements } from "./requirements.ts";
import type { SqliteFeatureStore } from "./store.ts";
import type { Store } from "../store.ts";
import type { CandidateRecord, DecisionRecord, FeatureRecord, Id, OutcomeMode, PublicationDecision, PublicationReceipt, QuestionBatch, Runner } from "./types.ts";
import { computeEligibility, defaultValidationPlan, runFeatureValidation, type ValidationPlan } from "./validation.ts";

export type StepName = "SUBMIT" | "DISCOVER" | "NORMALISE" | "CONSTRAINTS" | "CLARIFY" | "CONFIRM" | "OVERLAP" | "PLAN" | "GENERATE" | "CANDIDATE" | "VALIDATE" | "DECIDE" | "EXPORT" | "PUBLISH";
export type StepStatus = "DONE" | "PARTIAL" | "SKIPPED" | "STOPPED";
export type PipelineStep = { step: StepName; status: StepStatus; detail: string };
export type PipelineStop = "COMPLETE" | "NEEDS_ANSWER" | "ALREADY_SUPPORTED" | "PLAN_ONLY" | "BLOCKED" | "FAILED";

/** What a person (or a configuration file) declares about where validation ran. The driver never upgrades these. */
export interface ValidationDeclaration {
  /** "REPRESENTATIVE" only when whoever runs this states the runner's environment matches how the code runs. Default: PARTIAL. */
  fidelity?: "REPRESENTATIVE" | "PARTIAL" | "UNKNOWN"; dependencies?: "AVAILABLE" | "MISSING" | "UNKNOWN";
  environmentLabel?: string; testData?: { kind: "SYNTHETIC" | "AUTHORIZED_REDACTED"; authorizationRef?: string };
  performanceApplicable?: boolean; wallMs?: number;
}

export interface PipelineDeps {
  fs: SqliteFeatureStore; store: Store; auth: AuthorityConfig; runner: Runner;
  /** Production: `adapterEdits`. Tests: a scripted generator. Returns the edits and the model invocations they came from. */
  generateEdits: (i: { request: FeatureRecord; context: ContextArtifact[] }) => Promise<{ edits: FeatureEdit[]; invocationIds: string[] }>;
  adapter?: (requestId: Id) => FeatureModelAdapter; proposer?: (requestId: Id, actor: Id) => FindingProposer | undefined;
  /** Gate drivers (security, dependency, operational, browser, performance) for the validation run; see gateDriverFor. */
  runCheck?: (candidate: CandidateRecord, request: FeatureRecord) => RunCheck | undefined;
  publish?: Omit<PublishDeps, "fs" | "store">;
  /** Cancellation, a hook run just before the first external write (a job passes its commit point here), and a progress callback. */
  signal?: AbortSignal; beforePublish?: () => void; onStep?: (s: PipelineStep) => void;
}
export interface PipelineInput {
  repositoryId: Id; text: string; mode: OutcomeMode; idempotencyKey: string;
  /** Answers by question id, applied in order. An answer for a question the contract does not have is ignored and reported. */
  answers?: Record<string, string>; scope?: CandidateScope; releasePlan?: FeatureRecord["contract"] extends infer C ? C extends { releasePlan?: infer R } ? R : never : never;
  /** A person confirms the generated expected outcomes (all, or the named criteria); without this the oracle stays unreviewed and nothing can be verified. */
  confirm?: { criteria: "ALL" | string[]; rationale: string }; validation?: ValidationDeclaration; exportFormat?: (typeof EXPORT_FORMATS)[number] | null; publishTo?: string; budget?: { files?: number; tokens?: number };
}
export interface PipelineResult {
  requestId: Id; stop: PipelineStop; reason: string; steps: PipelineStep[]; questions?: QuestionBatch["questions"];
  candidate?: CandidateRecord; decision?: PublicationDecision; exportId?: Id; publication?: PublicationReceipt; unusedAnswers?: string[];
}

const SRC = /\.[cm]?[jt]sx?$/;
/** Files the generator is shown: planned edit targets that exist, then files the discovery matched to the request, capped. */
export function contextFor(request: FeatureRecord, max = 12, maxBytes = 24_000): ContextArtifact[] {
  const want = new Set<string>(request.tasks.flatMap((t) => t.plannedEdits));
  for (const e of request.assessment?.relatedEntities ?? []) want.add(e.file);
  const out: ContextArtifact[] = [];
  const present = new Set(walkFiles(request.repositoryId, (p) => SRC.test(p), 5000));
  for (const rel of [...want].filter((p) => present.has(p)).sort().slice(0, max)) {
    let text: string; try { text = readFileSync(safeJoin(request.repositoryId, rel)).subarray(0, maxBytes).toString("utf8"); } catch { continue; }
    out.push({ ref: { artifactId: `file:${rel}`, version: "1", locator: rel, contentHash: rawHash(readFileSync(safeJoin(request.repositoryId, rel))) }, text });
  }
  return out;
}

/** Production generator: the model adapter's full pipeline (requirements, contract, edit plan), then exact edits from what it quoted. */
export function adapterEdits(d: Pick<PipelineDeps, "fs" | "adapter" | "auth">, actor: Id, authorityPolicyHash: string): PipelineDeps["generateEdits"] {
  return async ({ request, context }) => {
    const cfg = loadFeatureConfig(request.repositoryId);
    const { FeatureModelAdapter } = await import("./model.ts");
    const adapter = d.adapter?.(request.requestId) ?? new FeatureModelAdapter(d.fs, request.requestId, { egress: cfg.egress });
    const gen = await adapter.generate({ prompt: request.promptRef.text ?? "", context, authorityPolicyHash, actor });
    if (gen.status !== "COMPLETE" || !gen.value) throw new FeatureError("PROVIDER_UNAVAILABLE", `generation did not complete: ${gen.diagnostics[0] ?? gen.status}`);
    return { edits: toFeatureEdits(gen.value.edits, context), invocationIds: gen.value.invocationIds };
  };
}

/** The plan the driver validates with: the repository's own build/test scripts, the declared environment, honest defaults for the rest. */
export function validationPlanFor(request: FeatureRecord, candidate: CandidateRecord, decl: ValidationDeclaration = {}): ValidationPlan {
  const base = defaultValidationPlan(request, candidate);
  const env = { ...base.environment, hash: rawHash(JSON.stringify({ label: decl.environmentLabel ?? "unlabelled", fidelity: decl.fidelity ?? "PARTIAL" })), fidelity: decl.fidelity ?? "PARTIAL", dependencies: decl.dependencies ?? "UNKNOWN" };
  const testData = decl.testData ? { kind: decl.testData.kind, fixtureHash: rawHash(JSON.stringify(Object.keys(candidate.contents ?? {}).sort())), generatorHash: rawHash("inline-in-tests"), seed: "none", ...(decl.testData.authorizationRef ? { authorizationRef: decl.testData.authorizationRef } : {}) } : base.testData;
  const touchesUi = candidate.mutations.some((m) => /\.(tsx|jsx|html|css)$/.test(m.newPath ?? m.oldPath ?? ""));
  const perfApplicable = decl.performanceApplicable ?? base.performanceApplicable;
  const checks = base.checks.map((c) => c.kind === "BROWSER" && !touchesUi ? { ...c, applicability: "NOT_APPLICABLE" as const, rationale: "the change touches no UI file (tsx, jsx, html, css)" }
    : c.kind === "PERFORMANCE" && !perfApplicable ? { ...c, applicability: "NOT_APPLICABLE" as const, rationale: `declared not performance-applicable by the caller (${decl.environmentLabel ?? "no label"}); the change was not measured` } : c);
  return { ...base, checks, environment: env, testData, performanceApplicable: perfApplicable, toolchainHash: rawHash(decl.environmentLabel ?? process.version) };
}

type Draft = { steps: PipelineStep[]; onStep?: (s: PipelineStep) => void };
const add = (d: Draft, step: StepName, status: StepStatus, detail: string) => { const s = { step, status, detail }; d.steps.push(s); d.onStep?.(s); };

export async function runFeaturePipeline(d: PipelineDeps, actor: Id, i: PipelineInput): Promise<PipelineResult> {
  const t: Draft = { steps: [], onStep: d.onStep }; let requestId: Id = "";
  const finish = (stop: PipelineStop, reason: string, extra: Partial<PipelineResult> = {}): PipelineResult => ({ requestId, stop, reason, steps: t.steps, ...extra });
  const intake = { fs: d.fs, store: d.store, config: loadFeatureConfig };
  const od = { fs: d.fs, store: d.store };
  const req = (): FeatureRecord => d.fs.getRequest(requestId)!;
  const hash = (): string => req().contract!.hash;
  try {
    // ---- submit and discover
    const sub = submitFeature(intake, actor, { inputRefs: [], text: i.text, repositoryId: i.repositoryId, mode: i.mode, idempotencyKey: i.idempotencyKey, budget: undefined });
    requestId = sub.requestId; add(t, "SUBMIT", "DONE", `${sub.replayed ? "replayed " : ""}request ${requestId} in ${sub.mode} mode${sub.warnings?.length ? `; ${sub.warnings[0]}` : ""}`);
    const rec0 = req();
    if (rec0.state === "RECEIVED" || rec0.state === "DISCOVERING" || !rec0.assessment) {
      const disc = discoverFeatureContext(intake, actor, { requestId, snapshot: rec0.source, retrievalBudget: { tokens: i.budget?.tokens ?? 20_000, files: i.budget?.files ?? 2000 } });
      add(t, "DISCOVER", disc.status === "FAILED" ? "STOPPED" : disc.status === "COMPLETE" ? "DONE" : "PARTIAL", disc.status === "COMPLETE" ? "repository assessed" : disc.diagnostics.slice(0, 2).join("; ") || disc.status);
      if (disc.status === "FAILED" || disc.status === "STALE") return finish("FAILED", `discovery ${disc.status.toLowerCase()}: ${disc.diagnostics[0] ?? ""}`);
    } else add(t, "DISCOVER", "SKIPPED", "already discovered");
    if (req().blockers.some((b) => b.id === "dep:unsupported-stack")) return finish("BLOCKED", req().blockers.find((b) => b.id === "dep:unsupported-stack")!.text);

    // ---- normalise requirements (needs the model); a repeated run reuses the contract it already has
    if (!req().contract) {
      const norm = await normalizeRequirements({ fs: d.fs, store: d.store, adapter: d.adapter }, actor, { requestId, sourceRefs: [], assessmentId: req().assessment!.id, signal: d.signal });
      add(t, "NORMALISE", norm.status === "COMPLETE" ? "DONE" : "STOPPED", norm.status === "COMPLETE" ? `${norm.value!.contract.requirements.length} requirement(s), ${norm.value!.contract.acceptance.length} criteria` : norm.diagnostics.slice(0, 2).join("; "));
      if (norm.status !== "COMPLETE") return finish("FAILED", `requirements were not produced: ${norm.diagnostics[0] ?? norm.status}`);
    } else add(t, "NORMALISE", "SKIPPED", "a contract already exists");

    // ---- deterministic constraints and conflicts
    const cdeps = { fs: d.fs, repoRoot: (r: FeatureRecord) => r.repositoryId, proposer: d.proposer?.(requestId, actor) };
    const cons = await checkRequirementConstraints(cdeps, actor, { contractHash: hash(), policyHashes: [], invariantIds: [] });
    const conf = await detectSemanticConflicts(cdeps, actor, { contractHash: hash(), relatedSourceRefs: [] });
    add(t, "CONSTRAINTS", "DONE", `${cons.value?.length ?? 0} constraint finding(s), ${conf.value?.length ?? 0} conflict finding(s)`);

    // ---- clarify: apply the caller's answers, stop on the first question nobody answered
    const unused = new Set(Object.keys(i.answers ?? {}));
    for (let round = 0; round < 6; round++) {
      const open = req().blockers.filter((b) => b.kind === "QUESTION" || b.kind === "FINDING");
      if (!open.length) break;
      const batch = planClarifications(d.fs, actor, { contractHash: hash(), findingIds: [], obligationIds: [] }).value!;
      const mine = batch.questions.filter((q) => i.answers && q.id in i.answers);
      if (!mine.length) {
        const qs = batch.questions;
        add(t, "CLARIFY", "STOPPED", `${open.length} open item(s); ${qs.length} question(s) need an answer`);
        return finish("NEEDS_ANSWER", qs.length ? `${qs.length} question(s) need an answer before work continues` : `${open.length} open item(s) block the request`, { questions: qs, unusedAnswers: [...unused] });
      }
      const ids: Id[] = [];
      for (const q of mine) {
        unused.delete(q.id);
        const rec = req(); const kind = q.scope && q.scope !== "business" ? authorize(d.auth, actor, q.scope as never, rec.createdBy) : { allowed: true as const, reason: "" };
        if (!kind.allowed) { add(t, "CLARIFY", "STOPPED", `${q.id} needs ${q.scope} authority: ${kind.reason}`); return finish("NEEDS_ANSWER", `${q.id} needs ${q.scope} authority that ${actor} does not have`, { questions: [q], unusedAnswers: [...unused] }); }
        const dec: DecisionRecord = recordDecision(d.fs, d.auth, actor, { requestId, expectedContractVersion: rec.contractVersion, questionId: q.id, answer: i.answers![q.id]!, idempotencyKey: `pipeline:${requestId}:${q.id}` });
        ids.push(dec.id);
      }
      reviseContract(d.fs, d.auth, actor, { requestId, expectedVersion: req().contractVersion, decisionIds: ids });
      add(t, "CLARIFY", "DONE", `recorded ${ids.length} answer(s); contract revised`);
    }
    if (req().blockers.length) return finish("NEEDS_ANSWER", `${req().blockers.length} item(s) still open`, { unusedAnswers: [...unused] });
    if (!t.steps.some((s) => s.step === "CLARIFY")) add(t, "CLARIFY", "SKIPPED", "nothing to ask");

    // ---- a person confirms the expected outcomes (the only way a generated oracle becomes a reviewed one)
    if (i.confirm) {
      const all = req().contract!.acceptance, want = i.confirm.criteria === "ALL" ? all.map((a) => a.id) : i.confirm.criteria;
      const todo = want.filter((id) => all.find((a) => a.id === id)?.oracleOrigin === "GENERATED_UNREVIEWED");
      if (todo.length) { confirmAcceptance(d.fs, d.auth, actor, { requestId, expectedVersion: req().contractVersion, criteria: todo.map((id) => ({ id })), rationale: i.confirm.rationale, idempotencyKey: `pipeline:${requestId}:confirm` }); add(t, "CONFIRM", "DONE", `${todo.length} expected outcome(s) confirmed by ${actor}`); }
      else add(t, "CONFIRM", "SKIPPED", "nothing left to confirm");
    } else if (req().contract!.acceptance.some((a) => a.oracleOrigin === "GENERATED_UNREVIEWED")) add(t, "CONFIRM", "SKIPPED", `${req().contract!.acceptance.filter((a) => a.oracleOrigin === "GENERATED_UNREVIEWED").length} expected outcome(s) stay unreviewed, so the result can be at most review-only`);

    // ---- overlap: does the repository already do this?
    const rel = findRelatedCapabilities(od, actor, { contractHash: hash(), snapshot: req().source, scope: "", budget: { files: 300 } });
    const cmp = compareRequestedBehaviour(od, actor, { contractHash: hash(), capabilityRefs: rel.value?.capabilities ?? [], evidenceIds: [] });
    const ver = verifyOverlap(od, actor, { assessmentId: cmp.value!.id, policyHash: overlapPolicyHash(), evidenceIds: [] });
    add(t, "OVERLAP", "DONE", `${cmp.value!.relationship}; strategy ${cmp.value!.strategy}; ${ver.value?.verified ? "verified" : "not verified"}`);
    if (alreadySupported(req())) {
      const reuse = planReuseChange(od, actor, { contractHash: hash(), verifiedAssessmentId: cmp.value!.id, capabilities: [] });
      add(t, "PLAN", "DONE", reuse.diagnostics[0] ?? "already supported");
      return finish("ALREADY_SUPPORTED", reuse.diagnostics[0] ?? "the repository already supports this", {});
    }

    // ---- release plan (a person's statement; the contract is re-hashed so every later step is bound to it)
    if (i.releasePlan) {
      const rec = req(); const { hash: _h, ...body } = rec.contract!; const next = { ...body, releasePlan: i.releasePlan };
      const contract = { ...next, hash: contractHashOf(next) };
      d.fs.updateRequest(requestId, rec.version, { ...rec, contract, workspace: { ...rec.workspace, contractHash: contract.hash, workspaceVersion: rec.workspace.workspaceVersion + 1 } });
    }

    // ---- impact and plan
    const impact = assessFeatureImpact(d.fs, d.store, actor, { contractHash: hash(), snapshot: req().source });
    if (impact.status === "STALE") return finish("FAILED", "the repository changed while the request was being analysed; run it again");
    const caps = (req().contract!.overlap?.capabilities ?? []).map((c) => c.id);
    const plan = planFeatureChange(od, actor, { contractHash: hash(), impactAssessmentId: impact.value!.id, capabilities: caps });
    add(t, "PLAN", "DONE", `${plan.value!.tasks.length} task(s), tier ${plan.value!.tier}`);
    if (req().mode === "PLAN") return finish("PLAN_ONLY", "plan only: this request was made in PLAN mode");

    // ---- generate edits and build the candidate
    const context = contextFor(req());
    let gen: Awaited<ReturnType<PipelineDeps["generateEdits"]>>;
    try { gen = await d.generateEdits({ request: req(), context }); } catch (e) { if (e instanceof FeatureError) { add(t, "GENERATE", "STOPPED", e.message); return finish("FAILED", e.message); } throw e; }
    add(t, "GENERATE", "DONE", `${gen.edits.length} edit(s) from ${gen.invocationIds.length} model call(s); ${context.length} file(s) shown`);
    const live = snapshotOf(d.store, i.repositoryId);
    const built = materializeCandidate({ fs: d.fs, store: d.store, auth: d.auth }, actor, { requestId, snapshot: live, edits: gen.edits, scope: i.scope, invocationIds: gen.invocationIds, idempotencyKey: `pipeline:${requestId}:candidate` });
    const cand = built.candidate;
    add(t, "CANDIDATE", "DONE", `${cand.mutations.length} file(s); oracle ${cand.oracleState}${built.replayed ? " (replayed)" : ""}`);

    // ---- validate
    let cur = req(); if (cur.state === "CONTRACTING") cur = transition(d.fs, requestId, cur.version, "IMPLEMENTING", actor, "candidate built");
    if (cur.state === "IMPLEMENTING") cur = transition(d.fs, requestId, cur.version, "VALIDATING", actor, "validation started");
    const vplan = validationPlanFor(req(), cand, i.validation);
    const evidence = await runFeatureValidation({ store: d.fs, runner: d.runner, runCheck: d.runCheck?.(cand, req()) }, { candidateId: cand.id, plan: vplan, actor, wallMs: i.validation?.wallMs ?? 600_000, signal: d.signal });
    const counts = evidence.flatMap((e) => e.results).reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
    add(t, "VALIDATE", evidence.every((e) => e.results.every((r) => r.status === "PASS" || r.status === "NOT_APPLICABLE")) ? "DONE" : "PARTIAL", `${evidence.length} check(s): ${Object.entries(counts).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);

    // ---- decide, then deliver
    const fresh = d.fs.getCandidate(cand.id)!; const rec = req();
    const decide = (purpose: string) => computeEligibility({ request: rec, candidate: fresh, plan: rec.validationPlan ?? vplan, evidence: d.fs.listEvidence(fresh.id).filter((e) => !e.verdict), decisions: d.fs.listDecisions(requestId), purpose });
    const decision = decide("EXPORT_PATCH");
    add(t, "DECIDE", decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? "DONE" : "PARTIAL", `${decision.eligibility}${decision.reasons.length ? `: ${decision.reasons.slice(0, 3).join("; ")}${decision.reasons.length > 3 ? ` (+${decision.reasons.length - 3} more)` : ""}` : ""}`);
    const result: Partial<PipelineResult> = { candidate: d.fs.getCandidate(cand.id)!, decision, unusedAnswers: [...unused] };
    if (decision.eligibility === "BLOCKED") { add(t, "EXPORT", "SKIPPED", "a blocked candidate is not exported"); return finish("BLOCKED", `blocked: ${decision.reasons[0] ?? "a mandatory check failed"}`, result); }
    if (i.exportFormat !== null) {
      const exp = exportFeaturePatch({ fs: d.fs, store: d.store }, actor, { candidateHash: fresh.bindingHash, decisionId: decision.id, format: i.exportFormat ?? "GIT_PATCH", exportPolicyHash: exportPolicyHash() });
      result.exportId = exp.value!.id; add(t, "EXPORT", "DONE", `${exp.value!.format}; ${exp.value!.label}`);
    } else add(t, "EXPORT", "SKIPPED", "export not requested");
    if (i.publishTo) {
      if (!d.publish) { add(t, "PUBLISH", "SKIPPED", "no forge is configured"); }
      else {
        d.beforePublish?.();
        try {
          const pub = await publishFeaturePR({ fs: d.fs, store: d.store, ...d.publish }, actor, { proposalId: fresh.id, decisionId: decide("PUBLISH_DRAFT_PR").id, expectedHeadHash: fresh.binding.candidateContentHash, destination: i.publishTo, idempotencyKey: `pipeline:${requestId}:publish` });
          result.publication = pub; add(t, "PUBLISH", "DONE", `draft PR #${pub.prNumber} (${pub.eligibility})`);
        } catch (e) { if (e instanceof FeatureError) { add(t, "PUBLISH", "STOPPED", e.message); return finish("BLOCKED", e.message, result); } throw e; }
      }
    } else add(t, "PUBLISH", "SKIPPED", "no destination given");
    return finish("COMPLETE", decision.eligibility === "VERIFIED_WITHIN_SCOPE" ? "verified within the scope of the recorded validation" : `review only: ${decision.eligibility}`, result);
  } catch (e) {
    if (e instanceof FeatureError) { add(t, t.steps.at(-1)?.step === "SUBMIT" ? "DISCOVER" : "CANDIDATE", "STOPPED", e.message); return finish(e.code === "BLOCKED" || e.code === "FORBIDDEN" ? "BLOCKED" : "FAILED", e.message); }
    throw e;
  }
}
