// C22 hypothesis and agentic investigation engine: the c22.v2 data model (design §4). Enums are closed: a value that is
// not in the list fails validation rather than defaulting to something that looks safe.
export const ENUMS = {
  closure: ["OPEN", "FINALIZED"],
  mode: ["GUIDED", "BOUNDED_AUTOMATIC", "LIVE_REFINEMENT"],
  execution: ["CREATED", "READY", "RUNNING", "WAITING", "PAUSED", "STOPPING", "CANCELLED", "FINISHED", "FAILED"],
  disposition: ["UNASSESSED", "EXPLAINED_WITH_LIMITS", "UNRESOLVED", "USER_CLOSED", "STALE"],
  origin: ["USER", "MODEL", "RULE", "IMPORTED"],
  lifecycle: ["ACTIVE", "SUPERSEDED", "RETIRED"],
  evaluation: ["OPEN", "SUPPORTED", "REFUTED", "CONTESTED", "UNRESOLVED"],
  freshness: ["CURRENT", "STALE", "ACCESS_RESTRICTED"],
  assumption: ["UNCHECKED", "EVIDENCED", "CONTRADICTED", "UNKNOWN"],
  relation: ["SUPPORTS", "CONTRADICTS", "NEUTRAL", "INCONCLUSIVE"],
  hypothesisRelation: ["COMPETES_WITH", "CAN_COEXIST", "REFINES", "MUTUALLY_EXCLUSIVE", "DEPENDS_ON"],
  mechanismRelation: ["CALLS", "WAITS_FOR", "PRECEDES", "CONTRIBUTES_TO", "CAUSES_CANDIDATE"],
  observationKind: ["SOURCE_FACT", "RUNTIME_SIGNAL", "TEST_RESULT", "USER_REPORT"],
  sampling: ["NONE", "SAMPLED", "UNKNOWN"],
  step: ["PENDING", "READY", "RUNNING", "SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED", "SUPERSEDED"],
  attempt: ["RESERVED", "DISPATCHED", "SUCCEEDED", "FAILED", "ABANDONED", "CANCELLED"],
  executionClass: ["READ_ONLY", "ISOLATED_EXPERIMENT_PROPOSAL", "PROHIBITED"],
  experiment: ["PROPOSED", "REQUESTED", "RUNNING_EXTERNAL", "EVIDENCE_RECEIVED", "REJECTED", "CANCELLED"],
  outcome: ["PRESENT", "ABSENT_WITH_COVERAGE", "NOT_OBSERVED", "UNKNOWN", "MATCH", "MISMATCH", "ERROR"],
  stop: ["CHECKS_COMPLETED", "NO_READY_CHECK", "BUDGET_EXHAUSTED", "DEADLINE", "USER_STOP", "ACCESS_REVOKED", "POLICY_FAILURE"],
  completionRule: ["EXHAUST_READY_CHECKS", "EXPLAIN_SYMPTOM_WITH_COVERAGE", "USER_REVIEW"],
  evaluationReason: ["GROUNDED_SUPPORT", "ESSENTIAL_PREDICTION_CONTRADICTED", "MIXED_EVIDENCE", "INCOMPLETE_COVERAGE", "CORRELATED_SOURCES", "UNVERIFIED_ASSUMPTION", "HUMAN_VERDICT", "STALE_SNAPSHOT"],
  gap: ["NOT_INDEXED", "NO_ACCESS", "NO_TELEMETRY", "INCOMPLETE_SAMPLING", "UNRESOLVED_SYMBOL", "ADAPTER_UNAVAILABLE", "BUDGET_LIMIT", "AMBIGUOUS_SCOPE"],
  event: ["CREATED", "HYPOTHESIS_REGISTERED", "HYPOTHESIS_REVISED", "EVIDENCE_ATTACHED", "ASSESSMENT_COMMITTED", "PLAN_CHANGED", "STEP_RESERVED", "STEP_COMPLETED", "STEP_FAILED", "EXECUTION_FENCED", "STATE_CHANGED", "COVERAGE_CHANGED", "COMPLETION_RECORDED", "SOURCE_INVALIDATED"],
} as const;
type Vals<K extends keyof typeof ENUMS> = (typeof ENUMS)[K][number];
export type InvestigationMode = Vals<"mode">;
export type ExecutionState = Vals<"execution">;
export type Disposition = Vals<"disposition">;
export type EvaluationState = Vals<"evaluation">;
export type Freshness = Vals<"freshness">;
export type EvidenceRelation = Vals<"relation">;
export type OutcomeTag = Vals<"outcome">;
export type StepState = Vals<"step">;
export type AttemptState = Vals<"attempt">;
export type StopReason = Vals<"stop">;
export type EvaluationReason = Vals<"evaluationReason">;
export type GapReason = Vals<"gap">;
export type EventType = Vals<"event">;
export type ExperimentState = Vals<"experiment">;
export type HypothesisRelationKind = Vals<"hypothesisRelation">;

