// Subset of contracts §2 used by the MVP. Field names match the contract on the wire.
import { z } from "zod";
export * from "./defect.ts";
export * from "./task.ts";
export * from "./twin.ts";

export type Id = string;
export type RevisionId = string;

export type EvidenceClass =
  | "STATIC_PARSED" | "STATIC_RESOLVED" | "RUNTIME" | "TEST" | "HISTORY"
  | "DOCUMENT" | "HUMAN_JUDGMENT" | "INFERRED" | "SPECULATIVE";
export type EvidenceState = "CURRENT" | "STALE" | "UNAVAILABLE" | "ACCESS_REVOKED";
export type ResolutionKind = "PARSED" | "RESOLVED" | "OBSERVED" | "UNRESOLVED" | "STATIC_RESOLVED" | "RUNTIME";
export type DisplayMode = "FACT" | "INFERENCE" | "HYPOTHESIS" | "FOG" | "HIDDEN";

export interface MapOverlayEntity {
  entityId: string; label: string;
  tests: { state: "FAILING" | "MEASURED" | "LINKED" | "UNKNOWN"; coveragePercent: number | null; reachingTests: number; failedTests: number; evidenceIds: string[]; notes: string[] };
  runtime: { spans: number; errors: number; exact: boolean; evidenceIds: string[]; notes: string[] };
}
export interface MapOverlays {
  revision: string; window: { from: number; to: number }; entities: MapOverlayEntity[]; withheld: boolean; gaps: string[];
}

export interface SourceSpan {
  sourceId: Id; contentHash: string; revision: RevisionId; startByte: number; endByteExclusive: number;
}
export interface EvidenceRef {
  id: Id; sourceId: Id;
  location: { kind: "CodeLocation"; span: SourceSpan } | { kind: string; [k: string]: unknown };
  class: EvidenceClass; observedAt: string; accessScopeId: Id; state: EvidenceState;
}
export interface Entity { entityId: Id; kind: string; name: string; file: string; spans: SourceSpan[]; symbolHash?: string }
export interface Relationship {
  id: Id; from: Id; to: Id; kind: string; evidence: EvidenceRef[]; resolution: ResolutionKind; label?: string;
}
export interface Fact {
  id: Id; subject: Id; predicate: string; object: { kind: string; [k: string]: unknown };
  evidence: EvidenceRef[]; resolution: ResolutionKind;
}
export interface Diagnostic { code: string; message: string; relatedEntityIds: Id[]; retryable: boolean }
export interface AnalysisBatch {
  revision: RevisionId; gitHead: string | null; repoRoot: string;
  entities: Entity[]; facts: Fact[]; relationships: Relationship[];
  diagnostics: Diagnostic[]; analyzerVersion: string;
  /** "full": every row. "delta": only the rows of changedFiles (the rest equal baseRevision's). "unchanged": the worktree is baseRevision. Absent: full (older parsers). */
  mode?: "full" | "delta" | "unchanged";
  baseRevision?: RevisionId;
  /** Digest of everything emitted per file (revision id left out); "" holds rows that belong to no file. */
  manifest?: Record<string, string>;
  changedFiles?: string[]; removedFiles?: string[];
}
/** What a caller holds of a revision, so the parser can send back only what differs. */
export interface BaseRevision { revision: RevisionId; analyzerVersion: string; digests: Record<string, string> }

export interface EvidenceBundle {
  id: Id; revision: RevisionId; evidence: EvidenceRef[];
  entities: Entity[]; relationships: Relationship[]; facts: Fact[];
  coverage: string[]; unresolved: string[]; tokenEstimate: number;
}

// ---- Envelope (contracts §1) ----
export type ErrorCode =
  | "UNAUTHORIZED" | "FORBIDDEN" | "STALE_REVISION" | "VERSION_CONFLICT" | "EVIDENCE_MISSING"
  | "EVIDENCE_STALE" | "INVALID_SCHEMA" | "BUDGET_EXCEEDED" | "PROVIDER_UNAVAILABLE" | "CANCELLED"
  | "DEADLINE_EXCEEDED" | "RESOURCE_LIMIT" | "STORAGE_FAILURE" | "INSUFFICIENT_EVIDENCE" | "NOT_FOUND"
  | "NOT_IMPLEMENTED" | "RUNTIME_PROBE_FAILED" | "RUNTIME_PROBE_OUTPUT_INVALID";

export interface ApiError { code: ErrorCode; message: string; retryable: boolean; currentVersion?: number }
export interface ResponseMetadata {
  requestId: Id; revision?: RevisionId; resourceVersion?: number;
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"; warnings: string[];
}
export type ApiResult<T> =
  | { ok: true; value: T; metadata: ResponseMetadata }
  | { ok: false; error: ApiError; metadata: ResponseMetadata };

export interface CallContext {
  requestId: Id; idempotencyKey: Id; actor: { principalId: Id; tenantId: Id; sessionId: Id };
  expectedRevision?: RevisionId; deadlineMs: number; traceId: Id;
}

// ---- Claims (§3, five gates; MVP implements GROUNDING + DISPLAY) ----
export type ClaimState = "DRAFTED" | "EVIDENCED" | "DISPLAYED" | "CONFIRMED" | "REFUTED" | "RETIRED" | "STALE";
export type GateStatus = "PASS" | "FAIL" | "INSUFFICIENT" | "NOT_APPLICABLE";
export interface GateOutcome { gate: "GROUNDING" | "CONSISTENCY" | "ADVERSARIAL" | "CALIBRATION" | "DISPLAY"; status: GateStatus; reasons: string[]; evidenceIds: Id[] }
export interface ClaimDraft {
  id: Id; revision: RevisionId; assertion: string; claimClass: string;
  evidenceIds: Id[]; counterEvidenceIds: Id[]; rationaleSummary: string; modelRun?: ModelRunRef;
  /** Checkable structure for the CONSISTENCY gate: an ordered chain of entity ids joined by edges. */
  structure?: { kind: "path"; entityIds: Id[] };
  /** Entities the claim is about, when it has no path: lets the counter-argument gate look for fog, gaps and failing tests around them. */
  subjects?: Id[];
  /** Claims this one was derived from; a refuted dependency makes this one STALE. */
  dependencyIds?: Id[];
}
export type VerdictKind = "CONFIRM" | "REFUTE" | "DISPUTE";
export interface Verdict { id: Id; actorId: Id; claimId: Id; verdict: VerdictKind; explanation: string; timestamp: string; evidenceIds: Id[] }
export interface Confidence {
  mode: "NOT_ESTIMATED" | "UNCALIBRATED" | "CALIBRATED";
  band?: { lower: number; upper: number; sampleCount: number; confidenceLevel: number };
  reasonCodes: string[];
}
export interface Claim {
  draft: ClaimDraft; version: number; state: ClaimState; gates: GateOutcome[]; displayMode: DisplayMode;
  confidence: Confidence; verdicts: Verdict[]; counterArgument: string;
}
export interface ModelRunRef { runId: Id; provider: string; model: string; promptTemplateVersion: string }

// ---- Views (§2, §6) ----
export type SalienceFactor = "TASK_MATCH" | "RECENCY" | "STRUCTURAL_CENTRALITY" | "RUNTIME_HOTNESS" | "USER_OVERRIDE" | "SEMANTIC_JUDGMENT";
export interface FactorScore { factor: SalienceFactor; rawValue: number; normalizedScore: number; reason: string; evidenceIds: Id[] }
export type HypothesisState = "OPEN" | "SUPPORTED" | "REFUTED" | "UNRESOLVED";
export interface ViewNode {
  id: Id; entityRefs: Id[]; label: string; kind: string; file: string; claimIds: Id[]; evidenceIds: Id[];
  tier: "CRITICAL" | "RELEVANT" | "CONTEXT" | "HIDDEN"; displayMode: DisplayMode; unresolvedCalls: number;
  /** Form-specific role, e.g. "failure-site", "entry", "writer", "symptom", "suspect". */
  role?: string; rank?: number; score?: number; factors?: FactorScore[]; hypothesisState?: HypothesisState; notes?: string[];
  /** Column for layered forms (cause → effect). */
  layer?: number;
  /** Explicit position for forms with their own layout (swim lanes, timelines, two-axis maps). */
  pos?: { x: number; y: number };
  lane?: string;
  /** A measured or composed value 0..1 that tints the node, with the words that explain it. */
  heat?: { value: number; label: string };
  /** Hypothetical structure (counterfactuals): drawn ghost-outlined, never as fact. */
  ghost?: boolean;
  /** A short badge, e.g. a boundary or an owner. */
  badge?: string;
  /** The claim this node itself stands for; a refuted claim removes the node. */
  ownClaimId?: Id;
}
export interface ViewEdge {
  ghost?: boolean; /** A path that returns (compensation, refund, retry) is drawn as a return lane. */ style?: "return";
  id: Id; fromNodeId: Id; toNodeId: Id; kind: string; relationshipId?: Id; claimId?: Id;
  evidenceIds: Id[]; displayMode: DisplayMode; label?: string;
}
export interface ViewGroup { id: Id; label: string; parentGroupId?: Id; kind: "file" | "concept" | "cluster" | "lane" | "region"; childNodeIds: Id[]; level: number; evidenceIds: Id[]; displayMode: DisplayMode }
export type FormId =
  | "SemanticMap" | "CausalGraph" | "HypothesisGraph"
  | "TransactionJourney" | "DataLineage" | "SemanticDiff" | "Archaeology" | "TrustBoundary" | "RuntimeOverlay"
  | "RaceWindow" | "Counterfactual" | "TestConfidence" | "Ownership" | "ConceptAtlas" | "PolicyMap" | "ChangeRisk"
  | "TraceLinkedProfile" | "RouteMap" | "GeneratedChart";
export interface TerrainCell {
  id: Id; label: string; file: string; factors: Record<string, number>; raw: Record<string, string>; evidenceIds: Id[]; area: number; entityIds: Id[]; note?: string;
}
export interface MatrixAxis {
  id: Id; label: string; sub?: string; role?: string;
  entityRefs: Id[]; evidenceIds: Id[]; claimId?: Id;
  /** 0 (cool) to 1 (hot) with a plain-words label, for rows that carry a risk. */
  heat?: { value: number; label: string };
}
/** One filled cell: absence of a cell means "no relation", which is itself shown as such. */
export interface MatrixCell {
  row: Id; col: Id;
  /** A form-specific state, spelled out in `ViewMatrix.states`; the UI never relies on colour alone. */
  state: string;
  /** 0..1 strength where the state has one (share of a behaviour's code a test reaches). */
  strength?: number;
  displayMode: DisplayMode;
  claimId?: Id; evidenceIds: Id[];
  /** One sentence saying what this cell asserts. */
  note: string;
}
export interface ViewMatrix {
  rowTitle: string; colTitle: string;
  rows: MatrixAxis[]; cols: MatrixAxis[]; cells: MatrixCell[];
  states: Record<string, { label: string; glyph: string; description: string }>;
  /** What an empty cell means in this form. */
  emptyMeaning: string;
}

