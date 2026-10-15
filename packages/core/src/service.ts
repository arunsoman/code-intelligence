import { summarizeValidation } from "./answer-validation.ts";
import { parseCompoundQuestion, planCompoundQuestion, evaluateCompoundQuestion, compoundAnswer } from "./compound-query.ts";
import { validateSnapshotReuse } from "./snapshot-reuse.ts";
import { retrieveFromSnapshot } from "./retrieval.ts";
import { validateImpactPolicy, explainImpactItem } from "./impact-report.ts";
import { renderImpactComment } from "./impact-render.ts";
import { ConversationActions, ConversationConflict } from "./conversation-actions.ts";
import { boundAnswerContext } from "./answer-visual.ts";
import { bindSelectedChart, responsePortfolio } from "./response-portfolio.ts";
import type { AnswerInvestigation, AnswerValidationSummary, ResponseManifest } from "@cie/schema";
import { diagnostic, bundleDiagnostics, withDiagnostics } from "./diagnostics.ts";
import { reEvidenceFailure, reExportBundle, reFogInventory, reImportBundle, reListEvidence, reListArtifacts, reAnalyzeArtifact } from "./re-evidence.ts";
// Orchestration. Public operations return ApiResult (contracts §1). Every model call goes through callModel,
// which enforces the per-repository egress opt-in, scrubs secrets, and writes the audit trail.
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { BudgetController, inferSourceOverview, OllamaProvider, hasModel, listInstalledModels, runModel, StubProvider, type GatewayFailure, type GatewayResult } from "@cie/model";
import { SCHEMA_SOURCE_OVERVIEW, type SourceOverviewOutput } from "@cie/schema";
import { matchName, readText, routerFor, validateProviderGuide, type ChartOption, type Intent as ChatIntent, type ProviderGuideResponse, type RouterModel } from "./llm-router.ts";
import { INTENT_CONFIDENCE_THRESHOLD } from "../../schema/src/intents.ts";
import { GitBrowsing } from "./repository-git.ts";
import { JobsAdmin } from "./jobs-admin.ts";
import { modelFailureNotice } from "./model-failure.ts";
import { validateChatPlan } from "./chat-plan.ts";
import { executeChatPlan } from "./chat-execution.ts";
import { runChatAgent } from "./chat-agent.ts";
import type {
  AnalysisBatch, ApiError, ApiResult, CallContext, ChallengeOutput, ChangesSince, Claim, ConceptCard, ConceptHierarchyView, ConceptStore, EntityCode, ConverseResult, DirListing, EditorContext, EditorEvent, EvidenceBundle, EvidenceRef, ExplainResult, ExplanationOutput, StructuralConceptCluster, StructuralConceptsView,
  ChartOutput, ChartOutputV2, ChartId, HypothesesOutput, ModelProvider, ModelRequest, NameArchOutput, NameConceptOutput, RepresentationOutput, ResolvedEvidence, JobView, SavedState, VerdictKind, ViewRoute, ViewSpec, SourceSpan,
  DefectDetectionInput, DetectorFinding, BenchmarkPolicy, BenchmarkResult, Fact, Entity, Relationship,
} from "@cie/schema";
import { chartCodeForQuestion, CHART_REGISTRY, SCHEMA_CHALLENGE, SCHEMA_EXPLANATION, SCHEMA_HYPOTHESES, SCHEMA_NAME_ARCH, SCHEMA_NAME_CONCEPT, SCHEMA_REPRESENTATION } from "@cie/schema";
import { applyVerdict, gateClaim, modelText, wilson, withChallenge } from "./claims.ts";
import { claimOf } from "./forms/common.ts";
import { buildHierarchy, persistHierarchy, type NamingAdapter } from "./concept-hierarchy/index.ts";
import { cloneScan, conceptIrView, renderIrs, similarOf } from "./irfirst.ts";
import { buildFailureGraph, buildInvariantGraph } from "./forms/causal.ts";
import { short } from "./forms/common.ts";
import { buildHypothesis } from "./forms/hypothesis.ts";
import { extractArtifacts } from "./artifacts.ts";
import { Collab } from "./collab.ts";
import { Evaluator, PLANTED_SECURITY, SEEDED_CONCEPTS } from "./evaluation.ts";
import { Indexer } from "./indexer.ts";
import { RevisionDiff } from "./change-diff.ts";
import { EditorEvents } from "./editor-events.ts";
import { History } from "./history.ts";
import { runRuntimeSandbox } from "./runtime-sandbox.ts";
import { Runtime } from "./runtime.ts";
import { mapOverlays } from "./overlays.ts";
import { Security } from "./security.ts";
import { PrAnalysis, PrCheckError, resolvePr, type PrRef } from "./pr-analysis.ts";
import { Profiles, ProfileCheckError } from "./profiles-analysis.ts";
import { Tasks, TaskError } from "./execution.ts";
import { GitHubCheckPublisher, newGrant } from "./pr-publish.ts";
import { githubRemote, isGhInstalled } from "./gh.ts";
import type { ModelRunRef, PrAnalysisView } from "@cie/schema";
import { conceptRequirement, navigateHierarchy, overviewSeeds } from "./overview.ts";
import { projectProfile } from "./profile.ts";
import { Registry } from "./registry.ts";
import { WorkspaceLog } from "./workspaces.ts";
import { Journal, type CommitReceipt } from "./journal.ts";
import { Cancelled, JobRunner, type JobControl } from "./jobs.ts";
import { detectSecret, EGRESS_FIELDS, payloadHash, scrubBundle } from "./policy.ts";
import { bundleFor, queryTerms, retrieveAround, retrieveForQuestion } from "./retrieval.ts";
import { resolveReferent, planQuery, type QueryPlan } from "./query-router.ts";
import { resolveMentions } from "./mentions.ts";
import { ZOOM_LEVELS, zoomLevelOf, choicesFor, sideZoomChoices } from "./zoom-map.ts";
import { ChatSessionManager, type ModelContext } from "./chat-session.ts";
import { revisionIndex, scoreEntity, WEIGHTS } from "./salience.ts";
import { DeltaBaseError, type RevisionRow, type Store } from "./store.ts";
import { entityAt, fingerprint, locateFrames, looksLikeTrace, parseTrace } from "./trace.ts";
import { compileView } from "./viewspec.ts";
import { viewMessage, withAnswer } from "./answer.ts";
import { catalog, ensureEdgeClaims, visualByForm, type CatalogEntry } from "./visuals.ts";
import { cachedChartPlan, chartCreatorRequest, chartPlanCacheKey, compileChartPlan, rememberChartPlan, validateChartIdNotChanged, type ChartCompileDiag } from "./chart-creator.ts";
import { fileHistory, headOf, isGitRepo } from "./gitinfo.ts";
import { ensureGhForgeConnector } from "./gh.ts";
import { deleteRepository as deleteRepo, type DeleteReport, type GcReport } from "./storage.ts";
import type { Health, RestoreDrill } from "./ops.ts";
import { EventBus } from "./events.ts";
import { buildExport, ExportError, ExportStore, Notifications, type ExportArtifact } from "./exports.ts";
import { SearchEngine, type ApiFail } from "./search.ts";
import { HistoryEngine, PolicyError, inspectHead, normalizePolicy, policyHash } from "./hotspots.ts";
import { ChangeEngine, ChangeError, type ChangeProposal, type DragResult, type Intent } from "./changes.ts";
import { compareScenarios, evaluateScenario, ScenarioError, type AssumptionInput, type CapacityData, type Scenario, type ScenarioResult } from "./scenarios.ts";
import { raceReplayByRunId } from "./twin-replay.ts";
import type { ChartPlanRaceTimeline } from "@cie/schema";
import { policyFor } from "./access.ts";
import { parseChat, runChatCommand, gateResult, renderReply, ReplyLedger, isFeedbackVerb, type ChatFeedback, type ChatShapedResult, type ChatSuggestions, type PrChatEvent, type PrScope, type ReplyVisibility } from "./pr-chat.ts";
import { FeedbackStore } from "./feedback.ts";
import { SuggestionEngine, githubReviewTransportFor, type FixCandidate } from "./suggestions.ts";
import { claimId as impactClaimId } from "./claims.ts";
import { redactBuilt } from "./redact.ts";
import { HashEmbedder, semanticScores, type Embedder } from "./embeddings.ts";
import { InvestigationEngine, type EngineOptions } from "./c22/engine.ts";
import { C22Error, type HypothesisDraft } from "./c22/types.ts";
import { seedContext, toDrafts } from "./c22/proposer.ts";
import { toPlan } from "./c22/compat.ts";
import { CausalityEngine, type CausalityScopeInput, type MechanismEvidenceRecord, type CauseClaimRecord, type Snapshot as C24Snapshot } from "./c24/causality.ts";
import { ingestTestArtifacts, loadTestSummary, testFactsFor, type TestSummary } from "./testartifacts.ts";
import { dependents as graphDependents, findPath as graphFindPath } from "./graph.ts";
import { ingestTraceExports } from "./traceexport.ts";
import type { WorkerClient } from "./worker.ts";
import { WorkerError } from "./worker.ts";
import { DefectError, DefectWorkflow, type DraftForge } from "./defect-workflow.ts";
import { DefectRequests } from "./defect-requests.ts";
import { SavedWorkspaces } from "./saved-workspaces.ts";
import { Answering } from "./answering.ts";
import { Profiling } from "./profiling.ts";
import { Campaigns, CampaignError, type CampaignAdapters } from "./campaigns.ts";
import { GitHubPublisher, JointRunner, RecipeRunner, repositoryInventory, validateCandidate } from "./campaign-runner.ts";
import { ReleaseScope, ReleaseError, type ReleaseAdapters } from "./release-scope.ts";
import { GhCiForge, GhError as CiGhError } from "./feature/ci-forge.ts";
import { buildReleaseReadiness } from "./release-readiness.ts";

export const chunkTokenBudget = () => Number(process.env.CIE_CHUNK_TOKEN_BUDGET) || 60_000; // per concept-extraction request; the gateway hard limit is 200k

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
export const fail = <T>(ctx: CallContext, error: ApiError): ApiResult<T> => ({ ok: false, error, metadata: meta(ctx) });
export const ok = <T>(ctx: CallContext, value: T, m: Parameters<typeof meta>[1] = {}): ApiResult<T> => ({ ok: true, value, metadata: meta(ctx, m) });
/** A full disk is a different problem from a broken database: nothing is corrupt, and writing works again once there is room. */
export function storageFailure(e: unknown): ApiError {
  const msg = (e as Error).message ?? String(e);
  if (/database or disk is full|SQLITE_FULL|ENOSPC/i.test(msg)) return { code: "RESOURCE_LIMIT", message: "The disk or database size limit was reached, so nothing was saved. Free some space and try again; existing data is intact.", retryable: true };
  if (/locked|SQLITE_BUSY/i.test(msg)) return { code: "STORAGE_FAILURE", message: "The database is busy with another writer. Try again in a moment.", retryable: true };
  return { code: "STORAGE_FAILURE", message: msg, retryable: true };
}

export const actor = (ctx: CallContext) => ctx.actor.principalId;

/** F16: the optional candidate payload of C28/prepareSuggestion — shape-checked, never trusted (the gate and the
 * scratch validation decide). Returns null when absent (the provider is asked), undefined when malformed. */
function parseCandidateArg(raw: unknown): FixCandidate | null | undefined {
  if (raw === undefined || raw === null) return null;
  const c = raw as FixCandidate;
  if (typeof c !== "object" || typeof c.id !== "string" || typeof c.findingId !== "string" || typeof c.baseHash !== "string"
    || typeof c.validationHash !== "string" || typeof c.oraclePreserved !== "boolean" || !Array.isArray(c.edits) || !c.edits.length) return undefined;
  for (const e of c.edits) {
    if (typeof e !== "object" || typeof e.file !== "string" || !Number.isInteger(e.start) || !Number.isInteger(e.end)
      || typeof e.expected !== "string" || typeof e.newText !== "string" || e.end < e.start) return undefined;
  }
  return c;
}

export class Service {
  readonly journal: Journal;
  readonly store: Store;
  readonly jobs: JobRunner;
  /** F02: the PR-analysis engine (§6.1) and its GitHub status publisher (§7.12). */
  readonly pr: PrAnalysis;
  readonly prPublisher: GitHubCheckPublisher;
  /** F16: validated inline fix suggestions (§4). A public slot so a host can install a candidate provider. */
  suggestionEngine: SuggestionEngine;
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
  readonly sessionManager: ChatSessionManager;
  /** The GitHub transport F07 publishes through. Unset means publication is refused, never simulated. */
  forge: DraftForge | null = null;
  worker: WorkerClient;
  /** Hermetic override of the concept-hierarchy motif batch (tests); production defaults to the Rust worker. */
  private motifBatch: import("./concept-hierarchy/motifs.ts").MotifBatchMatcher | undefined;
  model: ModelProvider;
  offline: ModelProvider;
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
  /** Release scope: what's actually in a release, frozen against a GitHub milestone. */
  readonly releases: ReleaseScope;
  /** F05: the profiling engine — persists artifacts, attributes builds, correlates traces, and verifies presentation (F05-A5). */
  readonly profiles: Profiles;
  readonly tasks: Tasks;
  /** C29: shared investigations and team knowledge. */
  readonly collab: Collab;
  /** C17: the evaluation registry. */
  readonly evaluator: Evaluator;
  /** C07: impact, generation fence and clean-index parity. */
  readonly indexer: Indexer;
  /** C04/C23: diffing two indexed revisions. */
  readonly revisionDiff: RevisionDiff;
  /** C01/C24: IDE events, exception reports and recent editor context. */
  readonly editorEvents: EditorEvents;
  /** Git info/branch switching and the local folder picker. */
  readonly gitBrowsing: GitBrowsing;
  /** Health/version, backup/gc/delete, and the background job queue. */
  readonly jobsAdmin: JobsAdmin;
  /** C26 Phase A: report-only defect detection requests and benchmarking. */
  readonly defectRequests: DefectRequests;
  /** C13: saved investigations - save, list, resume. */
  readonly savedWorkspaces: SavedWorkspaces;
  /** Free-text answering: ask/investigate/converse and the chart/explain machinery behind them. */
  readonly answering: Answering;
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
    "C04/listProfileArtifacts": (c, b) => this.profileWrap(c, async () => ({ artifacts: this.profiles.listArtifacts({ traceSourceId: b?.traceSourceId, limit: b?.limit }) })),
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
  tasksPublicationEnabled(): boolean { return this.jobsAdmin.tasksPublicationEnabled(); }

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

