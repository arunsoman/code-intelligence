// Orchestration. Public operations return ApiResult (contracts §1). Every model call goes through callModel,
// which enforces the per-repository egress opt-in, scrubs secrets, and writes the audit trail.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BudgetController, runModel, StubProvider, type GatewayFailure, type GatewayResult } from "@cie/model";
import type {
  AnalysisBatch, ApiError, ApiResult, CallContext, ChallengeOutput, ChangesSince, Claim, ConceptCard, ConceptStore, ConceptsOutput, ConverseResult, DirListing, EditorContext, EditorEvent, EvidenceRef, ExplainResult, ExplanationOutput,
  HypothesesOutput, ModelProvider, ModelRequest, RepresentationOutput, ResolvedEvidence, JobView, SavedState, VerdictKind, ViewRoute, ViewSpec, SourceSpan,
  DefectDetectionInput, DetectorFinding, BenchmarkPolicy, BenchmarkResult,
} from "@cie/schema";
import { SCHEMA_CHALLENGE, SCHEMA_CONCEPTS, SCHEMA_EXPLANATION, SCHEMA_HYPOTHESES, SCHEMA_REPRESENTATION } from "@cie/schema";
import { applyVerdict, gateClaim, modelText, wilson, withChallenge } from "./claims.ts";
import { claimOf } from "./forms/common.ts";
import { cardsFromOutput, chunkSymbols, mergeCards } from "./concepts.ts";
import { buildFailureGraph, buildInvariantGraph } from "./forms/causal.ts";
import { short } from "./forms/common.ts";
import { buildHypothesis } from "./forms/hypothesis.ts";
import { extractArtifacts } from "./artifacts.ts";
import { Collab } from "./collab.ts";
import { Evaluator, PLANTED_SECURITY, SEEDED_CONCEPTS } from "./evaluation.ts";
import { Indexer } from "./indexer.ts";
import { History } from "./history.ts";
import { Runtime } from "./runtime.ts";
import { mapOverlays } from "./overlays.ts";
import { Security } from "./security.ts";
import { PrAnalysis, PrCheckError, resolvePr, type PrRef } from "./pr-analysis.ts";
import { Profiles, ProfileCheckError } from "./profiles-analysis.ts";
import { Tasks, TaskError } from "./execution.ts";
import { GitHubCheckPublisher, newGrant } from "./pr-publish.ts";
import { githubRemote } from "./gh.ts";
import type { PrAnalysisView } from "@cie/schema";
import { projectProfile } from "./profile.ts";
import { Registry } from "./registry.ts";
import { WorkspaceLog } from "./workspaces.ts";
import { Journal, type CommitReceipt } from "./journal.ts";
import { Cancelled, JobRunner, type JobControl } from "./jobs.ts";
import { EGRESS_FIELDS, payloadHash, scrubBundle } from "./policy.ts";
import { bundleFor, retrieveAround, retrieveForQuestion } from "./retrieval.ts";
import { matchName, readText, type RouterModel } from "./llm-router.ts";
import { revisionIndex, scoreEntity, WEIGHTS } from "./salience.ts";
import { DeltaBaseError, type RevisionRow, type Store } from "./store.ts";
import { entityAt, fingerprint, locateFrames, looksLikeTrace, parseTrace } from "./trace.ts";
import { compileView } from "./viewspec.ts";
import { catalog, ensureEdgeClaims, visualByForm, type CatalogEntry } from "./visuals.ts";
import { isGitRepo } from "./gitinfo.ts";
import { ensureGhForgeConnector } from "./gh.ts";
import { backup as backupStore, deleteRepository as deleteRepo, gc as gcStore, type DeleteReport, type GcReport } from "./storage.ts";
import { API_VERSION, MIN_EXTENSION, health as healthOf, restoreDrill, type Health, type RestoreDrill } from "./ops.ts";
import { EventBus } from "./events.ts";
import { buildExport, ExportError, ExportStore, Notifications, type ExportArtifact } from "./exports.ts";
import { SearchEngine, type ApiFail } from "./search.ts";
import { HistoryEngine, PolicyError, inspectHead, normalizePolicy, policyHash } from "./hotspots.ts";
import { ChangeEngine, ChangeError, type ChangeProposal, type DragResult, type Intent } from "./changes.ts";
import { compareScenarios, evaluateScenario, ScenarioError, type AssumptionInput, type CapacityData, type Scenario, type ScenarioResult } from "./scenarios.ts";
import { policyFor } from "./access.ts";
import { redactBuilt } from "./redact.ts";
import { HashEmbedder, semanticScores, type Embedder } from "./embeddings.ts";
import { InvestigationEngine, type EngineOptions } from "./c22/engine.ts";
import { C22Error, type HypothesisDraft } from "./c22/types.ts";
import { seedContext, toDrafts } from "./c22/proposer.ts";
import { toPlan } from "./c22/compat.ts";
import { CausalityEngine, type CausalityScopeInput, type MechanismEvidenceRecord, type CauseClaimRecord, type Snapshot as C24Snapshot } from "./c24/causality.ts";
import { ingestTestArtifacts, loadTestSummary, type TestSummary } from "./testartifacts.ts";
import { ingestTraceExports } from "./traceexport.ts";
import type { WorkerClient } from "./worker.ts";
import { WorkerError } from "./worker.ts";
import { compareBenchmark, detectDefects } from "./defects.ts";
import { DefectDetectionInputSchema } from "@cie/schema";
import { DefectError, DefectWorkflow, type DraftForge } from "./defect-workflow.ts";
import { detectIndexedDefects } from "./defect-indexed.ts";
import { artifactHash } from "./defect-schedule.ts";
import { Profiling } from "./profiling.ts";
import { Campaigns, CampaignError, type CampaignAdapters } from "./campaigns.ts";
import { GitHubPublisher, JointRunner, RecipeRunner, repositoryInventory, validateCandidate } from "./campaign-runner.ts";

const chunkTokenBudget = () => Number(process.env.CIE_CHUNK_TOKEN_BUDGET) || 60_000; // per concept-extraction request; the gateway hard limit is 200k

function safeIsDir(p: string): boolean { try { return statSync(p).isDirectory(); } catch { return false; } }

export interface FileStats { files: number; symbols: number; kb: number; byExt: Record<string, number> }

/** Per-file sha256 of a worktree, budgeted: a full walk that never parses (used for the incremental re-index). */
export function hashFiles(root: string, deadlineMs = 30_000, maxFiles = 5_000): { map: Map<string, string>; count: number; scanned: number; error: string | null } {
  const out = new Map<string, string>();
  let scanned = 0;
  const t0 = Date.now();
  const walk = (abs: string, rel: string): string | null => {
    if (Date.now() - t0 > deadlineMs) return `walk exceeded ${deadlineMs} ms`;
    if (scanned > maxFiles) return `walk exceeded ${maxFiles} files`;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { entries = []; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) { const err = walk(join(abs, e.name), `${rel}${e.name}/`); if (err) return err; }
      else if (e.isFile()) {
        scanned++;
        if (scanned > maxFiles) return `walk exceeded ${maxFiles} files`;
        try { out.set(`${rel}${e.name}`, createHash("sha256").update(readFileSync(join(abs, e.name))).digest("hex")); } catch { /* unreadable: skip */ }
      }
    }
    return null;
  };
  const error = walk(root, "");
  return { map: out, count: out.size, scanned, error };
}