// ---- Jobs (C07): long work that runs in the background and can be cancelled ----
// "pr-analysis": F02 — a pull request's base and head are indexed, compared, analysed and gated in one background job.
export type JobKind = "index" | "concepts" | "investigate" | "defect-detect" | "defect-experiment" | "pr-analysis" | "search-index" | "dependency-scan" | "history-analysis" | "campaign-advance" | "campaign-joint-check" | "feature-build" | "feature-validate" | "feature-apply" | "runtime-introspect";
export type JobState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export interface JobView {
  id: Id; kind: JobKind; state: JobState;
  /** Asked to stop, not stopped yet (the runner is at a point where it can). */
  cancelRequested: boolean;
  /** Past the commit point: a cancel is refused, because stopping now would leave half a result. */
  committing: boolean;
  phase: string; message: string; done?: number; total?: number;
  params: { repoPath?: string; revision?: string; investigationId?: string; defectRequestHash?: string; specId?: string; prNumber?: number; policyId?: string; headHash?: string; headRef?: string; baseRef?: string; decisionId?: string; analysisId?: string; forge?: string; inventoryId?: string; snapshotId?: string; reportId?: string; findingId?: string; feedSource?: string; runId?: string; repositoryId?: string; campaignId?: string; batchId?: string; caseId?: string };
  createdAt: string; startedAt?: string; finishedAt?: string;
  /** F01 scheduling classes: INTERACTIVE (100) > LIVE (10) > BACKFILL (0). Higher runs first. */
  priority?: number;
  /** What the same call would have returned when run directly (value and warnings), once SUCCEEDED. */
  result?: { value: unknown; warnings: string[] };
  error?: ApiError;
}

export interface ViewRoute {
  source: "rule" | "similarity" | "model" | "default" | "chosen";
  confidence: "high" | "medium" | "low";
  form: FormId; kind?: "failure" | "invariant"; name: string; because: string;
  alternatives: { form: FormId; kind?: "failure" | "invariant"; name: string }[];
}
export interface ViewSpec {
  id: Id; version: number; revision: RevisionId; taskId: Id; formId: FormId; caption: string;
  /** Prose that answers the question in words (maps only); the map and caption stay the visual part. */
  answer?: string;
  question: string; level: number; nodes: ViewNode[]; edges: ViewEdge[]; groups: ViewGroup[];
  legend: { label: string; displayMode: DisplayMode; description: string }[];
  cameraPolicy: { behavior: "PRESERVE" }; gaps: string[];
  /** Why this form was chosen for the question (shown to the user). */
  formReason?: string;
  /** How the question was read: by which layer, how sure, and the other readings (shown as "I read this as…"). */
  route?: ViewRoute;
  /** Items deliberately left out and why, for "why is this hidden?". */
  hidden?: { entityId: Id; label: string; reason: string }[];
  /** Pruned by the user ("ignore X"); kept so the view can explain and restore. */
  ignored?: Id[];
  /** "What this means" rows beside a view (semantic diff, counterfactual): each with its own evidence and claim. */
  consequences?: { id: Id; text: string; kind: string; displayMode: DisplayMode; claimId?: Id; evidenceIds: Id[]; entityIds?: Id[] }[];
  /** Change-risk terrain: a composite of grounded factors per region; weights are tunable in the UI. */
  terrain?: { cells: TerrainCell[]; factors: { id: string; label: string; description: string; weight: number }[]; formula: string };
  /** A many-to-many relation drawn as a grid (V12, V15). Cells are built beside the graph and obey the same provenance rules. */
  matrix?: ViewMatrix;
  /** Parameters that produced this view, shown to the user and used to refresh it. */
  params?: Record<string, string | number | boolean>;
  /** Whole-system summary for level 0: the system itself and the external packages it depends on. */
  system?: { name: string; files: number; symbols: number; externals: { name: string; files: number; evidenceIds: Id[] }[] };
  /** Inputs needed to rebuild an investigation after steering ("ignore X"). */
  investigation?: { trace: string; ignored: Id[] };
  meta?: { kind?: string; field?: string; subject?: string };
}

// ---- Model I/O schemas (registry IDs; contracts §1: SchemaValue carries a registered schema ID) ----
export const SCHEMA_REPRESENTATION = "representation.v1";
export const SCHEMA_EXPLANATION = "explanation.v1";
export const SCHEMA_CONCEPTS = "concepts.v1";
export const SCHEMA_CHALLENGE = "challenge.v1";
export const SCHEMA_ROUTE = "route.v1";
export const SCHEMA_HYPOTHESES = "hypotheses.v1";
export const SCHEMA_CHART = "chart.v1";

export const RepresentationOutput = z.object({
  caption: z.string().max(400),
  /** A short prose answer to the question itself, shown above the map. Optional: without it, the answer is assembled from the groups. */
  answer: z.string().max(1500).optional(),
  groups: z.array(z.object({
    label: z.string().max(80), memberEntityIds: z.array(z.string()).max(200),
    rationale: z.string().max(400), evidenceIds: z.array(z.string()).max(50),
    /** Optional higher-level domain this group belongs to; groups sharing a label form one intermediate abstraction. */
    cluster: z.string().max(80).optional(),
  })).max(30),
  inferredEdges: z.array(z.object({
    from: z.string(), to: z.string(), rationale: z.string().max(400), evidenceIds: z.array(z.string()).max(50),
    /** Intermediate entities, in order, between `from` and `to`; lets the consistency gate re-verify the chain. */
    viaEntityIds: z.array(z.string()).max(10).optional(),
  })).max(100),
}).strict();
export type RepresentationOutput = z.infer<typeof RepresentationOutput>;

// C22 seeding: bounded competing candidate explanations with checkable predictions. The tools in `tool` are the
// registered read tools of C22's broker; payloads are flat string/number/boolean records — never anything executed.
export const HypothesesOutput = z.object({
  hypotheses: z.array(z.object({
    statement: z.string().min(8).max(300),
    mechanism: z.array(z.object({
      from: z.string().max(120), to: z.string().max(120),
      relation: z.enum(["CALLS", "WAITS_FOR", "PRECEDES", "CONTRIBUTES_TO", "CAUSES_CANDIDATE"]),
      evidenceIds: z.array(z.string()).max(10),
    })).max(4),
    assumptions: z.array(z.string().max(200)).max(4),
    predictions: z.array(z.object({
      description: z.string().min(4).max(200),
      tool: z.enum(["graph.dependents", "graph.paths", "source.entity", "retrieve.evidence", "runtime.window"]),
      payload: z.record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()])),
      outcomeIfTrue: z.array(z.enum(["PRESENT", "ABSENT_WITH_COVERAGE", "MATCH", "MISMATCH"])).max(3),
      outcomeIfFalse: z.array(z.enum(["PRESENT", "ABSENT_WITH_COVERAGE", "MATCH", "MISMATCH"])).max(3),
      essential: z.boolean(),
    })).max(6),
    basisEvidenceIds: z.array(z.string()).max(10),
  })).min(1).max(8),
}).strict();
export type HypothesesOutput = z.infer<typeof HypothesesOutput>;

/** A bounded, evidence-referenced chart plan. It is compiled into the normal ViewSpec graph; never executable source. */
export const ChartOutput = z.object({
  chartType: z.string().min(1).max(60),
  layout: z.enum(["flow", "lanes", "hierarchy", "timeline", "network"]),
  caption: z.string().max(400),
  nodes: z.array(z.object({
    entityId: z.string().max(300), evidenceIds: z.array(z.string()).max(20),
    shape: z.enum(["process", "decision", "event", "state", "external"]),
    lane: z.string().max(80).optional(), column: z.number().int().min(0).max(20), row: z.number().int().min(0).max(40),
  }).strict()).max(40),
  edges: z.array(z.object({
    from: z.string().max(300), to: z.string().max(300), relationshipId: z.string().max(300),
    label: z.string().max(100).optional(), evidenceIds: z.array(z.string()).max(20),
  }).strict()).max(80),
}).strict();
export type ChartOutput = z.infer<typeof ChartOutput>;

export const ExplanationOutput = z.object({
  summary: z.string().max(1000),
  claims: z.array(z.object({
    assertion: z.string().max(500), claimClass: z.string().max(40),
    evidenceIds: z.array(z.string()).max(50), counterEvidenceIds: z.array(z.string()).max(50).default([]),
    rationaleSummary: z.string().max(500),
    /** Ordered entity ids of the chain this claim asserts (optional, checked by the consistency gate). */
    pathEntityIds: z.array(z.string()).max(12).optional(),
  })).max(20),
}).strict();
export type ExplanationOutput = z.infer<typeof ExplanationOutput>;

export const CARD_KINDS = ["capability", "domain-concept", "invariant", "workflow", "failure-mode"] as const;
export const ConceptsOutput = z.object({
  cards: z.array(z.object({
    kind: z.enum(CARD_KINDS), title: z.string().max(100), summary: z.string().max(500),
    memberEntityIds: z.array(z.string()).max(60), evidenceIds: z.array(z.string()).max(60),
    statedConfidence: z.enum(["low", "medium", "high"]),
  })).max(40),
}).strict();
export type ConceptsOutput = z.infer<typeof ConceptsOutput>;

export const ChallengeOutput = z.object({
  objections: z.array(z.object({ text: z.string().max(500), evidenceIds: z.array(z.string()).max(30) })).max(8),
}).strict();
export type ChallengeOutput = z.infer<typeof ChallengeOutput>;

/** Which visual a question wants. The model picks a form only; it cannot cite evidence or change what the form shows. */
export const ROUTE_FORMS = ["SemanticMap", "CausalGraph", "TransactionJourney", "DataLineage", "SemanticDiff", "Archaeology", "TrustBoundary", "RuntimeOverlay", "RaceWindow", "Counterfactual", "TestConfidence", "Ownership", "ConceptAtlas", "PolicyMap", "ChangeRisk", "GeneratedChart"] as const;
export const RouteOutput = z.object({
  form: z.enum(ROUTE_FORMS).nullable(),
  /** Set when form is CausalGraph. */
  kind: z.enum(["failure", "invariant"]).nullable().optional(),
  /** The model's own judgment, uncalibrated; shown as such. */
  confidence: z.number().min(0).max(1),
  reason: z.string().max(300),
}).strict();
export type RouteOutput = z.infer<typeof RouteOutput>;

