// Subset of contracts §2 used by the MVP. Field names match the contract on the wire.
import { z } from "zod";

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
export interface ViewSpec {
  id: Id; version: number; revision: RevisionId; taskId: Id; formId: FormId; caption: string;
  question: string; level: number; nodes: ViewNode[]; edges: ViewEdge[]; groups: ViewGroup[];
  legend: { label: string; displayMode: DisplayMode; description: string }[];
  cameraPolicy: { behavior: "PRESERVE" }; gaps: string[];
  /** Why this form was chosen for the question (shown to the user). */
  formReason?: string;
  /** Items deliberately left out and why, for "why is this hidden?". */
  hidden?: { entityId: Id; label: string; reason: string }[];
  /** Pruned by the user ("ignore X"); kept so the view can explain and restore. */
  ignored?: Id[];
  /** "What this means" rows beside a view (semantic diff, counterfactual): each with its own evidence and claim. */
  consequences?: { id: Id; text: string; kind: string; displayMode: DisplayMode; claimId?: Id; evidenceIds: Id[]; entityIds?: Id[] }[];
  /** Change-risk terrain: a composite of grounded factors per region; weights are tunable in the UI. */
  terrain?: { cells: TerrainCell[]; factors: { id: string; label: string; description: string; weight: number }[]; formula: string };
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

export const OUTPUT_SCHEMAS = {
  [SCHEMA_REPRESENTATION]: RepresentationOutput,
  [SCHEMA_EXPLANATION]: ExplanationOutput,
  [SCHEMA_CONCEPTS]: ConceptsOutput,
  [SCHEMA_CHALLENGE]: ChallengeOutput,
} as const;

// ---- Model gateway interface ----
export interface ModelRequest {
  purpose: "REPRESENT" | "EXPLAIN" | "EXTRACT" | "CHALLENGE"; schemaId: keyof typeof OUTPUT_SCHEMAS;
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
  affectedNodes: { nodeId: Id; label: string; change: "changed" | "removed" }[];
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