const meta = (ctx: CallContext, o: Partial<{ revision: string; resourceVersion: number; completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"; warnings: string[] }> = {}) =>
  ({ requestId: ctx.requestId, completeness: "COMPLETE" as const, warnings: [] as string[], ...o });
const fail = <T>(ctx: CallContext, error: ApiError): ApiResult<T> => ({ ok: false, error, metadata: meta(ctx) });
const ok = <T>(ctx: CallContext, value: T, m: Parameters<typeof meta>[1] = {}): ApiResult<T> => ({ ok: true, value, metadata: meta(ctx, m) });
/** A full disk is a different problem from a broken database: nothing is corrupt, and writing works again once there is room. */
export function storageFailure(e: unknown): ApiError {
  const msg = (e as Error).message ?? String(e);
  if (/database or disk is full|SQLITE_FULL|ENOSPC/i.test(msg)) return { code: "RESOURCE_LIMIT", message: "The disk or database size limit was reached, so nothing was saved. Free some space and try again; existing data is intact.", retryable: true };
  if (/locked|SQLITE_BUSY/i.test(msg)) return { code: "STORAGE_FAILURE", message: "The database is busy with another writer. Try again in a moment.", retryable: true };
  return { code: "STORAGE_FAILURE", message: msg, retryable: true };
}

const actor = (ctx: CallContext) => ctx.actor.principalId;

export class Service {
  readonly journal: Journal;
  readonly store: Store;
  readonly jobs: JobRunner;
  /** F02: the PR-analysis engine (§6.1) and its GitHub status publisher (§7.12). */
  readonly pr: PrAnalysis;
  readonly prPublisher: GitHubCheckPublisher;
  readonly bus: EventBus;
  readonly c22: InvestigationEngine;
  /** C24 causality v2: execution-reconstruction engine. */
  readonly c24: CausalityEngine;
  readonly changes: ChangeEngine;
  readonly notifications: Notifications;
  /** F01: repository registry, text/symbol index and the query paths built on it (search.ts). */
  readonly search: SearchEngine;
  private readonly exportStore: ExportStore;
  readonly defects: DefectWorkflow;
  /** What turns text into vectors for semantic retrieval. The default is local and deterministic; see embeddings.ts. */
  embedder: Embedder = new HashEmbedder();
  /** Reads what a question wants (which view, or which conversational request). Null: nothing configured, and the general map is used. */
  router: RouterModel | null = null;
  /** The GitHub transport F07 publishes through. Unset means publication is refused, never simulated. */
  forge: DraftForge | null = null;
  private worker: WorkerClient;
  private model: ModelProvider;
  private offline: ModelProvider;
  /** C13 gateway operations over the workspace log. */
  readonly workspaceOps: Record<string, (ctx: CallContext, b: any) => ApiResult<unknown>> = {
    "C13/create": (c, b) => this.wsResult(c, this.workspaceLog.create(c.actor.principalId, b)),
    "C13/append": (c, b) => this.wsResult(c, this.workspaceLog.append(c.actor.principalId, b)),
    "C13/resume": (c, b) => this.wsResult(c, this.workspaceLog.resume(b.workspaceId, b.atSequence)),
    "C13/checkpoint": (c, b) => this.wsResult(c, this.workspaceLog.checkpoint(b.workspaceId)),
    "C13/annotateStaleness": (c, b) => ok(c, this.workspaceLog.annotateStaleness(c.actor.principalId, b.impact)),
    "C13/resurface": (c, b) => ok(c, this.workspaceLog.resurface(b.refs ?? [], b.limit)),
  };
  private wsResult(ctx: CallContext, r: { ok: true } | { ok: false; error: ApiError }): ApiResult<any> { return r.ok ? ok(ctx, r) : fail(ctx, r.error); }
  /** C08: canonical identities across revisions. */
  readonly registry: Registry;
  /** C23: change sets, archaeology and review threads. */
  readonly history: History;
  /** C24: runtime signals joined to code. */
  readonly runtime: Runtime;
  /** C25: security findings and the alarm gate. */
  readonly security: Security;
  /** F05: trace-linked continuous profiling. */
  readonly profiling: Profiling;
  /** F08: coordinated multi-repository campaigns. */
  readonly campaigns: Campaigns;
  /** F05: the profiling engine — persists artifacts, attributes builds, correlates traces, and verifies presentation (F05-A5). */
  readonly profiles: Profiles;
  readonly tasks: Tasks;
  /** C29: shared investigations and team knowledge. */
  readonly collab: Collab;
  /** C17: the evaluation registry. */
  readonly evaluator: Evaluator;
  /** C07: impact, generation fence and clean-index parity. */
  readonly indexer: Indexer;
  /** Operations the screens need that have no other home: revision and source lists, the evaluation registry, and local team administration. */
  readonly screenOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    "C07/listRevisions": (c, b) => ok(c, (this.store.db.prepare("select id, repo_root, created_at, file_count from revisions " + (b?.repoRoot ? "where repo_root = ? " : "") + "order by rowid desc limit 30").all(...(b?.repoRoot ? [b.repoRoot] : [])) as any[]).map((r) => ({ id: r.id, repoRoot: r.repo_root, createdAt: r.created_at, files: r.file_count }))),
    "C04/listSources": (c) => ok(c, (this.store.db.prepare("select id, state, last_ok, last_error, rate_resume_at from ext_sources order by id").all() as any[]).map((r) => ({ sourceId: r.id, state: r.state, lastOk: r.last_ok ? new Date(r.last_ok).toISOString() : null, lastError: r.last_error, resumeAt: r.rate_resume_at ? new Date(r.rate_resume_at).toISOString() : null }))),
    "C17/runs": (c, b) => ok(c, this.evaluator.runs(b?.suite).map(({ items, ...r }) => ({ ...r, items: items.length, misses: items.filter((i) => i.expected !== i.predicted).map((i) => i.id) })).reverse().slice(0, 20)),
    "C17/runSuite": async (c, b) => { const suite = b.suite === "planted-security" ? PLANTED_SECURITY : b.suite === "seeded-concepts" ? SEEDED_CONCEPTS : null; if (!suite) return fail(c, { code: "INVALID_SCHEMA", message: "suite must be planted-security or seeded-concepts", retryable: false }); if (!this.store.latestRevision()) return fail(c, { code: "NOT_FOUND", message: "index a repository first", retryable: false }); const r = await this.evaluator.runSuite(this, suite, this.activeModel); const { items, ...rest } = r; return ok(c, { ...rest, items: items.length, misses: items.filter((i) => i.expected !== i.predicted).map((i) => i.id) }); },
    "C17/status": (c) => ok(c, { model: this.activeModel, suites: ["planted-security", "seeded-concepts"].map((s) => ({ suite: s, ...this.evaluator.modelStatus(this.activeModel, s) })), calibration: this.evaluator.calibration(), experts: this.evaluator.expertCoverage() }),
    "C29/whoami": (c) => ok(c, { principal: c.actor.principalId, tenant: c.actor.tenantId }),
    "C29/addPrincipal": (c, b) => { if (!/^[A-Za-z0-9._-]{1,40}$/.test(b?.principal ?? "")) return fail(c, { code: "INVALID_SCHEMA", message: "a name is 1–40 letters, digits, dots, dashes", retryable: false }); this.collab.addPrincipal(b.principal, c.actor.tenantId); return ok(c, { principal: b.principal, tenant: c.actor.tenantId }); },
    "C29/setAccess": (c, b) => { const rev = this.store.revision(b?.revision); if (!rev) return fail(c, { code: "NOT_FOUND", message: "unknown revision", retryable: false }); if (!this.collab.tenantOf(b.principal)) return fail(c, { code: "NOT_FOUND", message: "unknown person", retryable: false }); this.collab.setAccess(b.principal, rev.repoRoot, { allowed: !!b.allowed, deniedPrefixes: b.deniedPrefixes ?? [] }); return ok(c, { principal: b.principal, repoRoot: rev.repoRoot, allowed: !!b.allowed }); },
    "C29/people": (c) => ok(c, (this.store.db.prepare("select principal from collab_principals order by principal").all() as any[]).map((r) => r.principal)),
    "C29/workspaces": (c) => ok(c, (this.store.db.prepare("select m.ws as id, m.name, s.role from ws_meta m join collab_shares s on s.ws = m.ws and s.principal = ? and s.active = 1 order by m.created_at desc").all(c.actor.principalId) as any[])),
    "C29/shares": (c, b) => ok(c, { shares: this.store.db.prepare("select principal, role from collab_shares where ws = ? and active = 1 order by principal").all(b.workspaceId), history: this.collab.history(b.workspaceId).slice(-15) }),
  };
  /** C05/C06/C07 gateway operations. */
  readonly indexOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    "C04/connectorHealth": (c, b) => { const r = this.store.db.prepare("select * from ext_sources where id = ?").get(b.sourceId) as any; if (!r) return fail(c, { code: "NOT_FOUND", message: "no such source", retryable: false }); const n = (t: string) => Number((this.store.db.prepare(`select count(*) as n from ${t} where source = ?`).get(b.sourceId) as any).n); return ok(c, { sourceId: r.id, state: r.state, lastOk: r.last_ok ? new Date(r.last_ok).toISOString() : null, lastError: r.last_error, items: n("ext_items"), quarantined: n("ext_quarantine"), resumeAt: r.rate_resume_at ? new Date(r.rate_resume_at).toISOString() : null }); },
    "C05/languageCapabilities": async (c) => ok(c, await this.worker.languageCapabilities()),
    "C05/compareWithCleanIndex": async (c, b) => { try { return ok(c, await this.indexer.compareWithCleanIndex(b.revision), { revision: b.revision }); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C06/extractArtifacts": (c, b) => { try { const r = extractArtifacts(this.store, b.revision); return ok(c, r, { revision: b.revision, warnings: [r.notice] }); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C07/computeImpact": (c, b) => { try { return ok(c, this.indexer.computeImpact(b.fromRevision, b.toRevision)); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C07/invalidateAndRevalidate": async (c, b) => ok(c, await this.indexer.invalidateAndRevalidate(b.impact)),
    "C04/ingestGhSource": async (c, b) => {
      if (!b?.repoRoot || !isAbsolute(b.repoRoot)) return fail(c, { code: "INVALID_SCHEMA", message: "repoRoot must be an absolute path", retryable: false });
      const conn = ensureGhForgeConnector(this.store, b.repoRoot);
      if (!conn) return fail(c, { code: "NOT_FOUND", message: "no GitHub origin remote found, or the gh CLI is not installed and authenticated", retryable: false });
      const rep = await conn.ingestPullRequests();
      return ok(c, rep, { completeness: rep.partial ? "PARTIAL" : "COMPLETE", warnings: rep.reasons });
    },
  };
  /** C29 gateway operations. The caller is the authenticated principal; nothing is taken from the request about who is acting. */
  readonly collabOps: Record<string, (ctx: CallContext, b: any) => ApiResult<unknown>> = {
    "C29/create": (c, b) => this.collabResult(c, this.collab.create(c.actor.principalId, b)),
    "C29/share": (c, b) => this.collabResult(c, this.collab.share(c.actor.principalId, b)),
    "C29/unshare": (c, b) => this.collabResult(c, this.collab.unshare(c.actor.principalId, b)),
    "C29/read": (c, b) => this.collabResult(c, this.collab.read(c.actor.principalId, b.workspaceId)),
    "C29/applyOperation": (c, b) => this.collabResult(c, this.collab.applyOperation(c.actor.principalId, b)),
    "C29/handover": (c, b) => this.collabResult(c, this.collab.handover(c.actor.principalId, b)),
    "C29/confirmSharedConcept": (c, b) => this.collabResult(c, this.collab.confirmSharedConcept(c.actor.principalId, b)),
    "C29/conceptsFor": (c, b) => ok(c, this.collab.conceptsFor(c.actor.principalId, b.revision)),
  };
  /** F05 gateway operations for trace-linked continuous profiling. The engine persists aggregates, enforces the
   * attribution ladder (F05-A2), grades correlation (F05-D8), gates compare on error populations (F05-A6) and verifies
   * every rendered metric against a registered template (F05-A5). `this.profiling` remains as the raw worker shim. */
  readonly profilingOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    "C04/ingestProfile": (c, b) => this.profileWrap(c, () => this.profiles.ingestProfile({ path: b?.path, serviceHint: b?.serviceHint, revisionHint: b?.revisionHint })),
    "C24/correlateProfile": (c, b) => this.profileWrap(c, () => this.profiles.correlate({ artifactHash: b?.artifactHash, traceSourceId: b?.traceSourceId, timeWindowMs: b?.timeWindowMs, overrideRevisionMismatch: b?.overrideRevisionMismatch })),
    "C26/queryHotspots": (c, b) => this.profileWrap(c, () => this.profiles.queryHotspots(b ?? {})),
    "C26/compareProfiles": (c, b) => this.profileWrap(c, () => this.profiles.compare({ baselinePopulationHash: b?.baselinePopulationHash, candidatePopulationHash: b?.candidatePopulationHash, normalise: b?.normalise ?? "PER_REQUEST", declareEquivalent: b?.declareEquivalent })),
    "C19/buildFlamegraph": (c, b) => this.profileWrap(c, () => this.profiles.flamegraph({ artifactHash: b?.artifactHash ?? b?.path, ordinal: b?.ordinal, viewRevision: b?.viewRevision })),
    "C26/profileEndpoints": (c, b) => this.profileWrap(c, () => this.profiles.endpointStats({ traceSourceId: b?.traceSourceId, window: b?.window, artifactHash: b?.artifactHash, viewRevision: b?.viewRevision })),
    "C26/profileWaterfall": (c, b) => this.profileWrap(c, () => this.profiles.waterfall({ traceSourceId: b?.traceSourceId, traceId: b?.traceId, window: b?.window })),
    "C26/listProfilePopulations": (c, b) => this.profileWrap(c, () => this.profiles.listPopulations({ traceSourceId: b?.traceSourceId, artifactHash: b?.artifactHash, limit: b?.limit })),
    "C04/listProfileArtifacts": (c, b) => this.profileWrap(c, () => this.profiles.listArtifacts({ traceSourceId: b?.traceSourceId, limit: b?.limit })),
    "C19/compileProfileView": (c, b) => this.profileWrap(c, () => this.profiles.compileProfileView(b ?? {})),
    "C16/verifyMetricPresentation": (c, b) => this.profileWrap(c, () => this.profiles.verifyPresentation(b?.items ?? [], b?.revision ?? this.store.latestRevision() ?? "")),
  };

  /**
   * F07 task execution. Every command here is a human gate in the guide's flow: intake and confirmation, a plan with
   * bounded unknowns, candidate proposals as exact edit operations, one validation run per role, a property-change
   * review, a second-person approval and a publication. `C30/publishDraftPR` needs the real forge supplied by the
   * caller (the `gh` implementation in production, a recording one in tests); without one it refuses rather than
   * pretending a draft PR exists.
   */
  readonly taskOps: Record<string, (ctx: CallContext, body: any) => Promise<ApiResult<unknown>>> = {
    "C02/submitTask": (c, b) => this.taskCall(c, () => { const view = this.tasks.submitTask(actor(c), { spec: b?.spec }); return { ...view, restatement: this.tasks.restatement(view.taskId) }; }),
    "C02/confirmIntent": (c, b) => this.taskCall(c, () => this.tasks.confirmIntent(actor(c), { taskId: b?.taskId, specHash: b?.specHash, expectedVersion: b?.expectedVersion })),
    "C02/getTask": (c, b) => this.taskCall(c, () => this.tasks.getTask(b?.taskId)),
    "C02/listTasks": (c, b) => this.taskCall(c, () => this.tasks.listTasks(b?.limit)),
    "C02/listTaskEvents": (c, b) => this.taskCall(c, () => ({ events: this.tasks.listEvents(b?.taskId, b?.afterSeq ?? 0) })),
    "C02/cancelTask": (c, b) => this.taskCall(c, () => this.tasks.cancelTask(actor(c), { taskId: b?.taskId, reason: b?.reason ?? "" })),
    "C15/draftPlan": (c, b) => this.taskCall(c, () => this.tasks.draftPlan(actor(c), { taskId: b?.taskId })),
    "C22/resolveObligation": (c, b) => this.taskCall(c, () => this.tasks.resolveObligation(actor(c), { taskId: b?.taskId, obligationId: b?.obligationId })),
    "C28/prepareChange": (c, b) => this.taskCall(c, () => this.tasks.prepareChange(actor(c), { taskId: b?.taskId, planVersion: b?.planVersion, editOperations: b?.editOperations ?? [], origin: b?.origin })),
    "C27/validatePatch": (c, b) => this.taskCall(c, () => this.tasks.validatePatch(actor(c), { taskId: b?.taskId, candidateIndex: b?.candidateIndex, requireAuditedIsolation: b?.requireAuditedIsolation })),
    "C28/reviewPropertyChange": (c, b) => this.taskCall(c, () => this.tasks.reviewPropertyChange(actor(c), { taskId: b?.taskId, candidateIndex: b?.candidateIndex, decision: b?.decision, rationale: b?.rationale })),
    "C28/approveCandidate": (c, b) => this.taskCall(c, () => this.tasks.approveCandidate(actor(c), { taskId: b?.taskId, candidateIndex: b?.candidateIndex, expectedVersion: b?.expectedVersion, explanation: b?.explanation ?? "" })),
    "C30/createPublicationGrant": (c, b) => this.taskCall(c, () => this.tasks.createGrant(actor(c), { taskId: b?.taskId, candidateIndex: b?.candidateIndex, repository: b?.repository, baseBranch: b?.baseBranch, branchName: b?.branchName })),
    "C30/publishDraftPR": (c, b) => {
      // The rollout switch comes first: with `tasks.publish` off a task ends at REVIEW_READY and exports a patch, and
      // no GitHub call is attempted at all. Each flag is independently reversible and none of them is inferred.
      if (!this.tasksPublicationEnabled()) return Promise.resolve(fail(c, { code: "FORBIDDEN", message: "Publishing from CIE is switched off for this installation, so this task stops at review-ready. The validated patch can still be exported as a patch.", retryable: false }));
      if (!this.forge) return Promise.resolve(fail(c, { code: "PROVIDER_UNAVAILABLE", message: "No GitHub transport is configured, so no draft PR is created. The validated patch can still be exported as a patch.", retryable: false }));
      return this.taskCall(c, () => this.tasks.publishDraftPR(actor(c), { taskId: b?.taskId, candidateIndex: b?.candidateIndex, repositoryId: b?.repositoryId, baseBranch: b?.baseBranch, branchName: b?.branchName, grantId: b?.grantId, generation: b?.generation }, this.forge!));
    },
    "C28/taskRuns": (c, b) => this.taskCall(c, () => this.tasks.listRuns(b?.taskId, b?.candidateIndex)),
  };

  /** `task_flags.publish` is the independent switch for the only write that leaves this machine. */
  tasksPublicationEnabled(): boolean {
    try {
      const row = this.store.db.prepare("select publish from task_flags limit 1").get() as { publish: number } | undefined;
      return Number(row?.publish ?? 0) === 1;
    } catch { return false; }
  }

  async taskCall<T>(ctx: CallContext, fn: () => T | Promise<T>): Promise<ApiResult<T>> {
    try { return ok(ctx, await fn()); }
    catch (e) {
      if (e instanceof TaskError) return fail(ctx, { code: e.code as ApiError["code"], message: e.message, retryable: e.code === "VERSION_CONFLICT" });
      return fail(ctx, storageFailure(e));
    }
  }
  /** Wraps an engine call: F05 check failures already carry an api-shaped code; anything else is a storage failure. */
  private async profileWrap(ctx: CallContext, fn: () => unknown | Promise<unknown>): Promise<ApiResult<unknown>> {
    try { return ok(ctx, await fn()); }
    catch (e) {
      if (e instanceof ProfileCheckError) return fail(ctx, e.api);
      return fail(ctx, { code: "STORAGE_FAILURE", message: (e as Error).message || "profile operation failed", retryable: false });
    }
  }
  /** F08 gateway operations for coordinated multi-repository campaigns. */
  readonly campaignOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    "C28/createCampaign": (c, b) => this.campaignResult(c, () => this.campaigns.createCampaign(c.actor.principalId, c.actor.tenantId, b.spec)),
    "C28/listCampaigns": (c, b) => this.campaignResult(c, () => this.campaigns.listCampaigns(c.actor.principalId, b.limit)),
    "C28/freezePopulation": (c, b) => this.campaignResult(c, () => this.campaigns.freezePopulation(b.campaignId, c.actor.principalId, b.expectedVersion)),
    "C28/assessPopulationChange": (c, b) => this.campaignResult(c, () => this.campaigns.assessPopulationChange(b.campaignId, c.actor.principalId, b.fromVersion, b.toVersion)),
    "C28/assessChild": (c, b) => this.campaignResult(c, () => this.campaigns.assessChild(b.campaignId, c.actor.principalId, b.repositoryId)),
    "C28/planCampaign": (c, b) => this.campaignResult(c, () => this.campaigns.planCampaign(b.campaignId, c.actor.principalId, b.expectedVersion)),
    "C28/getCampaignPlan": (c, b) => this.campaignResult(c, () => this.campaigns.getCampaignPlan(b.campaignId, c.actor.principalId)),
    "C28/advanceCampaign": (c, b) => ok(c, this.jobs.enqueue(c, {
      kind: "campaign-advance",
      params: { campaignId: b.campaignId, batchId: b.batchId },
      run: async (jctx) => this.campaignResult(jctx, () => this.campaigns.advanceCampaign(b.campaignId, jctx.actor.principalId, b.expectedVersion, b.batchId ?? null, jctx.idempotencyKey)),
    })),
    "C28/pauseCampaign": (c, b) => this.campaignResult(c, () => this.campaigns.pause(b.campaignId, c.actor.principalId, b.reason ?? "paused by an operator")),
    "C28/resumeCampaign": (c, b) => this.campaignResult(c, () => this.campaigns.resume(b.campaignId, c.actor.principalId, b.expectedVersion)),
    "C28/cancelCampaign": (c, b) => this.campaignResult(c, () => this.campaigns.cancel(b.campaignId, c.actor.principalId, b.expectedVersion, b.reason ?? "cancelled by an operator")),
    "C28/getCampaign": (c, b) => this.campaignResult(c, () => this.campaigns.getCampaign(b.campaignId, c.actor.principalId)),
    "C28/listChildren": (c, b) => this.campaignResult(c, () => this.campaigns.listChildren(b.campaignId, c.actor.principalId, b.filter, b.cursor, b.limit)),
    "C28/clusterChildren": (c, b) => this.campaignResult(c, () => this.campaigns.clusterChildren(b.campaignId, c.actor.principalId)),
    "C28/approveChild": (c, b) => this.campaignResult(c, () => this.campaigns.approveChild(b.campaignId, c.actor.principalId, b.repositoryId, b.explanation, b.clusterId ?? null)),
    "C28/confirmCluster": (c, b) => this.campaignResult(c, () => this.campaigns.confirmCluster(b.campaignId, c.actor.principalId, b.repositoryId, b.clusterId, b.expectedBindingHash ?? "")),
    "C28/runDryRun": (c, b) => this.campaignResult(c, () => this.campaigns.runDryRun(b.campaignId, c.actor.principalId, b.expectedVersion)),
    "C28/getDryRun": (c, b) => this.campaignResult(c, () => this.campaigns.getDryRun(b.campaignId, c.actor.principalId, b.runId)),
    "C28/updateTransformation": (c, b) => this.campaignResult(c, () => this.campaigns.updateTransformation(b.campaignId, c.actor.principalId, b.expectedVersion, b.transformation)),
    "C28/runJointCheck": (c, b) => ok(c, this.jobs.enqueue(c, {
      kind: "campaign-joint-check",
      params: { campaignId: b.campaignId, caseId: b.caseId },
      run: async (jctx) => this.campaignResult(jctx, () => this.campaigns.runJointCheck(b.campaignId, jctx.actor.principalId, b.caseId)),
    })),
    "C30/publishCampaignChildren": (c, b) => this.campaignResult(c, () => this.campaigns.publishCampaignChildren(b.campaignId, c.actor.principalId, b.batchId ?? null, b.childRepositoryIds ?? null, c.idempotencyKey)),
    "C30/reconcileCampaign": (c, b) => this.campaignResult(c, () => this.campaigns.reconcileCampaign(b.campaignId, c.actor.principalId)),
    "C30/issuePublicationGrant": (c, b) => this.campaignResult(c, () => this.campaigns.issuePublicationGrant(b.campaignId, c.actor.principalId, b.repositoryId, b.ttlMs)),
    "C30/revokePublicationGrant": (c, b) => this.campaignResult(c, () => { this.campaigns.revokePublicationGrant(b.campaignId, c.actor.principalId, b.grantId); return { revoked: true }; }),
    "C29/assignChildReviewers": (c, b) => this.campaignResult(c, () => { this.campaigns.assignChildReviewers(b.campaignId, c.actor.principalId, b.repositoryId, b.principals ?? [], b.role, b.source); return { ok: true }; }),
    "C29/recordChildException": (c, b) => this.campaignResult(c, () => ({ id: this.campaigns.recordChildException(b.campaignId, c.actor.principalId, b.repositoryId, b.scope, b.rationale, b.approver ?? null, b.expiresAt ?? null) })),
  };
  private campaignResult<T>(ctx: CallContext, fn: () => T): ApiResult<T> { try { return ok(ctx, fn()); } catch (e) { const api = e instanceof CampaignError ? e.api : storageFailure(e); return fail(ctx, api); } }

  /** Real campaign adapters: the F01/F04 repository inventory (packages, cross-repository edges, owners), an isolated
   * recipe runner, an isolated per-child validator, an npm local-link joint runner and a `gh`-based draft publisher.
   * Each is synchronous, matching the change engine; nothing here writes inside a repository's own root. */
  private campaignAdapters(): CampaignAdapters {
    const store = this.store;
    const collab = this.collab;
    const recipe = new RecipeRunner();
    const joint = new JointRunner();
    const publisher = new GitHubPublisher();
    for (const root of (process.env.CIE_CAMPAIGN_TRUSTED_ROOTS ?? "").split(":").filter(Boolean)) { try { recipe.trust(realpathSync(root)); } catch { /* the operator named a path that is not there */ } }

    const repoRoots = () => {
      const rows = store.db.prepare(
        "select r.id, r.repo_root, r.git_head from revisions r join (select repo_root, max(rowid) rid from revisions group by repo_root) m on m.rid = r.rowid where r.repo_root not in (select repo_root from repo_access where revoked = 1)",
      ).all() as any[];
      return rows.map((r) => {
        const repoRoot = r.repo_root as string;
        const branch = (() => { try { return (store.db.prepare("select default_branch from repositories where root = ?").get(repoRoot) as { default_branch?: string } | undefined)?.default_branch; } catch { return undefined; } })();
        return { repositoryId: repoRoot, repoRoot, defaultBranch: branch ?? "main", baseCommit: (r.git_head ?? r.id) as string };
      });
    };
    const inventory = () => repositoryInventory(store, repoRoots);
    const find = (id: string) => inventory().find((r) => r.repositoryId === id);

    return {
      repos: () => inventory(),
      baseCommit: (id, pinned) => pinned ?? find(id)?.baseCommit ?? null,
      transformationApplies: (id, t) => { const repo = find(id); return repo ? recipe.transformationApplies(repo.repoRoot, t) : { applies: false, reason: "unknown repository" }; },
      applyRecipe: (id, base, t) => { const repo = find(id); return repo ? recipe.applyRecipe(repo.repoRoot, base, t) : { ok: false, error: "unknown repository" }; },
      validateChild: (id, _base, candidate) => {
        const repo = find(id);
        const trusted = !!repo && recipe.trustedRoots.has(repo.repoRoot);
        return validateCandidate({ candidate, trusted });
      },
      jointCheck: (request) => joint.check(request),
      publish: (request) => publisher.publish(request),
      githubState: (id, prNumber) => { const repo = find(id); return repo ? publisher.state(repo.repoRoot, prNumber) : null; },
      rateLimit: () => publisher.rateLimit(),
      canSee: (principal, repo) => collab.access(principal, repo.repoRoot).allowed,
      canPublish: (principal, repo) => collab.access(principal, repo.repoRoot).allowed,
      ownerOf: (id) => find(id)?.owner ?? null,
    };
  }
  private collabResult(ctx: CallContext, r: { ok: true } | { ok: false; error: ApiError }): ApiResult<any> { return r.ok ? ok(ctx, r) : fail(ctx, r.error); }
  /** C25 gateway operations. */
  readonly securityOps: Record<string, (ctx: CallContext, b: any) => ApiResult<unknown>> = {
    "C25/analyze": (c, b) => { try { return ok(c, this.security.analyze(b), { revision: b.revision, warnings: ["Findings are candidates from static analysis. No finding does not mean safe, and nothing here certifies compliance."] }); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C25/gateSecurityAlarm": (c, b) => { try { return ok(c, this.security.gateSecurityAlarm(b.findingId, b)); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C25/buildAuditNarrative": (c, b) => ok(c, this.security.buildAuditNarrative(b.revision, b.findingIds ?? [])),
    "C25/checkInvariant": (c, b) => ok(c, this.security.checkInvariant(b.revision, b)),
    "C25/ruleTrace": (c, b) => { const t = this.security.ruleTrace(b.findingId); return t ? ok(c, t) : fail(c, { code: "NOT_FOUND", message: "no such finding", retryable: false }); },
  };
  /** C24 gateway operations. */
  readonly runtimeOps: Record<string, (ctx: CallContext, b: any) => ApiResult<unknown>> = {
    "C24/recordMarker": (c, b) => { this.runtime.recordMarker(b); return ok(c, { recorded: true }); },
    "C24/ingest": (c, b) => { const r = this.runtime.ingest(b.envelope); return r.ok ? ok(c, r) : fail(c, r.error); },
    "C24/attribute": (c, b) => { const r = this.runtime.attribute(b.envelopeId, b.revision); return "ok" in r ? fail(c, r.error) : ok(c, r, { revision: b.revision, completeness: r.exact ? "COMPLETE" : "PARTIAL", warnings: r.uncertaintyReason ? [r.uncertaintyReason] : [] }); },
    "C24/queryWindow": (c, b) => ok(c, this.runtime.queryWindow(b.revision, b.window, b.roots), { revision: b.revision }),
    "C24/replay": (c, b) => {
      if (!b?.window || !Number.isFinite(b.window.from) || !Number.isFinite(b.window.to) || b.window.from < 0 || b.window.to <= b.window.from || b.window.to > 8.64e15 || !Number.isFinite(b.cursor)) return fail(c, { code: "INVALID_SCHEMA", message: "replay needs a valid time window and finite cursor", retryable: false });
      if (typeof b.revision !== "string" || !this.store.revision(b.revision)) return fail(c, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
      return ok(c, this.runtime.replay(b.revision, b.window, b.cursor), { revision: b.revision });
    },
  };
  /** C23 gateway operations. */
  readonly historyOps: Record<string, (ctx: CallContext, b: any) => ApiResult<unknown>> = {
    "C23/compare": (c, b) => { try { const cs = this.history.compare(b.base, b.head); return ok(c, cs, { revision: b.head }); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C23/archaeology": (c, b) => { try { return ok(c, this.history.archaeology(b.revision, b.entityId, b.window), { revision: b.revision }); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C23/assessChangeImpact": (c, b) => ok(c, this.history.assessChangeImpact(b.changeSet)),
    "C23/addThread": (c, b) => { try { return ok(c, this.history.addThread(c.actor.principalId, b)); } catch (e) { return fail(c, { code: "NOT_FOUND", message: (e as Error).message, retryable: false }); } },
    "C23/reanchorThreads": (c, b) => ok(c, this.history.reanchorThreads(b.mergedRevision)),
    "C23/explainHotspot": (c, b) => this.hotspotCallSync(c, () => this.hotspots.explainHotspot(c, b ?? {})),
    "C23/explainCoupling": (c, b) => this.hotspotCallSync(c, () => this.hotspots.explainCoupling(c, b ?? {})),
  };
  /** C08 gateway operations. */
  readonly registryOps: Record<string, (ctx: CallContext, b: any) => ApiResult<unknown>> = {
    "C08/proposals": (c, b) => ok(c, this.registry.proposals(b ?? {})),
    "C08/duplicateNames": (c, b) => ok(c, this.registry.duplicateNames(b.revision)),
    "C08/lineage": (c, b) => { const canon = this.registry.canonOf(b.revision, b.entityId); return canon ? ok(c, { canonId: canon, lineage: this.registry.lineage(canon, b.revision), history: this.registry.history(canon) }) : fail(c, { code: "NOT_FOUND", message: "no canonical identity for that entity", retryable: false }); },
    "C08/diverge": (c, b) => ok(c, this.registry.diverge(b.a, b.b)),
    "C08/applyIdentityVerdict": (c, b) => { const r = this.registry.applyIdentityVerdict(c.actor.principalId, b); return r.ok ? ok(c, r.proposal) : fail(c, r.error); },
  };
  /** The model answering questions, for records of what was measured. */
  get activeModel() { return { name: this.model.name, model: this.model.model }; }
  /** F06: historical hotspots and change coupling (see hotspots.ts). Shares the store and the worker. */
  readonly hotspots: HistoryEngine;
  /** C13: event-sourced investigations (see workspaces.ts). */
  readonly workspaceLog: WorkspaceLog;
  /** Hosted-model allowance per repository. Local models are free and never charged. */
  readonly budget = new BudgetController({ tokens: Number(process.env.CIE_HOSTED_TOKEN_BUDGET) || 5_000_000, overageTokens: Number(process.env.CIE_HOSTED_OVERAGE_TOKENS) || 0 });
  /** The last failure from the model provider, cleared by the next success; reported by health(). */
  modelError: string | null = null;

  constructor(store: Store, worker: WorkerClient, model: ModelProvider, offline: ModelProvider = new StubProvider()) {
    this.store = store; this.worker = worker; this.model = model; this.offline = offline;
    this.registry = new Registry(store);
    this.history = new History(store, this.registry);
    this.runtime = new Runtime(store, this.registry);
    this.security = new Security(store);
    this.profiling = new Profiling(worker, store);
    this.profiles = new Profiles(store, worker);
    this.tasks = new Tasks({ store });
    this.indexer = new Indexer(this);
    this.evaluator = new Evaluator(store);
    this.workspaceLog = new WorkspaceLog(store, {
      evidenceState: (revision, evidenceId) => { const rev = this.store.revision(revision), ev = rev ? this.store.evidence(revision, evidenceId) : null; if (!rev || !ev) return "UNAVAILABLE"; const st = this.resolveEvidence(rev, ev).state; return st === "CURRENT" ? "CURRENT" : st === "STALE" ? "STALE" : "UNAVAILABLE"; },
      sourceAvailable: (revision) => { const rev = this.store.revision(revision); return !!rev && existsSync(rev.repoRoot); },
      allowed: (revision) => { const o = revision ? this.store.revision(revision, true) : null; return !(o && this.store.isRevoked(o.repoRoot)); },
    });
    this.collab = new Collab(store, this.workspaceLog);
    this.campaigns = new Campaigns(store, this.campaignAdapters());
    this.journal = new Journal(store);
    this.jobs = new JobRunner(store);
    // F01: the cross-repository search engine shares the store (its own schema slice) and the worker (regex runs there).
    this.search = new SearchEngine(store, () => this.worker);
    // F06: history reads run in the job runner; code-health metrics run in the worker.
    this.hotspots = new HistoryEngine(store, worker);
    this.bus = new EventBus(store);
    // Model-backed seeding (design §20 step 3): hypothesis drafts come from the model gateway through the same
    // egress, scrubbing and budget path as every other model call. The proposers' output is registry-validated
    // and then re-checked by the engine against the pinned scope; nothing it returns is executed or trusted.
    this.c22 = new InvestigationEngine(store, { proposer: (input) => this.c22Proposer(input) });
    // C24 causality v2 (phase 1): scoped, bounded execution-reconstruction. Privileged intake/correction/revocation are
    // engine methods, never on the public catalogue (design §12); queries are tenant-scoped, versioned and bounded.
    this.c24 = new CausalityEngine(store);    this.changes = new ChangeEngine(store);
    this.notifications = new Notifications(store);
    this.exportStore = new ExportStore(store);
    // Durable events become notifications through the same outbox as everything else, so a crash between the two loses neither.
    this.bus.subscribe("webhooks", (ev) => {
      if (ev.topic === "c22.COMPLETION_RECORDED") this.notifications.publish({ eventId: ev.eventId, type: "investigation.completed", revision: null, summary: "An investigation was finalized.", links: { investigation: String(ev.payload.investigationId ?? "") } });
    });
    this.defects = new DefectWorkflow(store);
    // F02: the PR-analysis engine. Its indexing reuses the exact C04 pipeline (same store, same worker);
    // a pending status is publishable on receipt, before any heavy work has run (§7.12).
    this.pr = new PrAnalysis(store, {
      security: this.security, registry: this.registry, history: this.history,
      indexRevision: async (repoPath, control) => {
        const jctx: CallContext = { requestId: `req-pr-index:${randomUUID()}`, idempotencyKey: `pr-index:${repoPath}`, actor: { principalId: "system", tenantId: "local", sessionId: "system" }, deadlineMs: Date.now() + 900_000, traceId: `trace-pr:${randomUUID()}` };
        const r = await this.ingestRepository(jctx, { repoPath }, control);
        if (!r.ok) throw new PrCheckError((r.error.code === "NOT_FOUND" || r.error.code === "INVALID_SCHEMA" || r.error.code === "FORBIDDEN" || r.error.code === "STALE_REVISION" || r.error.code === "EVIDENCE_STALE" ? r.error.code : "NOT_FOUND"), r.error.message);
        return { id: r.value.id, repoRoot: r.value.repoRoot };
      },
    }, { onPending: (analysisId, info) => this.prPendingPublication(analysisId, info) });
    this.prPublisher = new GitHubCheckPublisher(store, this.pr);
  }

  /** A pending status, published through the same grant discipline; the local server acts as the trusted host. */
  private async prPendingPublication(analysisId: string, info: { headHash: string; prNumber: number }) {
    try {
      const r = this.pr.row(analysisId) as { repository_id: string } | undefined;
      if (!r) return;
      const grant = newGrant(this.store, { repositoryId: r.repository_id, headHash: info.headHash, principalId: "system", pending: true, ttlMs: 120_000 });
      await this.prPublisher.publish(grant.id, { repositoryId: r.repository_id, prNumber: info.prNumber, analysisId, headHash: info.headHash, principalId: "system" });
    } catch { /* the publication row carries its own state and error; a pending failure never fails the analysis */ }
  }

  /** C26 Phase A is deliberately report-only: callers supply registered semantic facts for a pinned indexed revision. */
  detectDefects(ctx: CallContext, req: DefectDetectionInput): ApiResult<{ findings: DetectorFinding[]; truncated: boolean }> {
    const parsed = DefectDetectionInputSchema.safeParse(req);
    if (!parsed.success) return fail(ctx, { code: "INVALID_SCHEMA", message: "Invalid defect.v1 detection request", retryable: false });
    req = parsed.data;
    if (ctx.deadlineMs <= Date.now()) return fail(ctx, { code: "DEADLINE_EXCEEDED", message: "The detection deadline has expired", retryable: false });
    if (ctx.expectedRevision && ctx.expectedRevision !== req.revision) return fail(ctx, { code: "STALE_REVISION", message: "The requested revision differs from the expected revision", retryable: false });
    if (!req || typeof req.revision !== "string" || !this.store.revision(req.revision)) return fail(ctx, { code: "NOT_FOUND", message: "the pinned revision is not indexed or is no longer accessible", retryable: false });
    if ((req.lockOrders && !Array.isArray(req.lockOrders)) || (req.memoryAccesses && !Array.isArray(req.memoryAccesses))) return fail(ctx, { code: "INVALID_SCHEMA", message: "lockOrders and memoryAccesses must be arrays", retryable: false });
    const facts = [...(req.lockOrders ?? []), ...(req.memoryAccesses ?? [])];
    const entityIds = new Set(this.store.entities(req.revision).map((e) => e.entityId));
    const policy = policyFor(this.store, this.store.revision(req.revision)!.repoRoot);
    const files = new Map(this.store.entities(req.revision).map((e) => [e.entityId, e.file]));
    for (const fact of facts) {
      if (!fact || typeof fact.id !== "string" || typeof fact.entityId !== "string" || !entityIds.has(fact.entityId)) return fail(ctx, { code: "INVALID_SCHEMA", message: `fact ${fact?.id ?? "(unknown)"} cites an entity outside the pinned revision`, retryable: false });
      if (policy.deniedEntity(fact.entityId, (id) => files.get(id))) return fail(ctx, { code: "FORBIDDEN", message: "The request includes inaccessible entities", retryable: false });
      if (!Array.isArray(fact.evidenceIds) || fact.evidenceIds.length === 0 || fact.evidenceIds.some((id) => typeof id !== "string" || !this.store.evidence(req.revision, id))) return fail(ctx, { code: "EVIDENCE_MISSING", message: `fact ${fact.id} must cite evidence in the pinned revision`, retryable: false });
      for (const id of fact.evidenceIds) {
        const evidence = this.store.evidence(req.revision, id)!;
        if (evidence.state !== "CURRENT") return fail(ctx, { code: "EVIDENCE_STALE", message: "The request cites evidence that is not current", retryable: false });
        if (policy.deniedEntity(evidence.sourceId, (x) => files.get(x))) return fail(ctx, { code: "FORBIDDEN", message: "The request cites inaccessible evidence", retryable: false });
      }
      if (fact.span && fact.span.revision !== req.revision) return fail(ctx, { code: "STALE_REVISION", message: `fact ${fact.id} has a source span from another revision`, retryable: false });
    }
    const supplied = req.lockOrders !== undefined || req.memoryAccesses !== undefined;
    const value = supplied ? detectDefects(req.revision, { lockOrders: req.lockOrders, memoryAccesses: req.memoryAccesses, maxFacts: req.budget?.maxFacts, maxFindings: req.budget?.maxFindings }) : detectIndexedDefects(this.store, req.revision, req.budget);
    const gaps = supplied ? ["Caller-supplied semantic facts have not been independently resolved by the language adapter."] : (value as ReturnType<typeof detectIndexedDefects>).coverageGaps;
    return ok(ctx, value, { revision: req.revision, completeness: "PARTIAL", warnings: [...gaps, ...(value.truncated ? ["The configured analysis bound was reached; findings are incomplete."] : [])] });
  }

  compareDefectBenchmarks(ctx: CallContext, req: { baseline: number[]; candidate: number[]; policy: BenchmarkPolicy }): ApiResult<BenchmarkResult> {
    if (!req || !Array.isArray(req.baseline) || !Array.isArray(req.candidate) || req.baseline.length > 10000 || req.candidate.length > 10000 || !req.policy || !Number.isFinite(req.policy.minimumImprovement) || req.policy.minimumImprovement <= 0 || !Number.isFinite(req.policy.maximumRegression) || req.policy.maximumRegression < 0 || !Number.isSafeInteger(req.policy.minimumSamples) || req.policy.minimumSamples < 1) {
      return fail(ctx, { code: "INVALID_SCHEMA", message: "baseline, candidate, and a valid comparison policy are required", retryable: false });
    }
    return ok(ctx, compareBenchmark(req.baseline, req.candidate, req.policy));
  }

  async defectCall<T>(ctx: CallContext, fn: () => T | Promise<T>): Promise<ApiResult<T>> {
    try { return ok(ctx, await fn()); }
    catch (e) {
      if (e instanceof DefectError) return fail(ctx, { code: e.code, message: e.message, retryable: e.code === "VERSION_CONFLICT" });
      return fail(ctx, { code: "INVALID_SCHEMA", message: "The defect workflow request could not be accepted", retryable: false });
    }
  }

  startDefectDetection(ctx: CallContext, req: DefectDetectionInput): ApiResult<JobView> {
    const parsed = DefectDetectionInputSchema.safeParse(req);
    if (!parsed.success || !ctx.idempotencyKey) return fail(ctx, { code: "INVALID_SCHEMA", message: "A valid detection request and idempotency key are required", retryable: false });
    req = parsed.data;
    if (!this.store.revision(req.revision)) return fail(ctx, { code: "NOT_FOUND", message: "Revision is not accessible", retryable: false });
    const scoped = { ...ctx, idempotencyKey: `defect:${artifactHash([ctx.actor.tenantId, ctx.actor.principalId, ctx.idempotencyKey])}` };
    const hash = artifactHash(req), prior = this.store.jobByIdempotencyKey(scoped.idempotencyKey);
    if (prior && prior.params.defectRequestHash !== hash) return fail(ctx, { code: "VERSION_CONFLICT", message: "Idempotency key was used for a different detection request", retryable: false });
    return ok(ctx, this.jobs.enqueue(scoped, { kind: "defect-detect", params: { revision: req.revision, repoPath: this.store.revision(req.revision)!.repoRoot, defectRequestHash: hash }, run: async (c, control) => {
      control.checkpoint();
      const result = this.detectDefects(c, req);
      if (!result.ok) return result;
      control.commit();
      for (const f of result.value.findings) this.defects.recordFinding({ ...c, idempotencyKey: `${c.idempotencyKey}:${f.id}` }, f);
      return ok(c, result.value.findings, { revision: req.revision, completeness: result.metadata.completeness, warnings: result.metadata.warnings });
    } }));
  }

  /** Public commands do not register adapters, provision grants, dispatch native code, or publish to a forge. */
  readonly defectOps: Record<string, (ctx: CallContext, body: any) => Promise<ApiResult<unknown>>> = {
    "C26/listFindings": (c, b) => this.defectCall(c, () => this.defects.list(b.revision, "finding")),
    "C26/explainFinding": (c, b) => this.defectCall(c, () => {
      const f = this.defects.get<DetectorFinding>(b.findingId, "finding");
      if (f.version !== b.version) throw new DefectError("VERSION_CONFLICT", "Finding version changed");
      return f.value;
    }),
    "C26/defineObligations": (c, b) => this.defectCall(c, () => this.defects.defineObligations(c, b.findingId, b.expectedVersion, b.obligations)),
    "C27/listCapabilities": (c, b) => this.defectCall(c, () => this.defects.listCapabilities(b.languageId, b.platformId)),
    "C27/prepareExperiment": (c, b) => this.defectCall(c, () => this.defects.prepareExperiment(c, b.spec)),
    "C27/getRunManifest": (c, b) => this.defectCall(c, () => this.defects.get(b.manifestId, "manifest").value),
    "C28/proposeFix": (c, b) => this.defectCall(c, () => this.defects.proposeFix(c, b.proposal)),
    "C28/validateFix": (c, b) => this.defectCall(c, () => this.defects.validateFix(c, b)),
    "C30/preparePullRequest": (c, b) => this.defectCall(c, () => this.defects.preparePullRequest(c, b)),
  };

  // ---------------------------------------------------------------- model gateway with egress control
  private async callModel<T>(ctx: CallContext, rev: RevisionRow, req: ModelRequest): Promise<{ result: GatewayResult<T> | GatewayFailure; provider: ModelProvider; note?: string }> {
    let provider = this.model, note: string | undefined, request = req;
    // Fail closed: anything that is not clearly "stays on this machine" is treated as leaving it, and anything that goes wrong
    // while deciding or recording an egress means nothing is sent. An unknown provider, an unreadable policy, an audit that
    // cannot be written, a scrubber that throws: each of those is a refusal, not a pass-through.
    if (provider.hosted !== false) {
      let allowed = false;
      try { allowed = this.store.allowHosted(rev.repoRoot) === true; } catch { allowed = false; }
      if (!allowed) {
        provider = this.offline;
        note = "Sending code structure to the hosted model is not approved for this repository, so the offline model answered. Approve it under Repository → hosted model.";
        try { this.store.audit(actor(ctx), "egress.denied", rev.repoRoot, { purpose: req.purpose, destination: `${this.model.name}/${this.model.model}` }); } catch { /* the denial stands even if it could not be logged */ }
      } else {
        try {
          const scrub = scrubBundle(req.bundle);
          request = { ...req, bundle: scrub.bundle };
          // The record is written before anything is sent: a send that cannot be audited does not happen.
          this.store.audit(actor(ctx), "egress.approved", rev.repoRoot, {
            purpose: req.purpose, destination: `${provider.name}/${provider.model}`, payloadHash: payloadHash(scrub.bundle), fields: EGRESS_FIELDS, redactions: scrub.removed.length, minimized: scrub.minimized,
          });
          if (scrub.removed.length) note = `${scrub.removed.length} element(s) that looked like secrets were removed before sending.`;
        } catch (e) {
          provider = this.offline; request = req;
          note = "Sending to the hosted model was stopped because the safety checks before it could not complete, so the offline model answered.";
          try { this.store.audit(actor(ctx), "egress.denied", rev.repoRoot, { purpose: req.purpose, destination: `${this.model.name}/${this.model.model}`, reason: "pre-send check failed" }); } catch { /* ignore */ }
          void e;
        }
      }
    }
    const hostedCall = provider.hosted !== false;
    let result = await runModel<T>(provider, request, { deadlineMs: Math.max(1000, ctx.deadlineMs - Date.now()), budget: hostedCall ? { controller: this.budget, scope: rev.repoRoot } : undefined });
    if (hostedCall && !result.ok && result.error.code === "BUDGET_EXCEEDED") {
      // Feature degradation, not failure: the offline model answers and the person is told why.
      try { this.store.audit(actor(ctx), "budget.exhausted", rev.repoRoot, { purpose: req.purpose, message: result.error.message }); } catch { /* ignore */ }
      note = `The hosted-model budget for this repository is used up (${result.error.message}), so the offline model answered.`;
      provider = this.offline;
      result = await runModel<T>(provider, req, { deadlineMs: Math.max(1000, ctx.deadlineMs - Date.now()) });
    }
    if (provider === this.model) this.modelError = result.ok ? null : result.error.code;
    return { result, provider, note };
  }

  private persist(claims: Claim[]) { for (const c of claims) this.store.putClaim(c); }

  // ---------------------------------------------------------------- repository
  async ingestRepository(ctx: CallContext, req: { repoPath: string }, control?: JobControl): Promise<ApiResult<RevisionRow & { reuse?: { files: number; of: number }; delta?: { mode: string; changed: number; removed: number; of: number; phasesMs?: Record<string, number> } }>> {
    if (!req.repoPath || !isAbsolute(req.repoPath)) return fail(ctx, { code: "INVALID_SCHEMA", message: "repoPath must be an absolute path", retryable: false });
    if (this.store.isRevoked(req.repoPath)) return fail(ctx, { code: "FORBIDDEN", message: "access to this source was withdrawn; it is not indexed until access is granted again", retryable: false });
    try {
      // Incremental re-index: tell the parser which revision we already hold and what it holds of it (a digest per file), and it sends back only the
      // files whose rows differ, or nothing when the worktree is that revision. Parses of unchanged files are reused by the parser itself, by content.
      const phases: Record<string, number> = {};
      const lap = <T>(name: string, fn: () => T): T => { const t = performance.now(); try { return fn(); } finally { phases[name] = Math.round((phases[name] ?? 0) + performance.now() - t); } };
      const prev = this.store.latestRevision(req.repoPath);
      const prevFiles = prev ? this.store.revisionFiles(prev.id) : {};
      const base = prev && Object.keys(prevFiles).length ? { revision: prev.id, analyzerVersion: prev.analyzerVersion, digests: prevFiles } : undefined;
      control?.progress({ phase: "hashing", message: base ? "Checking which files changed…" : "Reading the repository…" });
      control?.checkpoint();
      control?.progress({ phase: "parsing", message: "Parsing the code…" });
      // The parser is one blocking call, so cancelling it means ending the process (a fresh one replaces it).
      // The parser is one blocking call, so cancelling it means ending the process (a fresh one replaces it).
      const stopWorker = control?.onCancel(() => this.worker.abort());
      const runIndex = async (withBase: typeof base) => {
        const run = this.worker.index(req.repoPath, control ? 600_000 : 120_000, undefined, withBase);
        return control ? await control.guard(run) : await run;
      };
      let batch: AnalysisBatch, row: RevisionRow;
      const parentId = prev?.id ?? null;
      try {
        const tw = performance.now();
        batch = await runIndex(base);
        phases.parserAndTransfer = Math.round(performance.now() - tw);
        control?.commit();
        if (batch.mode === "unchanged" && this.store.revision(batch.revision)) row = this.store.revision(batch.revision)!;
        else if (batch.mode === "delta") {
          try { row = lap("store", () => this.store.putDelta(batch)); }
          catch (e) {
            if (!(e instanceof DeltaBaseError)) throw e;
            // The base could not be built on (an older database, or a mismatch): index in full instead, and say so.
            this.store.audit(actor(ctx), "repo.ingest", req.repoPath, { incremental: `delta refused: ${e.message}; indexing in full` });
            batch = await runIndex(undefined);
            row = lap("store", () => this.store.putBatch(batch));
          }
        } else if (batch.mode === "unchanged") { batch = await runIndex(undefined); row = lap("store", () => this.store.putBatch(batch)); } // the parser said unchanged but the revision is gone
        else row = lap("store", () => this.store.putBatch(batch));
      } finally { stopWorker?.(); }
      // Stable identities across revisions (C08). A failure here must not lose the index: identities can be rebuilt later.
      try { lap("identities", () => this.registry.registerRevision(row.id, parentId && parentId !== row.id ? parentId : null)); } catch (e) { this.store.audit(actor(ctx), "registry.failed", row.id, { error: String((e as Error).message).slice(0, 200) }); }
      const reused = batch.diagnostics.find((d) => d.code === "REUSED_CACHED_PARSES");
      const unchanged = batch.mode === "unchanged";
      const reuse = unchanged ? { files: row.fileCount, of: row.fileCount } : reused ? { files: Number((/^incremental: (\d+)/.exec(reused.message)?.[1]) ?? 0), of: row.fileCount } : undefined;
      const delta = { mode: batch.mode ?? "full", changed: batch.changedFiles?.length ?? row.fileCount, removed: batch.removedFiles?.length ?? 0, of: row.fileCount };
      this.store.audit(actor(ctx), "repo.ingest", row.repoRoot, { revision: row.id, files: row.fileCount, mode: delta.mode, changedFiles: delta.changed, removedFiles: delta.removed, reusedParses: unchanged ? "all (worktree is the previous revision)" : reused?.message ?? "none (full parse)", phasesMs: phases });
      const tests = lap("testArtifacts", () => ingestTestArtifacts(this.store, row));
      const warnings = batch.diagnostics.filter((d) => d.code !== "REUSED_CACHED_PARSES").map((d) => d.message);
      const spans = lap("traceExports", () => ingestTraceExports(this.store, row));
      if (spans) warnings.push(`Loaded trace exports (${spans.found.join(", ")}): ${spans.spans} span(s), ${spans.errors} error span(s)${spans.p95 !== null ? `, p95 ${spans.p95} ms` : ""}.`, ...spans.staleness.map((x) => `Trace data may be out of date: ${x}`));
      if (delta.mode === "delta") warnings.unshift(`Incremental: ${delta.changed} of ${delta.of} file(s) changed${delta.removed ? `, ${delta.removed} removed` : ""}; the rest were carried over from the previous revision.`);
      else if (reuse) warnings.unshift(reuse.files === reuse.of ? "All files unchanged since the previous revision; every parse was reused." : `Incremental: parsed ${reuse.of - reuse.files} of ${reuse.of} file(s); the rest were reused from cache.`);
      if (tests) warnings.push(`Loaded test artifacts (${tests.found.join(", ")}): ${tests.tests.passed} passed, ${tests.tests.failed} failed${tests.coverageLinePercent !== null ? `, ${tests.coverageLinePercent}% line coverage` : ""}.`, ...tests.staleness.map((x) => `Test data may be out of date: ${x}`));
      // Auto-detect a GitHub source for this repository. Failure here is never fatal to indexing.
      try {
        const ghConn = ensureGhForgeConnector(this.store, row.repoRoot);
        if (ghConn) this.store.audit(actor(ctx), "source.gh.auto", row.repoRoot, { sourceId: ghConn.health().sourceId });
      } catch (e) { this.store.audit(actor(ctx), "source.gh.auto_failed", row.repoRoot, { error: String((e as Error).message).slice(0, 200) }); }
      this.scheduleSearchIndex(row.repoRoot, row.id, ctx);
      return ok(ctx, { ...row, reuse, delta: { ...delta, phasesMs: phases } }, { revision: row.id, warnings, completeness: batch.diagnostics.some((d) => d.code !== "REUSED_CACHED_PARSES") ? "PARTIAL" : "COMPLETE" });
    } catch (e) {
      if (e instanceof Cancelled || (control && e instanceof WorkerError && e.api.code === "CANCELLED")) throw new Cancelled();
      return fail(ctx, e instanceof WorkerError ? e.api : storageFailure(e));
    }
  }

  // ---------------------------------------------------------------- C22 hypothesis and agentic investigation
  /** Model-backed candidate generation (design §20 step 3): retrieval builds a scoped bundle, the gateway returns
   *  registry-validated draft hypotheses. Throwing is safe: the engine records the proposer's failure in the seed
   *  step's rejected list with a safe reason, and the deterministic candidates still stand. */
  private async c22Proposer(input: { question: string; roots: string[]; revision: string }): Promise<HypothesisDraft[]> {
    const rev = this.store.revision(input.revision);
    if (!rev) return [];
    const { bundle } = retrieveForQuestion(this.store, rev.id, input.question, { extraSeeds: input.roots, access: policyFor(this.store, rev.repoRoot), tokenBudget: chunkTokenBudget() });
    const { result, note } = await this.callModel<HypothesesOutput>(seedContext(), rev, { purpose: "HYPOTHESIZE", schemaId: SCHEMA_HYPOTHESES, question: input.question, bundle });
    if (!result.ok) {
      const why = note ? ` ${note}` : "";
      throw new Error(result.error.code === "INVALID_SCHEMA"
        ? `the model's candidates did not match the registered schema (${result.error.message})${why}`
        : `no model candidates: ${result.error.message}${why}`);
    }
    return toDrafts(result.value, bundle);
  }

  /** Run an engine call as an API call: typed errors become typed failures, never exceptions across the boundary. */
  async c22Call<T>(ctx: CallContext, fn: () => T | Promise<T>): Promise<ApiResult<T>> {
    try { return ok(ctx, await fn()); }
    catch (e) {
      if (e instanceof C22Error) return fail(ctx, { code: e.code, message: e.message, retryable: e.code === "VERSION_CONFLICT", ...(e.currentVersion !== undefined ? { currentVersion: e.currentVersion } : {}) });
      return fail(ctx, storageFailure(e));
    }
  }

  /** Schedule one bounded wave as a job (the same C07 queue); the wave commits its own snapshot even if the question stays unresolved. */
  private startWave(ctx: CallContext, investigationId: string, expectedVersion: number, maxSteps: number) {
    const admitted = this.c22.admitWave(ctx, { investigationId, expectedVersion });
    return this.jobs.enqueue(ctx, {
      kind: "investigate", params: { investigationId },
      run: async (jctx) => { try { return ok(jctx, await this.c22.runWave(investigationId, admitted.generation, maxSteps)); } catch (e) { return fail(jctx, storageFailure(e)); } },
    });
  }
  /** Await a wave and return the snapshot it committed (for callers that want a synchronous answer). */
  async runInvestigation(ctx: CallContext, req: { investigationId: string; expectedVersion?: number; maximumStepsThisWave?: number }) {
    const snap = this.c22.load(req.investigationId);
    const job = this.startWave(ctx, req.investigationId, req.expectedVersion ?? snap.version, req.maximumStepsThisWave ?? snap.policy.maxPlanSteps);
    await this.jobs.settled(job.id);
    return this.c22.load(req.investigationId);
  }

  /** The proposed v2 catalogue (design §5). Privileged operations (runtime intake, experiment dispatch, revocation) are not in this table. */
  readonly c22v2: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>>> = {
    create: (c, b) => this.c22Call(c, () => this.c22.create(c, b)),
    get: (c, b) => this.c22Call(c, () => this.c22.get(b.investigationId)),
    list: (c, b) => this.c22Call(c, () => this.c22.list(b.workspaceId, b.limit)),
    proposeHypothesis: (c, b) => this.c22Call(c, () => this.c22.proposeHypothesis(c, b).value),
    reviseHypothesis: (c, b) => this.c22Call(c, () => this.c22.reviseHypothesis(c, b).value),
    retireHypothesis: (c, b) => this.c22Call(c, () => this.c22.retireHypothesis(c, b).receipt),
    proposeChecks: (c, b) => this.c22Call(c, () => this.c22.proposeChecks(c, b).value),
    advanceV2: (c, b) => this.c22Call(c, () => this.startWave(c, b.investigationId, b.expectedVersion, b.maximumStepsThisWave ?? 8)),
    attachEvidence: (c, b) => this.c22Call(c, () => { const r = this.c22.attachEvidence(c, b); return { receipt: r.receipt, observationIds: r.value.observationIds, scheduledAssessmentStepIds: r.value.scheduledAssessmentStepIds, rejectedEvidenceIds: [] as string[] }; }),
    reassess: (c, b) => this.c22Call(c, () => this.c22.reassess(c, b).receipt),
    steerV2: (c, b) => this.c22Call(c, () => { const r = this.c22.steer(c, b); return { snapshot: this.c22.load(b.investigationId), invalidatedAttemptIds: r.value.invalidatedAttemptIds, clarification: r.value.clarification }; }),
    pause: (c, b) => this.c22Call(c, () => this.c22.pause(c, b).receipt),
    resume: (c, b) => this.c22Call(c, () => { this.c22.resume(c, b); return this.c22.load(b.investigationId); }),
    cancel: (c, b) => this.c22Call(c, () => this.c22.cancel(c, b).receipt),
    getCompletion: (c, b) => this.c22Call(c, () => this.c22.getCompletion(b.investigationId)),
    finalize: (c, b) => this.c22Call(c, () => this.c22.finalize(c, b).value),
    reopen: (c, b) => this.c22Call(c, () => { this.c22.reopen(c, b); return this.c22.load(b.investigationId); }),
    proposeExperiment: (c, b) => this.c22Call(c, () => this.c22.proposeExperiment(c, b).value),
    getBoard: (c, b) => this.c22Call(c, () => this.c22.getBoard(b.investigationId, b.knownVersion)),
    getDetails: (c, b) => this.c22Call(c, () => this.c22.getDetails(b.investigationId)),
    readEvents: (c, b) => this.c22Call(c, () => this.c22.readEvents(b.investigationId, Number(b.afterSequence) || 0, b.limit)),
  };

  /** The original five APIs, preserved. `start` makes a READY plan with a seed step and does not wait for seeding. */
  readonly c22Legacy: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>>> = {
    start: (c, b) => this.c22Call(c, () => { const s = this.c22.create(c, { workspaceId: b.workspaceId, goal: b.goal }); return toPlan(s, this.c22.stepsOf(s.id)); }),
    advance: (c, b) => this.c22Call(c, () => this.startWave(c, b.planId, b.expectedVersion, 8)),
    steer: (c, b) => this.c22Call(c, () => { const r = this.c22.steerLegacy(c, { investigationId: b.planId, expectedVersion: b.expectedVersion, instruction: b.instruction }); const s = this.c22.load(b.planId); return { ...toPlan(s, this.c22.stepsOf(s.id)), clarification: r.value.clarification }; }),
    interrupt: (c, b) => this.c22Call(c, () => this.c22.pause(c, { investigationId: b.planId, expectedVersion: b.expectedVersion, reason: "interrupted" }).receipt),
    // A summary read: it does not close or finalize anything.
    conclude: (c, b) => this.c22Call(c, () => this.c22.getCompletion(b.planId).findings),
  };

  /** C24 causality v2 public catalogue: scoped reads and gated delegations only. registerAdapter/ingestEvents/
   *  applyCorrection/invalidateSource stay privileged engine operations (design §12) and are deliberately absent. */
  readonly c24v2: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>>> = {
    reconstruct: (c, b) => this.okCall(c, () => this.c24.reconstruct(b.scope as CausalityScopeInput, { maxEvents: b.maxEvents })),
    querySlice: (c, b) => this.okCall(c, () => this.c24.querySlice(b.snapshotId, b)),
    traceAncestors: (c, b) => this.okCall(c, () => this.c24.traceAncestors(b.snapshotId, b.eventId, b.maxEvents)),
    checkOrder: (c, b) => this.okCall(c, () => this.c24.checkOrder(b.snapshotId, b.fromEventId, b.toEventId)),
    explainRelation: (c, b) => this.okCall(c, () => this.c24.explainRelation(b.snapshotId, b.edgeId)),
    criticalPath: (c, b) => this.okCall(c, () => this.c24.criticalPath(b.snapshotId, b.operationId)),
    getCoverage: (c, b) => this.okCall(c, () => this.c24.getCoverage(b.snapshotId)),
    getSnapshot: (c, b) => this.okCall(c, () => { const s = this.c24.snapshot(b.snapshotId); if (!s) return { ok: false as const, error: { code: "NOT_FOUND", message: "no such snapshot", retryable: false } }; return { ok: true as const, value: s }; }),
    readUpdates: (c, b) => this.okCall(c, () => this.c24.readUpdates(b.snapshotId, Number(b.afterSequence) || 0, b.limit)),
    buildMechanismEvidence: (c, b) => this.okCall(c, () => { const r = this.c24.buildMechanismEvidence(b.snapshotId, b.symptomEventIds ?? [], b.mechanismKinds); if (!r.ok) return r as any; this.c24.keepMechanisms(r.value); return r as any; }),
    proposeCausalClaim: (c, b) => this.okCall(c, () => this.c24.proposeCausalClaim(b.snapshotId, b)),
    linkInterventionEvidence: (c, b) => this.okCall(c, () => this.c24.linkInterventionEvidence(b)),
    replayPlayback: (c, b) => this.okCall(c, () => this.c24.replayPlayback(b.snapshotId, b.cursorMs)),
  };

  /** Typed engine results flow through as ApiResult; unexpected throws become storage failures, never raw errors. */
  private async okCall<T>(ctx: CallContext, fn: () => { ok: true; value: T } | { ok: false; error: ApiError }): Promise<ApiResult<T>> {
    try { const r = fn(); return r.ok ? ok(ctx, r.value) : fail(ctx, r.error); }
    catch (e) { return fail(ctx, storageFailure(e)); }
  }

  // ---------------------------------------------------------------- C03 source permission
  /**
   * Withdraw permission to read a repository. From this call on every read treats it as not indexed (nothing derived from it can
   * be fetched, even before the purge), investigations over it lose access, queued and running jobs for it are cancelled,
   * and by default everything derived from it is deleted. Re-indexing it is refused until access is granted again.
   */
  revokeSource(ctx: CallContext, req: { repoRoot: string; purge?: boolean }): ApiResult<{ revoked: true; purged: boolean; investigations: number; jobsCancelled: number; rowsAfter: number }> {
    if (!req.repoRoot || !isAbsolute(req.repoRoot)) return fail(ctx, { code: "INVALID_SCHEMA", message: "repoRoot must be an absolute path", retryable: false });
    try {
      for (const r of this.store.db.prepare("select id from revisions where repo_root = ?").all(req.repoRoot) as { id: string }[]) this.notifications.cancelForRevision(r.id);
      this.store.setRevoked(req.repoRoot, true);
      let investigations = 0;
      for (const r of this.store.db.prepare("select id, json from c22_investigations where deleted = 0").all() as { id: string; json: string }[]) {
        try { if ((JSON.parse(r.json).scope?.repoRoot) === req.repoRoot) { this.c22.revokeAccess(r.id, "source-revoked"); investigations++; } } catch { /* already stopped */ }
      }
      let jobsCancelled = 0;
      for (const j of this.store.activeJobs()) if (j.params.repoPath === req.repoRoot) { const c = this.jobs.cancel(j.id); if (c?.cancelled) jobsCancelled++; }
      this.store.audit(actor(ctx), "source.revoke", "(source)", { investigations, jobsCancelled, purge: req.purge !== false });
      let rowsAfter = 0, purged = false;
      if (req.purge !== false) {
        try { const rid = this.search.repositoryOfRoot(req.repoRoot)?.repositoryId; if (rid) this.search.purgeRepository(rid); } catch (e) { this.store.audit(actor(ctx), "search.purge_failed", req.repoRoot, { error: String((e as Error).message).slice(0, 200) }); }
        const d = deleteRepo(this.store, req.repoRoot, actor(ctx)); rowsAfter = d.rowsAfter; purged = true;
      }
      return ok(ctx, { revoked: true, purged, investigations, jobsCancelled, rowsAfter });
    } catch (e) { return fail(ctx, storageFailure(e)); }
  }
  grantSource(ctx: CallContext, req: { repoRoot: string }): ApiResult<{ granted: true }> {
    this.store.setRevoked(req.repoRoot, false);
    this.store.audit(actor(ctx), "source.grant", "(source)", {});
    return ok(ctx, { granted: true });
  }

  // ---------------------------------------------------------------- F01 cross-repository search (search.ts)
  /** Idempotent per revision: a worktree that did not change does not enqueue another build; priorities let the
   *  caller's interactive build pass a backfill. Returns the job, or null when search is off for the deployment. */
  private scheduleSearchIndex(repoRoot: string, revision: string, caller?: CallContext, priority = 10) {
    if (!this.search.searchEnabled()) return null;
    const jctx: CallContext = {
      requestId: `req-search:${randomUUID()}`,
      idempotencyKey: `search-index:${repoRoot}:${revision}`,
      actor: caller?.actor ?? { principalId: "system", tenantId: "local", sessionId: "system" }, // a build job acts as the deployment, not a person
      deadlineMs: Date.now() + 600_000, traceId: `trace-search:${randomUUID()}`,
    };
    return this.jobs.enqueue(jctx, {
      kind: "search-index", priority, params: { repoPath: repoRoot },
      run: async (jctx2) => {
        try {
          const r = await this.search.buildForRepository(repoRoot);
          return ok(jctx2, r, { warnings: r.warnings, completeness: r.state === "SUPERSEDED" ? "PARTIAL" : "COMPLETE" });
        } catch (e) { return fail(jctx2, storageFailure(e)); }
      },
    });
  }
  private async searchCall<T>(ctx: CallContext, fn: () => Promise<T | ApiFail> | T | ApiFail): Promise<ApiResult<T>> {
    try {
      const v = await fn();
      if (v && (v as { ok?: boolean }).ok === false) return fail(ctx, (v as ApiFail).error);
      return ok(ctx, v as T);
    } catch (e) { return fail(ctx, storageFailure(e)); }
  }
  /** F01 gateway operations (§8). Only enqueueIndex mutates; the rest read revision-bound states. */
  readonly searchOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    "C10/search": (c, b) => this.searchCall(c, () => this.search.search(c, b ?? {})),
    "C04/listRepositories": (c, b) => ok(c, { repositories: this.search.listRepositories(c, b?.includeCoverage === true) }),
    "C05/resolveDefinition": async (c, b) => {
      const r = await this.searchCall(c, () => this.search.resolveDefinition(c, b ?? {}));
      return r.ok ? ok(c, { ...r.value, gaps: (r.value?.gaps ?? []).map((g: string) => ({ code: "UNRESOLVED_REFERENCE", message: g, relatedEntityIds: [], retryable: false })), ...(r.value?.locations?.length ? { revision: r.value.locations[0].revision } : {}) }) : r;
    },
    "C09/findReferences": (c, b) => this.searchCall(c, () => this.search.findReferences(c, b ?? {})),
    "C07/indexStatus": (c, b) => { const r = this.search.indexStatus(c, b ?? {}); return (r as { ok?: boolean }).ok === false ? (r as ApiResult<never>) : ok(c, r); },
    "C07/enqueueIndex": async (c, b) => {
      if (typeof b?.repositoryId !== "string" && typeof b?.repoPath !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give a repositoryId or a repoPath", retryable: false });
      const root = typeof b.repositoryId === "string" ? this.search.rootOf(b.repositoryId) : b.repoPath;
      if (!root) return fail(c, { code: "NOT_FOUND", message: "no such repository", retryable: false });
      const revision = typeof b.revision === "string" ? b.revision : this.store.latestRevision(root)?.id;
      if (!revision) return fail(c, { code: "NOT_FOUND", message: "this repository has no indexed revision; run C04/ingestRepository first", retryable: true });
      const priority = ({ INTERACTIVE: 100, LIVE: 10, BACKFILL: 0 } as Record<string, number | undefined>)[b?.priority ?? "LIVE"] ?? 10;
      const job = this.scheduleSearchIndex(root, revision, c, priority);
      if (!job) return fail(c, { code: "PROVIDER_UNAVAILABLE", message: "search is disabled for this deployment (CIE_SEARCH=off or the search flag is off)", retryable: false });
      if (b?.wait === false) return ok(c, job);
      const done = await this.jobs.settled(job.id);
      if (done.error) return fail(c, done.error);
      return ok(c, { ...done, value: done.result?.value, warnings: done.result?.warnings ?? [] });
    },
  };

  // ---------------------------------------------------------------- F06 historical hotspots and change coupling (hotspots.ts)
  /** History analysis is off only when the deployment says so; reads never touch the model. */
  historyEnabled(): boolean { return process.env.CIE_HISTORY !== "off"; }
  private hotspotCallSync<T>(ctx: CallContext, fn: () => T | ApiFail): ApiResult<T> {
    try {
      const v = fn();
      if (v && (v as { ok?: boolean }).ok === false) return fail(ctx, (v as ApiFail).error);
      return ok(ctx, v as T);
    } catch (e) {
      if (e instanceof PolicyError) return fail(ctx, { code: "INVALID_SCHEMA", message: e.message, retryable: false });
      return fail(ctx, storageFailure(e));
    }
  }
  private async hotspotCall<T>(ctx: CallContext, fn: () => Promise<T | ApiFail> | T | ApiFail): Promise<ApiResult<T>> {
    try {
      const v = await fn();
      if (v && (v as { ok?: boolean }).ok === false) return fail(ctx, (v as ApiFail).error);
      return ok(ctx, v as T);
    } catch (e) {
      if (e instanceof PolicyError) return fail(ctx, { code: "INVALID_SCHEMA", message: e.message, retryable: false });
      return fail(ctx, storageFailure(e));
    }
  }
  /**
   * C26 history operations (§8). `analyzeHistory` and the two settings mutate; the rest read a stored
   * run and cannot see files the caller is denied (A3/A6 are enforced inside the engine).
   */
  readonly hotspotOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    "C26/analyzeHistory": async (c, b) => {
      if (!this.historyEnabled()) return fail(c, { code: "PROVIDER_UNAVAILABLE", message: "history analysis is disabled for this deployment (CIE_HISTORY=off)", retryable: false });
      let policy;
      try { policy = normalizePolicy(b?.policy ?? {}); } catch (e) { if (e instanceof PolicyError) return fail(c, { code: "INVALID_SCHEMA", message: e.message, retryable: false }); throw e; }
      const root = typeof b?.repositoryId === "string" ? this.hotspots.rootFor(b.repositoryId) : typeof b?.repoPath === "string" ? resolve(b.repoPath) : this.store.latestRevision()?.repoRoot;
      if (!root) return fail(c, { code: "NOT_FOUND", message: "give a repositoryId or a repoPath, or index a repository first", retryable: false });
      if (!existsSync(root)) return fail(c, { code: "NOT_FOUND", message: "that folder does not exist", retryable: false });
      const head = inspectHead(root);
      if (!head.isRepo) return fail(c, { code: "INSUFFICIENT_EVIDENCE", message: "this folder is not a Git work tree, so history-based hotspots cannot be computed", retryable: false });
      if (!head.head) return fail(c, { code: "INSUFFICIENT_EVIDENCE", message: "this repository has no commits yet, so there is no history to analyse", retryable: false });
      const priority = ({ INTERACTIVE: 100, LIVE: 10, BACKFILL: 0 } as Record<string, number | undefined>)[b?.priority ?? "LIVE"] ?? 10;
      const pH = policyHash(policy);
      const jctx: CallContext = {
        requestId: `req-history:${randomUUID()}`,
        idempotencyKey: `history-analysis:${root}:${pH}`,
        actor: c.actor, deadlineMs: Date.now() + 600_000, traceId: `trace-history:${randomUUID()}`,
      };
      const job = this.jobs.enqueue(jctx, {
        kind: "history-analysis", priority, params: { repoPath: root },
        run: async (jctx2, control) => {
          try {
            const r = await this.hotspots.runAnalysis(jctx2, control, root, policy, Math.max(5_000, jctx2.deadlineMs - Date.now()));
            return ok(jctx2, r, { warnings: r.warnings, completeness: r.state === "PARTIAL" ? "PARTIAL" : "COMPLETE" });
          } catch (e) {
            if (e instanceof PolicyError) return fail(jctx2, { code: "INVALID_SCHEMA", message: e.message, retryable: false });
            return fail(jctx2, storageFailure(e));
          }
        },
      });
      if (b?.wait === false) return ok(c, job);
      const done = await this.jobs.settled(job.id);
      if (done.error) return fail(c, done.error);
      const value = done.result?.value as { runId?: string; state?: string; commitCount?: number } | undefined;
      return ok(c, { ...done, ...(value ? { runId: value.runId, state: value.state, commitCount: value.commitCount } : {}), value, warnings: done.result?.warnings ?? [] });
    },
    "C26/getHotspotReport": (c, b) => this.hotspotCall(c, () => this.hotspots.getReport(c, b ?? {})),
    "C26/listCoupling": (c, b) => this.hotspotCall(c, () => this.hotspots.listCoupling(c, b ?? {})),
    "C26/rankStability": (c, b) => this.hotspotCall(c, () => this.hotspots.rankStability(c, b ?? {})),
    /** Contributor display names leave the store only for a granted principal with a policy that allows them (F06-A6). */
    "C26/grantContributorNames": (c, b) => {
      const granted = b?.grant !== false;
      this.hotspots.grantContributorNames(c.actor.principalId, granted);
      this.store.audit(actor(c), granted ? "history.grantNames" : "history.revokeNames", "(history)", {});
      return ok(c, { granted });
    },
    /** §17: opt this store into the F06 terrain factors (churn and knowledge from the analysed history). */
    "C26/setHistoryTerrain": (c, b) => {
      const enabled = b?.enabled === true;
      this.hotspots.setTerrainV2(enabled);
      this.store.audit(actor(c), "history.setTerrain", "(history)", { enabled });
      return ok(c, { enabled });
    },
  };

  // ---------------------------------------------------------------- C27 counterfactual scenarios
  /** Evaluate a typed what-if against a revision. Reads only. A scenario that cannot mean anything is refused with every reason. */
  evaluateScenario(ctx: CallContext, req: { revision?: string; scenario: Scenario; assumptions?: AssumptionInput[]; capacity?: CapacityData | null }): ApiResult<ScenarioResult> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    try {
      const r = evaluateScenario(this.store, rev, req.scenario, { assumptions: req.assumptions, capacity: req.capacity });
      this.store.audit(actor(ctx), "scenario.evaluate", rev.id, { ops: req.scenario.ops.length, level: req.scenario.level });
      return ok(ctx, r, { revision: rev.id });
    } catch (e) { if (e instanceof ScenarioError) return fail(ctx, { code: "INVALID_SCHEMA", message: e.message, retryable: false }); return fail(ctx, storageFailure(e)); }
  }
  compareScenarios(ctx: CallContext, req: { a: ScenarioResult; b: ScenarioResult }): ApiResult<ReturnType<typeof compareScenarios>> {
    try { return ok(ctx, compareScenarios(req.a, req.b)); } catch (e) { if (e instanceof ScenarioError) return fail(ctx, { code: "INVALID_SCHEMA", message: e.message, retryable: false }); throw e; }
  }

  // ---------------------------------------------------------------- C28 visual intent and change proposals
  async changeCall<T>(ctx: CallContext, fn: () => T | Promise<T>): Promise<ApiResult<T & unknown>> {
    try { return ok(ctx, await fn()); }
    catch (e) {
      if (e instanceof ChangeError) return fail(ctx, { code: e.code === "NEEDS_CLARIFICATION" ? "INSUFFICIENT_EVIDENCE" : e.code, message: e.message + (e.options ? ` Options: ${e.options.map((o) => `${o.id} (${o.label})`).join("; ")}` : ""), retryable: e.code === "NEEDS_CLARIFICATION" });
      return fail(ctx, storageFailure(e));
    }
  }
  /** Gestures and proposals. Nothing here writes to the repository: a proposal is data, and what leaves is a patch. */
  readonly changeOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>>> = {
    "C28/interpretDrag": (c, b) => this.changeCall(c, () => this.changes.interpretDrag(b.revision, b)),
    "C28/proposeFromDrag": (c, b) => this.changeCall(c, () => {
      const g = this.changes.interpretDrag(b.revision, b);
      const pick = b.choice ? g.options.find((o) => o.id === b.choice) : g.outcome === "READY" ? g.options[0] : undefined;
      if (g.outcome === "REJECTED") throw new ChangeError("INVALID_SCHEMA", g.reason ?? "that gesture means nothing here");
      if (!pick) throw new ChangeError("NEEDS_CLARIFICATION", g.reason ?? "that gesture can mean more than one thing", g.options);
      return this.changes.propose(c.actor.principalId, { revision: b.revision, intent: pick.intent });
    }),
    "C28/propose": (c, b) => this.changeCall(c, () => this.changes.propose(c.actor.principalId, { revision: b.revision, intent: b.intent as Intent })),
    "C28/get": (c, b) => this.changeCall(c, () => this.changes.checkFresh(c.actor.principalId, b.proposalId)),
    "C28/list": (c, b) => this.changeCall(c, () => this.changes.list(b.revision)),
    "C28/validate": (c, b) => this.changeCall(c, () => this.changes.validate(c.actor.principalId, b.proposalId)),
    "C28/approve": (c, b) => this.changeCall(c, () => this.changes.approve(c.actor.principalId, b.proposalId, b.expectedVersion, b.explanation)),
    "C28/reject": (c, b) => this.changeCall(c, () => this.changes.reject(c.actor.principalId, b.proposalId, b.reason)),
    "C28/exportPatch": (c, b) => this.changeCall(c, () => this.changes.exportPatch(c.actor.principalId, b.proposalId)),
  };

  // ---------------------------------------------------------------- C30 exports and notifications
  async exportCall<T>(ctx: CallContext, fn: () => T | Promise<T>): Promise<ApiResult<T>> {
    try { return ok(ctx, await fn()); } catch (e) { if (e instanceof ExportError) return fail(ctx, { code: e.code, message: e.message, retryable: false }); return fail(ctx, storageFailure(e)); }
  }
  /** What leaves this system. Claims are read from the store and carry their mode, confidence, state and revision; refuted, hidden and denied ones do not leave. */
  readonly exportOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>>> = {
    "C30/exportClaims": (c, b) => this.exportCall(c, () => {
      const rev = b.revision ? this.store.revision(b.revision) : this.store.latestRevision();
      if (!rev) throw new ExportError("NOT_FOUND", "no indexed revision, or access to it was withdrawn");
      return this.exportStore.create(rev, buildExport(this.store, rev, { title: b.title, claimIds: b.claimIds, format: b.format ?? "markdown" }), actor(c));
    }),
    "C30/getExport": (c, b) => this.exportCall(c, () => this.exportStore.get(b.exportId)),
    "C30/subscribe": (c, b) => this.exportCall(c, () => { const s = this.notifications.subscribe(b); this.store.audit(actor(c), "webhook.subscribe", s.id, { events: s.events }); return { id: s.id, url: s.url, events: s.events }; }),
    "C30/unsubscribe": (c, b) => this.exportCall(c, () => { this.notifications.unsubscribe(b.subscriptionId); this.store.audit(actor(c), "webhook.unsubscribe", b.subscriptionId, {}); return { ok: true }; }),
    "C30/listDeliveries": (c) => this.exportCall(c, () => this.notifications.deliveries().map((d) => ({ ...d, payload: undefined }))),
  };

  // ---------------------------------------------------------------- F02 PR analysis and quality gates (§4–§12)
  /** Map a forge "owner/repo" full name to a known repository root: the origin remote must match. */
  private prRepoRootFor(fullName: string): string | null {
    if (!fullName) return null;
    const roots = (this.store.db.prepare("select distinct repo_root r from revisions").all() as { r: string }[]).map((x) => x.r);
    for (const root of roots) {
      const url = githubRemote(root);
      if (url && `${url.owner}/${url.repo}` === fullName) return root;
    }
    return null;
  }

  /** Body-level validation + job enqueue for one PR (shared by the op and the webhook). */
  private analyzePullRequestValidated(ctx: CallContext, b: { repoPath?: unknown; repositoryId?: unknown; forge?: unknown; prNumber?: unknown; headRef?: unknown; baseRef?: unknown; policyId?: unknown; headRepository?: unknown }): ApiResult<JobView & { deduped?: boolean }> {
    if (!Number.isInteger(b.prNumber) || (b.prNumber as number) <= 0) return fail(ctx, { code: "INVALID_SCHEMA", message: "prNumber must be a positive integer", retryable: false });
    let repoRoot: string | null = null;
    if (typeof b.repositoryId === "string" && b.repositoryId) repoRoot = this.search.repositoryOfRoot(String(b.repositoryId))?.root ?? null;
    if (!repoRoot && typeof b.repoPath === "string" && b.repoPath) repoRoot = resolve(String(b.repoPath));
    if (!repoRoot) return fail(ctx, { code: "INVALID_SCHEMA", message: "give a repoPath (absolute) or a repositoryId", retryable: false });
    if (!existsSync(repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: "the repository folder does not exist on this machine", retryable: false });
    const forge = typeof b.forge === "string" && b.forge ? b.forge : "github";
    const ref: PrRef & { policyId?: string } = {
      repoRoot, forge, prNumber: Number(b.prNumber),
      ...(typeof b.headRef === "string" && b.headRef ? { headRef: b.headRef } : {}),
      ...(typeof b.baseRef === "string" && b.baseRef ? { baseRef: b.baseRef } : {}),
      ...(typeof b.headRepository === "string" && b.headRepository ? { headRepository: b.headRepository } : {}),
      ...(typeof b.policyId === "string" && b.policyId ? { policyId: b.policyId } : {}),
    };
    // Eager identity resolution (git-only): the analysis row exists and a pending status can go out on receipt (§7.12).
    try { resolvePr(repoRoot, ref); } catch (e) { const c = e as PrCheckError; return fail(ctx, { code: ((c.code ?? "NOT_FOUND") as ApiError["code"]), message: c.message, retryable: false }); }
    const jctx: CallContext = { ...ctx, requestId: `req-pr:${randomUUID()}`, ...(ctx.idempotencyKey ? {} : { idempotencyKey: `pr:${repoRoot}:${ref.prNumber}:${typeof b.headRef === "string" && b.headRef ? b.headRef : "refs/pull"}` }) };
    const job = this.jobs.enqueue(jctx, {
      kind: "pr-analysis", priority: 10, params: { repoPath: repoRoot, prNumber: ref.prNumber, forge, headRef: ref.headRef, baseRef: ref.baseRef, policyId: ref.policyId },
      run: async (jctx2, control) => {
        try { const view = await this.pr.run({ actor: jctx2.actor.principalId }, control, ref); return ok(jctx2, view, { revision: view.headRevision }); }
        catch (e) {
          const c = e as PrCheckError;
          if (c.name === "PrCheckError") return fail(jctx2, { code: (c.code ?? "STORAGE") as ApiError["code"], message: c.message, retryable: false });
          return fail(jctx2, storageFailure(e));
        }
      },
    });
    const analysisId = this.prAnalysisCreatedSoon(repoRoot, ref.prNumber) ?? undefined;
    return ok(ctx, { ...job, params: { ...job.params, analysisId } });
  }
  /** Newest analysis row for a PR within the queue window (best effort, for the op's response). */
  private prAnalysisCreatedSoon(repoRoot: string, prNumber: number) { return this.pr.latestForPr(repoRoot, prNumber)?.id as string | undefined; }

  readonly prOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    // ---- C23: analyse a pull request (one analysis per identity; the heavy work runs in a background job) ----
    "C23/analyzePullRequest": (c, b) => this.analyzePullRequestValidated(c, b ?? {}),
    "C23/getPrAnalysis": (c, b) => {
      if (typeof b?.analysisId === "string" && b.analysisId) { try { return ok(c, this.pr.compileReviewView(b.analysisId)); } catch (e) { const r = e as PrCheckError; return fail(c, { code: (r.code ?? "NOT_FOUND"), message: r.message, retryable: false }); } }
      const root = typeof b?.repoPath === "string" ? resolve(b.repoPath) : typeof b?.repositoryId === "string" ? this.search.repositoryOfRoot(b.repositoryId)?.root : null;
      if (!root || !Number.isInteger(b?.prNumber)) return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId, or a PR (repoPath/repositoryId + prNumber)", retryable: false });
      const latest = this.pr.latestForPr(root, Number(b.prNumber));
      if (!latest) return fail(c, { code: "NOT_FOUND", message: "no analysis for this pull request yet; run C23/analyzePullRequest", retryable: false });
      return ok(c, { analysis: this.pr.compileReviewView(latest.id), history: this.pr.allForPr(root, Number(b.prNumber)).map((a) => ({ analysisId: a.id, headHash: a.head_hash, state: a.state, createdAt: a.created_at, supersededBy: a.superseded_by ?? undefined })) as never });
    },
    // ---- C16: policies, gate decisions ----
    "C16/putPolicy": (c, b) => { const r = this.pr.putPolicy(b?.policy, c.actor.principalId); return r.ok ? ok(c, r) : fail(c, { code: "INVALID_SCHEMA", message: r.problems.join("; ").slice(0, 400), retryable: false }); },
    "C16/listPolicies": (c, b) => ok(c, this.pr.listPolicies(typeof b?.policyId === "string" && b.policyId ? b.policyId : undefined).map((p) => ({ policyId: p.policyId, version: p.version, policyHash: p.policyHash, createdBy: p.createdBy, createdAt: p.createdAt }))),
    "C16/getPolicy": (c, b) => { const p = typeof b?.policyId === "string" ? this.pr.getPolicy(b.policyId, Number.isInteger(b?.version) ? b.version : undefined) : null; return p ? ok(c, p) : fail(c, { code: "NOT_FOUND", message: "no such policy version", retryable: false }); },
    "C16/setRepositoryPolicy": (c, b) => {
      const root = typeof b?.repoPath === "string" ? resolve(b.repoPath) : typeof b?.repositoryId === "string" ? this.search.repositoryOfRoot(b.repositoryId)?.root : null;
      if (!root) return fail(c, { code: "INVALID_SCHEMA", message: "give a repoPath (absolute) or a repositoryId", retryable: false });
      const policyId = b?.policyId ?? null;
      if (policyId !== null && !this.pr.getPolicy(String(policyId))) return fail(c, { code: "NOT_FOUND", message: `no policy ${policyId} in the store; put it with C16/putPolicy first`, retryable: false });
      this.pr.setRepositoryPolicy(root, policyId === null ? null : String(policyId));
      this.store.audit(actor(c), "policy.assign", root, { policyId });
      return ok(c, { repoRoot: root, policyId });
    },
    "C16/evaluateQualityGate": (c, b) => {
      if (typeof b?.analysisId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId", retryable: false });
      try { return ok(c, this.pr.reEvaluate(b.analysisId), { revision: this.pr.row(b.analysisId)?.head_revision ?? undefined }); }
      catch (e) { const r = e as PrCheckError; return r.name === "PrCheckError" ? fail(c, { code: (r.code ?? "NOT_FOUND") as ApiError["code"], message: r.message, retryable: false }) : fail(c, storageFailure(e)); }
    },
    "C16/verifyBinding": (c, b) => { if (typeof b?.decisionId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give a decisionId", retryable: false }); return ok(c, this.pr.verifyBinding(b.decisionId)); },
    "C16/invalidateDecision": (c, b) => {
      if (typeof b?.decisionId !== "string" || typeof b?.reason !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give a decisionId and a reason", retryable: false });
      try { this.pr.invalidateDecision(b.decisionId, b.reason); return ok(c, { decisionId: b.decisionId, invalidated: true }); } catch (e) { const r = e as PrCheckError; return r.name === "PrCheckError" ? fail(c, { code: (r.code ?? "NOT_FOUND") as ApiError["code"], message: r.message, retryable: false }) : fail(c, storageFailure(e)); }
    },
    // ---- C18: dispositions (a reviewer's answer to a finding) ----
    "C18/recordDisposition": (c, b) => {
      if (typeof b?.analysisId !== "string" || typeof b?.findingId !== "string" || !b?.disposition) return fail(c, { code: "INVALID_SCHEMA", message: "give analysisId, findingId and disposition", retryable: false });
      const dispositions = ["OPEN", "WAIVED", "RESOLVED_BY_CHANGE", "DISMISSED_FALSE_POSITIVE"];
      if (!dispositions.includes(b.disposition)) return fail(c, { code: "INVALID_SCHEMA", message: `disposition is one of ${dispositions.join(", ")}`, retryable: false });
      const r = this.pr.recordDisposition({ analysisId: b.analysisId, findingId: b.findingId, disposition: b.disposition, rationale: b.rationale, actor: actor(c), ...(b.waiver ? { waiver: b.waiver } : {}) });
      return r.ok ? ok(c, { finding: r.finding, decisionId: r.decisionId }, { revision: this.pr.row(b.analysisId)?.head_revision ?? undefined }) : fail(c, { code: "INVALID_SCHEMA", message: r.error, retryable: false });
    },
    // ---- C30: publish the gate result to the forge (grant-gated; nothing but ids, counts, paths, lines leaves) ----
    "C30/publishCheck": async (c, b) => {
      if (!b || typeof b.repositoryId !== "string" || !Number.isInteger(b.prNumber)) return fail(c, { code: "INVALID_SCHEMA", message: "give repositoryId and prNumber", retryable: false });
      const decisionRow = b.decisionId ? this.pr.decisionRow(b.decisionId) : null;
      const analysis = decisionRow ? this.pr.row(decisionRow.analysis_id) : (b.analysisId ? this.pr.row(b.analysisId) : this.pr.latestForPr(String(b.repositoryId), Number(b.prNumber)));
      if (!analysis) return fail(c, { code: "NOT_FOUND", message: "no analysis for this pull request; run C23/analyzePullRequest first", retryable: false });
      const grant = newGrant(this.store, { repositoryId: analysis.repository_id, headHash: analysis.head_hash, decisionId: b.decisionId ?? undefined, principalId: actor(c), ttlMs: 60_000 });
      const receipt = await this.prPublisher.publish(grant.id, { repositoryId: analysis.repository_id, prNumber: Number(b.prNumber), analysisId: analysis.id, decisionId: b.decisionId ?? undefined, principalId: actor(c), kind: b.kind ?? "STATUS", alsoComment: !!b.alsoComment });
      return ok(c, receipt, { completeness: receipt.state === "PUBLISHED" ? "COMPLETE" : "PARTIAL" });
    },
    // ---- C04: a forge webhook in (HMAC-verified, replay-safe; pull_request events only) ----
    "C04/ingestWebhook": async (c, b) => { try { return ok(c, await this.ingestWebhook(b ?? {})); } catch (e) { const msg = String((e as Error).message ?? e).slice(0, 300); return fail(c, { code: (e as PrCheckError).code === "FORBIDDEN" ? "FORBIDDEN" as const : "INVALID_SCHEMA" as const, message: msg, retryable: false }); } },
  };

  /** GitHub webhook intake (§10.2): HMAC-verified, replay-safe, `pull_request` events opened/synchronize/reopened only.
   *  Returns what it did and why, as data — the caller can always tell why nothing happened. */
  async ingestWebhook(b: { headers?: Record<string, string>; rawBody?: string; secret?: string; repoOverride?: string; actor?: string }): Promise<{ ok: true; applied: boolean; replayed: boolean; reason?: string; job?: { id: string }; analysis?: { analysisId: string } }> {
    const secret = b.secret ?? process.env.CIE_WEBHOOK_SECRET ?? "";
    if (!secret) throw new PrCheckError("FORBIDDEN", "no webhook secret is configured; unsigned webhooks are refused");
    const headers = Object.fromEntries(Object.entries(b.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = b.rawBody ?? "";
    const sig = String(headers["x-hub-signature-256"] ?? "");
    const mac = createHmac("sha256", secret).update(body).digest("hex");
    const ok160 = sig.startsWith("sha256=") && sig.length === 7 + mac.length;
    if (!ok160 || !timingSafeEqual(Buffer.from(mac), Buffer.from(sig.slice(7)))) throw new PrCheckError("FORBIDDEN", "the webhook signature does not verify; nothing is applied from an unverified source");

    const delivery = String(headers["x-github-delivery"] ?? "");
    const event = String(headers["x-github-event"] ?? "");
    let payload: any;
    try { payload = JSON.parse(body); } catch { throw new PrCheckError("INVALID_SCHEMA", "the webhook body is not JSON"); }
    const fullName = String(payload?.repository?.full_name ?? "");
    const source = `webhook:${fullName || "unknown"}`;
    if (delivery) {
      const seen = this.store.db.prepare("select delivery_id from ext_deliveries where source = ? and delivery_id = ?").get(source, delivery);
      if (seen) return { ok: true, applied: false, replayed: true, reason: "this delivery was already recorded; it is not applied twice" };
    }
    if (event !== "pull_request") {
      this.recordDelivery(source, delivery, false);
      return { ok: true, applied: false, replayed: false, reason: `the ${event || "untyped"} event is not handled; only pull_request events are` };
    }
    const action = String(payload?.action ?? "");
    const prNumber = Number(payload?.number ?? payload?.pull_request?.number ?? 0);
    if (!["opened", "synchronize", "reopened"].includes(action)) {
      this.recordDelivery(source, delivery, false);
      return { ok: true, applied: false, replayed: false, reason: `the action "${action}" does not change the head; nothing is analysed` };
    }
    if (!prNumber) throw new PrCheckError("INVALID_SCHEMA", "the pull_request event does not carry a number");
    const repoRoot = b.repoOverride ? resolve(b.repoOverride) : this.prRepoRootFor(fullName);
    if (!repoRoot) {
      this.recordDelivery(source, delivery, false);
      return { ok: true, applied: false, replayed: false, reason: `no local repository's origin matches ${fullName}; nothing is analysed` };
    }
    const ctxLike: CallContext = { requestId: `req-webhook:${randomUUID()}`, idempotencyKey: `webhook:${delivery}`, actor: { principalId: b.actor ?? "github", tenantId: "local", sessionId: "webhook" }, deadlineMs: Date.now() + 30_000, traceId: `trace-webhook:${randomUUID()}` };
    const job = await this.analyzePullRequestValidated(ctxLike, {
      repoPath: repoRoot, prNumber, forge: "github",
      headRepository: String(payload?.pull_request?.head?.repo?.full_name ?? ""),
    });
    if (!job.ok) {
      this.recordDelivery(source, delivery, false);
      return { ok: true, applied: false, replayed: false, reason: `the analysis was not scheduled: ${job.error.message.slice(0, 200)}` };
    }
    this.recordDelivery(source, delivery, true);
    const analysisId = (job.value.params as { analysisId?: string }).analysisId;
    return { ok: true, applied: true, replayed: false, job: { id: job.value.id }, ...(analysisId ? { analysis: { analysisId } } : {}) };
  }
  private recordDelivery(source: string, delivery: string, applied: boolean) {
    if (delivery) this.store.db.prepare("insert or ignore into ext_deliveries values (?,?,?,?)").run(source, delivery, Date.now(), applied ? 1 : 0);
  }


  // ---------------------------------------------------------------- C31 storage and C32 operations
  /** Is it healthy? Answers even when parts are down, and says which. */
  async health(ctx: CallContext, _req: Record<string, never> = {}): Promise<ApiResult<Health>> {
    return ok(ctx, await healthOf({ store: this.store, ping: () => this.worker.ping(), model: { name: this.model.name, model: this.model.model, lastError: this.modelError }, dbPath: this.store.path }));
  }

  /** What an editor extension needs to decide whether it can talk to this server. */
  version(ctx: CallContext, _req: Record<string, never> = {}): ApiResult<{ api: string; minExtension: string; schema: number }> {
    return ok(ctx, { api: API_VERSION, minExtension: MIN_EXTENSION, schema: Number((this.store.db.prepare("select coalesce(max(version),0) v from schema_version").get() as { v: number }).v) });
  }

  /** A consistent copy of the database, written beside it under backups/. `name` is a plain file name, never a path. */
  backup(ctx: CallContext, req: { name?: string }): ApiResult<{ path: string; revisions: number; drill: RestoreDrill }> {
    const name = (req.name ?? `cie-${new Date().toISOString().replace(/[:.]/g, "-")}`).replace(/[^A-Za-z0-9._-]/g, "_");
    if (this.store.path === ":memory:") return fail(ctx, { code: "INVALID_SCHEMA", message: "an in-memory database cannot be backed up", retryable: false });
    const dir = join(dirname(this.store.path), "backups");
    try {
      mkdirSync(dir, { recursive: true });
      const b = backupStore(this.store, join(dir, `${name}.db`));
      // A backup nobody has restored is a hope. Prove this one before saying it exists.
      const drill = restoreDrill(b.path);
      this.store.audit(actor(ctx), "storage.backup", b.path, { revisions: b.revisions, drillOk: drill.ok });
      return ok(ctx, { ...b, drill });
    } catch (e) { return fail(ctx, storageFailure(e)); }
  }

  /** Remove revisions nothing refers to. `dryRun` says what would go without removing it. */
  gc(ctx: CallContext, req: { dryRun?: boolean; minAgeDays?: number }): ApiResult<GcReport> {
    const r = gcStore(this.store, { dryRun: req.dryRun ?? true, minAgeMs: Math.max(0, req.minAgeDays ?? 0) * 86_400_000 });
    if (!r.dryRun) this.store.audit(actor(ctx), "storage.gc", "(revisions)", { removed: r.removed.length, kept: Object.keys(r.kept).length });
    return ok(ctx, r);
  }

  /** Delete a repository and everything derived from it. The caller must repeat the path, so it cannot happen by accident. */
  deleteRepository(ctx: CallContext, req: { repoRoot: string; confirm: string }): ApiResult<DeleteReport> {
    if (!req.repoRoot || req.confirm !== req.repoRoot) return fail(ctx, { code: "INVALID_SCHEMA", message: "to delete, repeat the repository path in `confirm`", retryable: false });
    if (!this.store.hasRepo(req.repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: "unknown repository", retryable: false });
    try {
      try { const rid = this.search.repositoryOfRoot(req.repoRoot)?.repositoryId; if (rid) this.search.purgeRepository(rid); } catch { /* purge failure never blocks deletion of the base data */ }
      return ok(ctx, deleteRepo(this.store, req.repoRoot, actor(ctx)));
    } catch (e) { return fail(ctx, storageFailure(e)); }
  }

  // ---------------------------------------------------------------- C07 jobs
  /** Start indexing or concept extraction in the background. Returns the job at once; poll getJob for progress. */
  enqueueJob(ctx: CallContext, req: { kind: "index" | "concepts"; repoPath?: string; revision?: string }): ApiResult<JobView & { deduped?: boolean }> {
    if (req.kind === "index") {
      if (!req.repoPath || !isAbsolute(req.repoPath)) return fail(ctx, { code: "INVALID_SCHEMA", message: "repoPath must be an absolute path", retryable: false });
      const repoPath = req.repoPath;
      return ok(ctx, this.jobs.enqueue(ctx, { kind: "index", params: { repoPath }, run: (jctx, control) => this.ingestRepository(jctx, { repoPath }, control) }));
    }
    if (req.kind === "concepts") {
      const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
      if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index a repository first", retryable: false });
      return ok(ctx, this.jobs.enqueue(ctx, { kind: "concepts", params: { revision: rev.id, repoPath: rev.repoRoot }, run: (jctx, control) => this.extractConcepts(jctx, { revision: rev.id }, control) }));
    }
    return fail(ctx, { code: "INVALID_SCHEMA", message: "kind must be index or concepts", retryable: false });
  }

  getJob(ctx: CallContext, req: { jobId: string }): ApiResult<JobView> {
    const j = this.jobs.get(req.jobId);
    return j ? ok(ctx, j) : fail(ctx, { code: "NOT_FOUND", message: "no such job", retryable: false });
  }

  listJobs(ctx: CallContext, req: { limit?: number }): ApiResult<JobView[]> {
    return ok(ctx, this.jobs.list(Math.min(Math.max(req.limit ?? 20, 1), 50)));
  }

  /** Ask a job to stop. Before it starts saving, it stops and nothing is kept; once it is saving, it is left to finish. */
  cancelJob(ctx: CallContext, req: { jobId: string }): ApiResult<{ job: JobView; cancelled: boolean; reason?: string }> {
    const r = this.jobs.cancel(req.jobId);
    if (!r) return fail(ctx, { code: "NOT_FOUND", message: "no such job", retryable: false });
    this.store.audit(actor(ctx), "job.cancel", req.jobId, { kind: r.job.kind, cancelled: r.cancelled });
    return ok(ctx, r);
  }

  /** Directory names only (never file contents) so the UI can offer a folder picker. Loopback-only gateway. */
  browseDirectory(ctx: CallContext, req: { path?: string }): ApiResult<DirListing> {
    const want = req.path?.trim() || homedir();
    if (!isAbsolute(want)) return fail(ctx, { code: "INVALID_SCHEMA", message: "path must be absolute", retryable: false });
    let path: string;
    try {
      path = realpathSync(want);
      if (!statSync(path).isDirectory()) return fail(ctx, { code: "INVALID_SCHEMA", message: "not a directory", retryable: false });
    } catch { return fail(ctx, { code: "NOT_FOUND", message: "directory not found", retryable: false }); }
    const MAX = 500;
    let names: import("node:fs").Dirent[];
    try { names = readdirSync(path, { withFileTypes: true }); } catch { return fail(ctx, { code: "FORBIDDEN", message: "cannot read directory", retryable: false }); }
    const dirs = names
      .filter((d) => (d.isDirectory() || (d.isSymbolicLink() && safeIsDir(join(path, d.name)))) && !d.name.startsWith(".") && d.name !== "node_modules")
      .sort((a, b) => a.name.localeCompare(b.name));
    const entries = dirs.slice(0, MAX).map((d) => ({ name: d.name, path: join(path, d.name), isGitRepo: existsSync(join(path, d.name, ".git")) }));
    const parent = dirname(path);
    return ok(ctx, { path, parent: parent === path ? null : parent, entries, truncated: dirs.length > MAX });
  }

  /** C01: an IDE event. Only path + line numbers are accepted; they resolve to entity ids and nothing else is stored. */
  captureEditorEvent(ctx: CallContext, req: { event: EditorEvent }): ApiResult<{ accepted: boolean; stale?: boolean; entities: string[]; indexed: boolean }> {
    const e = req.event;
    const kinds = ["OPEN_FILE", "SELECTION", "DIFF", "BREAKPOINT"];
    if (!e || !kinds.includes(e.kind) || typeof e.file !== "string" || !isAbsolute(e.file) || !Number.isInteger(e.sequence) || !e.sessionId) {
      return fail(ctx, { code: "INVALID_SCHEMA", message: "event needs sessionId, integer sequence, a known kind and an absolute file path", retryable: false });
    }
    // Stale or reordered events are dropped, never applied over newer ones.
    if (e.sequence <= this.store.lastClientSeq(e.sessionId)) return ok(ctx, { accepted: false, stale: true, entities: [], indexed: true });
    const root = e.file;
    const rev = this.store.allRevisionRoots().filter((r) => root === r.repoRoot || root.startsWith(r.repoRoot + "/")).sort((a, b) => b.repoRoot.length - a.repoRoot.length)[0];
    if (!rev) { this.store.addContextEvent({ session: e.sessionId, clientSeq: e.sequence, kind: e.kind, revision: "", file: e.file, entities: [], lineStart: null, lineEnd: null }); return ok(ctx, { accepted: true, entities: [], indexed: false }); }
    const full = this.store.revision(rev.id)!;
    const rel = e.file.slice(full.repoRoot.length + 1);
    const lines = e.kind === "OPEN_FILE" ? [] : [e.startLine, e.endLine ?? e.startLine].filter((n): n is number => Number.isInteger(n) && n! > 0);
    const entities = [...new Set(lines.flatMap((l) => { const id = entityAt(this.store, full, rel, l); return id ? [id] : []; }))];
    this.store.addContextEvent({ session: e.sessionId, clientSeq: e.sequence, kind: e.kind, revision: full.id, file: rel, entities, lineStart: lines[0] ?? null, lineEnd: lines[1] ?? null });
    return ok(ctx, { accepted: true, entities, indexed: true }, { revision: full.id });
  }

  editorContext(ctx: CallContext, req: { revision?: string }): ApiResult<EditorContext> {
    const rev = req.revision ?? this.store.latestRevision()?.id;
    const events = this.store.recentContext(20).filter((e) => !rev || e.revision === rev || e.revision === "");
    const names = new Map(rev ? this.store.entities(rev).map((x) => [x.entityId, x.name]) : []);
    const focus: EditorContext["focus"] = [];
    for (const ev of events) if (ev.kind === "SELECTION" || ev.kind === "BREAKPOINT") for (const id of ev.entities) if (!focus.some((f) => f.entityId === id) && names.has(id)) focus.push({ entityId: id, label: names.get(id)! });
    return ok(ctx, { events: events.map(({ seq, kind, file, entities, lineStart, lineEnd, ts }) => ({ seq, kind: kind as EditorContext["events"][number]["kind"], file, entities, lineStart, lineEnd, ts })), focus: focus.slice(0, 6) });
  }

  /** C24: a running app (or you) reports an exception. Stored as an observation; grouped by fingerprint so a loop is one entry with a count. */
  reportException(ctx: CallContext, req: { trace?: string; error?: { name?: string; message?: string; stack?: string }; source?: string }): ApiResult<{ id: string; count: number; isNew: boolean; inRepo: boolean; errorClass: string | null }> {
    const fromError = (e: { name?: string; message?: string; stack?: string }) => {
      const head = `${e.name ?? "Error"}: ${e.message ?? ""}`.trimEnd();
      const stack = e.stack ?? "";
      // V8 stacks already begin with the heading; do not repeat it, but keep the message if the stack's own heading lost it.
      return stack.startsWith(e.name ?? "Error") ? (e.message === "" ? `${head}\n${stack.split("\n").slice(1).join("\n")}` : stack) : `${head}\n${stack}`;
    };
    const text = (req.trace ?? (req.error ? fromError(req.error) : "")).slice(0, 30_000);
    const parsed = parseTrace(text);
    if (parsed.frames.length === 0) return fail(ctx, { code: "INVALID_SCHEMA", message: "no stack frames found in the report", retryable: false });
    const rev = this.store.latestRevision();
    const inRepo = !!rev && locateFrames(this.store, rev, parsed).some((f) => f.file);
    const r = this.store.addException({ id: `exc:${randomUUID()}`, fingerprint: fingerprint(parsed), errorClass: parsed.errorClass ?? "Error", message: parsed.message.slice(0, 300), trace: text, source: (req.source ?? "report").slice(0, 60) });
    this.store.audit(actor(ctx), "exception.report", r.id, { errorClass: parsed.errorClass, frames: parsed.frames.length, inRepo, source: req.source ?? "report" });
    return ok(ctx, { ...r, inRepo, errorClass: parsed.errorClass });
  }

  listExceptions(ctx: CallContext, req: { includeDismissed?: boolean }): ApiResult<ReturnType<Store["exceptions"]>> {
    return ok(ctx, this.store.exceptions(!!req.includeDismissed));
  }

  dismissException(ctx: CallContext, req: { id: string }): ApiResult<{ dismissed: boolean }> {
    const done = this.store.dismissException(req.id);
    if (done) this.store.audit(actor(ctx), "exception.dismiss", req.id);
    return done ? ok(ctx, { dismissed: true }) : fail(ctx, { code: "NOT_FOUND", message: "no such exception", retryable: false });
  }

  status(ctx: CallContext, req: { revision?: string }): ApiResult<{ revision: RevisionRow | null; provider: string; hosted: boolean; allowHosted: boolean; concepts: number; tests: TestSummary | null }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    return ok(ctx, {
      revision: rev, provider: `${this.model.name}/${this.model.model}`, hosted: this.model.hosted,
      allowHosted: rev ? this.store.allowHosted(rev.repoRoot) : false, concepts: rev ? this.store.concepts(rev.id).length : 0,
      tests: rev ? loadTestSummary(this.store, rev.repoRoot) : null,
    }, rev ? { revision: rev.id } : {});
  }

  setEgress(ctx: CallContext, req: { repoRoot: string; allow: boolean }): ApiResult<{ repoRoot: string; allowHosted: boolean }> {
    if (!req.repoRoot || !this.store.latestRevision(req.repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: "unknown repository; index it first", retryable: false });
    this.store.setAllowHosted(req.repoRoot, !!req.allow);
    this.store.audit(actor(ctx), req.allow ? "egress.policy.allow" : "egress.policy.deny", req.repoRoot, { destination: `${this.model.name}/${this.model.model}`, fields: EGRESS_FIELDS });
    return ok(ctx, { repoRoot: req.repoRoot, allowHosted: !!req.allow });
  }

  auditLog(ctx: CallContext, req: { limit?: number }): ApiResult<{ events: unknown[]; chain: { ok: boolean; brokenAt?: number } }> {
    return ok(ctx, { events: this.store.auditEvents(Math.min(req.limit ?? 100, 500)), chain: this.store.verifyAuditChain() });
  }

  // ---------------------------------------------------------------- concept cards
  async extractConcepts(ctx: CallContext, req: { revision?: string }, control?: JobControl): Promise<ApiResult<{ cards: ConceptCard[]; dropped: string[]; provider: string }>> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const all: ConceptCard[] = [], dropped: string[] = [], warnings: string[] = [];
    let providerName = `${this.model.name}/${this.model.model}`;
    // Incremental invalidation (CE-3, region-level): concept cards whose every member symbol is
    // textually unchanged since the previous extraction are carried over verbatim (their claim
    // re-gated against this revision); only regions with changed members are re-extracted.
    const versions = this.store.conceptVersions(rev.repoRoot);
    const priorVersion = versions[0]?.version ?? 0;
    const priorCards = priorVersion ? this.store.conceptVersion(rev.repoRoot, priorVersion) ?? [] : [];
    const priorRevision = versions[0]?.revision ?? null;
    const carried: ConceptCard[] = [];
    let touchedIds: string[] = [];
    // Symbols present in the previous extraction's revision with identical text: a chunk made only of these needs no new model call.
    const unchangedSymbols = new Set<string>();
    if (priorRevision && priorRevision !== rev.id) {
      const before = new Map(this.store.entities(priorRevision).filter((e) => e.symbolHash).map((e) => [e.entityId, e.symbolHash!]));
      const now = new Map(this.store.entities(rev.id).filter((e) => e.symbolHash).map((e) => [e.entityId, e.symbolHash!]));
      for (const [id, h] of now) if (before.get(id) === h) unchangedSymbols.add(id);
      const memberIds = new Set(priorCards.flatMap((c) => c.members));
      const changedMembers = [...memberIds].filter((id) => before.get(id) !== now.get(id));
      const changedSet = new Set(changedMembers);
      carried.push(...priorCards.filter((c) => c.members.length > 0 && !c.members.some((m) => changedSet.has(m))));
      touchedIds = [...changedSet];
    }
    const carriedIds = new Set(carried.map((c) => c.id));
    if (carried.length) warnings.push(`Incremental: ${carried.length} concept card(s) carried over; ${touchedIds.length || "no"} changed member symbol(s) force re-extraction only for their regions.`);
    const carriedMembers = new Set(carried.flatMap((c) => c.members));
    // Members of prior cards that were not carried over (one of their members changed) are re-read together, so the card is rebuilt whole.
    const rebuildMembers = new Set(priorCards.filter((c) => !carriedIds.has(c.id)).flatMap((c) => c.members));
    const touched = new Set(touchedIds);
    // The entity-id set grounds every chunk's cards; build it once instead of reparsing every entity per chunk.
    const knownEntityIds = new Set(this.store.entities(rev.id).map((e) => e.entityId));
    const queue = chunkSymbols(this.store, rev.id);
    // Claims are written with the cards, in one step at the end, so a cancelled run leaves nothing behind.
    const pendingClaims: Claim[] = [];
    let chunksDone = 0;
    while (queue.length) {
      control?.checkpoint();
      await new Promise<void>((r) => setImmediate(r)); // building a bundle is synchronous database work; let requests in between parts
      control?.progress({ phase: "extracting", done: chunksDone, total: chunksDone + queue.length, message: `Reading the code with the model: part ${chunksDone + 1} of about ${chunksDone + queue.length}` });
      const whole = queue.shift()!;
      // Region-level re-extraction: only symbols that changed, are new, or belong to a card that must be rebuilt go to the model.
      // A chunk with none of those needs no call, and a chunk with a few sends only those few.
      const ids = priorRevision && priorRevision !== rev.id ? whole.filter((id) => touched.has(id) || !(carriedMembers.has(id) || unchangedSymbols.has(id)) || rebuildMembers.has(id)) : whole;
      if (ids.length === 0) continue;
      const bundle = bundleFor(this.store, rev.id, ids, ["concept extraction: deep defect semantic events are excluded from this projection"], { includeDefectSemantics: false });
      // Keep each request well under the gateway budget: halve a chunk whose evidence is too large.
      if (bundle.tokenEstimate > chunkTokenBudget() && ids.length > 1) {
        const mid = Math.ceil(ids.length / 2);
        queue.unshift(ids.slice(0, mid), ids.slice(mid));
        continue;
      }
      // Each model call gets its own deadline; the request that started a job has long expired by the later chunks.
      const callCtx = control ? { ...ctx, deadlineMs: Date.now() + 120_000 } : ctx;
      const asked = this.callModel<ConceptsOutput>(callCtx, rev, { purpose: "EXTRACT", schemaId: SCHEMA_CONCEPTS, question: "Extract concept cards", bundle });
      const { result, provider, note } = control ? await control.guard(asked) : await asked;
      chunksDone++;
      if (note && !warnings.includes(note)) warnings.push(note);
      providerName = `${provider.name}/${provider.model}`;
      if (!result.ok) { warnings.push(`extraction failed for a chunk (${result.error.code})`); continue; }
      const out = cardsFromOutput(this.store, rev.id, result.value, bundle, providerName, result.run, knownEntityIds);
      pendingClaims.push(...out.claims);
      all.push(...out.cards); dropped.push(...out.dropped);
    }
    // Same-titled cards from different chunks collapse to one.
    const unique = mergeCards(all, (c, evidenceIds) => {
      const claim = claimOf(this.store, rev.id, { assertion: `${c.title}: ${c.summary}`, claimClass: "concept-card", evidenceIds, rationaleSummary: `Extracted ${c.kind} in several parts and merged; confidence is the model's own, uncalibrated statement (${c.statedConfidence}).` });
      pendingClaims.push(claim);
      return claim.draft.id;
    });
    // Carried-over cards are re-anchored to this revision: new claim (re-gated with the same
    // assertion and evidence), new id, so stored cards always name their own revision.
    const adopted: ConceptCard[] = [];
    for (const c of carried) {
      if (carriedIds.has(`${c.id}`) && unique.some((u) => u.title.toLowerCase() === c.title.toLowerCase() && u.kind === c.kind)) continue; // re-extracted anyway; keep the fresh one
      const prior = this.store.getClaims([c.claimId])[0] ?? null;
      const assertion = prior ? prior.draft.assertion : `${c.title}: ${c.summary}`;
      const rationale = prior ? prior.draft.rationaleSummary : `Carried over from revision ${priorRevision}; extracted ${c.kind}.`;
      const ev = c.evidenceIds.filter((id) => this.store.evidence(rev.id, id));
      if (!ev.length) { dropped.push(`${c.title}: carried-over card has no evidence in this revision`); continue; }
      const claim = claimOf(this.store, rev.id, { assertion, claimClass: "concept-card", evidenceIds: ev, rationaleSummary: rationale });
      pendingClaims.push(claim);
      adopted.push({ ...c, id: "card:" + createHash("sha256").update(rev.id + c.kind + c.title).digest("hex").slice(0, 12), revision: rev.id, claimId: claim.draft.id, source: `${c.source} (carried over)` });
    }
    const merged = [...unique, ...adopted];
    control?.commit();
    this.persist(pendingClaims);
    const version = this.store.replaceConcepts(rev.id, merged, providerName);
    this.store.audit(actor(ctx), "concepts.extract", rev.id, { cards: merged.length, carried: adopted.length, dropped: dropped.length, provider: providerName, version });
    return ok(ctx, { cards: merged, dropped, provider: providerName }, { revision: rev.id, warnings, completeness: dropped.length ? "PARTIAL" : "COMPLETE" });
  }

  /** The concept store: cards with the claim behind each, the version history, and what changed since the previous version. */
  conceptStore(ctx: CallContext, req: { revision?: string; version?: number }): ApiResult<ConceptStore> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const versions = this.store.conceptVersions(rev.repoRoot);
    const current = versions[0]?.version ?? 0;
    const want = req.version ?? current;
    const snapshot = want === current ? this.store.concepts(rev.id, { includeRefuted: true }) : this.store.conceptVersion(rev.repoRoot, want) ?? [];
    const prior = want > 1 ? this.store.conceptVersion(rev.repoRoot, want - 1) : null;
    const key = (c: ConceptCard) => `${c.kind}|${c.title.toLowerCase()}`;
    const priorByKey = new Map((prior ?? []).map((c) => [key(c), c]));
    const nowKeys = new Set(snapshot.map(key));
    const changedMembers = (c: ConceptCard, p: ConceptCard) => c.members.length !== p.members.length || c.summary !== p.summary;
    const diff = prior ? {
      against: want - 1,
      added: snapshot.filter((c) => !priorByKey.has(key(c))).map((c) => c.title),
      removed: [...priorByKey.values()].filter((c) => !nowKeys.has(key(c))).map((c) => c.title),
      changed: snapshot.filter((c) => priorByKey.has(key(c)) && changedMembers(c, priorByKey.get(key(c))!)).map((c) => c.title),
    } : null;
    const claims = Object.fromEntries(this.store.getClaims(snapshot.map((c) => c.claimId)).map((c) => [c.draft.id, c]));
    return ok(ctx, { version: want, versions, cards: snapshot, claims, diff, statedConfidence: this.statedConfidenceReport(snapshot, claims) }, { revision: rev.id });
  }

  /** Does the model's own "high/medium/low" mean anything? Compare it with your verdicts, and abstain until there are enough. */
  statedConfidenceReport(cards: ConceptCard[], claims: Record<string, Claim>): ConceptStore["statedConfidence"] {
    const MIN = 5;
    return (["high", "medium", "low"] as const).map((level) => {
      let confirmed = 0, refuted = 0, unjudged = 0;
      for (const c of cards.filter((x) => x.statedConfidence === level)) {
        const v = claims[c.claimId]?.verdicts.filter((x) => x.verdict !== "DISPUTE").at(-1)?.verdict;
        if (v === "CONFIRM") confirmed++; else if (v === "REFUTE") refuted++; else unjudged++;
      }
      const n = confirmed + refuted;
      const band = n >= MIN ? wilson(confirmed, n) : null;
      return { level, cards: confirmed + refuted + unjudged, confirmed, refuted, unjudged, band: band ? { lower: band.lower, upper: band.upper, n } : null,
        note: n >= MIN ? `${confirmed}/${n} of the cards stated “${level}” were confirmed` : `${n}/${MIN} judged; the model's “${level}” is not calibrated yet` };
    });
  }

  listConcepts(ctx: CallContext, req: { revision?: string }): ApiResult<ConceptCard[]> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    return rev ? ok(ctx, this.store.concepts(rev.id), { revision: rev.id }) : fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
  }

  // ---------------------------------------------------------------- views
  /** A form the user picked (gallery, or a chip offering another reading). Nothing to second-guess, so no alternatives. */
  private chosenRoute(form: string, kind?: "failure" | "invariant"): ViewRoute {
    const v = visualByForm(form);
    const f = (v?.formId ?? form) as ViewRoute["form"];
    return { source: "chosen", confidence: "high", form: f, ...(f === "CausalGraph" ? { kind: kind ?? "failure" } : {}), name: f === "CausalGraph" ? (kind === "invariant" ? "Wrong-value map" : "Failure-space map") : v?.name ?? f, because: "You chose this view.", alternatives: [] };
  }

  /** What kind of view the question wants, from the router model; without one, the general map, said plainly. */
  private async readQuestion(question: string): Promise<ViewRoute> {
    const { intent } = await readText(this.router, question, { hasView: false, selectionCount: 0, looksLikeTrace: false }, true);
    return (intent as { type: "ask"; route: ViewRoute }).route; // with forms only, the reading is always a view
  }

  async ask(ctx: CallContext, req: { question: string; route?: ViewRoute; revision?: string; pins?: string[]; seeds?: string[]; level?: number; form?: string; kind?: "failure" | "invariant"; subject?: string; lens?: string }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const question = (req.question ?? "").trim();
    if (!question || question.length > 1000) return fail(ctx, { code: "INVALID_SCHEMA", message: "question must be 1–1000 characters", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; ingest a repository first", retryable: false });
    // The form is named explicitly (gallery, or a chip for another reading) or read from the question.
    const route = req.form ? this.chosenRoute(req.form, req.kind) : req.route ?? await this.readQuestion(question);
    const visual = route.source === "chosen" && route.form === "SemanticMap" ? null : visualByForm(route.form);
    if (visual?.build) {
      this.store.audit(actor(ctx), "ask", rev.id, { form: visual.formId, chars: question.length, route: route.source });
      const built = ensureEdgeClaims(this.store, rev, visual.build(this.store, rev, question, req.subject));
      built.view.route = route;
      this.persist(built.claims);
      redactBuilt(this.store, rev, built);
      return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
    }
    const choice = route.form === "CausalGraph" ? { form: "CausalGraph" as const, kind: route.kind ?? "failure", reason: route.kind === "invariant" ? "The question is about a value becoming incorrect, so I mapped every writer of that state." : "The question is about what can make something fail, so I mapped failure sites reachable from the operation." }
      : { form: "SemanticMap" as const, kind: undefined, reason: "The question is about how something works, so I composed a map of the relevant code, grouped by responsibility." };
    this.store.audit(actor(ctx), "ask", rev.id, { form: choice.form + (choice.kind ? `:${choice.kind}` : ""), chars: question.length, route: route.source });

    if (choice.form === "CausalGraph") {
      const built = choice.kind === "invariant" ? buildInvariantGraph(this.store, rev, question) : buildFailureGraph(this.store, rev, question);
      built.view.formReason = choice.reason;
      built.view.route = route;
      this.persist(built.claims);
      redactBuilt(this.store, rev, built);
      return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
    }

    // Hybrid retrieval: exact names, semantic closeness, concept cards and the graph, over only what this caller may see, cut to the model's budget.
    const semantic = await semanticScores(this.store, rev.id, question, this.embedder).catch(() => undefined);
    const { bundle, tiers, scored, hidden, inaccessible, truncation } = retrieveForQuestion(this.store, rev.id, question, { lens: req.lens, pins: new Set(req.pins ?? []), extraSeeds: [...(req.pins ?? []), ...(req.seeds ?? [])], semantic, access: policyFor(this.store, rev.repoRoot), tokenBudget: chunkTokenBudget() });
    const diagnostics = rev.diagnostics.filter((d) => d.code === "PARSE_ERRORS").map((d) => d.message);
    let representation: RepresentationOutput | undefined, run;
    const warnings: string[] = [];
    if (bundle.entities.length > 0) {
      const { result, note } = await this.callModel<RepresentationOutput>(ctx, rev, { purpose: "REPRESENT", schemaId: SCHEMA_REPRESENTATION, question, bundle });
      if (note) warnings.push(note);
      if (result.ok) { representation = result.value; run = result.run; }
      else { warnings.push(`model unavailable (${result.error.code}); showing deterministic facts only`); diagnostics.push(`model output unavailable: ${result.error.code}`); }
    }
    const { view, claims } = compileView({ question, bundle, tiers, scored, representation, run, diagnostics, store: this.store, systemName: rev.repoRoot.split("/").filter(Boolean).pop() });
    // "The question is about how something works" is only true when the wording said so. A default or a guess is described
    // by the reading itself (route.because), so the two never disagree.
    view.formReason = route.source !== "default" ? choice.reason : undefined;
    view.route = route;
    if (req.level !== undefined) view.level = req.level;
    view.hidden = hidden;
    if (inaccessible) view.gaps.push(`${inaccessible} match(es) are in code you do not have access to and were left out.`);
    if (truncation) view.gaps.push(`The evidence was cut to fit the model's budget (${truncation.before} → ${truncation.after} estimated tokens): ${truncation.dropped.length} element(s) were dropped, lowest-ranked first. "Why isn't X shown?" lists them.`);
    this.persist(claims);
    const mapBuilt = redactBuilt(this.store, rev, { view, claims });
    return ok(ctx, { view: mapBuilt.view, claims: mapBuilt.claims }, { revision: rev.id, warnings, completeness: mapBuilt.view.gaps.length ? "PARTIAL" : "COMPLETE" });
  }

  async investigate(ctx: CallContext, req: { trace: string; revision?: string; ignored?: string[] }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; ingest a repository first", retryable: false });
    if (!req.trace || req.trace.length > 100_000) return fail(ctx, { code: "INVALID_SCHEMA", message: "trace must be 1–100000 characters", retryable: false });
    const built = buildHypothesis(this.store, rev, { trace: req.trace, ignored: req.ignored });
    if ("error" in built) return fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message: built.error, retryable: false });
    this.persist(built.claims);
    this.store.audit(actor(ctx), "investigate", rev.id, { suspects: built.view.nodes.filter((n) => n.role === "suspect").length });
    redactBuilt(this.store, rev, built);
    return ok(ctx, built, { revision: rev.id, completeness: built.view.gaps.length ? "PARTIAL" : "COMPLETE" });
  }

  /** The catalogue of visuals, with whether each can be shown for the current repository and why not. */
  visuals(ctx: CallContext, req: { revision?: string }): ApiResult<CatalogEntry[]> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    return ok(ctx, catalog(this.store, rev, !!rev && isGitRepo(rev.repoRoot)), rev ? { revision: rev.id } : {});
  }

  /** Manual salience override, persistent per repository: pin = always shown, boost = ranked higher, demote = ranked lower. */
  setOverride(ctx: CallContext, req: { revision?: string; entityId: string; mode: "pin" | "boost" | "demote" | null }): ApiResult<{ entityId: string; mode: "pin" | "boost" | "demote" | null }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    if (![null, "pin", "boost", "demote"].includes(req.mode)) return fail(ctx, { code: "INVALID_SCHEMA", message: "mode must be pin, boost, demote or null", retryable: false });
    if (this.store.entitiesById(rev.id, [req.entityId]).length === 0) return fail(ctx, { code: "NOT_FOUND", message: "unknown element", retryable: false });
    this.store.setOverride(rev.repoRoot, req.entityId, req.mode);
    this.store.audit(actor(ctx), `override.${req.mode ?? "reset"}`, req.entityId, {});
    return ok(ctx, { entityId: req.entityId, mode: req.mode }, { revision: rev.id });
  }

  listOverrides(ctx: CallContext, req: { revision?: string }): ApiResult<{ entityId: string; mode: string }[]> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    return ok(ctx, [...this.store.overrides(rev.repoRoot)].map(([entityId, mode]) => ({ entityId, mode })));
  }

  /** Rebuild the current view with whatever changed underneath it (an override, a new exception), keeping its identity. */
  async refreshView(ctx: CallContext, req: { view: ViewSpec }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> {
    const v = req.view;
    if (!v) return fail(ctx, { code: "INVALID_SCHEMA", message: "no view", retryable: false });
    const r = v.investigation
      ? await this.investigate(ctx, { trace: v.investigation.trace, revision: v.revision, ignored: v.investigation.ignored })
      : await this.ask(ctx, { question: v.question, revision: v.revision, form: v.formId, subject: typeof v.params?.subject === "string" ? v.params.subject : undefined });
    if (r.ok) r.value.view.version = v.version + 1;
    return r;
  }

  /** "ignore X" / "restore X" on an investigation: rebuild with the new exclusion set; the view version advances. */
  steer(ctx: CallContext, req: { view: ViewSpec; action: "IGNORE" | "RESTORE"; entityId: string }): ApiResult<{ view: ViewSpec; claims: Claim[] }> {
    const inv = req.view?.investigation;
    if (req.view?.formId !== "HypothesisGraph" || !inv) return fail(ctx, { code: "INVALID_SCHEMA", message: "only an investigation can be steered", retryable: false });
    const rev = this.store.revision(req.view.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const ignored = new Set(inv.ignored);
    if (req.action === "IGNORE") ignored.add(req.entityId); else ignored.delete(req.entityId);
    const built = buildHypothesis(this.store, rev, { trace: inv.trace, ignored: [...ignored] });
    if ("error" in built) return fail(ctx, { code: "INSUFFICIENT_EVIDENCE", message: built.error, retryable: false });
    built.view.version = req.view.version + 1;
    this.persist(built.claims);
    this.store.audit(actor(ctx), `steer.${req.action.toLowerCase()}`, req.entityId, { version: built.view.version });
    redactBuilt(this.store, rev, built);
    return ok(ctx, built, { revision: rev.id });
  }

  // ---------------------------------------------------------------- explanations
  async explain(ctx: CallContext, req: { revision: string; entityIds: string[]; question?: string }): Promise<ApiResult<ExplainResult>> {
    const rev = this.store.revision(req.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const selected = [...new Set(req.entityIds ?? [])].slice(0, 20);
    if (selected.length === 0) return fail(ctx, { code: "INVALID_SCHEMA", message: "select at least one element", retryable: false });
    const found = this.store.entitiesById(rev.id, selected);
    if (found.length !== selected.length) return fail(ctx, { code: "NOT_FOUND", message: "selection references unknown entities", retryable: false });
    const acc = policyFor(this.store, rev.repoRoot);
    // A selection inside code this caller cannot see is refused without saying what it was.
    if (found.some((e) => acc.denied(e.file))) return fail(ctx, { code: "FORBIDDEN", message: "one or more selected elements are not accessible to you", retryable: false });

    const bundle = retrieveAround(this.store, rev.id, selected, 3, 120, acc);
    const question = req.question?.trim() || "Why are these connected?";
    const { result, note } = await this.callModel<ExplanationOutput>(ctx, rev, { purpose: "EXPLAIN", schemaId: SCHEMA_EXPLANATION, question, bundle, selected });
    if (!result.ok) return fail(ctx, result.error);

    let claims = result.value.claims.map((c) => gateClaim({ ...c, structure: c.pathEntityIds && c.pathEntityIds.length > 1 ? { kind: "path", entityIds: c.pathEntityIds } : undefined }, bundle, { run: result.run, store: this.store }));
    // Adversarial pass by the model for the claims that survived grounding (bounded; the stub has nothing to add).
    if (this.model.name !== "stub") {
      claims = await Promise.all(claims.map(async (c, i) => {
        if (i >= 3 || c.displayMode === "HIDDEN") return c;
        const ch = await this.callModel<ChallengeOutput>(ctx, rev, { purpose: "CHALLENGE", schemaId: SCHEMA_CHALLENGE, question, bundle, selected, claim: { assertion: c.draft.assertion, evidenceIds: c.draft.evidenceIds } });
        if (!ch.result.ok) return c;
        return withChallenge(c, bundle, ch.result.value.objections, this.store);
      }));
    }
    this.persist(claims);
    const shown = claims.filter((c) => c.displayMode !== "HIDDEN");
    const rejected = claims.length - shown.length;
    const evidence = this.resolveMany(rev, bundle.evidence, [...new Set(shown.flatMap((c) => c.draft.evidenceIds))]);
    const said = modelText(result.value.summary, `The model's summary was withheld: it claimed certainty or carried a link, which only evidence and the gates may do.`);
    const summary = rejected ? `${said.text} (${rejected} claim(s) withheld: they failed a gate.)` : said.text;
    this.store.audit(actor(ctx), "explain", rev.id, { selected: selected.length, claims: claims.length, withheld: rejected });
    return ok(ctx, { summary, claims, evidence, selected }, { revision: rev.id, completeness: rejected ? "PARTIAL" : "COMPLETE", warnings: note ? [note] : [] });
  }

  private resolveMany(rev: RevisionRow, pool: EvidenceRef[], ids: string[]): ResolvedEvidence[] {
    return ids.flatMap((id) => { const e = pool.find((x) => x.id === id) ?? this.store.evidence(rev.id, id); return e ? [this.resolveEvidence(rev, e)] : []; });
  }

  /** "Why are you showing this?": the salience factors and evidence behind a node, in plain terms. */
  whyShown(ctx: CallContext, req: { view: ViewSpec; nodeId: string }): ApiResult<ExplainResult> {
    const rev = this.store.revision(req.view?.revision);
    const node = req.view?.nodes.find((n) => n.id === req.nodeId);
    if (!rev || !node) return fail(ctx, { code: "NOT_FOUND", message: "no such element in this view", retryable: false });
    const lines: string[] = [];
    if (node.rank) lines.push(`Ranked #${node.rank} among suspects (score ${node.score?.toFixed(2)}).`);
    else if (node.score !== undefined) lines.push(`Relevance ${node.score.toFixed(2)} → tier ${node.tier}.`);
    for (const f of (node.factors ?? []).filter((x) => x.normalizedScore > 0).sort((a, b) => b.normalizedScore - a.normalizedScore)) lines.push(`${f.factor.replace(/_/g, " ").toLowerCase()}: ${f.reason} (${f.normalizedScore.toFixed(2)}).`);
    if (node.role === "failure-site" || node.role === "writer" || node.role === "state") lines.push(...(node.notes ?? []));
    if (lines.length === 0) lines.push(node.role ? `It plays the role “${node.role}” in this ${req.view.formId}.` : "It is a direct neighbour of a matched element.");
    const factorEv = (node.factors ?? []).flatMap((f) => f.evidenceIds);
    const evidenceIds = [...new Set([...node.evidenceIds, ...factorEv])].slice(0, 8);
    const claim = gateClaim({ assertion: `“${node.label}” is shown because: ${lines.slice(0, 3).join(" ")}`, claimClass: "why-shown", evidenceIds, rationaleSummary: "Explains the salience factors that placed this element in the view." }, bundleFor(this.store, rev.id, node.entityRefs), { store: this.store, trusted: true });
    this.persist([claim]);
    return ok(ctx, { summary: lines.join("\n"), claims: [claim], evidence: this.resolveMany(rev, [], evidenceIds), selected: node.entityRefs }, { revision: rev.id });
  }

  /** "Why isn't X shown?": names the reason, using the retrieval record or by scoring X against the question. */
  whyHidden(ctx: CallContext, req: { view: ViewSpec; query: string }): ApiResult<ExplainResult> {
    const rev = this.store.revision(req.view?.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const q = req.query.trim().toLowerCase();
    if (!q) return fail(ctx, { code: "INVALID_SCHEMA", message: "say what you expected to see", retryable: false });
    const shownIds = new Set(req.view.nodes.flatMap((n) => n.entityRefs));
    const matches = this.store.entities(rev.id).filter((e) => e.kind !== "file" && (e.name.toLowerCase().includes(q) || e.entityId.toLowerCase().includes(q)));
    if (matches.length === 0) return ok(ctx, { summary: `Nothing in this repository is named like “${req.query}”, so it can't be shown. Static analysis only sees what is in the code.`, claims: [], evidence: [], selected: [] }, { revision: rev.id });
    const lines: string[] = [];
    for (const e of matches.slice(0, 4)) {
      if (shownIds.has(e.entityId)) { lines.push(`${e.name} is shown (it is in the view).`); continue; }
      const rec = req.view.hidden?.find((h) => h.entityId === e.entityId);
      if (req.view.ignored?.includes(e.entityId)) { lines.push(`${e.name}: you asked to ignore it.`); continue; }
      if (rec) { lines.push(`${e.name}: ${rec.reason}.`); continue; }
      const terms = (req.view.question.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []).filter((t) => t.length > 2);
      const s = scoreEntity(e, { store: this.store, revision: rev.id, terms, weights: WEIGHTS.map });
      const top = s.factors.filter((f) => f.normalizedScore > 0).map((f) => f.reason);
      lines.push(`${e.name}: relevance ${s.score.toFixed(2)} for this question — ${top.length ? top.join("; ") : "it does not match the question's terms and is not next to a shown element"}.`);
    }
    return ok(ctx, { summary: lines.join("\n"), claims: [], evidence: [], selected: matches.map((m) => m.entityId) }, { revision: rev.id });
  }

  /** "Why do you suspect X?": the ranking factors behind a suspect, with citations. */
  whySuspect(ctx: CallContext, req: { view: ViewSpec; target: string }): ApiResult<ExplainResult> {
    const t = req.target.trim().toLowerCase();
    const suspects = (req.view?.nodes ?? []).filter((n) => n.role === "suspect");
    const node = t ? suspects.find((n) => n.label.toLowerCase().includes(t)) : suspects[0];
    if (!node) return fail(ctx, { code: "NOT_FOUND", message: t ? `no suspect named like “${req.target}”` : "no suspects in this view", retryable: false });
    return this.whyShown(ctx, { view: req.view, nodeId: node.id });
  }

  evidenceFor(ctx: CallContext, req: { revision: string; evidenceId: string }): ApiResult<ResolvedEvidence> {
    const rev = this.store.revision(req.revision);
    const ev = rev && this.store.evidence(rev.id, req.evidenceId);
    if (!rev || !ev) return fail(ctx, { code: "EVIDENCE_MISSING", message: "no such evidence in this revision", retryable: false });
    return ok(ctx, this.resolveEvidence(rev, ev), { revision: rev.id });
  }

  /** One read op for a list surface that needs a location per row: hundreds of single reads per screen render would not be affordable. Non-mutating. */
  evidenceBatch(ctx: CallContext, req: { revision: string; evidenceIds: string[] }): ApiResult<ResolvedEvidence[]> {
    if (!req || typeof req.revision !== "string" || !Array.isArray(req.evidenceIds) || req.evidenceIds.some((id) => typeof id !== "string") || req.evidenceIds.length > 2000) return fail(ctx, { code: "INVALID_SCHEMA", message: "evidenceBatch requires a revision and at most 2000 evidence IDs", retryable: false });
    const rev = this.store.revision(req.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    return ok(ctx, this.resolveMany(rev, [], req.evidenceIds), { revision: rev.id });
  }

  /** File/line for spans that are recorded on findings (the detector's fact location, before any evidence was resolved). */
  locateSpans(ctx: CallContext, req: { revision: string; spans: SourceSpan[] }): ApiResult<{ file: string; absPath?: string; startLine: number; endLine: number; state: "CURRENT" | "STALE" | "UNAVAILABLE" | "ACCESS_REVOKED" }[]> {
    if (!req || typeof req.revision !== "string" || !Array.isArray(req.spans) || req.spans.length > 2000 || req.spans.some((s) => !s || typeof s !== "object" || typeof s.sourceId !== "string" || typeof s.contentHash !== "string" || !Number.isInteger(s.startByte) || !Number.isInteger(s.endByteExclusive))) return fail(ctx, { code: "INVALID_SCHEMA", message: "locateSpans requires a revision and at most 2000 source spans", retryable: false });
    const rev = this.store.revision(req.revision);
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    const acc = policyFor(this.store, rev.repoRoot);
    return ok(ctx, req.spans.map((s) => {
      if (acc.denied(s.sourceId)) return { file: "(not shown)", startLine: 0, endLine: 0, state: "ACCESS_REVOKED" as const };
      const path = resolve(rev.repoRoot, s.sourceId);
      const rel = relative(rev.repoRoot, path);
      if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(path)) return { file: s.sourceId, startLine: 0, endLine: 0, state: "UNAVAILABLE" as const };
      try {
        const buf = readFileSync(path);
        const stale = createHash("sha256").update(buf).digest("hex") !== s.contentHash;
        const startLine = buf.subarray(0, s.startByte).toString("utf8").split("\n").length;
        const endLine = startLine + buf.subarray(s.startByte, s.endByteExclusive).toString("utf8").split("\n").length - 1;
        return { file: s.sourceId, absPath: path, startLine, endLine, state: stale ? "STALE" : "CURRENT" };
      } catch { return { file: s.sourceId, startLine: 0, endLine: 0, state: "UNAVAILABLE" as const };
      }
    }), { revision: rev.id });
  }

  overlays(ctx: CallContext, req: { revision: string; entityIds: string[]; window: { from: number; to: number }; layers?: { tests?: boolean; runtime?: boolean } }) {
    if (!req || typeof req.revision !== "string" || !Array.isArray(req.entityIds) || req.entityIds.length > 2000 || req.entityIds.some((id) => typeof id !== "string") || !req.window || !Number.isFinite(req.window.from) || !Number.isFinite(req.window.to) || req.window.from < 0 || req.window.to <= req.window.from || req.window.to > 8.64e15) return fail(ctx, { code: "INVALID_SCHEMA", message: "overlays require a revision, at most 2000 entity IDs and a valid time window", retryable: false });
    if (!this.store.revision(req.revision)) return fail(ctx, { code: "NOT_FOUND", message: "unknown revision", retryable: false });
    return ok(ctx, mapOverlays(this.store, req.revision, req.entityIds, req.window, { tests: req.layers?.tests !== false, runtime: req.layers?.runtime !== false }), { revision: req.revision });
  }

  /** Read a span from the repo root of `rev`, refusing paths outside it and hashing to detect drift. */
  resolveEvidence(rev: RevisionRow, ev: EvidenceRef): ResolvedEvidence {
    // Evidence in a denied path is not readable by this caller: no file name, no snippet.
    const acc = policyFor(this.store, rev.repoRoot);
    const where = (ev.location as { kind: string; span?: { sourceId: string } }).span?.sourceId ?? ev.sourceId;
    if (typeof where === "string" && acc.denied(where)) return { id: ev.id, class: ev.class, file: "(not shown)", startByte: 0, endByte: 0, startLine: 0, endLine: 0, snippet: "", state: "ACCESS_REVOKED" };
    const loc = ev.location as { kind: string; locator?: string; span?: { sourceId: string; contentHash: string; startByte: number; endByteExclusive: number } };
    // Non-code evidence (git history, pasted traces) carries its own description and has no span to re-read.
    if (loc.kind !== "CodeLocation" || !loc.span) {
      return { id: ev.id, class: ev.class, file: ev.sourceId, startByte: 0, endByte: 0, startLine: 0, endLine: 0, snippet: loc.locator ?? "", state: ev.state };
    }
    const span = loc.span;
    const base = { id: ev.id, class: ev.class, file: span.sourceId, absPath: resolve(rev.repoRoot, span.sourceId), startByte: span.startByte, endByte: span.endByteExclusive, startLine: 0, endLine: 0, snippet: "" };
    const path = resolve(rev.repoRoot, span.sourceId);
    const rel = relative(rev.repoRoot, path);
    if (rel.startsWith("..") || isAbsolute(rel)) return { ...base, state: "UNAVAILABLE" };
    let buf: Buffer;
    try { buf = readFileSync(path); } catch { return { ...base, state: "UNAVAILABLE" }; }
    const stale = createHash("sha256").update(buf).digest("hex") !== span.contentHash;
    // Offsets are bytes; slice on the byte buffer, then compute lines from the prefix.
    const startLine = buf.subarray(0, span.startByte).toString("utf8").split("\n").length;
    const snippet = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
    return { ...base, startLine, endLine: startLine + snippet.split("\n").length - 1, snippet: snippet.length > 4000 ? snippet.slice(0, 4000) + "\n…" : snippet, state: stale ? "STALE" : "CURRENT" };
  }

  // ---------------------------------------------------------------- verdicts
  verdict(ctx: CallContext, req: { claimId: string; verdict: VerdictKind; explanation: string; expectedVersion: number }): ApiResult<{ claim: Claim; affected: Claim[] }> {
    if (!["CONFIRM", "REFUTE", "DISPUTE"].includes(req.verdict)) return fail(ctx, { code: "INVALID_SCHEMA", message: "verdict must be CONFIRM, REFUTE or DISPUTE", retryable: false });
    const r = applyVerdict(this.store, { claimId: req.claimId, verdict: req.verdict, explanation: req.explanation ?? "", actorId: actor(ctx), expectedVersion: req.expectedVersion });
    if (!r.ok) return fail(ctx, r.error);
    // Subscribers hear that a judgement was recorded, by id and verdict only: not what the claim said, and nothing about the code.
    this.notifications.publish({ eventId: `verdict:${r.claim.draft.id}:${r.claim.version}`, type: "verdict.recorded", revision: r.claim.draft.revision, summary: `A claim was ${req.verdict === "CONFIRM" ? "confirmed" : req.verdict === "REFUTE" ? "refuted" : "disputed"}; ${r.affected.length} dependent claim(s) were affected.`, links: { claim: r.claim.draft.id } });
    return ok(ctx, { claim: r.claim, affected: r.affected }, { resourceVersion: r.claim.version });
  }

  claims(ctx: CallContext, req: { ids: string[] }): ApiResult<Claim[]> {
    return ok(ctx, this.store.getClaims((req.ids ?? []).slice(0, 500)));
  }

  // ---------------------------------------------------------------- workspaces (investigation memory)
  saveWorkspace(ctx: CallContext, req: { workspaceId?: string; name: string; expectedVersion: number; revision?: string; state: SavedState }): ApiResult<{ workspaceId: string; receipt: CommitReceipt; replayed: boolean }> {
    const name = (req.name ?? "").trim();
    if (!name || name.length > 120) return fail(ctx, { code: "INVALID_SCHEMA", message: "name must be 1–120 characters", retryable: false });
    const workspaceId = req.workspaceId ?? `ws:${randomUUID()}`;
    const r = this.journal.submit(ctx, { id: ctx.requestId, type: "UPDATE_WORKSPACE", subjectId: workspaceId, expectedVersion: req.expectedVersion ?? 0, payload: { name, revision: req.revision, state: req.state } });
    if (!r.ok) return fail(ctx, r.error);
    if (!r.replayed) this.store.audit(actor(ctx), "workspace.save", workspaceId, { version: r.receipt.resourceVersion });
    return ok(ctx, { workspaceId, receipt: r.receipt, replayed: r.replayed }, { resourceVersion: r.receipt.resourceVersion, revision: req.revision });
  }

  listWorkspaces(ctx: CallContext): ApiResult<{ id: string; name: string; version: number; revision: string | null; updatedAt: string }[]> {
    const rows = (this.store.db.prepare("select id, name, version, revision, updated_at from workspaces order by updated_at desc").all() as any[])
      .filter((r) => { const o = r.revision ? this.store.revision(r.revision, true) : null; return !(o && this.store.isRevoked(o.repoRoot)); });
    return ok(ctx, rows.map((r) => ({ id: r.id, name: r.name, version: r.version, revision: r.revision, updatedAt: r.updated_at })));
  }

  /** Resume: saved state plus staleness (evidence whose source changed) and the current state of every saved claim. */
  openWorkspace(ctx: CallContext, req: { workspaceId: string }): ApiResult<{ id: string; name: string; version: number; revision: string | null; state: SavedState; staleEvidence: string[]; staleFiles: string[]; revisionIndexed: boolean; claimStates: Claim[] }> {
    const row = this.store.db.prepare("select * from workspaces where id = ?").get(req.workspaceId) as any;
    if (!row) return fail(ctx, { code: "NOT_FOUND", message: "no such workspace", retryable: false });
    // A saved investigation over a source whose permission was withdrawn is not served, even before it is purged.
    const owner = row.revision ? this.store.revision(row.revision, true) : null;
    if (owner && this.store.isRevoked(owner.repoRoot)) return fail(ctx, { code: "FORBIDDEN", message: "access to the source this was saved against was withdrawn", retryable: false });
    const state: SavedState = JSON.parse(row.json);
    const rev = row.revision ? this.store.revision(row.revision) : null;
    const ids = new Set<string>();
    for (const n of state.view?.nodes ?? []) n.evidenceIds.forEach((i) => ids.add(i));
    for (const e of state.view?.edges ?? []) e.evidenceIds.forEach((i) => ids.add(i));
    for (const c of [...state.claims, ...(state.explanation?.claims ?? [])]) c.draft.evidenceIds.forEach((i) => ids.add(i));
    const staleEvidence: string[] = [];
    const staleFiles = new Set<string>();
    if (rev) {
      for (const id of ids) {
        const ev = this.store.evidence(rev.id, id);
        if (!ev) continue;
        const res = this.resolveEvidence(rev, ev);
        if (res.state === "STALE" || res.state === "UNAVAILABLE") { staleEvidence.push(id); staleFiles.add(res.file); }
      }
    }
    const claimIds = [...new Set([...state.claims, ...(state.explanation?.claims ?? [])].map((c) => c.draft.id))];
    this.store.audit(actor(ctx), "workspace.open", row.id, { stale: staleEvidence.length });
    return ok(ctx, { id: row.id, name: row.name, version: row.version, revision: row.revision, state, staleEvidence, staleFiles: [...staleFiles].sort(), revisionIndexed: !!rev, claimStates: this.store.getClaims(claimIds) },
      { revision: row.revision ?? undefined, resourceVersion: row.version, completeness: staleEvidence.length ? "PARTIAL" : "COMPLETE", warnings: staleEvidence.length ? [`${staleEvidence.length} evidence span(s) changed since this was saved`] : [] });
  }

  /** "What changed since I left": re-index the repository and diff against the saved revision. */
  async changesSince(ctx: CallContext, req: { workspaceId: string }): Promise<ApiResult<ChangesSince>> {
    const row = this.store.db.prepare("select * from workspaces where id = ?").get(req.workspaceId) as any;
    const rev0 = row?.revision ? this.store.revision(row.revision) : null;
    if (!row || !rev0) return fail(ctx, { code: "NOT_FOUND", message: "no saved revision to compare against", retryable: false });
    if (!existsSync(rev0.repoRoot)) return fail(ctx, { code: "NOT_FOUND", message: `repository folder no longer exists: ${rev0.repoRoot}`, retryable: false });
    const ing = await this.ingestRepository(ctx, { repoPath: rev0.repoRoot });
    if (!ing.ok) return ing as ApiResult<never>;
    const rev1 = ing.value;
    const state: SavedState = JSON.parse(row.json);
    const fileHash = (rev: string) => new Map(this.store.entities(rev).filter((e) => e.kind === "file").map((e) => [e.file, e.spans[0]?.contentHash ?? ""]));
    const h0 = fileHash(rev0.id), h1 = fileHash(rev1.id);
    const files = {
      added: [...h1.keys()].filter((f) => !h0.has(f)).sort(), removed: [...h0.keys()].filter((f) => !h1.has(f)).sort(),
      changed: [...h1.keys()].filter((f) => h0.has(f) && h0.get(f) !== h1.get(f)).sort(),
    };
    const changedSet = new Set(files.changed);
    const e0 = new Map(this.store.entities(rev0.id).map((e) => [e.entityId, e]));
    const e1 = new Map(this.store.entities(rev1.id).map((e) => [e.entityId, e]));
    const affectedNodes: ChangesSince["affectedNodes"] = [];
    for (const n of state.view?.nodes ?? []) {
      for (const id of n.entityRefs) {
        const cur = e1.get(id);
        if (!cur) affectedNodes.push({ nodeId: n.id, label: n.label, change: "removed" });
        // A node is affected when its own source changed (symbol hash), not merely when its file did.
        else if (changedSet.has(cur.file) && cur.symbolHash !== e0.get(id)?.symbolHash) affectedNodes.push({ nodeId: n.id, label: n.label, change: "changed" });
      }
    }
    const hist = (rev: string) => new Map(this.store.factsByPredicate(rev, "history").map((f) => [f.subject.replace(/^file:/, ""), (f.object as any).value]));
    const c0 = hist(rev0.id), c1 = hist(rev1.id);
    const commits = [...c1].filter(([f, v]) => c0.get(f)?.lastCommit !== v.lastCommit).map(([file, v]) => ({ file, subject: v.lastSubject, author: v.lastAuthor, date: v.lastDate })).slice(0, 10);
    const changed = rev1.id !== rev0.id;
    const summary = !changed ? "Nothing in the repository has changed since you saved this investigation."
      : `Since you left: ${files.changed.length} file(s) changed, ${files.added.length} added, ${files.removed.length} removed; ${affectedNodes.length} element(s) of this investigation are affected.${commits.length ? ` Latest: “${commits[0].subject}” by ${commits[0].author}.` : ""}`;
    return ok(ctx, { fromRevision: rev0.id, toRevision: rev1.id, changed, files, affectedNodes, commits, summary }, { revision: rev1.id });
  }

  /** "What changed since my last index?": re-index the repository without a saved investigation and summarise the delta. */
  async changesSinceIndex(ctx: CallContext, req: { revision?: string }): Promise<ApiResult<ChangesSince>> {
    const from = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!from) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision to compare against", retryable: false });
    const ing = await this.ingestRepository(ctx, { repoPath: from.repoRoot });
    if (!ing.ok) return ing as ApiResult<never>;
    return this.changesBetween(ctx, from.id, ing.value.id);
  }

  /** Post-MVP (C04.readRevisionPair): an indexed revision id may name any earlier revision. */
  async changesBetweenRevisions(ctx: CallContext, req: { fromRevision: string; toRevision?: string }): Promise<ApiResult<ChangesSince>> {
    const from = this.store.revision(req.fromRevision);
    if (!from) return fail(ctx, { code: "NOT_FOUND", message: `no such revision: ${req.fromRevision}`, retryable: false });
    const to = (req.toRevision ? this.store.revision(req.toRevision) : null) ?? this.store.latestRevision(from.repoRoot);
    if (!to) return fail(ctx, { code: "NOT_FOUND", message: "no later revision of this repository is indexed", retryable: false });
    return this.changesBetween(ctx, from.id, to.id);
  }

  /** Diff two stored revisions (C04.readRevisionPair, C23.compare): file deltas, affected elements, commits. */
  changesBetween(ctx: CallContext, rev0id: string, rev1id: string): ApiResult<ChangesSince> {
    const rev0 = this.store.revision(rev0id), rev1 = this.store.revision(rev1id);
    if (!rev0 || !rev1) return fail(ctx, { code: "NOT_FOUND", message: "no such revision", retryable: false });
    const fileHash = (rev: string) => new Map(this.store.entities(rev).filter((e) => e.kind === "file").map((e) => [e.file, e.spans[0]?.contentHash ?? ""]));
    const h0 = fileHash(rev0.id), h1 = fileHash(rev1.id);
    const files = {
      added: [...h1.keys()].filter((f) => !h0.has(f)).sort(), removed: [...h0.keys()].filter((f) => !h1.has(f)).sort(),
      changed: [...h1.keys()].filter((f) => h0.has(f) && h0.get(f) !== h1.get(f)).sort(),
    };
    const kinds = ["function", "method", "class"];
    const e0 = new Map(this.store.entities(rev0.id).filter((e) => kinds.includes(e.kind)).map((e) => [e.entityId, e]));
    const e1 = new Map(this.store.entities(rev1.id).filter((e) => kinds.includes(e.kind)).map((e) => [e.entityId, e]));
    // Element-level changes: symbols whose text changed inside a changed file (no workspace needed).
    const affectedNodes: ChangesSince["affectedNodes"] = [];
    for (const [id, cur] of e1) {
      const before = e0.get(id);
      if (!before) affectedNodes.push({ nodeId: `n:${id}`, label: cur.name, change: "added" });
      else if (cur.symbolHash && before.symbolHash && cur.symbolHash !== before.symbolHash) affectedNodes.push({ nodeId: `n:${id}`, label: cur.name, change: "changed" });
    }
    for (const [id] of e0) if (!e1.has(id)) affectedNodes.push({ nodeId: `n:${id}`, label: short(id), change: "removed" });
    const hist = (rev: string) => new Map(this.store.factsByPredicate(rev, "history").map((f) => [f.subject.replace(/^file:/, ""), (f.object as any).value]));
    const c0 = hist(rev0.id), c1 = hist(rev1.id);
    const commits = [...c1].filter(([f, v]) => c0.get(f)?.lastCommit !== v.lastCommit).map(([file, v]) => ({ file, subject: v.lastSubject, author: v.lastAuthor, date: v.lastDate })).slice(0, 10);
    const changed = rev1.id !== rev0.id;
    const summary = !changed ? "Nothing in the repository has changed since this revision was indexed."
      : `Between revisions: ${files.changed.length} file(s) changed, ${files.added.length} added, ${files.removed.length} removed; ${affectedNodes.length} symbol(s) changed.${commits.length ? ` Latest: “${commits[0].subject}” by ${commits[0].author}.` : ""}`;
    return ok(ctx, { fromRevision: rev0.id, toRevision: rev1.id, changed, files, affectedNodes, commits, summary }, { revision: rev1.id });
  }

  /** System status (post-MVP worker stats): indexed revisions, file/symbol counts, last analyzer run. */
  revisionStats(ctx: CallContext, req: { revision?: string }): ApiResult<{ revision: string | null; files: number; symbols: number; diagnostics: string[] }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return ok(ctx, { revision: null, files: 0, symbols: 0, diagnostics: [] });
    const ents = this.store.entities(rev.id);
    return ok(ctx, {
      revision: rev.id, files: ents.filter((e) => e.kind === "file").length,
      symbols: ents.filter((e) => ["function", "method", "class"].includes(e.kind)).length,
      diagnostics: rev.diagnostics.map((d) => d.message),
      repoRoot: rev.repoRoot, gitHead: rev.gitHead, createdAt: rev.createdAt,
    }, { revision: rev.id });
  }

  // ---------------------------------------------------------------- conversation
  /** One text box: new question, trace → investigation, steering, "why …", or resume. Selection chips are referents. */
  async converse(ctx: CallContext, req: { text: string; view?: ViewSpec | null; selection?: string[]; revision?: string; pins?: string[] }): Promise<ApiResult<ConverseResult>> {
    const text = (req.text ?? "").trim();
    if (!text) return fail(ctx, { code: "INVALID_SCHEMA", message: "say something", retryable: false });
    const view = req.view ?? null;
    const nodeById = new Map((view?.nodes ?? []).map((n) => [n.id, n]));
    const selected = (req.selection ?? []).map((id) => nodeById.get(id)).filter((n): n is NonNullable<typeof n> => !!n);
    const referentCount = selected.length || (req.pins?.length ?? 0);
    const reading = await readText(this.router, text, { hasView: !!view || referentCount >= 1, viewForm: view?.formId, selectionCount: referentCount, looksLikeTrace: looksLikeTrace(text) });
    const intent = reading.intent;
    const entityIds = selected.flatMap((n) => n.entityRefs);
    const revision = view?.revision ?? req.revision;
    // A steering turn adjusts the current view, so it does not repeat why that kind of view was chosen.
    const asView = (r: ApiResult<{ view: ViewSpec; claims: Claim[] }>, lead: string, steering = false): ApiResult<ConverseResult> =>
      r.ok ? ok(ctx, { kind: "view", view: r.value.view, claims: r.value.claims, message: `${lead} ${steering ? "" : r.value.view.formReason ?? ""} ${r.value.view.caption}`.replace(/\s+/g, " ").trim() }, r.metadata) : (r as ApiResult<never>);
    const asExplain = (r: ApiResult<ExplainResult>, lead = ""): ApiResult<ConverseResult> =>
      r.ok ? ok(ctx, { kind: "explanation", explanation: r.value, message: `${lead}${r.value.summary}`.trim() }, r.metadata) : (r as ApiResult<never>);
    const needsView = () => fail<ConverseResult>(ctx, { code: "INVALID_SCHEMA", message: "Ask a question first, then I can talk about what's on the map.", retryable: false });

    const overview = async (lead: string): Promise<ApiResult<ConverseResult>> => {
        const rev = revision ? this.store.revision(revision) : this.store.latestRevision();
        if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index a repository first", retryable: false });
        // The most connected code is what a newcomer should see first; the map starts zoomed out to the domains.
        const idx = revisionIndex(this.store, rev.id);
        const kinds = new Set(["function", "method", "class"]);
        const seeds = this.store.entities(rev.id).filter((e) => kinds.has(e.kind)).sort((a, b) => (idx.degree.get(b.entityId) ?? 0) - (idx.degree.get(a.entityId) ?? 0) || a.entityId.localeCompare(b.entityId)).slice(0, 30).map((e) => e.entityId);
        const r = await this.ask(ctx, { question: "Give me an overview of the whole project", revision: rev.id, seeds, level: 1 });
        const profile = projectProfile(this.store, rev.id);
        if (r.ok) { r.value.view.formReason = "The most connected code in the repository, grouped by responsibility. Zoom in for detail."; r.value.view.gaps.unshift(profile.text); }
        return asView(r, `${lead} ${profile.text}`);
    };
    switch (intent.type) {
      case "investigate": return asView(await this.investigate(ctx, { trace: text, revision }), "Investigating the exception you pasted.");
      case "overview": return overview("You asked about the project as a whole.");
      case "ask": {
        const r = await this.ask(ctx, { question: text, revision, pins: req.pins, route: intent.route });
        // Nothing matched any word in the question: say so, and show the project instead of an empty map.
        if (r.ok && r.value.view.nodes.length === 0 && !(req.pins?.length)) return overview("No element of the code matches those words, so here is the project as a whole instead. Name a feature, module or function for something specific.");
        return asView(r, "");
      }
      case "resume": {
        const list = this.listWorkspaces(ctx);
        const hit = list.ok ? matchName(intent.name, list.value) : null;
        if (!hit) return ok(ctx, { kind: "message", message: intent.name ? `I couldn't find a saved investigation matching “${intent.name}”.` : "There are no saved investigations yet." });
        return ok(ctx, { kind: "resume", workspaceId: hit.id, message: `Resuming “${hit.name}”…` });
      }
      case "zoom": return ok(ctx, { kind: "zoom", direction: intent.direction, message: intent.direction === "in" ? "Zooming in one level." : intent.direction === "out" ? "Zooming out one level." : "Showing the overview." });
      case "whyShown": {
        if (!view) return needsView();
        return asExplain(this.whyShown(ctx, { view, nodeId: selected[0].id }), `About “${selected[0].label}”: `);
      }
      case "whyHidden": return view ? asExplain(this.whyHidden(ctx, { view, query: intent.target })) : needsView();
      case "whySuspect": return view ? asExplain(this.whySuspect(ctx, { view, target: intent.target || selected[0]?.label || "" })) : needsView();
      case "pin": case "unpin": case "boost": case "demote": {
        if (!view || !revision) return needsView();
        const want = intent.target.toLowerCase();
        const pool = selected.length && !want ? selected.map((n) => ({ id: n.entityRefs[0], label: n.label })) : this.store.entities(revision).filter((e) => e.kind !== "file" && e.kind !== "test" && (e.name.toLowerCase() === want || e.name.toLowerCase().endsWith("." + want) || e.name.toLowerCase().includes(want))).map((e) => ({ id: e.entityId, label: e.name }));
        const exact = pool.find((p) => p.label.toLowerCase() === want || p.label.toLowerCase().endsWith("." + want)) ?? pool[0];
        // "reset password flow" is a question, not a command, when no element is named like that.
        if (!exact) return asView(await this.ask(ctx, { question: text, revision, pins: req.pins }), "");
        const mode = intent.type === "unpin" ? null : intent.type;
        const set = this.setOverride(ctx, { revision, entityId: exact.id, mode });
        if (!set.ok) return set as ApiResult<never>;
        const refreshed = await this.refreshView(ctx, { view });
        const verb = { pin: `Pinned ${exact.label}: it will always be shown.`, unpin: `Reset ${exact.label} to its computed relevance.`, boost: `Boosted ${exact.label}: it ranks higher.`, demote: `Demoted ${exact.label}: it ranks lower.` }[intent.type];
        return asView(refreshed, verb, true);
      }
      case "ignore": case "restore": {
        if (!view) return needsView();
        const want = intent.target.toLowerCase();
        const pool = intent.type === "ignore" ? view.nodes.filter((n) => n.role === "suspect") : (view.ignored ?? []).map((id) => ({ entityRefs: [id], label: id.replace(/^.*#/, ""), id }));
        const hit = pool.find((n) => n.label.toLowerCase().includes(want) || n.entityRefs[0]?.toLowerCase().includes(want));
        if (!hit) return ok(ctx, { kind: "message", message: `I couldn't find “${intent.target}” among the ${intent.type === "ignore" ? "suspects" : "ignored items"}.` });
        const r = this.steer(ctx, { view, action: intent.type === "ignore" ? "IGNORE" : "RESTORE", entityId: hit.entityRefs[0] });
        return asView(r, intent.type === "ignore" ? `Ignoring ${hit.label}; re-ranked the remaining suspects.` : `Restored ${hit.label}.`, true);
      }
      case "connected": {
        if (!revision) return needsView();
        const ids = entityIds.length ? entityIds : (req.pins ?? []);
        if (ids.length === 0) return ok(ctx, { kind: "message", message: "Select the elements you mean on the map first; then I can say how they relate." });
        return asExplain(await this.explain(ctx, { revision, entityIds: ids, question: text }));
      }
    }
  }
}