export const OUTPUT_SCHEMAS = {
  [SCHEMA_REPRESENTATION]: RepresentationOutput,
  [SCHEMA_EXPLANATION]: ExplanationOutput,
  [SCHEMA_CONCEPTS]: ConceptsOutput,
  [SCHEMA_CHALLENGE]: ChallengeOutput,
  [SCHEMA_ROUTE]: RouteOutput,
  [SCHEMA_HYPOTHESES]: HypothesesOutput,
  [SCHEMA_CHART]: ChartOutput,
} as const;

// ---- Model gateway interface ----
export interface ModelRequest {
  purpose: "REPRESENT" | "EXPLAIN" | "EXTRACT" | "CHALLENGE" | "ROUTE" | "HYPOTHESIZE" | "CHART"; schemaId: keyof typeof OUTPUT_SCHEMAS;
  question: string; bundle: EvidenceBundle; selected?: Id[];
  /** For a bounded model task such as generating a chart plan. */
  instructions?: string;
  /** For CHALLENGE: the claim being attacked. */
  claim?: { assertion: string; evidenceIds: Id[] };
}
export interface ModelProvider {
  readonly name: string; readonly model: string;
  /** True when requests leave this machine (hosted model); gates egress approval. */
  readonly hosted: boolean;
  /** Returns raw JSON; the gateway validates it against `schemaId`. Must only cite evidence in `bundle`. */
  generate(req: ModelRequest): Promise<unknown>;
}

// ---- API payloads shared by core and web ----
export interface ResolvedEvidence {
  id: Id; class: EvidenceClass; file: string; /** Absolute path on this machine, for "open in editor" links. */ absPath?: string; startByte: number; endByte: number;
  startLine: number; endLine: number; snippet: string; state: EvidenceState;
}
export interface ConceptCard {
  id: Id; revision: RevisionId; kind: (typeof CARD_KINDS)[number]; title: string; summary: string;
  members: Id[]; evidenceIds: Id[]; claimId: Id; statedConfidence: "low" | "medium" | "high"; source: string;
}
export interface ExplainResult { summary: string; claims: Claim[]; evidence: ResolvedEvidence[]; selected: Id[] }
export interface SavedState {
  question: string; view: ViewSpec | null; claims: Claim[]; selection: Id[]; explanation: ExplainResult | null;
  events: { kind: string; at: string; detail?: string }[];
  messages?: { role: "user" | "assistant"; text: string; at: string }[];
}
export interface RevisionInfo { id: Id; repoRoot: string; gitHead: string | null; createdAt: string; analyzerVersion: string; fileCount: number; diagnostics: Diagnostic[] }
export interface RepositoryGitInfo {
  remotes: string[];
  remoteBranches: { ref: string; remote: string; branch: string; localBranch: string | null }[];
  repoRoot: string; isGitRepo: boolean; branch: string | null; head: string | null;
  dirty: boolean; branches: string[]; origin: string | null;
  github: { repository: string; credentialsAvailable: boolean } | null;
}
export interface WorkspaceOpen {
  id: Id; name: string; version: number; revision: Id | null; state: SavedState;
  staleEvidence: Id[]; staleFiles: string[]; revisionIndexed: boolean; claimStates?: Claim[];
}

export interface DirEntry { name: string; path: string; isGitRepo: boolean }
export interface DirListing { path: string; parent: string | null; entries: DirEntry[]; truncated: boolean }

export interface ChangesSince {
  fromRevision: RevisionId; toRevision: RevisionId; changed: boolean;
  files: { added: string[]; removed: string[]; changed: string[] };
  affectedNodes: { nodeId: Id; label: string; change: "added" | "changed" | "removed" }[];
  commits: { file: string; subject: string; author: string; date: string }[];
  summary: string;
}
export interface ChatAnalysisResult {
  tool: "overview" | "view" | "risk" | "tests" | "ask";
  title: string;
  status: "complete" | "failed" | "skipped";
  message: string;
  /** This step's pre-answer text (the raw facts it assembled), kept as a trace once `message` carries the composed answer. */
  thinking?: string;
  subject?: string;
  view?: ViewSpec;
  claims: Claim[];
}
export type ConverseResult =
  // `thinking`: the old-style, pre-answer text (why this form, the caption) — kept for the trace, not meant as the reply.
  // `message` is the composed answer; with no grounded answer available, `message` falls back to that same text and
  // `thinking` is omitted rather than duplicated.
  | { kind: "analysis"; results: ChatAnalysisResult[]; message: string; thinking?: string }
  | { kind: "view"; view: ViewSpec; claims: Claim[]; message: string; thinking?: string }
  | { kind: "explanation"; explanation: ExplainResult; message: string }
  | { kind: "resume"; workspaceId: Id; message: string }
  | { kind: "zoom"; direction: "in" | "out" | "overview"; message: string }
  | { kind: "message"; message: string };
export interface TestSummaryInfo {
  found: string[]; coverageFiles: number; coverageLinePercent: number | null;
  tests: { passed: number; failed: number; skipped: number }; failing: { name: string; file?: string; message?: string }[]; generatedAt: string; staleness: string[];
}
export interface StatusInfo { revision: RevisionInfo | null; provider: string; /** Bare model name, or null when running the offline stub; what the model menu shows and switches. */ model: string | null; hosted: boolean; allowHosted: boolean; concepts: number; tests: TestSummaryInfo | null }
export interface WorkspaceOpen2 extends WorkspaceOpen { claimStates: Claim[] }
export interface AuditEvent { seq: number; actor: string; action: string; resource: string; ts: string; meta: string }

export type EditorEventKind = "OPEN_FILE" | "SELECTION" | "DIFF" | "BREAKPOINT";
export interface EditorEvent { sessionId: Id; sequence: number; kind: EditorEventKind; file: string; startLine?: number; endLine?: number }
export interface EditorContext {
  events: { seq: number; kind: EditorEventKind; file: string; entities: Id[]; lineStart: number | null; lineEnd: number | null; ts: string }[];
  /** Entities under the editor's current selection or caret, newest first; offered as referents. */
  focus: { entityId: Id; label: string }[];
}

export interface ConceptStore {
  version: number;
  versions: { version: number; revision: RevisionId; createdAt: string; provider: string; cards: number }[];
  cards: ConceptCard[];
  claims: Record<Id, Claim>;
  diff: { against: number; added: string[]; removed: string[]; changed: string[] } | null;
  statedConfidence: { level: "high" | "medium" | "low"; cards: number; confirmed: number; refuted: number; unjudged: number; band: { lower: number; upper: number; n: number } | null; note: string }[];
}

// ---------------------------------------------------------------- F01: cross-repository search and precise navigation
// Additive types over the existing envelope (contracts §1). Byte spans stay canonical (SourceSpan); a display {line, column}
// is derived at query time. The resolution enum is NOT extended: a resolution `basis` is added instead, and the user-facing
// tier is computed from it so a better future resolver upgrades results without a schema change.
export type SearchTier = "PRECISE" | "RESOLVED" | "HEURISTIC" | "UNRESOLVED";
export type SearchMatchKind = "SYMBOL_EXACT" | "SYMBOL_QUALIFIED" | "TEXT_LITERAL" | "TEXT_REGEX" | "STRING_OR_DOC";
export type SearchIndexState = "NONE" | "PARTIAL" | "COMPLETE";
export type SemanticIndexTier = "NONE" | "SYNTAX" | "COMPILER";
/** Which repository a search scope covers, or which revision of it. */
export type RepositorySelector =
  | { kind: "ALL_VISIBLE" }
  | { kind: "IDS"; repositoryIds: string[] }
  | { kind: "DEPENDENTS_OF"; repositoryId: string; transitive?: boolean };
export type RevisionSelector =
  | { kind: "DEFAULT_BRANCH_HEAD" }
  | { kind: "COMMIT"; repositoryId: string; commitHash: string }
  | { kind: "REVISION"; revisionId: string };
export interface SearchFilters {
  languages?: string[]; pathGlobs?: string[]; excludePathGlobs?: string[];
  symbolKinds?: string[]; includeTests?: boolean; includeGenerated?: boolean;
}
/** A repository revision as seen by F01, derived from a stored revision + the build state of its search index. */
export interface SnapshotRef {
  repositoryId: string; revision: string; commitHash: string | null; contentRootHash: string;
  indexGeneration: number; analyzerVersion: string;
  textState: SearchIndexState; symbolState: SearchIndexState; semanticTier: SemanticIndexTier;
  filesTotal: number; filesIndexed: number;
}
export interface SearchHit {
  hitId: string;
  repositoryId: string; repositoryName: string; revision: string; path: string;
  span: SourceSpan;
  display: { line: number; column: number; endLine: number; endColumn: number; snippet: string[]; snippetStartLine: number };
  matchKinds: SearchMatchKind[]; tier: SearchTier;
  /** Set when the hit is a symbol (definition or reference); the identity is the symbol id used across the product. */
  symbol?: { symbolId: string; name: string; kind: string };
  inString: boolean;
  /** Why this hit is here, in words, highest-scoring reason first. */
  rationale: string[];
  evidenceIds: string[];
  /** Set on cross-repository hits: the package through which the consuming repository reaches the symbol. */
  viaPackage?: string;
  viaRepositoryId?: string;
}
export interface UnresolvedPackageEdge {
  package: string; ecosystem: string;
  reason: "PROVIDER_NOT_INDEXED" | "PROVIDER_NOT_VISIBLE_COUNTED_NOT_NAMED" | "VERSION_MISMATCH" | "AMBIGUOUS";
  detail: string;
}
export interface SkippedCounts { generated: number; binary: number; too_large: number; unsupported_language: number; denied: number }
export interface CoverageByRepository {
  repositoryId: string; repositoryName: string; revision: string; indexGeneration: number;
  textState: SearchIndexState; symbolState: SearchIndexState;
  semanticTierByLanguage: Record<string, SemanticIndexTier>;
  files: { total: number; indexed: number; skipped: SkippedCounts };
  unresolvedPackageEdges: UnresolvedPackageEdge[];
  stoppedBy: "NONE" | "LIMIT" | "BUDGET" | "DEADLINE";
}
export interface SearchDiagnostics { totals: { shown: number; matched: number | ["AT_LEAST", number] }; queryDiagnostics: Diagnostic[] }
export interface SearchResponse {
  mode: Exclude<SearchModes, undefined> | "AUTO";
  hits: SearchHit[]; nextCursor?: string;
  coverageByRepository: CoverageByRepository[];
  notIndexed: { repositoryId: string; repositoryName: string; reason: string }[];
  totals: { shown: number; matched: number | null; matchedAtLeast: number | null };
  queryDiagnostics: Diagnostic[];
  /** AUTO only: code names the query was read as — named inside a sentence ("exact") or spelt close to one ("fuzzy").
   * Listed only when the name produced a hit the caller may see, so a reading never reveals a hidden symbol. */
  readAs?: { text: string; name: string; how: "exact" | "fuzzy" }[];
}
export type SearchModes = "LITERAL" | "REGEX" | "SYMBOL";
export interface DefinitionLocation {
  repositoryId: string; repositoryName: string; revision: string;
  symbolId: string; name: string; qualified: string; kind: string;
  path: string; span: SourceSpan;
  display: { line: number; column: number; snippet: string };
  tier: SearchTier; basis: string;
}
export interface ReferenceHit extends Omit<SearchHit, "symbol"> {
  symbol: { symbolId: string; name: string; kind: string };
  refKind: string; basis: string;
  /** When the binding is ambiguous, every candidate is listed — never a silent pick. */
  candidates?: { symbolId: string; name: string; path: string }[];
}
export interface ReferencesResponse {
  references: ReferenceHit[]; nextCursor?: string;
  groups: { repositoryId: string; repositoryName: string; revision: string; viaPackage?: string; count: number }[];
  coverageByRepository: CoverageByRepository[];
  unresolvedCallSites: { repositoryId: string; count: number; sampleHitIds: string[] }[];
  reExportTruncated?: boolean;
  gaps: string[];
}
export interface RepositoryView {
  repositoryId: string; displayName: string; root: string | null; remoteUrl: string | null;
  state: "ACTIVE" | "REVOKED" | "UNREACHABLE";
  /** The latest indexed revision, if any. */
  revision?: { id: string; gitHead: string | null; textState: SearchIndexState; symbolState: SearchIndexState; indexedAt: string; files: { total: number; indexed: number } };
  /** With includeCoverage: the number of this repository's package dependencies that could not be bound (reasons via C10/search coverage). */
  unresolvedPackageEdges?: number;
  visibleToCaller: boolean;
}
export interface RepositoryIndexStatus extends SnapshotRef { repositoryId: string; skipped: SkippedCounts; indexedAt: string }