  /** Release-scope gateway operations: what's actually in a release, frozen against a GitHub milestone. */
  readonly releaseOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>> | ApiResult<unknown>> = {
    "C32/createRelease": (c, b) => this.releaseResult(c, () => this.releases.createRelease(c.actor.principalId, c.actor.tenantId, b.spec)),
    "C32/listReleases": (c, b) => this.releaseResult(c, () => this.releases.listReleases(c.actor.tenantId, b.limit)),
    "C32/getRelease": (c, b) => this.releaseResult(c, () => this.releases.getRelease(b.releaseId)),
    "C32/previewMilestone": (c, b) => this.releaseResult(c, () => this.releases.previewMilestone(b.releaseId)),
    "C32/listMilestones": (c, b) => this.releaseResult(c, () => this.releases.listMilestones(String(b.owner ?? ""), String(b.repo ?? ""))),
    "C32/lookupIssue": (c, b) => this.releaseResult(c, () => this.releases.lookupReleaseIssue(b.releaseId, Number(b.number))),
    "C32/freezeScope": (c, b) => this.releaseResult(c, () => this.releases.freezeScope(b.releaseId, c.actor.principalId, b.expectedVersion, b.selection)),
    "C32/assessScopeChange": (c, b) => this.releaseResult(c, () => this.releases.assessScopeChange(b.releaseId, c.actor.principalId, b.fromVersion, b.toVersion)),
    "C32/assessReleaseItem": (c, b) => this.releaseResult(c, () => this.releases.assessItem(b.releaseId, c.actor.principalId, b.issueNumber)),
    "C32/getReleaseReadiness": async (c, b) => {
      try { return ok(c, await buildReleaseReadiness({ releases: this.releases, ci: this.ciForge(), security: this.security, store: this.store }, { releaseId: b.releaseId, revisionId: b.revisionId, prNumbers: b.prNumbers, headSha: b.headSha })); }
      catch (e) { const api = e instanceof ReleaseError ? e.api : storageFailure(e); return fail(c, api); }
    },
  };
  private releaseResult<T>(ctx: CallContext, fn: () => T): ApiResult<T> { try { return ok(ctx, fn()); } catch (e) { const api = e instanceof ReleaseError ? e.api : storageFailure(e); return fail(ctx, api); } }

  /** C04 read-only GitHub CI/security signal operations, backing the release-readiness ledger. */
  private ciForgeInstance?: GhCiForge;
  private ciForge(): GhCiForge { return (this.ciForgeInstance ??= new GhCiForge()); }
  private async ciResult<T>(ctx: CallContext, fn: () => Promise<T>): Promise<ApiResult<T>> {
    try { return ok(ctx, await fn()); }
    catch (e) {
      if (e instanceof CiGhError) return fail(ctx, { code: e.state === "NOT_FOUND" ? "NOT_FOUND" : e.state === "REFUSED" ? "FORBIDDEN" : "PROVIDER_UNAVAILABLE", message: `GitHub: ${e.message}`, retryable: e.state === "RATE_LIMITED" });
      return fail(ctx, storageFailure(e));
    }
  }
  readonly ciOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>>> = {
    "C04/pullReviews": (c, b) => this.ciResult(c, () => this.ciForge().pullReviews(b.repo, b.pr)),
    "C04/checkRuns": (c, b) => this.ciResult(c, () => this.ciForge().checkRuns(b.repo, b.sha)),
    "C04/dependabotAlerts": (c, b) => this.ciResult(c, () => this.ciForge().dependabotAlerts(b.repo)),
    "C04/codeScanningAlerts": (c, b) => this.ciResult(c, () => this.ciForge().codeScanningAlerts(b.repo)),
    "C04/actionsRuns": (c, b) => this.ciResult(c, () => this.ciForge().actionsRuns(b.repo, b.workflow)),
    "C04/releaseByTag": (c, b) => this.ciResult(c, () => this.ciForge().releaseByTag(b.repo, b.tag)),
  };

  /** C33 — reverse-engineering evidence (the "Reverse engineering" menu; packages/evidence). Read-only
   * except importBundle and analyzeArtifact: an import stores nothing that has not authenticated — every
   * record id and the bundle digest are recomputed from content — and the artifact probe reaches storage
   * through that same authenticated import path. */
  readonly reOps: Record<string, (ctx: CallContext, b: any) => Promise<ApiResult<unknown>>> = {
    "C33/fogInventory": (c, b) => this.reResult(c, () => reFogInventory(this.store, String(b?.revision ?? ""))),
    "C33/listEvidence": (c, b) => this.reResult(c, () => reListEvidence(this.store, String(b?.revision ?? ""))),
    "C33/importBundle": (c, b) => this.reResult(c, () => reImportBundle(this.store, String(b?.revision ?? ""), b)),
    "C33/exportBundle": (c, b) => this.reResult(c, () => reExportBundle(this.store, String(b?.revision ?? ""))),
    "C33/listArtifacts": (c, b) => this.reResult(c, () => reListArtifacts(this.store, String(b?.revision ?? ""))),
    "C33/analyzeArtifact": (c, b) => this.reResult(c, () => reAnalyzeArtifact(this.store, this.worker, String(b?.revision ?? ""), b?.path)),
  };

  private async reResult<T>(ctx: CallContext, fn: () => T | Promise<T>): Promise<ApiResult<T>> {
    try {
      return ok(ctx, await fn());
    } catch (e) {
      return fail(ctx, reEvidenceFailure(e) ?? storageFailure(e));
    }
  }