export function oneOf<K extends keyof typeof ENUMS>(kind: K, v: unknown, what = kind as string): Vals<K> {
  if (!(ENUMS[kind] as readonly unknown[]).includes(v)) throw new C22Error("INVALID_SCHEMA", `${what}: "${String(v)}" is not one of ${(ENUMS[kind] as readonly string[]).join(", ")}`);
  return v as Vals<K>;
}

export class C22Error extends Error {
  readonly code: "INVALID_SCHEMA" | "VERSION_CONFLICT" | "FORBIDDEN" | "NOT_FOUND" | "BUDGET_EXCEEDED" | "STALE_REVISION" | "CANCELLED" | "INSUFFICIENT_EVIDENCE";
  readonly currentVersion?: number;
  constructor(code: C22Error["code"], message: string, currentVersion?: number) { super(message); this.code = code; this.currentVersion = currentVersion; }
}

export interface TimeWindow { start: string; end: string }
export interface Usage { tokens: number; cost: number; toolSteps: number }
export interface Budget { tokens: number; cost: number; toolSteps: number }
export interface InvestigationScope {
  revision: string; repoRoot: string; roots: string[]; deploymentIds: string[]; incidentWindow: TimeWindow | null;
  allowedTools: string[]; maxGraphDepth: number; maxGraphNodes: number; authorityEpoch: number; scopeHash: string;
}
export interface InvestigationPolicy {
  maxActiveHypotheses: number; maxPlanSteps: number; maxAssessmentsPerBatch: number; maxRetriesPerStep: number;
  readTimeoutMs: number; leaseDurationMs: number; maxConcurrentSteps: number; allowAutomaticAdvance: boolean; completionRule: Vals<"completionRule">;
}
export const DEFAULT_POLICY: InvestigationPolicy = {
  maxActiveHypotheses: 8, maxPlanSteps: 32, maxAssessmentsPerBatch: 64, maxRetriesPerStep: 1, readTimeoutMs: 10_000, leaseDurationMs: 30_000,
  maxConcurrentSteps: 2, allowAutomaticAdvance: true, completionRule: "EXHAUST_READY_CHECKS",
};
export interface Goal { question: string; entityRefs?: string[]; incidentWindow?: TimeWindow | null; trace?: string }

export interface InvestigationSnapshot {
  id: string; workspaceId: string; version: number; generation: number; eventSequence: number;
  goal: Goal; mode: InvestigationMode; scope: InvestigationScope; execution: ExecutionState; closure: "OPEN" | "FINALIZED";
  disposition: Disposition; hypothesisIds: string[]; stepIds: string[];
  budget: { limit: Budget; consumed: Usage; reserved: Usage };
  policy: InvestigationPolicy; coverage: CoverageReport; stopReason: StopReason | null;
  pendingEvidence: number; pinned: string[]; waitingFor: { what: string; deadline: string } | null;
  lastCheckpointId: string; createdAt: string; updatedAt: string;
}