// ---- Defect analysis (defect.v1, report-only Phase A) ----
export type DefectKind = "DEADLOCK_CANDIDATE" | "MEMORY_RACE" | "LOGICAL_RACE" | "STARVATION"
  | "CONTENTION" | "CPU_HOTSPOT" | "ALLOCATION_HOTSPOT" | "IO_BOTTLENECK"
  | "QUEUE_SATURATION" | "LOOP_OPTIMIZATION" | "REPEATED_EXTERNAL_CALL" | "RESOURCE_LEAK";
export type Severity = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type EvidenceLevel = "STATIC_CANDIDATE" | "DETECTOR_REPORT" | "REPRODUCED" | "MEASURED" | "BOUNDED_EXHAUSTIVE";
export type ObligationState = "PENDING" | "EVIDENCED" | "FAILED" | "UNRESOLVED";
export interface SafetyObligation { id: Id; description: string; predicateSchemaId: Id; state: ObligationState; evidenceIds: Id[] }
export interface DetectorFinding {
  id: Id; version: number; kind: DefectKind; revision: RevisionId; entityIds: Id[]; spans: SourceSpan[];
  ruleId: Id; ruleVersion: number; evidenceIds: Id[]; coverageGaps: string[]; severity: Severity;
  evidenceLevel: EvidenceLevel; safetyObligations: SafetyObligation[]; hypothesisPlanId?: Id;
  /** A bounded, reviewable witness. It never upgrades the evidence level by itself. */
  witness?: { kind: string; paths: Id[][]; detail: string };
}
export interface MemoryAccessFact {
  id: Id; entityId: Id; accessPath: string; mode: "READ" | "WRITE"; atomic: boolean;
  contextId: Id; concurrentWith: Id[]; happensBefore: Id[]; evidenceIds: Id[]; span?: SourceSpan;
  aliasState?: "RESOLVED" | "MAY_ALIAS" | "UNKNOWN";
}
export interface LockOrderFact {
  id: Id; entityId: Id; heldLockId: Id; acquiredLockId: Id; acquireKind: "BLOCKING" | "TRY" | "REENTRANT";
  pathCondition?: string; globalGuardId?: Id; evidenceIds: Id[]; span?: SourceSpan;
  resolution: ResolutionKind;
}
export interface DefectDetectionInput {
  revision: RevisionId; lockOrders?: LockOrderFact[]; memoryAccesses?: MemoryAccessFact[];
  /** Bounds work and makes truncation visible instead of silently dropping candidates. */
  budget?: { maxFacts?: number; maxFindings?: number };
}
export type ComparisonVerdict = "IMPROVED" | "REGRESSED" | "NO_MATERIAL_CHANGE" | "INCONCLUSIVE";
export interface BenchmarkPolicy { minimumImprovement: number; maximumRegression: number; minimumSamples: number }
export interface BenchmarkResult { effectEstimate: number | null; verdict: ComparisonVerdict; limitations: string[] }

// ---------------------------------------------------------------- C24 causality v2 (phase-0 contract closure; C24_Runtime_Causality_Detailed_Design.md §11)
// Frozen wire contract for the proposed causality extension. Every DTO and enum below is taken from design §11 verbatim;
// changes to any of these require a new registered schema version, not a silent edit (§20 freeze list).
export type EventKind = "OP_START" | "OP_END" | "SEND" | "RECEIVE" | "ENQUEUE" | "DEQUEUE"
  | "SPAWN" | "JOIN" | "TASK_RESUME" | "TASK_SUSPEND" | "TASK_COMPLETE"
  | "LOCK_ACQUIRE" | "LOCK_RELEASE" | "LOCK_WAIT" | "READ_VERSION" | "WRITE_VERSION" | "TX_COMMIT" | "EXCEPTION" | "DEADLINE" | "CANCEL_REQUEST" | "SAMPLE" | "DEPLOYMENT_MARKER";
export type EdgeKind = "PROGRAM_ORDER" | "SPAWN" | "SEND_RECEIVE" | "COMPLETE_JOIN" | "RELEASE_ACQUIRE" | "READS_FROM"
  | "REQUEST_RESPONSE" | "CONTEXT_ASSOCIATION" | "WAITS_FOR" | "CORRELATES_WITH" | "CAUSE_CANDIDATE" | "INTERVENTION_SUPPORTS";
export type GraphLayer = "EXECUTION_ORDER" | "CONTEXT" | "WAIT" | "ASSOCIATION" | "EXPLANATION";
export type EdgeState = "ACCEPTED" | "CANDIDATE" | "QUARANTINED" | "INVALIDATED";
export type TimeQuality = "BOUNDED" | "LOCAL_MONOTONIC_ONLY" | "UNKNOWN" | "CONTRADICTORY";
export type SourceTrust = "AUTHENTICATED_ADAPTER" | "IMPORTED_UNVERIFIED" | "UNTRUSTED_CONTEXT";
export type SamplingState = "NONE" | "HEAD" | "TAIL" | "MIXED" | "UNKNOWN";
export type GapKind = "MISSING_EVENT" | "SAMPLED_REGION" | "UNATTRIBUTED_CODE" | "CLOCK_UNKNOWN" | "ACCESS_RESTRICTED" | "ADAPTER_UNSUPPORTED" | "RETENTION_EXPIRED";
export type CertificateState = "ACTIVE" | "INVALIDATED" | "REJECTED";
export type GraphConsistency = "CONSISTENT" | "PARTIAL" | "CONTRADICTORY";
export type OrderRelation = "HAPPENS_BEFORE" | "HAPPENS_AFTER" | "CONCURRENT_CERTIFIED" | "UNKNOWN";
export type MechanismKind = "LOCK_WAIT" | "POOL_WAIT" | "DOWNSTREAM_WAIT" | "QUEUE_DELAY" | "DATA_DEPENDENCY" | "RETRY_AMPLIFICATION" | "SCHEDULER_DELAY" | "UNKNOWN";
export type SegmentKind = "EXECUTING" | "WAITING" | "RUNNABLE" | "DOWNSTREAM" | "UNEXPLAINED";
export type CausalClaimLevel = "EXECUTION_RELATION" | "MECHANISM_CANDIDATE" | "MECHANISM_SUPPORTED" | "INTERVENTION_SUPPORTED";
export type ClaimFreshness = "CURRENT" | "STALE" | "RESTRICTED";

const c24Id = z.string().min(1).max(200);
const c24Hash = z.string().min(8).max(128);
/** Registered bounded attribute values: a schema id pins the shape; values stay small. */
const RegisteredAttributesZ = z.strictObject({ schemaId: c24Id, version: z.number().int().nonnegative(), values: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean(), z.null()])).refine((v) => Object.keys(v).length <= 32, "at most 32 attribute keys") });
export const RegisteredAttributesSchema = RegisteredAttributesZ;

export const EventKindZ = z.enum(["OP_START", "OP_END", "SEND", "RECEIVE", "ENQUEUE", "DEQUEUE", "SPAWN", "JOIN", "TASK_RESUME", "TASK_SUSPEND", "TASK_COMPLETE", "LOCK_ACQUIRE", "LOCK_RELEASE", "LOCK_WAIT", "READ_VERSION", "WRITE_VERSION", "TX_COMMIT", "EXCEPTION", "DEADLINE", "CANCEL_REQUEST", "SAMPLE", "DEPLOYMENT_MARKER"] as const satisfies [EventKind, ...EventKind[]]);
export const EdgeKindZ = z.enum(["PROGRAM_ORDER", "SPAWN", "SEND_RECEIVE", "COMPLETE_JOIN", "RELEASE_ACQUIRE", "READS_FROM", "REQUEST_RESPONSE", "CONTEXT_ASSOCIATION", "WAITS_FOR", "CORRELATES_WITH", "CAUSE_CANDIDATE", "INTERVENTION_SUPPORTS"] as const satisfies [EdgeKind, ...EdgeKind[]]);
export const GraphLayerZ = z.enum(["EXECUTION_ORDER", "CONTEXT", "WAIT", "ASSOCIATION", "EXPLANATION"] as const satisfies [GraphLayer, ...GraphLayer[]]);