  /** Real release adapters: milestone issues read live via the `gh` CLI (no token stored or passed; `gh auth`
   * handles authentication). When `gh` is unavailable this answers with no issues rather than guessing — the
   * same "say I can't determine this" rule the rest of the system follows. */
  private releaseAdapters(): ReleaseAdapters {
    /** One `gh` read. A failure is reported with GitHub's own reason rather than read as "nothing there". */
    const ghJson = (args: string[], what: string): unknown => {
      if (!isGhInstalled()) throw new ReleaseError("PROVIDER_UNAVAILABLE", "the GitHub CLI (gh) is not installed or not signed in, so GitHub cannot be read");
      try {
        return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] }) || "[]");
      } catch (e) {
        const text = String((e as { stderr?: unknown }).stderr ?? (e as Error).message);
        if (/not found|404/i.test(text)) throw new ReleaseError("NOT_FOUND", `GitHub has no ${what}`);
        if (/invalid|422|validation/i.test(text) && /milestone/i.test(what)) throw new ReleaseError("NOT_FOUND", `GitHub has no ${what}`);
        throw new ReleaseError("PROVIDER_UNAVAILABLE", `GitHub could not be read for ${what}: ${text.split("\n")[0]!.trim() || "unknown error"}`, true);
      }
    };
    return {
      milestoneIssues: (milestone) => {
        const parsed = ghJson(["api", "--method", "GET", `repos/${milestone.owner}/${milestone.repo}/issues`, "-f", `milestone=${milestone.number}`, "-f", "state=all", "-f", "per_page=100"], `milestone #${milestone.number} of ${milestone.owner}/${milestone.repo}`);
        return (Array.isArray(parsed) ? parsed : [])
          .filter((i: any) => !i.pull_request)
          .map((i: any) => ({ number: Number(i.number), title: String(i.title ?? ""), state: i.state === "closed" ? "closed" as const : "open" as const }));
      },
      listMilestones: (owner, repo) => {
        const parsed = ghJson(["api", "--method", "GET", `repos/${owner}/${repo}/milestones`, "-f", "state=all", "-f", "per_page=100"], `${owner}/${repo}`);
        return (Array.isArray(parsed) ? parsed : []).map((m: any) => ({
          number: Number(m.number), title: String(m.title ?? ""), state: m.state === "closed" ? "closed" as const : "open" as const,
          openIssues: Number(m.open_issues ?? 0), closedIssues: Number(m.closed_issues ?? 0),
        }));
      },
      issue: (owner, repo, number) => {
        const i: any = ghJson(["api", "--method", "GET", `repos/${owner}/${repo}/issues/${number}`], `issue #${number} of ${owner}/${repo}`);
        if (i?.pull_request) throw new ReleaseError("INVALID_SCHEMA", `#${number} is a pull request, not an issue`);
        return { number: Number(i.number), title: String(i.title ?? ""), state: i.state === "closed" ? "closed" as const : "open" as const };
      },
    };
  }

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
    // F12 MCP backing reads: single-symbol blast radius, cited connection paths, static test reach. All read-only,
    // access-filtered (denied entities are counted by the graph layer, never named), revision-bound.
    "C23/dependents": (c, b) => this.dependentsCall(c, b ?? {}),
    "C23/findConnection": (c, b) => this.findConnectionCall(c, b ?? {}),
    "C23/testsReaching": (c, b) => this.testsReachingCall(c, b ?? {}),
  };

  /** F12: the revision an entity-name operation works on: the requested one, else the latest of the repo, else overall. */
  private mcpRevision(ctx: CallContext, b: { repoPath?: string; revision?: string }): ApiResult<NonNullable<ReturnType<Store["latestRevision"]>>> {
    const rev = (typeof b.revision === "string" && this.store.revision(b.revision))
      ? this.store.revision(b.revision)
      : typeof b.repoPath === "string" ? this.store.latestRevision(b.repoPath) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision; index the repository first", retryable: true });
    return ok(ctx, rev);
  }

  /** F12: resolve a name or entity id to an entity of the revision; on a miss, offer nearest names, never a guess. */
  private mcpEntity(rev: RevisionRow, name: string): { entity: Entity } | { failure: { code: "NOT_FOUND"; message: string; retryable: false }; nearest: string[] } {
    const q = name.trim();
    const access = policyFor(this.store, rev.repoRoot);
    const ents = this.store.entities(rev.id).filter(entity => !access.denied(entity.file));
    const byId = ents.find((e) => e.entityId === q);
    if (byId) return { entity: byId };
    const lower = q.toLowerCase();
    const named = ents.filter((e) => e.kind !== "file" && e.name.toLowerCase() === lower);
    if (named.length === 1) return { entity: named[0] };
    if (named.length > 1) return { failure: { code: "NOT_FOUND" as const, message: `“${q}” is ambiguous: it names ${named.length} elements; give the file or an id`, retryable: false as const }, nearest: named.slice(0, 5).map((e) => `${e.name} — ${e.file}`) };
    const near = ents.filter((e) => e.kind !== "file" && (e.name.toLowerCase().includes(lower) || lower.includes(e.name.toLowerCase())) && e.name.toLowerCase() !== lower)
      .sort((a, b) => a.name.length - b.name.length).slice(0, 5).map((e) => `${e.name} — ${e.file}`);
    return { failure: { code: "NOT_FOUND" as const, message: near.length ? `no element is exactly named “${q}”; nearest: ${near.join("; ")}` : `no element is named “${q}” in the indexed revision`, retryable: false as const }, nearest: near };
  }

  /** F12: line location of an entity's primary span, for citations. Null when the file is gone or has no span. */
  private mcpLocation(rev: RevisionRow, e: Entity): { path: string; startLine: number; endLine: number } | null {
    const span = e.spans[0];
    if (!span) return null;
    let buf: Buffer;
    try { buf = readFileSync(resolve(rev.repoRoot, span.sourceId)); } catch { return null; }
    const startLine = buf.subarray(0, span.startByte).toString("utf8").split("\n").length;
    const text = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
    return { path: e.file, startLine, endLine: startLine + text.split("\n").length - 1 };
  }

  /** F12 `C23/dependents`: everything that reaches one entity within a bounded hop count, with per-edge evidence ids. */
  private dependentsCall(ctx: CallContext, b: { repoPath?: string; revision?: string; name?: string; entityId?: string; maxDepth?: number; maxNodes?: number }): ApiResult<unknown> {
    const revR = this.mcpRevision(ctx, b);
    if (!revR.ok) return revR;
    const rev = revR.value;
    const wanted = typeof b.entityId === "string" ? b.entityId : b.name;
    if (typeof wanted !== "string" || !wanted.trim()) return fail(ctx, { code: "INVALID_SCHEMA", message: "give a name or entityId", retryable: false });
    const hit = this.mcpEntity(rev, wanted);
    if ("failure" in hit) return fail(ctx, { ...hit.failure, message: hit.failure.message } as never);
    const access = policyFor(this.store, rev.repoRoot);
    const projection = graphDependents(this.store, rev.id, hit.entity.entityId, { access, ...(b.maxDepth ? { maxDepth: b.maxDepth } : {}), ...(b.maxNodes ? { maxNodes: b.maxNodes } : {}) });
    const locations = new Map<string, { path: string; startLine: number; endLine: number } | null>();
    for (const n of projection.nodes) { const e = this.store.entitiesById(rev.id, [n.id])[0]; locations.set(n.id, e ? this.mcpLocation(rev, e) : null); }
    return ok(ctx, {
      entity: { entityId: hit.entity.entityId, name: hit.entity.name, kind: hit.entity.kind, file: hit.entity.file, location: this.mcpLocation(rev, hit.entity) },
      projection: { ...projection, locations: Object.fromEntries(locations) },
    }, { revision: rev.id });
  }

  /** F12 `C23/findConnection`: the shortest cited call path between two entities, or an honest "cannot determine". */
  private findConnectionCall(ctx: CallContext, b: { repoPath?: string; revision?: string; from: string; to: string }): ApiResult<unknown> {
    const revR = this.mcpRevision(ctx, b);
    if (!revR.ok) return revR;
    const rev = revR.value;
    for (const key of ["from", "to"] as const) {
      if (typeof b[key] !== "string" || !b[key].trim()) return fail(ctx, { code: "INVALID_SCHEMA", message: `give ${key} as a name or entity id`, retryable: false });
    }
    const from = this.mcpEntity(rev, b.from), to = this.mcpEntity(rev, b.to);
    for (const [key, hit] of [["from", from], ["to", to]] as const) {
      if ("failure" in hit) return fail(ctx, { ...hit.failure, message: `${key}: ${hit.failure.message}` } as never);
    }
    const access = policyFor(this.store, rev.repoRoot);
    const r = graphFindPath(this.store, rev.id, (from as { entity: Entity }).entity.entityId, (to as { entity: Entity }).entity.entityId, { access });
    const ents = new Map(this.store.entities(rev.id).map((e) => [e.entityId, e]));
    const describe = (id: string) => { const e = ents.get(id); return { entityId: id, name: e?.name ?? id, kind: e?.kind ?? "unknown", file: e?.file ?? "", location: e ? this.mcpLocation(rev, e) : null }; };
    const spanLoc = (span: SourceSpan) => {
      let buf: Buffer;
      try { buf = readFileSync(resolve(rev.repoRoot, span.sourceId)); } catch { return null; }
      const startLine = buf.subarray(0, span.startByte).toString("utf8").split("\n").length;
      const text = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
      return { path: relative(rev.repoRoot, resolve(rev.repoRoot, span.sourceId)), startLine, endLine: startLine + text.split("\n").length - 1 };
    };
    return ok(ctx, {
      from: describe((from as { entity: Entity }).entity.entityId), to: describe((to as { entity: Entity }).entity.entityId),
      found: r.found, path: r.path.map(describe),
      edges: r.edges.map((e) => ({
        from: e.from, to: e.to, kind: e.kind, label: e.label ?? null, evidenceIds: e.evidence.map((x) => x.id),
        evidenceLocations: e.evidence.map((x) => ({ evidenceId: x.id, location: x.location.kind === "CodeLocation" ? spanLoc(x.location.span as SourceSpan) : null })),
      })),
      hops: r.hops, hiddenRouteExists: r.hiddenRouteExists, truncated: r.truncated, visited: r.visited,
    }, { revision: rev.id });
  }

  /** F12 `C23/testsReaching`: static test links to one entity's file — call paths and imports, never "tests pass". */
  private testsReachingCall(ctx: CallContext, b: { repoPath?: string; revision?: string; name?: string; entityId?: string }): ApiResult<unknown> {
    const revR = this.mcpRevision(ctx, b);
    if (!revR.ok) return revR;
    const rev = revR.value;
    const wanted = typeof b.entityId === "string" ? b.entityId : b.name;
    if (typeof wanted !== "string" || !wanted.trim()) return fail(ctx, { code: "INVALID_SCHEMA", message: "give a name or entityId", retryable: false });
    const hit = this.mcpEntity(rev, wanted);
    if ("failure" in hit) return fail(ctx, { ...hit.failure, message: hit.failure.message } as never);
    const entity = (hit as { entity: Entity }).entity;
    const access = policyFor(this.store, rev.repoRoot);
    const ents = this.store.entities(rev.id).filter((e) => !access.denied(e.file));
    const byId = new Map(ents.map((e) => [e.entityId, e]));
    const incoming = new Map<string, Relationship[]>();
    for (const r of this.store.allRelationships(rev.id)) {
      if (r.kind !== "calls" || r.resolution === "UNRESOLVED" || !byId.has(r.from) || !byId.has(r.to)) continue;
      incoming.set(r.to, [...(incoming.get(r.to) ?? []), r]);
    }
    // Reverse BFS from the entity, at most four hops, collecting test entities (the same bound module-tests uses).
    const paths = new Map<string, Relationship[]>([[entity.entityId, []]]);
    let frontier = [entity.entityId];
    for (let depth = 0; depth < 4 && frontier.length; depth++) {
      const next: string[] = [];
      for (const id of frontier) for (const r of incoming.get(id) ?? []) {
        if (paths.has(r.from)) continue;
        paths.set(r.from, [r, ...paths.get(id)!]);
        next.push(r.from);
      }
      frontier = next;
    }
    const isTest = (e: Entity) => e.kind === "test" || /(^|\/)(__tests__|tests?)(\/|$)|[._-](test|spec)\.[^/]+$/i.test(e.file);
    const reached = ents.filter((e) => isTest(e) && paths.has(e.entityId));
    const reachedFiles = new Set(reached.map((e) => e.file));
    const fileEntity = ents.find((e) => e.kind === "file" && e.file === entity.file);
    const imports = fileEntity
      ? this.store.allRelationships(rev.id).filter((r) => r.kind === "imports" && r.to === fileEntity.entityId && byId.has(r.from) && isTest(byId.get(r.from)!) && !reachedFiles.has(byId.get(r.from)!.file))
      : [];
    const tests = [
      ...reached.map((e) => ({ entityId: e.entityId, name: e.name, file: e.file, mode: "calls" as const, evidenceIds: [...new Set(paths.get(e.entityId)!.flatMap((r) => r.evidence.map((x) => x.id)))] })),
      ...imports.map((r) => ({ entityId: r.from, name: byId.get(r.from)!.name, file: byId.get(r.from)!.file, mode: "imports" as const, evidenceIds: r.evidence.map((x) => x.id) })),
    ];
    const coverage = fileEntity ? testFactsFor(this.store, rev.id, fileEntity.entityId).coverage ?? null : null;
    const truncated = frontier.length > 0;
    const testEntities = new Map(ents.filter((e) => tests.some((t) => t.entityId === e.entityId)).map((e) => [e.entityId, e]));
    return ok(ctx, {
      entity: { entityId: entity.entityId, name: entity.name, kind: entity.kind, file: entity.file, location: this.mcpLocation(rev, entity) },
      tests: tests.slice(0, 60).map((t) => ({ ...t, location: testEntities.has(t.entityId) ? this.mcpLocation(rev, testEntities.get(t.entityId)!) : null })),
      truncated, coverage: coverage ? { percent: coverage.percent, covered: coverage.covered, lines: coverage.lines, evidenceIds: coverage.evidenceIds } : null,
    }, { revision: rev.id });
  }
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

  constructor(store: Store, worker: WorkerClient, model: ModelProvider, offline: ModelProvider = new StubProvider(), motifBatch?: import("./concept-hierarchy/motifs.ts").MotifBatchMatcher) {
    this.store = store; this.worker = worker; this.model = model; this.offline = offline; this.motifBatch = motifBatch;
    this.sessionManager = new ChatSessionManager(this.store);
    this.registry = new Registry(store);
    this.history = new History(store, this.registry);
    this.runtime = new Runtime(store, this.registry);
    this.security = new Security(store);
    this.profiling = new Profiling(worker, store);
    this.profiles = new Profiles(store, worker);
    this.tasks = new Tasks({ store });
    this.indexer = new Indexer(this);
    this.revisionDiff = new RevisionDiff(this);
    this.editorEvents = new EditorEvents(this);
    this.gitBrowsing = new GitBrowsing(this);
    this.jobsAdmin = new JobsAdmin(this);
    this.defectRequests = new DefectRequests(this);
    this.savedWorkspaces = new SavedWorkspaces(this);
    this.answering = new Answering(this);
    this.evaluator = new Evaluator(store);
    this.workspaceLog = new WorkspaceLog(store, {
      evidenceState: (revision, evidenceId) => { const rev = this.store.revision(revision), ev = rev ? this.store.evidence(revision, evidenceId) : null; if (!rev || !ev) return "UNAVAILABLE"; const st = this.resolveEvidence(rev, ev).state; return st === "CURRENT" ? "CURRENT" : st === "STALE" ? "STALE" : "UNAVAILABLE"; },
      sourceAvailable: (revision) => { const rev = this.store.revision(revision); return !!rev && existsSync(rev.repoRoot); },
      allowed: (revision) => { const o = revision ? this.store.revision(revision, true) : null; return !(o && this.store.isRevoked(o.repoRoot)); },
    });
    this.collab = new Collab(store, this.workspaceLog);
    this.campaigns = new Campaigns(store, this.campaignAdapters());
    this.releases = new ReleaseScope(store, this.releaseAdapters());
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
    // F16: the suggestion engine starts without a candidate provider — prepare answers "no validated fix is
    // available" (§7.1) until a host installs one (the F07 pipeline registers its validated candidates).
    this.suggestionEngine = new SuggestionEngine(store);
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
  detectDefects(ctx: CallContext, req: DefectDetectionInput): ApiResult<{ findings: DetectorFinding[]; truncated: boolean }> { return this.defectRequests.detectDefects(ctx, req); }

  compareDefectBenchmarks(ctx: CallContext, req: { baseline: number[]; candidate: number[]; policy: BenchmarkPolicy }): ApiResult<BenchmarkResult> { return this.defectRequests.compareDefectBenchmarks(ctx, req); }

  async defectCall<T>(ctx: CallContext, fn: () => T | Promise<T>): Promise<ApiResult<T>> {
    try { return ok(ctx, await fn()); }
    catch (e) {
      if (e instanceof DefectError) return fail(ctx, { code: e.code, message: e.message, retryable: e.code === "VERSION_CONFLICT" });
      return fail(ctx, { code: "INVALID_SCHEMA", message: "The defect workflow request could not be accepted", retryable: false });
    }
  }

  startDefectDetection(ctx: CallContext, req: DefectDetectionInput): ApiResult<JobView> { return this.defectRequests.startDefectDetection(ctx, req); }

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
  async callModel<T>(ctx: CallContext, rev: RevisionRow, req: ModelRequest): Promise<{ result: GatewayResult<T> | GatewayFailure; provider: ModelProvider; note?: string }> {
    const modelStarted = performance.now();
    diagnostic("model.start", { requestId: ctx.requestId, revision: rev.id, purpose: req.purpose, schemaId: req.schemaId, chartId: req.chartId, question: req.question, configuredProvider: this.model.name, configuredModel: this.model.model, deadlineRemainingMs: ctx.deadlineMs - Date.now(), bundle: bundleDiagnostics(req.bundle) });
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
    diagnostic("model.dispatch", { requestId: ctx.requestId, purpose: req.purpose, provider: provider.name, model: provider.model, hosted: provider.hosted !== false, note, sentBundle: bundleDiagnostics(request.bundle) });
    const hostedCall = provider.hosted !== false;
    let result = await runModel<T>(provider, request, { deadlineMs: Math.max(1000, ctx.deadlineMs - Date.now()), budget: hostedCall ? { controller: this.budget, scope: rev.repoRoot } : undefined });
    if (hostedCall && !result.ok && result.error.code === "BUDGET_EXCEEDED") {
      // Feature degradation, not failure: the offline model answers and the person is told why.
      try { this.store.audit(actor(ctx), "budget.exhausted", rev.repoRoot, { purpose: req.purpose, message: result.error.message }); } catch { /* ignore */ }
      note = `The hosted-model budget for this repository is used up (${result.error.message}), so the offline model answered.`;
      diagnostic("model.fallback", { requestId: ctx.requestId, purpose: req.purpose, reason: result.error, provider: this.offline.name }, "warn");
      provider = this.offline;
      result = await runModel<T>(provider, req, { deadlineMs: Math.max(1000, ctx.deadlineMs - Date.now()) });
    }
    if (provider === this.model) this.modelError = result.ok ? null : result.error.code;
    diagnostic("model.complete", { requestId: ctx.requestId, purpose: req.purpose, elapsedMs: performance.now() - modelStarted, provider: provider.name, model: provider.model, ok: result.ok, ...(result.ok ? { run: result.run, outputKeys: result.value && typeof result.value === "object" ? Object.keys(result.value) : [] } : { error: result.error }), note }, result.ok ? "debug" : "warn");
    return { result, provider, note };
  }

  persist(claims: Claim[]) { for (const c of claims) this.store.putClaim(c); }

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
      lap("historyRefresh", () => this.refreshHistoryFacts(row));
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
      this.scheduleRuntimeIntrospection(row.repoRoot, row.id, ctx);
      return ok(ctx, { ...row, reuse, delta: { ...delta, phasesMs: phases } }, { revision: row.id, warnings, completeness: batch.diagnostics.some((d) => d.code !== "REUSED_CACHED_PARSES") ? "PARTIAL" : "COMPLETE" });
    } catch (e) {
      if (e instanceof Cancelled || (control && e instanceof WorkerError && e.api.code === "CANCELLED")) throw new Cancelled();
      return fail(ctx, e instanceof WorkerError ? e.api : storageFailure(e));
    }
  }

  /**
   * History facts record the git chronology of the files at index time, but a content-addressed revision is
   * reused whenever the files' bytes are unchanged — even though HEAD may have advanced since (a
   * revert-and-reapply, a merge that yields identical files, an amended author or message, an empty commit).
   * When HEAD differs from the one the revision was indexed at, recompute just the history facts and point the
   * revision at the new HEAD: the graph itself is shared and untouched.
   */
  private refreshHistoryFacts(row: RevisionRow): void {
    const root = row.repoRoot;
    if (!isGitRepo(root)) return;
    const head = headOf(root);
    if (!head || head === row.gitHead) return;
    const files = new Set(Object.keys(this.store.revisionFiles(row.id)));
    const facts: Fact[] = [];
    for (const [rel, h] of fileHistory(root, 500)) {
      if (!files.has(rel)) continue;
      const eid = `ev:${createHash("sha256").update(`history:${rel}:${h.lastCommit}`).digest("hex").slice(0, 16)}`;
      facts.push({
        id: `fact:history:${rel}`, subject: `file:${rel}`, predicate: "history", resolution: "OBSERVED",
        object: { kind: "ScalarValue", value: { commits: h.commits, lastCommit: h.lastCommit, lastAuthor: h.lastAuthor, lastDate: h.lastDate, lastSubject: h.lastSubject, authors: h.authors } },
        evidence: [{ id: eid, sourceId: rel, class: "HISTORY", observedAt: h.lastDate, accessScopeId: "local", state: "CURRENT", location: { kind: "DocumentLocation", documentId: h.lastCommit, version: h.lastDate, locator: `${rel}: ${h.commits} commit(s); last by ${h.lastAuthor} — ${h.lastSubject}` } }],
      });
    }
    this.store.replaceFactsBySource(row.id, "fact:history:", facts);
    this.store.setGitHead(row.id, head);
    row.gitHead = head;
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
  /** Idempotent per revision: schedule runtime introspection for frameworks we can safely bootstrap (NestJS for now). */
  private scheduleRuntimeIntrospection(repoRoot: string, revision: string, caller?: CallContext) {
    // Only run when framework metadata suggests a supported runtime framework.
    const hasNest = this.store.factsByPredicate(revision, "framework_role").some((f) => (f.object as { value?: { framework?: string } }).value?.framework === "nestjs");
    if (!hasNest) return null;
    const jctx: CallContext = {
      requestId: `req-runtime:${randomUUID()}`,
      idempotencyKey: `runtime-introspect:${repoRoot}:${revision}`,
      actor: caller?.actor ?? { principalId: "system", tenantId: "local", sessionId: "system" },
      deadlineMs: Date.now() + 600_000, traceId: `trace-runtime:${randomUUID()}`,
    };
    return this.jobs.enqueue(jctx, {
      kind: "runtime-introspect", priority: 5, lane: "runner", params: { repoPath: repoRoot, revision },
      run: async (jctx2, control) => {
        const rev = this.store.revision(revision);
        if (!rev) return fail(jctx2, { code: "NOT_FOUND", message: "revision not found", retryable: false });
        control?.progress({ phase: "runtime", message: "Running framework runtime introspection…" });
        const r = await runRuntimeSandbox({ store: this.store, registry: this.registry, revision: rev, wallMs: 120_000 });
        if (!r.ok) return fail(jctx2, r.error);
        return ok(jctx2, { facts: r.value.facts.length, evidence: r.value.evidence.length, diagnostics: r.value.diagnostics }, { warnings: r.value.diagnostics });
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
  historyEnabled(): boolean { return this.jobsAdmin.historyEnabled(); }
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
  /** Re-create the replay timeline behind a runtime-replay claim. The run is deterministic per its seed,
   *  so reopening a claim yields exactly the timeline that produced it — or an honest expiry, never a re-narration. */
  replayClaim(ctx: CallContext, req: { revision?: string; claimId: string }): ApiResult<{ view: ViewSpec; claims: Claim[] }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const claim = this.store.getClaim(req.claimId);
    if (!claim || claim.draft.claimClass !== "runtime-replay") return fail(ctx, { code: "NOT_FOUND", message: `claim "${req.claimId}" is not a runtime replay claim`, retryable: false });
    const runId = claim.draft.modelRun?.provider === "twin-kernel" ? claim.draft.modelRun.runId : claim.draft.rationaleSummary.match(/run:[0-9a-f]{24}/)?.[0];
    const replayed = runId ? raceReplayByRunId(runId) : null;
    if (!replayed) return fail(ctx, { code: "NOT_FOUND", message: "this replay run has expired from the replay cache; re-run the scenario from the chart to recreate it", retryable: true });
    const p = replayed.spec.params;
    const plan: ChartPlanRaceTimeline = {
      contractVersion: "chart.v2", chartId: "R1", chartType: CHART_REGISTRY.R1.name, layout: "timeline",
      caption: claim.draft.assertion, nodes: [], edges: [],
      subject: replayed.spec.subject, scenario: replayed.spec.scenario,
      arrivalRatePerSec: p.arrivalRatePerSec, durationSec: p.durationSec,
      ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
      ...(p.faultProbability !== undefined ? { faultProbability: p.faultProbability } : {}),
      seed: replayed.spec.seed,
    };
    try {
      // Compile through the chart facade (chart-creator → discovered R1 adapter), never the compiler module directly.
      const result = compileChartPlan({
        plan, bundle: { id: `replay:${rev.id}`, revision: rev.id, evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 },
        rev, question: claim.draft.assertion,
        route: { source: "chosen", confidence: "high", form: "RaceWindow", name: "Replay timeline", because: "reopened from a replay claim", alternatives: [] },
        chartId: "R1",
      });
      this.store.audit(actor(ctx), "scenario.replay", rev.id, { claimId: req.claimId, runId: replayed.spec.runId });
      return ok(ctx, result, { revision: rev.id });
    } catch (e) { return fail(ctx, storageFailure(e)); }
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

  /** Stored reports must remain readable under today's source policy, including after a restriction. */
  private readableImpactReport(analysisId: string) {
    const row = this.pr.row(analysisId);
    if (!row || this.store.isRevoked(row.repo_root)) return null;
    const report = this.pr.impactReportOf(analysisId);
    if (!report) return null;
    const access = policyFor(this.store, row.repo_root);
    const items = [...report.surfaced, ...report.suppressed, ...report.fog, ...(report.muted ?? [])];
    if (items.some(item => item.citations.some(c => access.denied(c.path)) || item.subjectEntityIds.some(id => access.deniedEntity(id)))) return null;
    const summary = report.summary;
    if (summary && [...summary.readingOrder.map(item => item.path), ...(summary.alsoReadPaths ?? []), ...(summary.description?.changedNotMentioned.map(item => item.path) ?? [])].some(path => access.denied(path))) return null;
    return report;
  }

  /** F14: the PR scope for chat — what "this" means (§7.3). Null when the analysis row or its head index is gone. */
  prChatScopeFor(analysisId: string): PrScope | null {
    const row = this.pr.row(analysisId);
    if (!row || !row.head_revision || this.store.isRevoked(row.repo_root)) return null;
    const cs = this.pr.changeSetOf(analysisId);
    const report = this.pr.impactReportOf(analysisId);
    return {
      analysisId, headHash: row.head_hash, baseHash: row.base_hash,
      headRevision: row.head_revision, repoRoot: row.repo_root,
      changedEntityIds: cs ? cs.entities.map((e) => e.head).filter((h): h is string => !!h) : [],
      reportItems: (report?.surfaced ?? []).map((item, i) => ({ n: i + 1, id: item.id })),
    };
  }

  /** F14 §14/§9: the scope for a comment's head. CIE answers only from the index at the head the comment carried. */
  prChatScopeForHead(repoRoot: string, prNumber: number, headHash: string): PrScope | null {
    const rows = this.pr.allForPr(repoRoot, prNumber) as { id: string; head_hash: string; state: string }[];
    const row = rows.find((r) => r.head_hash === headHash && ["DECIDED", "PUBLISHED"].includes(r.state));
    return row ? this.prChatScopeFor(row.id) : null;
  }

  /** F14: the command environment — same read operations the MCP tools reach (§5), nothing mutating (§10.2). */
  prChatEnvFor(scope: PrScope) {
    return {
      store: this.store, scope,
      access: policyFor(this.store, scope.repoRoot),
      cs: this.pr.changeSetOf(scope.analysisId),
      report: this.pr.impactReportOf(scope.analysisId),
      modelAvailable: !!this.model.model,
    };
  }

  prChatReportHash(analysisId: string): string | null {
    const row = this.store.db.prepare("select report_hash from impact_reports where analysis_id = ? and state = 'CURRENT'").get(analysisId) as { report_hash: string } | undefined;
    return row?.report_hash ?? null;
  }

  /** The PR's current head (§9): when it differs from the answered head, the reply says so. */
  prChatNowHead(analysisId: string): string | null {
    const row = this.pr.row(analysisId);
    if (!row) return null;
    return (this.pr.latestForPr(row.repo_root, row.pr_number) as { head_hash?: string } | null)?.head_hash ?? null;
  }

  /**
   * F15: the feedback hooks behind the watcher's mutating verbs (§8). Labels land in the usefulness log keyed by
   * this repository; wrong/right become C18 verdicts on the (lazily materialised) claim behind the item (§7.1),
   * so claim calibration is fed exactly as today. The PR-author flag is set when the forge told us who opened the PR.
   */
  chatFeedbackFor(ev: PrChatEvent, scope: PrScope): ChatFeedback | null {
    const row = this.pr.row(scope.analysisId);
    if (!row) return null;
    const repositoryId = row.repository_id;
    const analysisId = scope.analysisId;
    const fb = new FeedbackStore(this.store);
    const report = () => this.pr.impactReportOf(analysisId);
    const totals = () => { const s = fb.state(repositoryId).labels; return { total: s.total, principals: s.principals }; };
    const roleOf = (principal: string) => fb.roleFor(repositoryId, principal) ?? "owner"; // local-first: no explicit row ⇒ the operator
    return {
      itemAt: (n) => {
        const item = report()?.surfaced[n - 1];
        return item ? { itemKind: item.kindDetail ?? item.kind, itemId: item.id, kindDetail: item.kindDetail, text: item.text } : null;
      },
      recordUsefulness: async (n, label, actor) => {
        const item = this.pr.impactReportOf(analysisId)?.surfaced[n - 1];
        if (!item) return { ok: false, error: `there is no item ${n} in the current report` };
        const r = fb.recordLabel({
          repositoryId, itemKind: item.kindDetail ?? item.kind, itemId: item.id, analysisId,
          label, principalId: actor, role: roleOf(actor),
          // The PR-author flag comes from the forge when known; the analysis row does not carry it (v1: false).
          isPrAuthor: false,
        });
        if (!r.ok) return { ok: false, error: r.error };
        const t = totals();
        return { ok: true, summary: `recorded ${label} on item ${n} (${r.label.itemKind}) — ${t.total} labels by ${t.principals} reviewer(s) in the log now.` };
      },
      recordVerdict: async (n, verdict, actor) => {
        const item = this.pr.impactReportOf(analysisId)?.surfaced[n - 1];
        if (!item) return { ok: false, error: `there is no item ${n} in the current report` };
        const id = impactClaimId(scope.headRevision, item.text, item.evidenceIds);
        let claim = this.store.getClaim(id);
        if (!claim) {
          // Materialise the claim behind the item once; afterwards the C18 ledger treats it like any claim.
          claim = gateClaim(
            { assertion: item.text, claimClass: item.claimClass, evidenceIds: item.evidenceIds, rationaleSummary: `impact item ${n} of ${repositoryId} PR ${row.pr_number}` },
            bundleFor(this.store, scope.headRevision, item.subjectEntityIds), { store: this.store, trusted: true });
          this.store.putClaim(claim, actor, "feedback.materialise");
        }
        const r = applyVerdict(this.store, {
          claimId: id, verdict, actorId: actor, expectedVersion: claim.version,
          explanation: `PR feedback: item ${n} labelled ${verdict === "REFUTE" ? "wrong" : "right"} by ${actor} (F15 §7.1)`,
        });
        if (!r.ok) return { ok: false, error: r.error.message };
        return { ok: true, summary: `recorded a ${verdict.toLowerCase()} verdict on the claim behind item ${n} — the claim ledger (C18), not the ranking (§7.1).` };
      },
      setMute: async (kind, actor, reason, role) => {
        const r = fb.setMute({ repositoryId, kind, createdBy: actor, role, reason });
        return r.ok
          ? { ok: true, summary: `${kind} muted ${r.mute.scope.type === "REPOSITORY" ? "repository-wide" : "at " + r.mute.scope.type} by ${actor} until ${(r.mute.expiresAt ?? "").slice(0, 10)}${r.mute.reason ? ` (reason: ${r.mute.reason})` : ""} — the next comment counts it, never hides it (§7.4).` }
          : { ok: false, error: r.error };
      },
      listMutes: async () => fb.mutes(repositoryId).active,
      clearMute: async (kind, actor, role) => {
        const r = fb.clearMute(repositoryId, kind, actor, role);
        return r.ok
          ? { ok: true, summary: `${kind} unmuted by ${actor} — the kind may surface again on the next report.` }
          : { ok: false, error: r.error };
      },
      resetRanking: async (actor, role) => {
        if (role !== "owner") return { ok: false, error: "reset-ranking needs the owner role (§7.7)" };
        const t = totals();
        fb.resetRanking(repositoryId, actor);
        return { ok: true, summary: `ranking reset to default by ${actor} — ${t.total} labels stay in the log (§7.7).` };
      },
      labelTotals: totals,
    };
  }

  /**
   * F16: the suggestion hooks behind the watcher's `/cie suggest <n>` (§8). Item N of the current impact report
   * is the finding (impact items are consequences of this change, so introduced is by construction, D4); the
   * engine asks the installed candidate provider (§7.1) and, when a suggestion prepares clean, publishes it
   * through the repository's review-comment transport with a grant this service provisions as the trusted host.
   */
  chatSuggestionsFor(ev: PrChatEvent, scope: PrScope): ChatSuggestions | null {
    const row = this.pr.row(scope.analysisId) as { repository_id: string; pr_number: number; repo_root: string } | undefined;
    if (!row || !this.suggestionEngine.provider) return null;
    const engine = this.suggestionEngine;
    const report = () => this.pr.impactReportOf(scope.analysisId);
    return {
      prepare: async (n, actor) => {
        const item = report()?.surfaced[n - 1];
        if (!item) return { ok: false, reason: `there is no item ${n} in the current report` };
        const prepared = await engine.prepare({
          analysisId: scope.analysisId, findingId: item.id, headHash: scope.headHash, repoRoot: scope.repoRoot,
          principalId: actor, introduced: true,
        });
        if (!prepared.ok) return { ok: false, reason: prepared.reason };
        if (prepared.replayed && prepared.record.state === "POSTED")
          return { ok: true, summary: `item ${n} already has a suggestion posted for head ${prepared.record.headHash.slice(0, 7)}; one posting per finding, head and replacement (§11).` };
        const grant = newGrant(this.store, { repositoryId: row.repository_id, headHash: scope.headHash, principalId: actor, operation: "PUBLISH_SUGGESTION", ttlMs: 60_000 });
        let visibility: "public" | "private" | undefined;
        try { visibility = (await this.prPublisher.transportFor(row.repo_root).visibility()) as "public" | "private"; } catch { visibility = undefined; }
        const published = await engine.publish({
          suggestionId: prepared.record.id, prNumber: row.pr_number, repositoryId: row.repository_id,
          principalId: actor, grantId: grant.id, transport: githubReviewTransportFor(row.repo_root),
          visibility,
          deniedPrefixes: this.store.deniedPrefixes(row.repo_root),
        });
        for (const u of engine.observe({ analysisId: scope.analysisId, repoRoot: row.repo_root, headHash: scope.headHash }).toUpdate)
          await engine.writeBackSuperseded(u.record, scope.headHash, githubReviewTransportFor(row.repo_root)).catch(() => undefined);
        if (!published.ok) {
          if (published.code === "CAP") return { ok: true, summary: `${prepared.record.findingId} prepared a validated suggestion, but ${published.reason}` };
          return { ok: false, reason: published.reason };
        }
        return { ok: true, summary: `a validated suggestion for item ${n} (${item.kindDetail ?? item.kind}) is posted as an inline review comment, bound to head ${scope.headHash.slice(0, 7)} — apply it only if you agree; the checks that ran and those that did not are listed there (§1.2).` };
      },
    };
  }

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
    // ---- F11: the cited impact report and the blast-radius comment (§8) ----
    "C23/getImpactReport": (c, b) => {
      if (typeof b?.analysisId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId", retryable: false });
      const report = this.readableImpactReport(b.analysisId);
      if (!report) return fail(c, { code: "NOT_FOUND", message: "no impact report for this analysis; run C23/analyzePullRequest first", retryable: false });
      return ok(c, report, { revision: this.pr.row(b.analysisId)?.head_revision ?? undefined });
    },
    "C23/getPrSummary": (c, b) => {
      if (typeof b?.analysisId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId", retryable: false });
      const report = this.readableImpactReport(b.analysisId);
      if (!report) return fail(c, { code: "NOT_FOUND", message: "no impact report for this analysis; run C23/analyzePullRequest first", retryable: false });
      if (!report.summary) return fail(c, { code: "NOT_FOUND", message: "this report has no summary; it predates F13 or the analysis needs a re-run", retryable: false });
      return ok(c, report.summary, { revision: this.pr.row(b.analysisId)?.head_revision ?? undefined });
    },
    "C23/explainImpactItem": (c, b) => {
      if (typeof b?.analysisId !== "string" || typeof b?.itemId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId and an itemId", retryable: false });
      const report = this.readableImpactReport(b.analysisId);
      if (!report) return fail(c, { code: "NOT_FOUND", message: "no impact report for this analysis; run C23/analyzePullRequest first", retryable: false });
      return ok(c, explainImpactItem(report, b.itemId));
    },
    "C30/previewImpactComment": (c, b) => {
      if (typeof b?.analysisId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId", retryable: false });
      const row = this.pr.row(b.analysisId);
      const report = this.readableImpactReport(b.analysisId);
      if (!row || !report) return fail(c, { code: "NOT_FOUND", message: "no impact report for this analysis; run C23/analyzePullRequest first", retryable: false });
      const policyCheck = b?.policy !== undefined ? validateImpactPolicy(b.policy) : { ok: true as const, policy: undefined };
      if (!policyCheck.ok) return fail(c, { code: "INVALID_SCHEMA", message: policyCheck.problems.join("; ").slice(0, 300), retryable: false });
      const denied = this.store.deniedPrefixes(row.repo_root);
      const resolveEvidence = (id: string) => !!this.store.evidence(row.head_revision ?? "", id);
      const reviewUrl = this.prPublisher.selfUrl ? `${this.prPublisher.selfUrl}/#pr=${b.analysisId}` : undefined;
      const rendered = renderImpactComment({ report, analysisState: row.state, policy: policyCheck.policy, deniedPrefixes: denied, resolveEvidence, reviewUrl });
      const hashRow = this.store.db.prepare("select report_hash from impact_reports where analysis_id = ?").get(b.analysisId) as { report_hash: string } | undefined;
      return ok(c, { markdown: rendered.markdown, reportHash: hashRow?.report_hash ?? "", silent: rendered.silent, cuts: rendered.cuts }, { completeness: rendered.cuts.length ? "PARTIAL" : "COMPLETE", warnings: rendered.cuts });
    },
    // ---- F14: chat inside the PR thread (§8) ----
    "C15/runPrCommand": (c, b) => {
      if (typeof b?.analysisId !== "string" || typeof b?.text !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId and the comment text", retryable: false });
      const scope = this.prChatScopeFor(b.analysisId);
      if (!scope) return fail(c, { code: "NOT_FOUND", message: "no analysis at a head for this PR; run C23/analyzePullRequest first", retryable: false });
      const parsed = parseChat(b.text);
      if (parsed.type === "ignore") return ok(c, { kind: "IGNORED" }, { revision: scope.headRevision });
      let result: ChatShapedResult;
      if (parsed.type === "freeform") {
        result = this.prChatEnvFor(scope).modelAvailable
          ? { schemaVersion: 1, kind: "FREE_FORM", headHash: scope.headHash, claims: [], gaps: [], refusedReason: "Free-form answering is not enabled in this build." }
          : { schemaVersion: 1, kind: "FREE_FORM", headHash: scope.headHash, claims: [{ class: "FOG", text: "Free-form questions need a locally installed model; deterministic commands work without one. /cie help lists them.", evidence: [] }], gaps: [] };
      } else {
        // Feedback verbs are mutating; they run through the watcher, not this read-only shaping op (§7.1).
        if (isFeedbackVerb(parsed.verb) || parsed.verb === "suggest") return fail(c, { code: "FORBIDDEN", message: "feedback commands are mutating; run them through the PR chat watcher", retryable: false });
        result = runChatCommand(this.prChatEnvFor(scope), { verb: parsed.verb as import("./pr-chat.ts").ReadVerb, args: parsed.args });
      }
      const visibility: ReplyVisibility = b.visibility === "private" ? "private" : "public";
      const gated = gateResult(result, { visibility, deniedPrefixes: this.store.deniedPrefixes(scope.repoRoot), resolveEvidence: (id) => !!this.store.evidence(scope.headRevision, id) });
      return ok(c, { ...result, claims: gated.claims, refusedReason: gated.refusedReason }, { revision: scope.headRevision });
    },
    "C30/postPrReply": async (c, b) => {
      if (typeof b?.commentId !== "string" || typeof b?.resultHash !== "string" || typeof b?.idempotencyKey !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give commentId, resultHash and idempotencyKey", retryable: false });
      const ledger = new ReplyLedger(this.store);
      const row = ledger.anyRow(b.commentId);
      if (!row || row.result_hash !== b.resultHash) return fail(c, { code: "NOT_FOUND", message: "no shaped reply for this comment; run the watcher or C15/runPrCommand first", retryable: false });
      if (row.idempotency_key !== b.idempotencyKey) return fail(c, { code: "FORBIDDEN", message: "idempotency key mismatch", retryable: false });
      if (row.reply_id) return ok(c, { replyId: row.reply_id, idempotent: true }, { completeness: "COMPLETE" }); // §11: a replay returns the same receipt
      const analysisRow = row.analysis_id ? this.pr.row(row.analysis_id) : null;
      newGrant(this.store, { repositoryId: row.repository, headHash: row.head_hash, principalId: actor(c), operation: "POST_PR_REPLY", ttlMs: 60_000 });
      const t = this.prPublisher.transportFor(analysisRow?.repo_root ?? row.repository) as unknown as { postReply?: (pr: number, inReplyTo: string, body: string) => Promise<{ id: string }> };
      if (!t.postReply || !row.reply_body) return fail(c, { code: "PROVIDER_UNAVAILABLE", message: "this transport cannot post PR replies (the F19 forge interface)", retryable: false });
      try {
        const receipt = await t.postReply(row.pr_number, row.comment_id, row.reply_body);
        ledger.markPosted(row.comment_id, row.content_hash, receipt.id);
        return ok(c, { replyId: receipt.id, idempotent: false }, { completeness: "COMPLETE" });
      } catch (e) {
        ledger.markPosted(row.comment_id, row.content_hash, "", "FAILED", String((e as Error).message ?? e).slice(0, 200));
        return fail(c, { code: "PROVIDER_UNAVAILABLE", message: String((e as Error).message ?? e).slice(0, 300), retryable: true });
      }
    },
    // ---- F15: the reviewer feedback loop (§8) — usefulness labels, mutes, derived weights, reset ----
    "C17/recordUsefulness": (c, b) => {
      if (typeof b?.repositoryId !== "string" || typeof b?.itemId !== "string" || typeof b?.itemKind !== "string" || typeof b?.analysisId !== "string" || !["USEFUL", "NOISE"].includes(b?.label)) return fail(c, { code: "INVALID_SCHEMA", message: "give repositoryId, itemKind, itemId, analysisId and label USEFUL|NOISE", retryable: false });
      const fb = new FeedbackStore(this.store);
      const r = fb.recordLabel({
        repositoryId: b.repositoryId, itemKind: b.itemKind, itemId: b.itemId, analysisId: b.analysisId,
        label: b.label, principalId: actor(c), role: fb.roleFor(b.repositoryId, actor(c)) ?? "owner",
        source: b.source === "REACTION" ? "REACTION" : "COMMAND", isPrAuthor: b.isPrAuthor === true, provenance: b.provenance === "SYNTHETIC" ? "SYNTHETIC" : "HUMAN",
      });
      return r.ok ? ok(c, r.label, { completeness: "COMPLETE" }) : fail(c, { code: "FORBIDDEN", message: r.error, retryable: false });
    },
    "C29/setMute": (c, b) => {
      if (typeof b?.repositoryId !== "string" || typeof b?.kind !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give repositoryId and kind", retryable: false });
      const fb = new FeedbackStore(this.store);
      const scope = b?.scope && typeof b.scope === "object" && b.scope.type === "REPOSITORY" ? { type: "REPOSITORY" as const }
        : b?.scope && typeof b.scope === "object" && typeof b.scope.value === "string" && ["PATH_PREFIX", "SYMBOL"].includes(b.scope.type) ? { type: b.scope.type as "PATH_PREFIX" | "SYMBOL", value: b.scope.value }
        : undefined;
      const r = fb.setMute({ repositoryId: b.repositoryId, kind: String(b.kind).toUpperCase(), scope, createdBy: actor(c), role: fb.roleFor(b.repositoryId, actor(c)) ?? "owner", expiresAt: typeof b?.expiresAt === "string" ? b.expiresAt : undefined, reason: typeof b?.reason === "string" ? b.reason : undefined });
      return r.ok ? ok(c, r.mute, { completeness: "COMPLETE" }) : fail(c, { code: "FORBIDDEN", message: r.error, retryable: false });
    },
    "C29/clearMute": (c, b) => {
      if (typeof b?.repositoryId !== "string" || typeof b?.id !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give repositoryId and the mute id or kind", retryable: false });
      const fb = new FeedbackStore(this.store);
      const r = fb.clearMute(b.repositoryId, b.id, actor(c), fb.roleFor(b.repositoryId, actor(c)) ?? "owner");
      return r.ok ? ok(c, r.mute, { completeness: "COMPLETE" }) : fail(c, { code: "NOT_FOUND", message: r.error, retryable: false });
    },
    "C17/getFeedbackState": (c, b) => {
      if (typeof b?.repositoryId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give repositoryId", retryable: false });
      return ok(c, new FeedbackStore(this.store).state(b.repositoryId), { completeness: "COMPLETE" });
    },
    "C17/recomputeWeights": (c, b) => {
      if (typeof b?.repositoryId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give repositoryId", retryable: false });
      const fb = new FeedbackStore(this.store);
      const r = fb.recomputeWeights(b.repositoryId, { minFeedback: Number.isInteger(b?.minFeedback) ? b.minFeedback : undefined, distinctPrincipals: Number.isInteger(b?.distinctPrincipals) ? b.distinctPrincipals : undefined });
      return ok(c, { weights: r.weights, truncated: r.truncated, logHash: r.logHash }, { completeness: r.truncated ? "PARTIAL" : "COMPLETE", warnings: r.truncated ? [`the label log is capped at ${r.truncated ? "the" : ""} the recompute bound; counts may be incomplete`] : undefined });
    },
    // ---- F16: validated inline fix suggestions (§8) — prepare (gate + scratch validation), publish (grant-checked
    // review comment, find-before-create, per-PR cap), list (read-only, with outcome observation) ----
    "C28/prepareSuggestion": async (c, b) => {
      if (typeof b?.analysisId !== "string" || typeof b?.findingId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give analysisId and findingId", retryable: false });
      const row = this.pr.row(b.analysisId);
      if (!row) return fail(c, { code: "NOT_FOUND", message: "no such analysis", retryable: false });
      if (this.store.isRevoked(row.repo_root)) return fail(c, { code: "FORBIDDEN", message: "Access to this source was withdrawn.", retryable: false });
      const candidate = parseCandidateArg(b.candidate); // null: ask the installed provider (§7.1)
      if (candidate === undefined) return fail(c, { code: "INVALID_SCHEMA", message: "candidate must carry id, findingId, baseHash, edits[], validationHash and oraclePreserved", retryable: false });
      const r = await this.suggestionEngine.prepare({
        analysisId: b.analysisId, findingId: b.findingId, headHash: row.head_hash, repoRoot: row.repo_root,
        principalId: actor(c), introduced: b.introduced !== false, candidate,
      });
      return r.ok ? ok(c, r.record, { completeness: "COMPLETE" }) : fail(c, { code: "FORBIDDEN", message: r.reason, retryable: false });
    },
    "C30/publishSuggestion": async (c, b) => {
      if (typeof b?.suggestionId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give suggestionId", retryable: false });
      const rec = this.suggestionEngine.record(b.suggestionId);
      if (!rec) return fail(c, { code: "NOT_FOUND", message: "no such suggestion", retryable: false });
      const row = this.pr.row(rec.analysisId);
      if (!row) return fail(c, { code: "NOT_FOUND", message: "the suggestion's analysis no longer exists", retryable: false });
      if (this.store.isRevoked(row.repo_root)) return fail(c, { code: "FORBIDDEN", message: "Access to this source was withdrawn.", retryable: false });
      const grant = newGrant(this.store, { repositoryId: row.repository_id, headHash: rec.headHash, principalId: actor(c), operation: "PUBLISH_SUGGESTION", ttlMs: 60_000 });
      const t = githubReviewTransportFor(row.repo_root);
      const r = await this.suggestionEngine.publish({
        suggestionId: rec.id, prNumber: row.pr_number, repositoryId: row.repository_id, principalId: actor(c),
        grantId: grant.id, transport: t, idempotencyKey: typeof b?.idempotencyKey === "string" ? b.idempotencyKey : undefined,
        visibility: (await this.prPublisher.transportFor(row.repo_root).visibility()) as "public" | "private",
        deniedPrefixes: this.store.deniedPrefixes(row.repo_root),
      });
      if (!r.ok) return fail(c, { code: r.code === "CAP" ? "FORBIDDEN" : r.code === "STALE" ? "STALE_REVISION" : r.code === "GUARD" ? "FORBIDDEN" : "PROVIDER_UNAVAILABLE", message: r.reason, retryable: r.code === "FAILED" });
      return ok(c, { suggestion: r.record, externalId: r.externalId, idempotent: r.idempotent }, { completeness: "COMPLETE" });
    },
    "C23/getSuggestions": async (c, b) => {
      if (typeof b?.analysisId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give analysisId", retryable: false });
      const row = this.pr.row(b.analysisId);
      if (!row) return fail(c, { code: "NOT_FOUND", message: "no such analysis", retryable: false });
      if (this.store.isRevoked(row.repo_root)) return fail(c, { code: "FORBIDDEN", message: "Access to this source was withdrawn.", retryable: false });
      const denied = this.store.deniedPrefixes(row.repo_root);
      const suggestions = this.suggestionEngine.forAnalysis(b.analysisId).filter(rec => !denied.some(p => rec.path === p || rec.path.startsWith(p + "/")));
      return ok(c, { suggestions, supersededCommentsUpdated: 0 }, { completeness: "COMPLETE" });
    },
    "C30/publishImpactComment": async (c, b) => {
      if (typeof b?.analysisId !== "string") return fail(c, { code: "INVALID_SCHEMA", message: "give an analysisId", retryable: false });
      const row = this.pr.row(b.analysisId);
      if (!row) return fail(c, { code: "NOT_FOUND", message: "no such analysis", retryable: false });
      const policyCheck = b?.policy !== undefined ? validateImpactPolicy(b.policy) : { ok: true as const, policy: undefined };
      if (!policyCheck.ok) return fail(c, { code: "INVALID_SCHEMA", message: policyCheck.problems.join("; ").slice(0, 300), retryable: false });
      const grant = newGrant(this.store, { repositoryId: row.repository_id, headHash: row.head_hash, principalId: actor(c), operation: "PUBLISH_IMPACT", ttlMs: 60_000 });
      const receipt = await this.prPublisher.publishImpact(grant.id, { repositoryId: row.repository_id, prNumber: row.pr_number, analysisId: b.analysisId, policy: policyCheck.policy });
      return ok(c, receipt, { completeness: receipt.state === "PUBLISHED" ? "COMPLETE" : receipt.state === "PREPARED" ? "COMPLETE" : "PARTIAL" });
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
  health(ctx: CallContext, req: Record<string, never> = {}): Promise<ApiResult<Health>> { return this.jobsAdmin.health(ctx, req); }

  /** What an editor extension needs to decide whether it can talk to this server. */
  version(ctx: CallContext, req: Record<string, never> = {}): ApiResult<{ api: string; minExtension: string; schema: number }> { return this.jobsAdmin.version(ctx, req); }

  /** A consistent copy of the database, written beside it under backups/. `name` is a plain file name, never a path. */
  backup(ctx: CallContext, req: { name?: string }): ApiResult<{ path: string; revisions: number; drill: RestoreDrill }> { return this.jobsAdmin.backup(ctx, req); }

  /** Remove revisions nothing refers to. `dryRun` says what would go without removing it. */
  gc(ctx: CallContext, req: { dryRun?: boolean; minAgeDays?: number }): ApiResult<GcReport> { return this.jobsAdmin.gc(ctx, req); }

  /** Delete a repository and everything derived from it. The caller must repeat the path, so it cannot happen by accident. */
  deleteRepository(ctx: CallContext, req: { repoRoot: string; confirm: string }): ApiResult<DeleteReport> { return this.jobsAdmin.deleteRepository(ctx, req); }

  // ---------------------------------------------------------------- C07 jobs
  /** Start indexing, concept extraction, or hierarchy building in the background. Returns the job at once; poll getJob for progress. */
  enqueueJob(ctx: CallContext, req: { kind: "index" | "concepts" | "concept-hierarchy"; repoPath?: string; revision?: string }): ApiResult<JobView & { deduped?: boolean }> { return this.jobsAdmin.enqueueJob(ctx, req); }

  getJob(ctx: CallContext, req: { jobId: string }): ApiResult<JobView> { return this.jobsAdmin.getJob(ctx, req); }

  listJobs(ctx: CallContext, req: { limit?: number }): ApiResult<JobView[]> { return this.jobsAdmin.listJobs(ctx, req); }

  /** Ask a job to stop. Before it starts saving, it stops and nothing is kept; once it is saving, it is left to finish. */
  cancelJob(ctx: CallContext, req: { jobId: string }): ApiResult<{ job: JobView; cancelled: boolean; reason?: string }> { return this.jobsAdmin.cancelJob(ctx, req); }

  repositoryGit(ctx: CallContext, req: { repoPath: string }) { return this.gitBrowsing.repositoryGit(ctx, req); }

  fetchBranches(ctx: CallContext, req: { repoPath: string }) { return this.gitBrowsing.fetchBranches(ctx, req); }

  switchBranch(ctx: CallContext, req: { repoPath: string; branch: string; expectedHead: string | null; expectedBranch: string | null; kind?: "local" | "remote" }) { return this.gitBrowsing.switchBranch(ctx, req); }

  /** Directory names only (never file contents) so the UI can offer a folder picker. Loopback-only gateway. */
  browseDirectory(ctx: CallContext, req: { path?: string }): ApiResult<DirListing> { return this.gitBrowsing.browseDirectory(ctx, req); }

  /** C01: an IDE event. Only path + line numbers are accepted; they resolve to entity ids and nothing else is stored. */
  captureEditorEvent(ctx: CallContext, req: { event: EditorEvent }): ApiResult<{ accepted: boolean; stale?: boolean; entities: string[]; indexed: boolean }> { return this.editorEvents.captureEditorEvent(ctx, req); }

  editorContext(ctx: CallContext, req: { revision?: string }): ApiResult<EditorContext> { return this.editorEvents.editorContext(ctx, req); }

  /** C24: a running app (or you) reports an exception. Stored as an observation; grouped by fingerprint so a loop is one entry with a count. */
  reportException(ctx: CallContext, req: { trace?: string; error?: { name?: string; message?: string; stack?: string }; source?: string }): ApiResult<{ id: string; count: number; isNew: boolean; inRepo: boolean; errorClass: string | null }> { return this.editorEvents.reportException(ctx, req); }

  listExceptions(ctx: CallContext, req: { includeDismissed?: boolean }): ApiResult<ReturnType<Store["exceptions"]>> { return this.editorEvents.listExceptions(ctx, req); }

  dismissException(ctx: CallContext, req: { id: string }): ApiResult<{ dismissed: boolean }> { return this.editorEvents.dismissException(ctx, req); }

  status(ctx: CallContext, req: { revision?: string; repoRoot?: string }): ApiResult<{ revision: RevisionRow | null; provider: string; model: string | null; hosted: boolean; allowHosted: boolean; concepts: number; tests: TestSummary | null }> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision(req.repoRoot);
    return ok(ctx, {
      revision: rev, provider: `${this.model.name}/${this.model.model}`, model: this.model.name === "stub" ? null : this.model.model, hosted: this.model.hosted,
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

  /** Every model `ollama list` reports, and which one (if any) is currently in use — the status chip's own menu. */
  async listModels(ctx: CallContext): Promise<ApiResult<{ installed: string[]; current: string | null; hosted: boolean; reachable: boolean }>> {
    const installed = await listInstalledModels(process.env.CIE_OLLAMA_URL);
    return ok(ctx, { installed: installed ?? [], current: this.model.name === "stub" ? null : this.model.model, hosted: this.model.hosted, reachable: installed !== null });
  }

  /** Switch the one model this installation uses, for both the status chip's provider and the chat router, with
   * no restart: it must already be installed (`ollama list`), and the choice is persisted so it survives one. */
  async setModel(ctx: CallContext, req: { model: string }): Promise<ApiResult<{ model: string; hosted: boolean }>> {
    if (!req || typeof req.model !== "string" || !req.model.trim() || req.model.length > 200) return fail(ctx, { code: "INVALID_SCHEMA", message: "model is required", retryable: false });
    const model = req.model.trim();
    const baseUrl = process.env.CIE_OLLAMA_URL;
    const installed = await listInstalledModels(baseUrl);
    if (installed === null) return fail(ctx, { code: "PROVIDER_UNAVAILABLE", message: "Ollama is not reachable; cannot confirm which models are installed", retryable: true });
    if (!hasModel(installed, model)) return fail(ctx, { code: "NOT_FOUND", message: `"${model}" is not installed. Installed: ${installed.length ? installed.join(", ") : "none"}`, retryable: false });
    const think = (["low", "medium", "high", "off"] as const).find((x) => x === process.env.CIE_OLLAMA_THINK);
    const provider = new OllamaProvider({ model, baseUrl, think });
    this.model = provider;
    this.router = routerFor(model, process.env);
    this.store.setSelectedModel(model);
    this.store.audit(actor(ctx), "model.selected", "server", { model, hosted: provider.hosted });
    return ok(ctx, { model, hosted: provider.hosted });
  }

  auditLog(ctx: CallContext, req: { limit?: number }): ApiResult<{ events: unknown[]; chain: { ok: boolean; brokenAt?: number } }> {
    return ok(ctx, { events: this.store.auditEvents(Math.min(req.limit ?? 100, 500)), chain: this.store.verifyAuditChain() });
  }

  // ---------------------------------------------------------------- concept cards
  async extractConcepts(ctx: CallContext, req: { revision?: string }, control?: JobControl): Promise<ApiResult<{ cards: ConceptCard[]; dropped: string[]; provider: string }>> {
    return fail(ctx, { code: "NOT_IMPLEMENTED", message: "Concept cards have been retired. Click “Build concept hierarchy”; it is the only concept-generation mechanism.", retryable: false });
  }

  /** The concept store: cards with the claim behind each, the version history, and what changed since the previous version. */
  conceptStore(ctx: CallContext, req: { revision?: string; version?: number }): ApiResult<ConceptStore> {
    return fail(ctx, { code: "NOT_IMPLEMENTED", message: "Concept cards have been removed. Use conceptHierarchy.", retryable: false });
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

  // ---------------------------------------------------------------- concept hierarchy (dual-axis)
  /**
   * Naming runs through the same gateway path as every model call (egress, budget, audit), but its
   * result is a label, never a claim: it is stored in the naming cache and on the concept, and the
   * claims/verdicts tables are untouched. `modelVersion` in the cache key keeps names from one model
   * from leaking into another's cache.
   */
  private namingAdapter(rev: RevisionRow, control?: JobControl, deadlineMs?: number): NamingAdapter {
    const modelVersion = `${this.model.name}/${this.model.model}`;
    const usage = { model: 0, offline: 0 };
    const notes = new Set<string>();
    return {
      modelVersion, usage, notes,
      name: async (req) => {
        control?.checkpoint();
        const schemaId = req.purpose === "NAME_ARCH" ? SCHEMA_NAME_ARCH : SCHEMA_NAME_CONCEPT;
        const callCtx: CallContext = {
          requestId: `req-name:${randomUUID()}`, idempotencyKey: `naming:${rev.id}:${randomUUID()}`,
          actor: { principalId: "system", tenantId: "local", sessionId: "system" },
          // Naming has its own generous budget, but a caller with a nearer deadline still cancels it.
          deadlineMs: deadlineMs !== undefined ? Math.min(Date.now() + 120_000, deadlineMs) : Date.now() + 120_000,
          traceId: `trace-name:${randomUUID()}`,
        };
        const bundle: EvidenceBundle = { id: "naming", revision: rev.id, evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 };
        const asked = this.callModel<NameConceptOutput & NameArchOutput>(callCtx, rev, { purpose: req.purpose, schemaId, question: req.question, bundle });
        const { result, provider, note } = control ? await control.guard(asked) : await asked;
        control?.checkpoint();
        if (!result.ok) return null;
        // Who actually answered: the gateway swaps in the offline stand-in when a hosted model is not approved or its budget is spent.
        const offline = provider === this.offline || provider.name === "stub";
        if (offline) usage.offline += result.value.names.length; else usage.model += result.value.names.length;
        if (note) notes.add(note);
        return result.value.names.map((n) => ({ conceptId: n.conceptId, name: n.name, ...(offline ? { offline: true } : {}) }));
      },
    };
  }

  /**
   * Build the dual-axis hierarchy for a revision: graphs → motifs → concepts → invariants →
   * architecture → links → anchoring → naming. Job-controlled like concept extraction; everything is
   * written in one persist step at the end, so a cancelled run leaves nothing behind.
   */
  async buildConceptHierarchy(ctx: CallContext, req: { revision?: string }, control?: JobControl): Promise<ApiResult<ConceptHierarchyView>> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const adapter = this.namingAdapter(rev, control, ctx.deadlineMs);
    const result = await buildHierarchy(this.store, rev.id, { repoRoot: rev.repoRoot, adapter, control, provider: `${this.model.name}/${this.model.model}`, motifBatch: this.motifBatch });
    control?.commit();
    // Record who really wrote the names, not who was configured to: a hosted model that was not approved did not write them.
    const u = adapter.usage!;
    const offlineName = `${this.offline.name}/${this.offline.model}`;
    const provider = u.model === 0 && u.offline > 0 ? offlineName : u.model > 0 && u.offline > 0 ? `${this.model.name}/${this.model.model} (partly ${offlineName})` : `${this.model.name}/${this.model.model}`;
    // First, so it is the one the person sees in the completion notice: it is the reason the names are what they are.
    for (const n of [...(adapter.notes ?? [])].reverse()) if (!result.stats.warnings.includes(n)) result.stats.warnings.unshift(n);
    const version = persistHierarchy(this.store, result, provider);
    // Every concept gets a real provenance claim grounded in its members' evidence, so team verdicts
    // (confirm/refute with attribution) attach to the concept instead of dangling on claimId "".
    // The assertion is concept-id-based, so a rebuilt (renamed) concept keeps its claim and its verdicts.
    for (const c of result.concepts) {
      if (!(c.members?.length)) continue;
      const bundle = bundleFor(this.store, rev.id, c.members);
      const claim = gateClaim({
        assertion: `Concept ${c.id} is a ${c.kind} composed of ${c.members.length} named site(s).`,
        claimClass: "concept", evidenceIds: (c.evidenceIds ?? []).slice(0, 6),
        rationaleSummary: "Structural composition found in the indexed graph.", subjects: c.members,
      }, bundle, { store: this.store });
      if (claim.displayMode === "HIDDEN") continue;
      this.store.putClaim(claim);
      this.store.setConceptClaim(rev.id, c.id, claim.draft.id);
    }
    this.store.audit(actor(ctx), "concept-hierarchy.build", rev.id, {
      version, concepts: result.concepts.length, invariants: result.invariants.length,
      archNodes: result.arch.length, crossPackage: result.crossPackage.length, fullRebuild: result.stats.fullRebuild,
      pdgsReused: result.stats.pdgs.reused, namingCacheHits: result.stats.naming.cacheHits,
    });
    const view = this.hierarchyView(rev, version, result);
    return ok(ctx, view, { revision: rev.id, warnings: result.stats.warnings });
  }

  /** The read-only hierarchy view: the current version's live tables, or an older version's snapshot. */
  conceptHierarchy(ctx: CallContext, req: { revision?: string; version?: number; summary?: boolean }): ApiResult<ConceptHierarchyView> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    // A header or button only needs to know whether a build exists and how big it is; the full view can be megabytes.
    if (req.summary === true) {
      const latest = this.store.semanticConceptVersions(rev.repoRoot)[0];
      return ok(ctx, { revision: latest?.revision ?? rev.id, version: latest?.version ?? 0, versions: [], concepts: [], invariants: [], arch: [], surfaces: [], entryPoints: [], crossPackage: [], links: [], stats: null, summary: { concepts: latest?.concepts ?? 0 } },
        { revision: rev.id, warnings: latest && latest.revision !== rev.id ? ["The existing concept hierarchy belongs to an older indexed revision. Click “Build concept hierarchy” to update it."] : [] });
    }
    const versions = this.store.semanticConceptVersions(rev.repoRoot);
    const current = versions[0]?.version ?? 0;
    const want = req.version ?? current;
    if (!want) {
      return ok(ctx, { revision: rev.id, version: 0, versions: [], concepts: [], invariants: [], arch: [], surfaces: [], entryPoints: [], crossPackage: [], links: [], stats: null });
    }
    if (want === current) {
      const hierarchyRevision = versions[0]!.revision;
      const snapshot = this.store.latestSemanticVersionSnapshot(hierarchyRevision);
      return ok(ctx, {
        revision: hierarchyRevision, version: want, versions,
        concepts: this.store.semanticConcepts(hierarchyRevision),
        invariants: (snapshot?.invariants as ConceptHierarchyView["invariants"]) ?? [],
        arch: this.store.archNodes(hierarchyRevision),
        surfaces: (snapshot?.surfaces as ConceptHierarchyView["surfaces"]) ?? [],
        entryPoints: [], crossPackage: (snapshot?.crossPackage as ConceptHierarchyView["crossPackage"]) ?? [],
        links: this.store.crossAxisLinks(hierarchyRevision),
        stats: (snapshot?.stats as ConceptHierarchyView["stats"]) ?? null,
      }, { revision: rev.id, warnings: hierarchyRevision !== rev.id ? ["The existing concept hierarchy belongs to an older indexed revision. Click “Build concept hierarchy” to update it."] : [] });
    }
    const snap = this.store.semanticConceptVersion(rev.repoRoot, want);
    if (!snap) return fail(ctx, { code: "NOT_FOUND", message: `no hierarchy version ${want}`, retryable: false });
    const versionRevision = versions.find((v) => v.version === want)?.revision ?? rev.id;
    return ok(ctx, {
      revision: versionRevision, version: want, versions,
      concepts: (snap.concepts as ConceptHierarchyView["concepts"]),
      invariants: (snap.invariants as ConceptHierarchyView["invariants"]),
      arch: this.store.archNodes(versionRevision),
      surfaces: (snap.surfaces as ConceptHierarchyView["surfaces"]),
      entryPoints: [], crossPackage: (snap.crossPackage as ConceptHierarchyView["crossPackage"]),
      links: this.store.crossAxisLinks(versionRevision),
      stats: null,
    });
  }

  /** Zero-LLM structural concept clusters the worker found at index time (shape.rs's AST-shape hash, shared
   * framework role, and near-duplicate IR copies) — see store.ts's `conceptClusters`. Separate from
   * `conceptHierarchy` above: no build step, always current for whatever revision is indexed, nothing to go
   * stale. A near-duplicate cluster's pairs carry the per-pair similarity and structural-diff summary. */
  structuralConcepts(ctx: CallContext, req: { revision?: string }): ApiResult<StructuralConceptsView> {
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const raw = this.store.conceptClusters(rev.id);
    const allIds = [...new Set(raw.flatMap((c) => c.memberEntityIds))];
    const entityById = new Map(this.store.entitiesById(rev.id, allIds).map((e) => [e.entityId, e]));
    const clusters: StructuralConceptsView["clusters"] = raw.map((c) => ({
      id: c.conceptId, kind: c.kind as StructuralConceptCluster["kind"], name: c.name,
      members: c.memberEntityIds.flatMap((id) => { const e = entityById.get(id); return e ? [{ entityId: id, name: e.name, kind: e.kind, file: e.file }] : []; }),
      ...(c.kind === "near-duplicate" && c.pairs.length ? { pairs: c.pairs.map((p) => ({ a: p.a, b: p.b, similarity: p.similarity, diff: p.diff })) } : {}),
    }));
    return ok(ctx, { revision: rev.id, clusters }, { revision: rev.id, warnings: [] });
  }

  private hierarchyView(rev: RevisionRow, version: number, result: Awaited<ReturnType<typeof buildHierarchy>>): ConceptHierarchyView {
    return {
      revision: rev.id, version,
      versions: this.store.semanticConceptVersions(rev.repoRoot),
      concepts: result.concepts, invariants: result.invariants, arch: result.arch,
      surfaces: result.surfaces, entryPoints: result.entryPoints, crossPackage: result.crossPackage,
      links: result.links.map(({ conceptId, archNodeId }) => ({ conceptId, archNodeId })),
      stats: result.stats,
    };
  }

  // ---------------------------------------------------------------- views
  /** Every question gets both: the picture, and the written answer composed from the same view (after access redaction, so it never says more). */
  ask(ctx: CallContext, req: Parameters<Answering["askView"]>[1]): Promise<ApiResult<{ view: ViewSpec; claims: Claim[]; manifest?: ResponseManifest }>> { return this.answering.ask(ctx, req); }

  investigate(ctx: CallContext, req: { trace: string; revision?: string; ignored?: string[] }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> { return this.answering.investigate(ctx, req); }

  visuals(ctx: CallContext, req: { revision?: string }): ApiResult<CatalogEntry[]> { return this.answering.visuals(ctx, req); }

  recommendCharts(ctx: CallContext, req: { question?: string; response?: string; revision?: string; options?: ChartOption[] }): Promise<ApiResult<{ codes: string[]; source: "llm" | "unavailable"; model: string | null; reason?: string }>> { return this.answering.recommendCharts(ctx, req); }

  /** Generate a provider wizard from the configured chat model; invalid or unavailable model output is explicit. */
  async providerGuide(ctx: CallContext, req: { providerName: string; revision?: string }): Promise<ApiResult<{ guide: ProviderGuideResponse | null; source: string; model: string | null; message: string }>> {
    const name = typeof req?.providerName === "string" ? req.providerName.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 40) : "";
    if (!name) return fail(ctx, { code: "INVALID_SCHEMA", message: "enter a provider name using letters or numbers", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    const context = rev ? (() => {
      const entities = this.store.entities(rev.id);
      const files = [...new Set(entities.map((e) => e.file).filter(Boolean))].slice(0, 500);
      const symbols = entities.filter((e) => e.kind !== "file" && e.kind !== "test").slice(0, 1000).map((e) => `${e.kind} ${e.name} — ${e.file}`);
      const concepts = this.store.concepts(rev.id).slice(0, 60).map((c) => `${c.title}: ${c.summary}`);
      return JSON.stringify({ repoRoot: rev.repoRoot, fileCount: rev.fileCount, files, symbols, concepts });
    })() : "No indexed repository is available. Treat all paths and project details as proposals.";
    if (this.router?.providerGuide) {
      try {
        const guide = validateProviderGuide(await this.router.providerGuide({ providerName: name, context }), name);
        if (guide) {
          this.store.audit(actor(ctx), "provider-guide.generated", "chat", { provider: name, source: "llm", model: this.router.name });
          return ok(ctx, { guide, source: "llm", model: this.router.name, message: `Recommendations generated by ${this.router.name}. Confirm project-specific paths and database schema before applying them.` });
        }
      } catch { /* report that the model path failed below */ }
      return ok(ctx, { guide: null, source: "unavailable", model: this.router.name, message: `The configured model (${this.router.name}) did not return a valid provider guide. Try again or use the built-in MTN-pattern guide.` });
    }
    return ok(ctx, { guide: null, source: "unavailable", model: null, message: "No LLM is configured for the provider wizard. Try again after selecting a model, or use the built-in MTN-pattern guide." });
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
  refreshView(ctx: CallContext, req: { view: ViewSpec }): Promise<ApiResult<{ view: ViewSpec; claims: Claim[] }>> { return this.answering.refreshView(ctx, req); }

  steer(ctx: CallContext, req: { view: ViewSpec; action: "IGNORE" | "RESTORE"; entityId: string }): ApiResult<{ view: ViewSpec; claims: Claim[] }> { return this.answering.steer(ctx, req); }

  explain(ctx: CallContext, req: { revision: string; entityIds: string[]; question?: string }): Promise<ApiResult<ExplainResult>> { return this.answering.explain(ctx, req); }

  resolveMany(rev: RevisionRow, pool: EvidenceRef[], ids: string[]): ResolvedEvidence[] {
    return ids.flatMap((id) => { const e = pool.find((x) => x.id === id) ?? this.store.evidence(rev.id, id); return e ? [this.resolveEvidence(rev, e)] : []; });
  }

  /** "Why are you showing this?": the salience factors and evidence behind a node, in plain terms. */
  whyShown(ctx: CallContext, req: { view: ViewSpec; nodeId: string }): ApiResult<ExplainResult> { return this.answering.whyShown(ctx, req); }

  whyHidden(ctx: CallContext, req: { view: ViewSpec; query: string }): ApiResult<ExplainResult> { return this.answering.whyHidden(ctx, req); }

  /** "Why do you suspect X?": the ranking factors behind a suspect, with citations. */
  whySuspect(ctx: CallContext, req: { view: ViewSpec; target: string }): ApiResult<ExplainResult> { return this.answering.whySuspect(ctx, req); }

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

  /** The source of one function-like entity, for the leaf of the concept tree. Access-checked, bounded, and it says when the file has changed since indexing. */
  entityCode(ctx: CallContext, req: { revision?: string; entityId?: unknown }): ApiResult<EntityCode> {
    if (!req || typeof req.entityId !== "string" || !req.entityId || req.entityId.length > 600) return fail(ctx, { code: "INVALID_SCHEMA", message: "entityId must be a non-empty string", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const e = this.store.entities(rev.id).find((x) => x.entityId === req.entityId);
    if (!e) return fail(ctx, { code: "NOT_FOUND", message: "no such code element in this revision", retryable: false });
    const base = { entityId: e.entityId, name: e.name, kind: e.kind };
    if (policyFor(this.store, rev.repoRoot).denied(e.file)) return ok(ctx, { ...base, file: "(not shown)", startLine: 0, endLine: 0, text: "", truncated: false, state: "WITHHELD" as const }, { revision: rev.id });
    const unavailable = (): ApiResult<EntityCode> => ok(ctx, { ...base, file: e.file, startLine: 0, endLine: 0, text: "", truncated: false, state: "UNAVAILABLE" as const }, { revision: rev.id });
    const span = e.spans[0];
    if (!span) return unavailable();
    const path = resolve(rev.repoRoot, span.sourceId), rel = relative(rev.repoRoot, path);
    if (rel.startsWith("..") || isAbsolute(rel) || !existsSync(path)) return unavailable();
    try {
      const buf = readFileSync(path);
      const stale = createHash("sha256").update(buf).digest("hex") !== span.contentHash;
      const full = buf.subarray(span.startByte, span.endByteExclusive).toString("utf8");
      const lines = full.split("\n");
      const MAX_LINES = 160, MAX_CHARS = 16_000;
      let text = lines.slice(0, MAX_LINES).join("\n");
      let truncated = lines.length > MAX_LINES;
      if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
      const startLine = buf.subarray(0, span.startByte).toString("utf8").split("\n").length;
      return ok(ctx, { ...base, file: span.sourceId, startLine, endLine: startLine + lines.length - 1, text, truncated, state: stale ? "STALE" as const : "CURRENT" as const }, { revision: rev.id });
    } catch { return unavailable(); }
  }

  /** IR-first (plan): a stored symbol's semantic IR rendered as deterministic pseudocode — what a
   *  model reads instead of re-parsed source; the source slice stays available beside it. */
  irOf(ctx: CallContext, req: { revision?: string; entityId?: unknown; maxLines?: unknown }): ApiResult<{ entityId: string; name: string; file: string; state: "CURRENT" | "UNAVAILABLE" | "WITHHELD"; render: string | null }> {
    if (!req || typeof req.entityId !== "string" || !req.entityId || req.entityId.length > 600) return fail(ctx, { code: "INVALID_SCHEMA", message: "entityId must be a non-empty string", retryable: false });
    const maxLines = req.maxLines === undefined || req.maxLines === null ? undefined : req.maxLines;
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const e = this.store.entitiesById(rev.id, [req.entityId])[0];
    if (!e) return fail(ctx, { code: "NOT_FOUND", message: "no such code element in this revision", retryable: false });
    const base = { entityId: e.entityId, name: e.name, file: e.file, render: null as string | null };
    if (policyFor(this.store, rev.repoRoot).denied(e.file)) return ok(ctx, { ...base, file: "(not shown)", state: "WITHHELD" as const }, { revision: rev.id });
    if (!(e.irDump ?? "").length) return ok(ctx, { ...base, state: "UNAVAILABLE" as const }, { revision: rev.id });
    const [render] = renderIrs([{ entityId: e.entityId, name: e.name, file: e.file, irDump: e.irDump! }], typeof maxLines === "number" ? maxLines : undefined);
    return ok(ctx, { ...base, state: "CURRENT" as const, render: render.render }, { revision: rev.id });
  }

  /** IR-first (plan): structurally nearest stored symbols by the stored vectors — "code shaped like
   *  this", rename-stable, across files and languages. */
  similarOf(ctx: CallContext, req: { revision?: string; entityId?: unknown; topK?: unknown }): ApiResult<{ entityId: string; similar: import("./irfirst.ts").Similar[] }> {
    if (!req || typeof req.entityId !== "string" || !req.entityId || req.entityId.length > 600) return fail(ctx, { code: "INVALID_SCHEMA", message: "entityId must be a non-empty string", retryable: false });
    const topK = req.topK === undefined ? 8 : req.topK;
    if (!Number.isInteger(topK) || (topK as number) < 1 || (topK as number) > 50) return fail(ctx, { code: "INVALID_SCHEMA", message: "topK must be an integer in 1..50", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const access = policyFor(this.store, rev.repoRoot);
    const similar = similarOf(this.store, rev.id, req.entityId, topK as number).filter((x) => !access.denied(x.file));
    return ok(ctx, { entityId: req.entityId, similar: topK === undefined ? similar : similar.slice(0, topK as number) }, { revision: rev.id });
  }

  /** IR-first (plan): the corpus-wide duplicate scan — exact-shape clone groups (shared IR fingerprint)
   *  plus the worker's proved near-duplicate pairs, access-filtered. The anchorless recall path: one
   *  deterministic call, no browsing. */
  duplicates(ctx: CallContext, req: { revision?: string; minSimilarity?: unknown; maxGroups?: unknown; maxPairs?: unknown }): ApiResult<{ revision: string; exactGroups: { irHash: string; members: { entityId: string; name: string; file: string }[]; withheld: number }[]; nearPairs: { a: string; b: string; similarity: number; diff: string }[]; pairsWithheld: number }> {
    if ((req.minSimilarity !== undefined && (typeof req.minSimilarity !== "number" || (req.minSimilarity as number) < 0 || (req.minSimilarity as number) > 1)) || (req.maxGroups !== undefined && (!Number.isInteger(req.maxGroups) || (req.maxGroups as number) < 1 || (req.maxGroups as number) > 50)) || (req.maxPairs !== undefined && (!Number.isInteger(req.maxPairs) || (req.maxPairs as number) < 1 || (req.maxPairs as number) > 100))) return fail(ctx, { code: "INVALID_SCHEMA", message: "minSimilarity must be 0..1; maxGroups 1..50; maxPairs 1..100", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const access = policyFor(this.store, rev.repoRoot);
    const scan = cloneScan(this.store, rev.id, { minSimilarity: req.minSimilarity as number | undefined, maxGroups: req.maxGroups as number | undefined, maxPairs: req.maxPairs as number | undefined });
    const exactGroups = scan.exactGroups.map((g) => {
      const members = g.members.filter((e) => !access.denied(e.file));
      return { irHash: g.irHash, members: members.map((e) => ({ entityId: e.entityId, name: e.name, file: e.file })), withheld: g.members.length - members.length };
    }).filter((g) => g.members.length > 0);
    const files = new Map(this.store.entitiesById(rev.id, scan.nearPairs.flatMap((p) => [p.a, p.b])).map((e) => [e.entityId, e.file]));
    let pairsWithheld = 0;
    const nearPairs = scan.nearPairs.filter((p) => {
      const shown = !access.denied(files.get(p.a) ?? "?") && !access.denied(files.get(p.b) ?? "?");
      if (!shown) pairsWithheld++;
      return shown;
    });
    return ok(ctx, { revision: rev.id, exactGroups, nearPairs, pairsWithheld }, { revision: rev.id });
  }

  /** IR-first (plan): the anchorless similarity entry — resolve an element by name or id (what the model
   *  naturally has from prose), then the rename-stable structural neighborhood. Same ground as
   *  C11/similarOf with mention resolution built in. */
  similarTo(ctx: CallContext, req: { revision?: string; name?: unknown; topK?: unknown }): ApiResult<{ entityId: string; similar: import("./irfirst.ts").Similar[]; candidates: { id: string; name: string }[] }> {
    if (!req || typeof req.name !== "string" || !req.name.trim() || req.name.length > 300) return fail(ctx, { code: "INVALID_SCHEMA", message: "name must be a non-empty string", retryable: false });
    const topK = req.topK === undefined ? 8 : req.topK;
    if (!Number.isInteger(topK) || (topK as number) < 1 || (topK as number) > 50) return fail(ctx, { code: "INVALID_SCHEMA", message: "topK must be an integer in 1..50", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const access = policyFor(this.store, rev.repoRoot);
    const mention = resolveMentions(this.store, rev.id, req.name as string, access).resolved[0]?.matches[0];
    if (!mention) return ok(ctx, { entityId: "", similar: [], candidates: [] }, { revision: rev.id });
    const anchor = this.store.entitiesById(rev.id, [mention.entityId])[0];
    if (!anchor || access.denied(anchor.file)) return ok(ctx, { entityId: "", similar: [], candidates: [] }, { revision: rev.id });
    const similar = similarOf(this.store, rev.id, anchor.entityId, topK as number).filter((x) => !access.denied(x.file));
    return ok(ctx, { entityId: anchor.entityId, similar, candidates: [] }, { revision: rev.id });
  }

  /** IR-first (plan): a concept card — the concept's live members with each member's rendered IR,
   *  the grounding unit for conversations. Members in revoked files are withheld, not listed. */
  conceptIr(ctx: CallContext, req: { revision?: string; conceptId?: unknown; maxMembers?: unknown }): ApiResult<{ revision: string; conceptId: string; name: string | null; kind: string; renderedCount: number; members: { entityId: string; name: string; file: string; render: string | null; state: "CURRENT" | "WITHHELD" }[] }> {
    if (!req || typeof req.conceptId !== "string" || !req.conceptId || req.conceptId.length > 600) return fail(ctx, { code: "INVALID_SCHEMA", message: "conceptId must be a non-empty string", retryable: false });
    if (req.maxMembers !== undefined && (!Number.isInteger(req.maxMembers) || (req.maxMembers as number) < 1 || (req.maxMembers as number) > 50)) return fail(ctx, { code: "INVALID_SCHEMA", message: "maxMembers must be an integer in 1..50", retryable: false });
    const rev = req.revision ? this.store.revision(req.revision) : this.store.latestRevision();
    if (!rev) return fail(ctx, { code: "NOT_FOUND", message: "no indexed revision", retryable: false });
    const access = policyFor(this.store, rev.repoRoot);
    const view = conceptIrView(this.store, rev.id, req.conceptId, { maxMembers: typeof req.maxMembers === "number" ? req.maxMembers : undefined });
    if (!view) return fail(ctx, { code: "NOT_FOUND", message: "no such concept in this revision (or its members were re-indexed away)", retryable: false });
    const members = view.members.map((m) => access.denied(m.file)
      ? { ...m, file: "(not shown)", render: null, state: "WITHHELD" as const }
      : { ...m, state: "CURRENT" as const });
    return ok(ctx, { revision: rev.id, conceptId: view.conceptId, name: view.name, kind: view.kind, renderedCount: members.filter((m) => m.state === "CURRENT" && m.render).length, members }, { revision: rev.id });
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
  saveWorkspace(ctx: CallContext, req: { workspaceId?: string; name: string; expectedVersion: number; revision?: string; state: SavedState }): ApiResult<{ workspaceId: string; receipt: CommitReceipt; replayed: boolean }> { return this.savedWorkspaces.saveWorkspace(ctx, req); }

  listWorkspaces(ctx: CallContext): ApiResult<{ id: string; name: string; version: number; revision: string | null; updatedAt: string }[]> { return this.savedWorkspaces.listWorkspaces(ctx); }

  /** Resume: saved state plus staleness (evidence whose source changed) and the current state of every saved claim. */
  openWorkspace(ctx: CallContext, req: { workspaceId: string }): ApiResult<{ id: string; name: string; version: number; revision: string | null; state: SavedState; staleEvidence: string[]; staleFiles: string[]; revisionIndexed: boolean; claimStates: Claim[] }> { return this.savedWorkspaces.openWorkspace(ctx, req); }

  /** "What changed since I left": re-index the repository and diff against the saved revision. */
  changesSince(ctx: CallContext, req: { workspaceId: string }): Promise<ApiResult<ChangesSince>> { return this.revisionDiff.changesSince(ctx, req); }

  /** Bounded freshness probe: compares bytes without replacing the indexed graph. */
  probeIndexChanges(ctx: CallContext, req: { revision?: string }): ApiResult<unknown> { return this.revisionDiff.probeIndexChanges(ctx, req); }

  /** "What changed since my last index?": re-index the repository without a saved investigation and summarise the delta. */
  changesSinceIndex(ctx: CallContext, req: { revision?: string }): Promise<ApiResult<ChangesSince>> { return this.revisionDiff.changesSinceIndex(ctx, req); }

  /** Post-MVP (C04.readRevisionPair): an indexed revision id may name any earlier revision. */
  changesBetweenRevisions(ctx: CallContext, req: { fromRevision: string; toRevision?: string }): Promise<ApiResult<ChangesSince>> { return this.revisionDiff.changesBetweenRevisions(ctx, req); }

  /** Diff two stored revisions (C04.readRevisionPair, C23.compare): file deltas, affected elements, commits. */
  changesBetween(ctx: CallContext, rev0id: string, rev1id: string): ApiResult<ChangesSince> { return this.revisionDiff.changesBetween(ctx, rev0id, rev1id); }

  /** System status (post-MVP worker stats): indexed revisions, file/symbol counts, last analyzer run. */
  revisionStats(ctx: CallContext, req: { revision?: string }): ApiResult<{ revision: string | null; files: number; symbols: number; diagnostics: string[] }> { return this.revisionDiff.revisionStats(ctx, req); }

  focusConversation(ctx: CallContext, req: { sessionId: string; revision: string; chartCode?: string; form: string; entityIds?: string[] }): ApiResult<{seq:number}> { return this.answering.focusConversation(ctx, req); }

  conversation(ctx: CallContext, req: { sessionId: string }): ApiResult<{ sessionId: string; turns: { seq: number; role: "user" | "assistant"; text: string; at: string; validation?: AnswerValidationSummary }[] }> { return this.answering.conversation(ctx, req); }

  converse(ctx: CallContext, req: { text: string; sessionId?: string; view?: ViewSpec | null; selection?: string[]; revision?: string; pins?: string[]; history?: { role: "user" | "assistant"; text: string }[] }): Promise<ApiResult<ConverseResult>> { return this.answering.converse(ctx, req); }

}