export interface Assumption { id: string; statement: string; entityRefs: string[]; verification: Vals<"assumption">; evidenceIds: string[] }
export interface Prediction {
  id: string; description: string; checkId: string;
  /** The registered read that settles it. Absent means "not yet testable", which is recorded as a gap, never run. */
  request?: { toolId: string; payload: Record<string, unknown> }; outcomeIfTrue: OutcomeTag[]; outcomeIfFalse: OutcomeTag[];
  distinguishingHypothesisIds: string[]; essentialForHypothesis: boolean;
}
export interface MechanismLink {
  from: { kind: "entity"; ref: string } | { kind: "observation"; observationId: string };
  to: { kind: "entity"; ref: string } | { kind: "observation"; observationId: string };
  relation: Vals<"mechanismRelation">; evidenceIds: string[];
}
export interface HypothesisRelation { otherId: string; kind: HypothesisRelationKind; basisClaimId?: string }
export interface HypothesisDraft {
  statement: string; mechanism: MechanismLink[]; assumptions: Assumption[]; predictions: Prediction[];
  basisEvidenceIds: string[]; alternativeRelations: HypothesisRelation[];
}
export interface HypothesisEvaluation {
  state: EvaluationState; freshness: Freshness; supportingAssessmentIds: string[]; contradictingAssessmentIds: string[];
  independentSupportGroups: number; independentContradictionGroups: number;
  unresolvedGapIds: string[]; reasonCodes: EvaluationReason[]; verdictIds: string[]; disputed: boolean;
  calibration: { kind: "Uncalibrated"; reason: string } | { kind: "Calibrated"; probability: number; lower: number; upper: number };
  rank: PriorityBreakdown;
}
export interface PriorityBreakdown { investigationPriority: number; impact: number; relevance: number; discriminability: number; evidenceQuality: number; reasons: string[] }
export interface HypothesisRecord extends HypothesisDraft {
  id: string; investigationId: string; version: number; claimId: string; scopeHash: string; origin: Vals<"origin">;
  lifecycle: Vals<"lifecycle">; evaluation: HypothesisEvaluation; assessmentIds: string[]; experimentIds: string[];
  parentVersion: number | null; supersedesId: string | null; createdAt: string; updatedAt: string;
}