export const RuntimeEventSchema = z.strictObject({
  id: c24Id, version: z.number().int().nonnegative(), tenantId: c24Id, sourceId: c24Id, sourceEpoch: c24Id,
  sourceSequence: z.string().max(120).nullable(), processEpoch: c24Id.nullable(),
  taskId: c24Id.nullable(), threadId: c24Id.nullable(), operationId: c24Id.nullable(),
  attemptId: c24Id.nullable(), traceId: c24Id.nullable(), spanId: c24Id.nullable(),
  kind: EventKindZ, time: z.strictObject({
    observedWallTime: z.number().nullable(), earliestWallTime: z.number().nullable(), latestWallTime: z.number().nullable(),
    clockDomainId: c24Id, clockEpoch: c24Id, monotonicTicks: z.string().max(80).nullable(), tickUnit: z.string().max(24).nullable(),
    logicalClock: z.strictObject({ schemaId: c24Id, valueHandle: c24Id, semanticsCertificateId: c24Id }).nullable(),
    quality: z.enum(["BOUNDED", "LOCAL_MONOTONIC_ONLY", "UNKNOWN", "CONTRADICTORY"]),
  }),
  deploymentId: c24Id.nullable(), buildId: c24Id.nullable(),
  attributes: RegisteredAttributesZ.nullable(), evidenceRefs: z.array(c24Id).max(64),
  quality: z.strictObject({
    sourceTrust: z.enum(["AUTHENTICATED_ADAPTER", "IMPORTED_UNVERIFIED", "UNTRUSTED_CONTEXT"]),
    sampling: z.enum(["NONE", "HEAD", "TAIL", "MIXED", "UNKNOWN"]),
    droppedEventCount: z.number().int().nonnegative().nullable(), completeness: z.string().max(40), ingestionTime: z.number(), correctionOfEventId: c24Id.nullable(),
  }),
});

export const RuntimeEdgeSchema = z.strictObject({
  id: c24Id, version: z.number().int().nonnegative(), fromEventId: c24Id, toEventId: c24Id,
  kind: EdgeKindZ, layer: GraphLayerZ, state: z.enum(["ACCEPTED", "CANDIDATE", "QUARANTINED", "INVALIDATED"]),
  ruleId: c24Id, ruleVersion: z.number().int().nonnegative(), evidenceIds: z.array(c24Id).max(64),
  relationCertificateId: c24Id.nullable(), scopeHash: c24Hash, claimId: c24Id.nullable(), limitations: z.array(z.string().max(200)).max(12),
});

export const WaitRelationSchema = z.strictObject({
  id: c24Id, snapshotId: c24Id, taskId: c24Id, processEpoch: c24Id, resourceId: c24Id, resourceEpoch: c24Id,
  ownerTaskIds: z.array(c24Id).max(128), observationEventIds: z.array(c24Id).max(128), evidenceIds: z.array(c24Id).max(64),
  escapeConditions: z.array(z.string().max(200)).max(12), completeness: z.string().max(40),
});

export const CoverageCertificateSchema = z.strictObject({
  id: c24Id, sourceId: c24Id, sourceEpoch: c24Id, window: z.strictObject({ from: z.number(), to: z.number() }),
  predicateSchemaId: c24Id, queryHash: c24Hash, retentionPolicyVersion: z.number().int().nonnegative(),
  exhaustiveForPredicate: z.boolean(), sampling: z.enum(["NONE", "HEAD", "TAIL", "MIXED", "UNKNOWN"]),
  adapterId: c24Id, adapterVersion: z.string().max(64), exclusions: z.array(z.string().max(200)).max(32),
});

export const GapNodeSchema = z.strictObject({
  id: c24Id, kind: z.enum(["MISSING_EVENT", "SAMPLED_REGION", "UNATTRIBUTED_CODE", "CLOCK_UNKNOWN", "ACCESS_RESTRICTED", "ADAPTER_UNSUPPORTED", "RETENTION_EXPIRED"]),
  scopeHash: c24Hash, adjacentEventIds: z.array(c24Id).max(256), missingPredicate: z.string().max(300), material: z.boolean(), safeExplanation: z.string().max(400),
});

export const CausalClaimReferenceSchema = z.strictObject({
  claimId: c24Id, snapshotId: c24Id, snapshotVersion: z.number().int().nonnegative(),
  level: z.enum(["EXECUTION_RELATION", "MECHANISM_CANDIDATE", "MECHANISM_SUPPORTED", "INTERVENTION_SUPPORTED"]),
  populationSchemaId: c24Id, mechanismEvidenceIds: z.array(c24Id).max(64), experimentReportIds: z.array(c24Id).max(16),
  gateReportId: c24Id, state: z.enum(["CURRENT", "STALE", "RESTRICTED"]),
});

// ---------------------------------------------------------------- F02: PR analysis and quality gates
// Additive wire types over the same envelope (contracts §1). A gate decision is a verdict computed from exact evidence,
// bound to hashes, and honest about incompleteness: INCOMPLETE is not an error — absence of evidence never passes.
export type GateDecisionStatus = "PASS" | "FAIL" | "INCOMPLETE";
export type GateConditionOutcome = "PASSED" | "FAILED" | "INCOMPLETE" | "WAIVED" | "NOT_APPLICABLE";
export type GateConditionType = "NEW_FINDINGS" | "REQUIRED_ANALYZERS" | "TESTS_NOT_LOST" | "COVERAGE_ON_CHANGED_LINES" | "ORACLE_PRESERVED" | "DEPENDENCY_POLICY" | "BLAST_RADIUS";
export type MissingDataPolicy = "FAIL" | "INCOMPLETE" | "IGNORE_WITH_DISCLOSURE";
export type PrFindingSeverity = "high" | "medium" | "low";
export type FindingDisposition = "OPEN" | "WAIVED" | "RESOLVED_BY_CHANGE" | "DISMISSED_FALSE_POSITIVE";
export type PrAnalysisState =
  | "RECEIVED" | "FETCHING" | "INDEXING" | "ANALYZING" | "EVALUATING"
  | "DECIDED" | "PUBLISHED" | "PUBLISH_FAILED" | "SUPERSEDED" | "FAILED" | "EXPIRED_WAIVER";
export type AnalyzerState = "COMPLETE" | "PARTIAL" | "TIMED_OUT" | "UNAVAILABLE" | "FAILED";

export interface PullRequestRef { repositoryId: string; forge: string; prNumber: number }

export interface GatePolicyCondition {
  id: string; type: GateConditionType;
  /** NEW_FINDINGS: severities that count and rule selectors (a rule id, or "*" for every rule). */
  severity?: PrFindingSeverity[]; ruleSelectors?: string[];
  /** REQUIRED_ANALYZERS: analyzer ids with versions, e.g. "security-rules@1". */
  analyzers?: string[];
  /** COVERAGE_ON_CHANGED_LINES. */
  minimumPercent?: number; minimumExecutableLines?: number;
  /** ORACLE_PRESERVED: what an un-reviewed candidate means. */
  onUnreviewed?: "FAILED" | "INCOMPLETE";
  /** DEPENDENCY_POLICY: the licence policy artifact to evaluate against. */
  ref?: string;
  /** BLAST_RADIUS: informational when the dependent count exceeds this. */
  informationalAboveDependents?: number;
  /** Absent means blocking (fail closed). */
  blocking?: boolean;
  onMissing?: MissingDataPolicy;
}
export interface GatePolicyBody {
  policyId: string; version: number;
  conditions: GatePolicyCondition[];
  baseline?: { mode: "REANALYZE_BASE_WITH_SAME_RULES" | "REUSE_MATCHING_ANALYSIS" };
  exceptions?: { maxDurationDays: number; requireApprovalFrom: string[] };
  missingDataDefault?: MissingDataPolicy;
}
export interface GatePolicyRecord { policyId: string; version: number; policyHash: string; body: GatePolicyBody; createdBy: string; createdAt: string }

export interface AnalyzerCoverage { analyzedFiles: number; skippedFiles: number; reason?: string }
export interface AnalyzerRecord { id: string; version: string; state: AnalyzerState; coverage: AnalyzerCoverage; reason?: string; wallMs?: number }

export interface ChangedFile { path: string; status: "added" | "modified" | "removed" | "renamed"; oldPath?: string; additions?: number; deletions?: number; generated: boolean }

export interface PrFinding {
  findingId: string; fingerprint: string;
  introduced: boolean;
  baselineFindingId?: string | null;
  ruleId: string; ruleVersion: number; severity: PrFindingSeverity;
  path: string; line: number | null; entityId: string | null;
  disposition: FindingDisposition;
  title: string; summary: string; evidenceIds: string[]; counterArgument: string; claimId?: string;
  /** A detector candidate (e.g. an oracle-preservation candidate), not a security rule. */
  kind?: "SECURITY" | "ORACLE_CANDIDATE" | "DEFECT";
}

export interface CoverageEvidence {
  source: "CI" | "REPOSITORY" | "LOCAL_RUN";
  /** The commit the artifact was produced for; CI artifacts from another commit are rejected (EVIDENCE_STALE). */
  artifactHead?: string; ciRunId?: string; artifactHash?: string;
  executableChangedLines: number; covered: number; percent: number | null;
  /** "supplied by the PR itself": artifacts committed in the head are accepted only with this disclosure. */
  disclosure?: string;
}
export interface OracleEvidence { candidates: number; reviewed: number; headChangesTests: boolean }
export interface WaiverRecord {
  id: string; scopeKind: "FINDING_FINGERPRINT" | "RULE_IN_PATH" | "CONDITION_ONCE";
  scope: { fingerprint?: string; ruleId?: string; path?: string; decisionId?: string };
  actor: string; approver?: string; rationale: string;
  createdAt: string; expiresAt: string; revokedAt?: string | null;
}

/** The evidence a decision is computed from. Whatever is absent is stated, never assumed. */
export interface GateEvidence {
  findings?: PrFinding[];
  testImpact?: { lost: string[]; gained: number; unchanged: number } | null;
  analyzers: AnalyzerRecord[];
  coverage?: CoverageEvidence | null;
  testsRun?: { source: "CI" | "REPOSITORY"; headHash: string; failedTests: number } | null;
  oracle?: OracleEvidence | null;
  dependencies?: { policyRef: string; violations: string[] } | null;
  blastRadius?: { dependents: number } | null;
  waivers?: WaiverRecord[];
}

export interface GateConditionResult {
  id: string; type: GateConditionType; blocking: boolean;
  outcome: GateConditionOutcome; reason: string;
  /** Evidence ids (artifact hashes, analyzer ids, finding fingerprints) the outcome rests on; never empty for a shown outcome. */
  evidenceIds: string[]; waiverId?: string;
}

export interface GateDecisionView {
  decisionId: string; status: GateDecisionStatus; bindingHash: string;
  policy: { policyId: string; version: number; policyHash: string };
  evaluatedAt: string; validUntil?: string; superseded: boolean; revokedReason?: string;
  exceptionsUsed?: string[];
  conditions: GateConditionResult[];
  analysisId: string;
}

