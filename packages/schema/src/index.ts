// Subset of contracts §2 used by the MVP. Field names match the contract on the wire.
import { z } from "zod";
export * from "./defect.ts";

export type Id = string;
export type RevisionId = string;

export type EvidenceClass =
  | "STATIC_PARSED" | "STATIC_RESOLVED" | "RUNTIME" | "TEST" | "HISTORY"
  | "DOCUMENT" | "HUMAN_JUDGMENT" | "INFERRED" | "SPECULATIVE";
export type EvidenceState = "CURRENT" | "STALE" | "UNAVAILABLE" | "ACCESS_REVOKED";
export type ResolutionKind = "PARSED" | "RESOLVED" | "OBSERVED" | "UNRESOLVED";
export type DisplayMode = "FACT" | "INFERENCE" | "HYPOTHESIS" | "FOG" | "HIDDEN";

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
}

export interface EvidenceBundle {
  id: Id; revision: RevisionId; evidence: EvidenceRef[];
  entities: Entity[]; relationships: Relationship[]; facts: Fact[];
  coverage: string[]; unresolved: string[]; tokenEstimate: number;
}

// ---- Envelope (contracts §1) ----
export type ErrorCode =
  | "UNAUTHORIZED" | "FORBIDDEN" | "STALE_REVISION" | "VERSION_CONFLICT" | "EVIDENCE_MISSING"
  | "EVIDENCE_STALE" | "INVALID_SCHEMA" | "BUDGET_EXCEEDED" | "PROVIDER_UNAVAILABLE" | "CANCELLED"
  | "DEADLINE_EXCEEDED" | "RESOURCE_LIMIT" | "STORAGE_FAILURE" | "INSUFFICIENT_EVIDENCE" | "NOT_FOUND";

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
  | "RaceWindow" | "Counterfactual" | "TestConfidence" | "Ownership" | "ConceptAtlas" | "PolicyMap" | "ChangeRisk";
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
export type JobKind = "index" | "concepts" | "investigate" | "defect-detect" | "defect-experiment";
export type JobState = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED";
export interface JobView {
  id: Id; kind: JobKind; state: JobState;
  /** Asked to stop, not stopped yet (the runner is at a point where it can). */
  cancelRequested: boolean;
  /** Past the commit point: a cancel is refused, because stopping now would leave half a result. */
  committing: boolean;
  phase: string; message: string; done?: number; total?: number;
  params: { repoPath?: string; revision?: string; investigationId?: string; defectRequestHash?: string; specId?: string };
  createdAt: string; startedAt?: string; finishedAt?: string;
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

export const RepresentationOutput = z.object({
  caption: z.string().max(400),
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
export const ROUTE_FORMS = ["SemanticMap", "CausalGraph", "TransactionJourney", "DataLineage", "SemanticDiff", "Archaeology", "TrustBoundary", "RuntimeOverlay", "RaceWindow", "Counterfactual", "TestConfidence", "Ownership", "ConceptAtlas", "PolicyMap", "ChangeRisk"] as const;
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
} as const;

// ---- Model gateway interface ----
export interface ModelRequest {
  purpose: "REPRESENT" | "EXPLAIN" | "EXTRACT" | "CHALLENGE" | "ROUTE"; schemaId: keyof typeof OUTPUT_SCHEMAS;
  question: string; bundle: EvidenceBundle; selected?: Id[];
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
export type ConverseResult =
  | { kind: "view"; view: ViewSpec; claims: Claim[]; message: string }
  | { kind: "explanation"; explanation: ExplainResult; message: string }
  | { kind: "resume"; workspaceId: Id; message: string }
  | { kind: "zoom"; direction: "in" | "out" | "overview"; message: string }
  | { kind: "message"; message: string };
export interface TestSummaryInfo {
  found: string[]; coverageFiles: number; coverageLinePercent: number | null;
  tests: { passed: number; failed: number; skipped: number }; failing: { name: string; file?: string; message?: string }[]; generatedAt: string; staleness: string[];
}
export interface StatusInfo { revision: RevisionInfo | null; provider: string; hosted: boolean; allowHosted: boolean; concepts: number; tests: TestSummaryInfo | null }
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