export interface EvidenceQuality { completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"; sampling: Vals<"sampling">; clockUncertaintyMs: number | null; collectionErrors: string[]; certificateId: string | null }
export interface CoverageCertificate {
  id: string; sourceId: string; revision: string | null; deploymentId: string | null; window: TimeWindow | null;
  queryHash: string; exhaustiveForPredicate: boolean; predicateSchemaId: string; sampling: Vals<"sampling">; exclusions: string[];
  issuerAdapterId: string; adapterVersion: string;
}
export interface Observation {
  id: string; investigationId: string; evidenceIds: string[]; kind: Vals<"observationKind">; description: string;
  revision: string | null; deploymentId: string | null; window: TimeWindow | null; sourceEventIds: string[];
  correlationGroupId: string; attributionId: string | null; unknownContext: boolean; quality: EvidenceQuality;
  outcome: OutcomeTag; predictionId: string | null; introducedByHypothesisId: string | null;
  eventTime: string | null; retracted: boolean; createdAt: string;
}
export interface ObservationInput {
  evidenceIds: string[]; description: string; predictionId?: string | null; sourceEventId: string;
  kind?: Vals<"observationKind">; outcome?: OutcomeTag; revision?: string | null; deploymentId?: string | null; window?: TimeWindow | null;
  certificate?: CoverageCertificate | null; sampling?: Vals<"sampling">; traceLineage?: string | null; contentHash?: string | null;
  attributionId?: string | null; eventTime?: string | null; introducedByHypothesisId?: string | null; clockUncertaintyMs?: number | null;
}
export interface EvidenceAssessment {
  id: string; hypothesisId: string; hypothesisVersion: number; observationId: string; relation: EvidenceRelation;
  predictionId: string | null; claimId: string; gateReportId: string; correlationGroupId: string; snapshotHash: string; scopeHash: string;
  accepted: boolean; stale: boolean; reasonCodes: string[]; createdAt: string;
}

export interface RegisteredToolRequest { schemaId: string; version: number; payload: Record<string, unknown> }
export interface CheckOutcomeRule { outcome: OutcomeTag; description: string; supports: string[]; contradicts: string[]; requiredPredictionIds: string[] }
export interface DiscriminatingCheck {
  id: string; description: string; hypothesisIds: string[]; toolId: string; request: RegisteredToolRequest; outcomes: CheckOutcomeRule[];
  requiredCoverage: { requiresExhaustivePredicate: boolean; minimumObservationCount: number; requiredRevision: string };
  expectedCost: Usage; dependencies: string[]; executionClass: Vals<"executionClass">;
  value: { partitionQuality: number; gapReduction: number; incidentRelevance: number; score: number; method: "DETERMINISTIC_HEURISTIC" | "CALIBRATED_EXPECTED_GAIN" };
}
export interface StepRecord {
  id: string; investigationId: string; version: number; checkId: string | null; toolId: string; request: RegisteredToolRequest;
  dependsOn: string[]; state: StepState; generation: number; attemptIds: string[]; resultHandle: string | null; resultHash: string | null; unavailableReason: string | null;
  acceptedAttemptId: string | null;
}
export interface StepAttempt {
  id: string; stepId: string; generation: number; attemptNumber: number; state: AttemptState; leaseOwner: string; leaseExpiresAt: string;
  dispatchId: string; requestHash: string; scopeHash: string; reservation: Usage; startedAt: string; finishedAt: string | null;
  resultHandle: string | null; error: string | null;
}
export interface ExperimentProposal {
  id: string; investigationId: string; hypothesisIds: string[]; description: string; predictedOutcomes: CheckOutcomeRule[];
  requiredEnvironment: string; requiredPermissions: string[]; executionClass: "ISOLATED_EXPERIMENT_PROPOSAL"; state: ExperimentState; scenarioId: string | null; evidenceIds: string[];
}
export interface EvidenceGap { id: string; description: string; hypothesisIds: string[]; material: boolean; reason: GapReason; suggestedCheckIds: string[] }
export interface CoverageReport { inspectedEntityIds: string[]; excludedEntityIds: string[]; attemptedCheckIds: string[]; missing: EvidenceGap[]; completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"; scopeHash: string }
export interface Finding { id: string; statement: string; kind: "supported" | "refuted" | "unresolved" | "limit"; hypothesisIds: string[]; claimIds: string[] }
export interface CompletionReport {
  investigationId: string; version: number; execution: ExecutionState; disposition: Disposition;
  supportedHypothesisIds: string[]; refutedHypothesisIds: string[]; unresolvedHypothesisIds: string[]; contestedHypothesisIds: string[];
  findings: Finding[]; coverage: CoverageReport; stopReason: StopReason; nextActions: DiscriminatingCheck[]; conclusionClaimIds: string[];
  /** True only when a sound exhaustive analysis was declared; never true here, and said so. */
  universalClaim: false; limits: string[]; generatedAt: string;
}
export interface InvestigationEvent { id: string; investigationId: string; sequence: number; aggregateVersion: number; generation: number; type: EventType; payload: Record<string, unknown>; scopeHash: string; causedByCommandId: string; createdAt: string; redacted?: boolean }

export interface BoardSnapshot {
  investigationId: string; investigationVersion: number; sequence: number; generation: number; scopeHash: string; restricted: boolean;
  hypothesisIds: string[]; claimIds: string[]; evidenceIds: string[]; checkIds: string[]; unknownGapIds: string[];
  execution: ExecutionState; disposition: Disposition;
  hypotheses: { id: string; version: number; statement: string; state: EvaluationState; freshness: Freshness; claimId: string; priority: number; disputed: boolean; independentSupportGroups: number; reasonCodes: EvaluationReason[] }[];
}
export interface BoardDelta {
  investigationId: string; baseVersion: number; newVersion: number; fromSequence: number; toSequence: number; generation: number;
  changedHypothesisIds: string[]; removedHypothesisIds: string[]; changedClaimIds: string[]; addedEvidenceIds: string[]; requiresRecompile: boolean;
}
export type BoardReply = { kind: "full"; snapshot: BoardSnapshot } | { kind: "changed"; delta: BoardDelta; snapshot: BoardSnapshot } | { kind: "unchanged"; version: number; sequence: number };