export interface PrAnalysisView {
  analysisId: string; pr: PullRequestRef;
  repoRoot: string; baseHash: string; headHash: string; mergeBaseHash: string; headRepository?: string;
  baseRevision?: string; headRevision?: string;
  policyId: string; policyHash: string; analyzerSetHash: string;
  state: PrAnalysisState; supersededBy?: string;
  job?: { id: string; kind: string; state: string; phase: string; message: string };
  changes: { files: ChangedFile[]; consequences: { id: string; text: string; kind: string }[]; blastRadius: { entityId: string; dependents: number; files: string[] }[]; testImpact: { entityId: string; lost: string[]; gained: string[]; unchanged: string[] }[]; gaps: string[] };
  findings: { introduced: PrFinding[]; existing: PrFinding[]; resolvedByChange: PrFinding[]; detectorCandidates?: PrFinding[] };
  analyzers: AnalyzerRecord[];
  baseline: { mode: "REUSED" | "REANALYZED"; analyzerSetHash: string };
  tests: { summary: TestSummaryInfo | null; coverage: CoverageEvidence | null; source: string } | null;
  waivers: WaiverRecord[];
  unresolved?: { dynamicCalls: number; runtimeData: boolean };
  disclosure: string[];
  decision?: GateDecisionView;
}

export type CheckKind = "STATUS" | "CHECK_RUN" | "COMMENT";
export interface PublicationReceipt {
  publicationId: string; forge: string; repositoryId: string; headHash: string;
  kind: CheckKind; externalId?: string; url?: string;
  state: "PREPARED" | "PUBLISHING" | "PUBLISHED" | "FAILED" | "SUPERSEDED";
  idempotencyKey: string;
  lastError?: string;
}

/** Validation of a policy document (§7.1). A policy that names an unknown condition type is rejected here, never at evaluation time. */
export const GatePolicySchema = z.strictObject({
  policyId: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/, "policyId is a lower-case slug"),
  version: z.number().int().positive(),
  conditions: z.array(z.strictObject({
    id: z.string().min(1).max(80),
    type: z.enum(["NEW_FINDINGS", "REQUIRED_ANALYZERS", "TESTS_NOT_LOST", "COVERAGE_ON_CHANGED_LINES", "ORACLE_PRESERVED", "DEPENDENCY_POLICY", "BLAST_RADIUS"]),
    severity: z.array(z.enum(["high", "medium", "low"])).max(3).optional(),
    ruleSelectors: z.array(z.string().min(1).max(120)).max(50).optional(),
    analyzers: z.array(z.string().min(3).max(120)).max(20).optional(),
    minimumPercent: z.number().min(0).max(100).optional(),
    minimumExecutableLines: z.number().int().min(0).max(1e6).optional(),
    onUnreviewed: z.enum(["FAILED", "INCOMPLETE"]).optional(),
    ref: z.string().min(3).max(120).optional(),
    informationalAboveDependents: z.number().int().min(0).max(1e6).optional(),
    blocking: z.boolean().optional(),
    onMissing: z.enum(["FAIL", "INCOMPLETE", "IGNORE_WITH_DISCLOSURE"]).optional(),
  })).min(1).max(20),
  baseline: z.strictObject({ mode: z.enum(["REANALYZE_BASE_WITH_SAME_RULES", "REUSE_MATCHING_ANALYSIS"]) }).optional(),
  exceptions: z.strictObject({ maxDurationDays: z.number().int().min(1).max(365).optional(), requireApprovalFrom: z.array(z.string().max(60)).max(10).optional() }).optional(),
  missingDataDefault: z.enum(["FAIL", "INCOMPLETE", "IGNORE_WITH_DISCLOSURE"]).optional(),
});

// ---------------------------------------------------------------- F04: dependency vulnerability and licence scanning
// Additive wire types over the same envelope (contracts §1, F04 spec §8). Severity on a finding is as *reported* by the
// advisory feed — never recomputed; applicability and reachability are separate statements, none implying another.
export type DepEcosystem = "npm" | "cargo" | "golang" | "pypi" | "maven";
/** What the inventory rests on (F04 §7.1): a parseable lockfile, manifests only, or a tool run in isolation. */
export type InventoryTier = "LOCKFILE" | "DECLARED_ONLY" | "TOOL_RESOLVED";
/** Labelled evidence level (F04 §7.6); NOT_ASSESSED is the default and is displayed, not hidden. */
export type Reachability = "NOT_ASSESSED" | "NOT_IMPORTED" | "PACKAGE_IMPORTED" | "SYMBOL_REFERENCED";
export type DepFindingState = "OPEN" | "FIXED" | "WAIVED" | "WITHDRAWN";
export type DepScope = "PROD" | "DEV" | "OPTIONAL" | "PEER" | "BUILD";
export type DriftKind = "MISSING_IN_LOCK" | "EXTRA_IN_LOCK" | "RANGE_VIOLATION" | "INTEGRITY_MISSING" | "STALE_LOCK_FORMAT";
export type LicenceOutcome = "ALLOWED" | "DENIED" | "NEEDS_REVIEW" | "EXCEPTION";
export type FeedSource = { kind: "OSV_MIRROR"; url?: string } | { kind: string; url?: string };

/** One manifest↔lockfile disagreement (F04 §7.3, F04-A2). */
export interface DriftItem {
  kind: DriftKind;
  packageName: string;
  workspacePath: string;
  declaredRange?: string;
  lockedVersion?: string;
  message: string;
}
export interface DependencyScanRequest {
  repositoryId: string; revision: string;
  workspacePaths?: string[];
  feed?: { snapshotId?: string };
  licencePolicy?: { policyId: string; version?: number };
  resolution?: "LOCKFILE_ONLY" | "ALLOW_ISOLATED_TOOL";
}
/** One introduction path from a workspace root to a package (F04 §7.5). */
export interface DepPath {
  /** Purls from the direct dependency to the target (the workspace root itself is implied). */
  nodes: string[];
  /** Scope of every edge on this path; a path is DEV-exposure only when all edges are DEV. */
  edgeScopes: DepScope[];
  scope: "PROD" | "DEV";
  /** The direct dependency through which the target is reached — the candidate fix location. */
  directDependency: string;
}
/** A remediation option (F04 §7.7); producing the patch for one is C28's proposeDependencyUpgrade. */
export interface FixOption {
  kind: "DIRECT_BUMP" | "ANCESTOR_BUMP" | "OVERRIDE" | "REMOVE" | "ACCEPT" | "NO_FIX";
  /** Plain statement of the risk, e.g. an override is temporary: it forces a version the ancestor was not tested with. */
  risk: string;
  targetVersion?: string;
}
export type FixOptionRef = { kind: FixOption["kind"]; targetVersion?: string };
export interface FeedSnapshotView {
  snapshotId: string; feed: string; fetchedAt: string; upstreamModified?: string;
  contentHash: string; advisories: number; licenceNotice: string;
}
export interface LicenceItem {
  purl: string; name: string; version: string;
  /** The SPDX expression as declared, or null when absent/unparseable (NEEDS_REVIEW, never silently accepted). */
  expression: string | null;
  outcome: LicenceOutcome;
  /** Where the licence string came from: lockfile field, manifest metadata, vendored file, registry. */
  source: string;
  reason: string;
}
export interface DepFindingView {
  findingId: string; purl: string; advisoryId: string; aliases: string[];
  installedVersion: string; fixedIn: string[];
  /** As reported by the feed — the feed's claim, labelled with its source. */
  severity: { source: string; label?: string; cvss?: string };
  applicability: { applies: boolean | "UNKNOWN"; matchedRange?: string; reason: string };
  reachability: Reachability;
  reachabilityEvidenceIds: string[];
  exposure: { prodPaths: number; devOnlyPaths: number; exact: boolean };
  /** Previous assessments under earlier feed snapshots (append-only; F04-A4). */
  previous?: { snapshotId: string; applies: boolean | "UNKNOWN"; at: string }[];
  state: DepFindingState;
}
export interface DependencyInventorySummary {
  inventoryId: string; workspacePath: string; ecosystem: string; tier: InventoryTier;
  inventoryHash: string; packageCount: number; drift: DriftItem[];
}
export interface DependencyReport {
  reportId: string; repositoryId: string; revision: string;
  inventories: DependencyInventorySummary[];
  feed: { snapshotId: string; fetchedAt: string; ageHours: number; stale: boolean };
  findings: DepFindingView[];
  licences: { policyHash: string; counts: Record<LicenceOutcome, number>; items: LicenceItem[] };
  coverage: {
    ecosystemsSupported: string[]; ecosystemsPresentButUnsupported: string[];
    privatePackagesExcluded: number; unmappedReachability: string[];
  };
}

// ---- F05 — Trace-linked continuous profiling ----

export type SampleKind = "CPU" | "WALL" | "ALLOC_SPACE" | "ALLOC_OBJECTS" | "INUSE_SPACE" | "INUSE_OBJECTS" | "LOCK_CONTENTION" | "OTHER";

export interface SampleTypeView {
  ordinal: number;
  kind: SampleKind;
  unit: string;
  rawType: string;
  rawUnit: string;
}

export interface ProfileMappingView {
  mappingId: number;
  buildId?: string;
  file?: string;
  hasFunctions: boolean;
  hasFilenames: boolean;
  hasLineNumbers: boolean;
  hasInlineFrames: boolean;
  revision?: string;
  revisionState: "MATCHED" | "MISMATCH" | "UNKNOWN";
}

export interface ProfileDiagnostic {
  code: string;
  message: string;
}

export type DroppedSamples = number | "NOT_REPORTED";

export interface IngestProfileResponse {
  artifactHash: string;
  format: string;
  sampleTypes: SampleTypeView[];
  periodNs?: number;
  mappings: ProfileMappingView[];
  diagnostics: ProfileDiagnostic[];
  droppedSamples: DroppedSamples;
}

export type CorrelationGrade = "SPAN_LABELLED" | "ENDPOINT_LABELLED" | "WINDOW_OVERLAP" | "NONE";

export interface CorrelationLink {
  traceId?: string;
  spanId?: string;
  grade: CorrelationGrade;
  overlapMs?: number;
  reason: string;
}

export interface BuildResolution {
  buildId?: string;
  revision?: string;
  state: "MATCHED" | "MISMATCH" | "UNKNOWN";
  evidenceIds: string[];
}

export interface ProfileCorrelation {
  correlationId: string;
  links: CorrelationLink[];
  build: BuildResolution;
  populationHash: string;
}

export interface HotspotRow {
  rank: number;
  functionKey: string;
  name: string;
  file: string;
  line: number;
  selfValue: number;
  totalValue: number;
  selfShare: number;
  totalShare: number;
  sampleCount: number;
  uncertaintyLow: number;
  uncertaintyHigh: number;
  entityId?: string;
  attributionMethod: string;
}

export interface ProfileCoverage {
  collectionRatio?: number;
  droppedSamples: DroppedSamples;
  truncatedStacks: number;
  unattributedShare: number;
  prunedShare: number;
}

export interface ProfileUncertainty {
  method: string;
  minSamplesForRanking: number;
  tooFewSamples: boolean;
}

export interface HotspotResult {
  rows: HotspotRow[];
  nextCursor?: string;
  unit: string;
  sampleCount: number;
  populationValue: number;
  coverage: ProfileCoverage;
  uncertainty: ProfileUncertainty;
  basis: "MEASURED_PROFILE";
  grade: CorrelationGrade;
  populationHash: string;
}

export interface FlameNode {
  functionKey: string;
  name: string;
  file: string;
  line: number;
  selfValue: number;
  totalValue: number;
  children: FlameNode[];
  otherValue: number;
}

export interface FlameTreeResult {
  tree: FlameNode;
  nodeCount: number;
  prunedValue: number;
  prunedShare: number;
  unit: string;
  populationValue: number;
}

export interface ProfilePopulation {
  populationHash: string;
  service: string;
  windowFromNs: number;
  windowToNs: number;
  revision?: string;
  sampleTypeKind: SampleKind;
  chunkIds: string[];
  sampleCount: number;
  expectedSamples?: number;
  collectionRatio?: number;
  requestCount?: number;
  errorCount?: number;
}

export interface DeltaRow {
  functionKey: string;
  name: string;
  file: string;
  line: number;
  baselineValue: number;
  candidateValue: number;
  deltaPerRequest: number;
  baselineShare: number;
  candidateShare: number;
  shareChange: number;
}

export interface PopulationCompare {
  baseline: ProfilePopulation;
  candidate: ProfilePopulation;
}

export type CompareVerdict = "DIFFERENCE_OBSERVED" | "NO_MATERIAL_DIFFERENCE" | "NOT_COMPARABLE" | "INCONCLUSIVE";

export interface CompareProfilesResult {
  verdict: CompareVerdict;
  reasons: string[];
  rows: DeltaRow[];
  populations: PopulationCompare;
  limitations: string[];
}

// ---- F05 presentation binding (guide §15 minimum path) ----

/** How strong a wording template may claim to be; a template moves classes only by becoming a new version. */
export type MetricClaimClass = "MEASURED_PROFILE" | "POPULATION_OVERLAP" | "OBSERVED_TRACE" | "MODELED" | "ESTIMATED";

/** One renderable metric fact, bound to its template, population, window, unit and basis. */
export interface MetricItem {
  itemId: string;
  locator: string;
  claimId: string | null;
  templateId: string;
  templateVersion: number;
  certificateId: string | null;
  value: number;
  unit: string;
  basis: MetricClaimClass;
  populationHash: string;
  window: { fromNs: number; toNs: number };
  sampleCount: number;
  populationValue: number | null;
  artifactHash: string | null;
  uncertainty?: { lower: number; upper: number } | null;
  caveatIds: string[];
}

export interface PresentationCheckItem {
  itemId: string;
  verdict: "VERIFIED" | "REJECTED";
  reasons: string[];
}

export interface PresentationManifest {
  manifestHash: string;
  items: MetricItem[];
  checks: PresentationCheckItem[];
}

/** Form V17's compiled views. One view at a time; kinds are never mixed (F05-A3). */
export interface ProfileViewSpec {
  kind: "HOTSPOT_TABLE" | "METRIC_TABLE" | "WATERFALL" | "TIMELINE" | "FLAMEGRAPH";
  title: string;
  captions: string[];
  artifactHash?: string;
  revision?: string;
  revisionState?: "MATCHED" | "MISMATCH" | "UNKNOWN";
  populationHash?: string;
  kindOfMetric?: SampleKind;
  grade?: CorrelationGrade;
  buildWarning?: string;
  rows?: HotspotRow[];
  metrics?: { ordinal: number; kind: SampleKind; unit: string; rawType: string; rawUnit: string; populationValue: number; sampleCount: number; present: true }[];
  kindsPresent?: SampleKind[];
  waterfall?: { traceId: string; spans: { spanId: string; parentId: string | null; name: string; startMs: number; durationMs: number; exclusiveMs: number; category: "CPU" | "IO" | "LOCK" | "POOL" | "QUEUE" | "OTHER"; onCriticalPath: boolean; errors: number }[]; criticalPath: string[]; criticalPathDurationMs: number; waitingNarrative: string | null };
  timeline?: { chunks: { artifactHash: string; startNs: number; endNs: number; format: string; sampleCount: number; service: string | null }[]; brushNote: string };
  flame?: FlameTreeResult;
  outline?: { depth: number; name: string; file: string; share: number; id: string }[];
  unverified?: { locator: string; reasons: string[] }[];
}

// ---- F06 — Historical hotspots and change coupling ----
// A prioritisation heuristic built from the repository's own recorded history, code-health signals,
// impact and knowledge concentration. It is never a statement about defects or productivity (§12.2).

export interface HistoryPolicy {
  window: { since?: string; until?: string; months?: number };
  mergePolicy: "AUTO" | "FIRST_PARENT" | "ALL_NO_MERGE_DIFFS" | "SQUASH_ONLY";
  rename: { enabled: boolean; similarityPercent: number };
  exclusions: { bulk: { files: number; shareOfTracked: number }; format: boolean; botPatterns: string[]; generated: boolean; revertPairs: boolean };
  decay: { halfLifeDays: number };
  coupling: { minSupport: number; minConfidence: number; maxFilesPerChange: number; ubiquitousShare: number };
  /** Thresholds for the code-health signals, versioned (formulaVersion). */
  health: { thresholds: Record<string, number>; formulaVersion: number };
  weights: { preset: "default" | "refactor" | "security" | "incident" | "custom"; custom?: Record<string, number> };
  contributors: "HIDDEN" | "COUNTS_ONLY" | "NAMES_FOR_AUTHORISED";
}

/** §6.1: what was analysed. Every derived number carries the same boundaryHash. */
export interface HistoryBoundaryView {
  repositoryId: string; headCommit: string;
  since?: string; until: string;
  shallow: boolean; commitCount: number; commitListHash: string;
  /** True when the commit cap bit and only the newest commits were analysed. */
  cappedAt?: number;
}

export interface FactorExplanation {
  id: string; label: string; raw: number; normalised: number | null; weight: number; contribution: number; missing: boolean;
}

/** One counted or excluded commit, with its evidence (F06-A5). */
export interface CommitEvidence {
  commitHash: string; committedAt: string; subject: string; prNumber: number | null;
  class: string; classReason: string; filesChanged: number; logicalChangeId: string;
  /** When the change touched the file by an older name, the path then in use. */
  pathAtCommit?: string;
}

export interface ExcludedCommitView extends CommitEvidence { rule: string }

export interface HealthSignal { id: string; label: string; value: number | "NOT_AVAILABLE"; threshold: number; status: "OK" | "ABOVE" | "MISSING" }

export interface RankSensitivity {
  baseline: number;
  /** rank again with each exclusion class counted back in ("the ranking effect of the exclusions"). */
  withClass: { rule: string; rank: number }[];
  /** rank again with each factor removed ("what would change the rank"). */
  withoutFactor: { id: string; label: string; rank: number }[];
}

export interface HotspotScoreRow {
  runId: string; lineageId: string; path: string; renamedFrom: string[];
  score: number; rank: number; rankRaw: number;
  change: { raw: number; logical: number; decayed: number; percentile: number };
  health: { signals: HealthSignal[]; worstFunction?: { name: string; value: number } };
  impact: { dependents: number; incidents: number | "NOT_AVAILABLE"; coveragePercent: number | "NOT_AVAILABLE" };
  knowledge: { contributors: number | "HIDDEN"; topContributorShare?: number };
  /** Factors that fell back to the neutral 0.5 because the data is missing. */
  missing: string[];
}

export interface CouplingEdgeView {
  edgeId: string; runId: string; aLineage: string; aPath: string; bLineage: string; bPath: string;
  support: number; countA: number; countB: number; totalChanges: number;
  confidenceAToB: number; confidenceBToA: number; lift: number; jaccard: number;
  firstSeen: string; lastSeen: string;
  /** NONE | A_TO_B | B_TO_A | BOTH from the static call/import graph at the head, or UNKNOWN when no revision is indexed to check. */
  staticDependency: string;
}

export interface RankStabilityView {
  topK: number; trials: number; stableFraction: number;
  changes: { entered: string[]; left: string[] }[];
  perturbationPercent: number;
  /** The seed is derived from the policyHash: same policy, same trial sets (F06-D10). */
  seedHex: string;
}

export interface ExclusionSummary {
  total: number;
  byRule: { rule: string; count: number }[];
  /** Files dropped from coupling as ubiquitous (in more than `ubiquitousShare` of changes), listed. */
  ubiquitousFiles: { path: string; share: number; logicalChanges: number; totalChanges: number }[];
  samples: ExcludedCommitView[];
}

export interface HotspotReportView {
  runId: string; boundary: HistoryBoundaryView; policyHash: string; mergePolicyUsed: string;
  state: string; stale: { stale: boolean; behindBy: number; rewritten: boolean }; warnings: string[];
  rows: HotspotScoreRow[]; nextCursor?: string;
  exclusions: ExclusionSummary;
  stability: RankStabilityView | null;
  coverage: { shallow: boolean; commitCount: number; cappedAt?: number; symbolResolution: "FILE_ONLY" | "FILE_AND_TOP_SYMBOLS"; gaps: string[] };
  contributorsAvailable: boolean;
}

export interface ExplainHotspotView {
  runId: string; lineageId: string; path: string; renamedFrom: string[]; score: number; rank: number;
  factors: FactorExplanation[];
  changes: CommitEvidence[]; nextCursor?: string;
  excluded: ExcludedCommitView[];
  sensitivity: RankSensitivity;
  /** Monthly counts of the counted changes (raw and decayed), oldest month last (F06 §12 trend sparkline). */
  trend: { month: string; raw: number; decayed: number }[];
  /** Present only when the policy allows names AND the caller holds a grant (F06-A6); never an individual ranking. */
  contributors?: { displayName: string; commits: number }[];
  gaps: string[];
}

export interface ExplainCouplingView {
  edgeId: string; runId: string; aPath: string; bPath: string;
  support: number; countA: number; countB: number; total: number;
  confidenceAToB: number; confidenceBToA: number; lift: number;
  staticDependency: string;
  commits: CommitEvidence[]; nextCursor?: string;
  gaps: string[];
}

// ---- F08 — Coordinated multi-repository changes ----

export type CampaignState = "DRAFT" | "POPULATION_FROZEN" | "PLANNED" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED" | "FAILED";
export type ChildState =
  | "NOT_STARTED" | "PLANNED" | "RUNNING" | "REVIEW_READY" | "PUBLISHED" | "FAILED"
  | "BLOCKED" | "STALE" | "EXCLUDED" | "CANCELLED" | "CLOSED_ON_GITHUB";
export type AssessmentState = "ASSESSED" | "NEEDS_ASSESSMENT";
export type CampaignRole = "PRODUCER" | "CONSUMER" | "BOTH" | "INDEPENDENT";
export type CompatibilityMode = "CANDIDATE_WITH_CANDIDATE" | "CANDIDATE_WITH_BASE" | "BASE_WITH_CANDIDATE";
export type CompatibilityState = "PENDING" | "PASSED" | "FAILED" | "NOT_EVALUABLE" | "NOT_EVALUATED";
export type BatchKind = "CANARY" | "STANDARD";
export type BatchState = "PENDING" | "RUNNING" | "COMPLETE" | "PAUSED";

export interface PauseRule {
  kind: "CANARY_ALL_READY" | "FAILURE_RATE" | "JOINT_FAILURE";
  /** FAILURE_RATE only: pause when the failed fraction of a standard batch exceeds this (e.g. 0.1 = 10 %). */
  threshold?: number;
}

export interface CampaignSelector {
  explicit?: string[];
  search?: { query: string; mode: "LITERAL" | "REGEX" | "SYMBOL" };
  dependentsOf?: { package?: string; symbol?: string };
  attributes?: Record<string, string>;
}

export type CampaignTransformation =
  | { kind: "RECIPE"; recipeId: string; recipeVersion: string; args: Record<string, unknown> }
  | { kind: "TASK_TEMPLATE"; templateId: string };

export interface CampaignCompatibilityPolicy {
  policyId: string;
  required: CompatibilityMode[];
  contractTests?: string[];
}

export interface CampaignBatchesPolicy {
  canarySize: number;
  maxConcurrent: number;
  pauseRules: PauseRule[];
}

export interface CampaignBudgets {
  wallMs: number;
  modelTokens?: number;
  githubWrites: number;
}

export interface CampaignSpec {
  name: string;
  selector: CampaignSelector;
  transformation: CampaignTransformation;
  compatibility: CampaignCompatibilityPolicy;
  batches: CampaignBatchesPolicy;
  budgets: CampaignBudgets;
}

export interface Campaign {
  campaignId: string; tenantId: string; name: string;
  spec: CampaignSpec; specHash: string; transformationHash: string;
  state: CampaignState; version: number;
  createdBy: string; createdAt: string; updatedAt: string;
}

export interface PopulationVersion {
  campaignId: string; version: number; populationHash: string;
  frozenAt: string; createdBy: string;
  selectorResult: string[];
}

export interface CampaignChild {
  campaignId: string; repositoryId: string; populationVersion: number;
  baseCommit: string; taskId?: string; batchId?: string;
  state: ChildState; role: CampaignRole; blockedBy: string[];
  assessmentState: AssessmentState;
  publicationId?: string; prNumber?: number; prState?: string;
  validation?: { runs: number; passed: number; failed: number };
  updatedAt: string;
}

export interface ChildView {
  repositoryId: string; role: CampaignRole; state: ChildState; assessmentState: AssessmentState;
  batchId: string | null; baseCommit: string;
  validation: { runs: number; passed: number; failed: number } | null;
  pr: { number: number; state: string } | null;
  gate: string | null; stale: boolean; exception: boolean;
  /** The most recent stated reason for a non-ready state (validation failure, forbidden path, exclusion). */
  reason?: string;
  /** The materialised candidate's identity: the candidate content hash and the binding hash a grant/approval names. */
  headHash?: string; bindingHash?: string; shapeHash?: string;
  /** Set once a reviewer approves this child's exact binding hash; per child, never cluster-wide. */
  approved?: boolean;
  /** Who produced the child (the second-approver rule is applied against this). */
  author?: string;
  /** Model tokens this child consumed (0 for a deterministic recipe). */
  tokensUsed?: number;
}

export interface ChildClusterMember {
  repositoryId: string; bindingHash: string; state: ChildState; approved: boolean; stale: boolean;
}
export interface ChildCluster {
  clusterId: string; shapeHash: string; representativeRepositoryId: string;
  members: ChildClusterMember[]; note: string;
}
export interface PublicationGrantView {
  id: string; campaignId: string; repositoryId: string; principal: string;
  baseHash: string; headHash: string; diffHash: string; expiresAt: string; revoked: boolean;
}
export interface DryRunRepositoryResult {
  repositoryId: string; applies: boolean; reason: string;
  diffHash: string | null; files: string[]; forbiddenPaths: string[];
  validation: { state: "PASSED" | "FAILED"; runs: number; passedRuns: number; failedRuns: number; reason?: string } | null;
}
export interface DryRunResult {
  campaignId: string; runId: string; createdBy: string; createdAt: string;
  populationHash: string | null; populationSize: number; repositories: DryRunRepositoryResult[];
  note: string;
}

export interface CampaignOrderEntry {
  repositoryId: string; role: CampaignRole; batchId: string;
  dependsOnRepositoryIds: string[];
  reason: string;
}

export interface CampaignOrder {
  mergeOrder: CampaignOrderEntry[];
  cycles: string[][];
  notSafeToReorder: { producer: string; consumer: string; mode: CompatibilityMode; state: CompatibilityState }[];
  rollbackPlan: { repositoryId: string; action: string; consumersFirst: string[] }[];
  externalEffects: string[];
}

export interface BatchView {
  batchId: string; ordinal: number; kind: BatchKind; state: BatchState;
  members: string[]; dependsOn: string[]; pauseRule: PauseRule;
}

export interface CompatCaseView {
  caseId: string; producerRepository: string; consumerRepository: string;
  mode: CompatibilityMode; state: CompatibilityState; reason?: string;
}

export interface CampaignPlan {
  campaignId: string; version: number;
  batches: BatchView[];
  compatibility: CompatCaseView[];
  roles: Record<string, CampaignRole>;
  cycles: string[][];
  order: CampaignOrder;
}

export interface PopulationDiffEntry {
  repositoryId: string;
  change: "ADDED" | "REMOVED" | "BASE_CHANGED" | "UNCHANGED";
  fromBase?: string; toBase?: string;
  previousVersion: number; nextVersion: number;
  state: "NEEDS_ASSESSMENT" | "EXCLUDED" | "ASSESSED";
  reason: string;
}

export interface PopulationDiff {
  campaignId: string; fromVersion: number; toVersion: number;
  populationHash: string; entries: PopulationDiffEntry[];
  added: string[]; removed: string[]; baseChanged: string[];
}

export interface ChildPublicationResult {
  repositoryId: string; action: "CREATED" | "ADOPTED" | "FAILED" | "SKIPPED";
  prNumber?: number; state: ChildState; reason?: string;
}

export interface ReconcileRow {
  repositoryId: string;
  recorded: string; github: string;
  action: "NONE" | "ADOPT" | "RETRY" | "STALE";
}

export interface CampaignProgress {
  campaignId: string; version: number; batchId: string | null;
  counts: Partial<Record<ChildState, number>>;
  started: string[]; hiddenNote: string; paused: boolean; reason?: string;
}

export interface CampaignView {
  campaign: Campaign;
  population: { version: number; populationHash: string; frozenAt: string } | null;
  children: ChildView[];
  counts: Partial<Record<ChildState, number>>;
  batchSizes: Record<string, number>;
  progress: { completed: number; total: number };
  hiddenNote: string;
  order: CampaignOrder | null;
  /** Budget usage so far: wall time admitted, model tokens and GitHub writes (global, viewer-independent). */
  usage?: { wallMs: number; modelTokens: number; githubWrites: number };
  budget?: CampaignBudgets;
}

// ---- Release scope — what's actually in a release, frozen against a GitHub milestone ----
//
// Mirrors F08's campaign population model (create / freeze / version-diff / event-sourced replay), scaled down to a
// single repository's milestone issues. An item added to the milestone after freeze is NEEDS_ASSESSMENT, never
// silently folded into scope (the same rule campaigns apply to a repository added after freeze).

export type ReleaseState = "DRAFT" | "SCOPE_FROZEN" | "CANCELLED";
export type ReleaseItemState = "IN_SCOPE" | "EXCLUDED";

export interface ReleaseMilestoneRef {
  host: string; owner: string; repo: string; number: number;
}

export interface ReleaseSpec {
  name: string;
  tag: string;
  milestone: ReleaseMilestoneRef;
}

export interface Release {
  releaseId: string; tenantId: string; name: string; tag: string;
  milestone: ReleaseMilestoneRef;
  state: ReleaseState; version: number;
  createdBy: string; createdAt: string; updatedAt: string;
}

export interface ReleaseScopeVersionInfo {
  releaseId: string; version: number; scopeHash: string;
  issueNumbers: number[];
  frozenAt: string; createdBy: string;
}

export interface ReleaseItem {
  releaseId: string; issueNumber: number; scopeVersion: number;
  title: string; issueState: "open" | "closed";
  state: ReleaseItemState; assessmentState: AssessmentState;
  updatedAt: string;
}

export interface ReleaseItemView {
  issueNumber: number; title: string; issueState: "open" | "closed";
  state: ReleaseItemState; assessmentState: AssessmentState;
  /** The most recent stated reason for a non-default state (added after freeze, no longer in the milestone). */
  reason?: string;
}

export interface ReleaseScopeDiffEntry {
  issueNumber: number;
  change: "ADDED" | "REMOVED" | "UNCHANGED";
  previousVersion: number; nextVersion: number;
  state: ReleaseItemState | "NEEDS_ASSESSMENT";
  reason: string;
}

export interface ReleaseScopeDiff {
  releaseId: string; fromVersion: number; toVersion: number; scopeHash: string;
  entries: ReleaseScopeDiffEntry[];
  added: number[]; removed: number[];
}

export interface ReleaseView {
  release: Release;
  scope: { version: number; scopeHash: string; frozenAt: string } | null;
  items: ReleaseItemView[];
  counts: Partial<Record<ReleaseItemState, number>>;
  needsAssessment: number;
}
