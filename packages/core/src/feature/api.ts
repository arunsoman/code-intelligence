// Frozen operation catalogue for Prompt-to-feature (spec §19, §36.1, §40, §47.1). `OPS` is the single list the gateway
// registers (./routes.ts); each row names the task that replaces its stub. Long operations return a durable job id and
// complete later with an Outcome (spec §19); mutating operations need an Idempotency-Key and, where applicable,
// an expected version.
import type {
  ApplicationAssessment, ApplicationReceipt, BuilderEvaluation, CancellationReceipt, CapabilityRef, ChangeGraphPage, Ctx, DecisionRecord,
  DependencyReview, FeatureContract, FeatureContractDraft, FeaturePlan, FeatureRequest, FeatureWorkspace, Hash, Id, ImpactAssessment,
  IntegrationAssessment, IssueBindingReceipt, IssueSyncReceipt, ModelInvocation, MutationLease, MutationLineage, OperationalAssessment,
  Outcome, OutcomeMode, OverlapAssessment, OverlapEvidence, PairedExperiment, PatchBinding, PatchExport, PerformanceAssessment,
  PerformanceRiskAssessment, PublicationDecision, PublicationReceipt, QuestionBatch, RepositoryAssessment, RequirementFinding, ReviewFeedback,
  RevalidationPlan, SecurityAssessment, Snapshot, SourceRef, TestAssociation, ValidationPage, ValidationResult, VerifiedOverlapAssessment,
  WizardStage, InvestigationPlan, CoverageRecord,
} from "./types.ts";

export type Job<T> = { jobId: Id; result?: Outcome<T> };
export type OpSpec = { key: string; mutating: boolean; owner: string; note?: string };

/** Typed signatures other tasks code against. Implementations return these; the gateway wraps them in ApiResult. */
export interface FeatureApi {
  // intake and discovery (1.B, 1.C)
  submitFeature(ctx: Ctx, i: { inputRefs: SourceRef[]; text: string; repositoryId: Id; mode: OutcomeMode; budget?: { modelTokens: number; wallMs: number }; idempotencyKey: string }): FeatureRequest;
  discoverFeatureContext(ctx: Ctx, i: { requestId: Id; snapshot: Snapshot; retrievalBudget: { tokens: number; files: number } }): Outcome<RepositoryAssessment>;
  resumeRequest(ctx: Ctx, i: { requestId: Id }): FeatureWorkspace;
  // requirements, conflicts, questions (2.I)
  normalizeRequirements(ctx: Ctx, i: { requestId: Id; sourceRefs: SourceRef[]; assessmentId: Id }): Outcome<FeatureContractDraft>;
  detectSemanticConflicts(ctx: Ctx, i: { contractHash: Hash; relatedSourceRefs: SourceRef[] }): Outcome<RequirementFinding[]>;
  checkRequirementConstraints(ctx: Ctx, i: { contractHash: Hash; policyHashes: Hash[]; invariantIds: Id[] }): Outcome<RequirementFinding[]>;
  assessFeatureImpact(ctx: Ctx, i: { contractHash: Hash; snapshot: Snapshot }): Outcome<ImpactAssessment>;
  planClarifications(ctx: Ctx, i: { contractHash: Hash; findingIds: Id[]; obligationIds: Id[] }): Outcome<QuestionBatch>;
  // decisions (1.D)
  recordDecision(ctx: Ctx, i: { contractId: Id; expectedVersion: number; questionId: Id; answer: string; authorityBindingId?: Id; idempotencyKey: string }): DecisionRecord;
  reviseContract(ctx: Ctx, i: { contractId: Id; expectedVersion: number; decisionIds: Id[] }): Outcome<FeatureContract>;
  // overlap (2.I)
  findRelatedCapabilities(ctx: Ctx, i: { contractHash: Hash; snapshot: Snapshot; scope: string; budget: { files: number } }): Outcome<{ capabilities: CapabilityRef[]; coverage: CoverageRecord[] }>;
  compareRequestedBehaviour(ctx: Ctx, i: { contractHash: Hash; capabilityRefs: CapabilityRef[]; evidenceIds: Id[] }): Outcome<OverlapAssessment>;
  investigateOverlap(ctx: Ctx, i: { assessmentId: Id; unknownIds: Id[]; budget: { steps: number } }): Outcome<OverlapEvidence>;
  assessReuseImpact(ctx: Ctx, i: { assessmentId: Id; strategy: string; snapshot: Snapshot }): Outcome<ImpactAssessment>;
  verifyOverlap(ctx: Ctx, i: { assessmentId: Id; policyHash: Hash; evidenceIds: Id[] }): Outcome<VerifiedOverlapAssessment>;
  // plan and candidate (1.E)
  planFeatureChange(ctx: Ctx, i: { contractHash: Hash; impactAssessmentId: Id; capabilities: string[] }): Outcome<FeaturePlan>;
  planReuseChange(ctx: Ctx, i: { contractHash: Hash; verifiedAssessmentId: Id; capabilities: string[] }): Outcome<FeaturePlan>;
  materializeCandidate(ctx: Ctx, i: { planId: Id; snapshot: Snapshot; idempotencyKey: string }): Job<PatchBinding>;
  readCandidateFile(ctx: Ctx, i: { candidateHash: Hash; path: string; range?: [number, number]; representation: "CANDIDATE" | "BASELINE" | "UNIFIED_DIFF" | "SPLIT_DIFF" }): Outcome<{ sourceArtifactRef: Id; content: string; complete: boolean }>;
  // validation (2.J, 2.K, 2.L, 2.M, 3.S)
  runValidation(ctx: Ctx, i: { patchBindingHash: Hash; validationPlanHash: Hash; budget: { wallMs: number } }): Job<ValidationResult[]>;
  runSecurityValidation(ctx: Ctx, i: { patchBindingHash: Hash; scannerPlanHash: Hash; budget: { wallMs: number } }): Job<SecurityAssessment>;
  reviewDependencyDiff(ctx: Ctx, i: { patchBindingHash: Hash; inventoryHashes: Hash[]; policyHash: Hash }): Outcome<DependencyReview>;
  assessPerformanceRisk(ctx: Ctx, i: { contractHash: Hash; patchBindingHash: Hash; runtimeEvidenceIds: Id[] }): Outcome<PerformanceRiskAssessment>;
  runPairedBenchmark(ctx: Ctx, i: { baselineSnapshot: Snapshot; patchBindingHash: Hash; workloadHash: Hash; environmentHash: Hash; measurementPlanHash: Hash; budget: { wallMs: number } }): Job<PairedExperiment>;
  evaluatePerformance(ctx: Ctx, i: { pairedExperimentId: Id; budgetIds: Id[]; analysisPolicyHash: Hash }): Outcome<PerformanceAssessment>;
  assessOperationalReadiness(ctx: Ctx, i: { contractHash: Hash; patchBindingHash: Hash; planHash: Hash }): Outcome<OperationalAssessment>;
  queryValidationResults(ctx: Ctx, i: { candidateHash: Hash; contractHash: Hash; filters?: { status?: string; kind?: string }; cursor?: string }): Outcome<ValidationPage>;
  queryRelatedTests(ctx: Ctx, i: { candidateHash: Hash; fileId?: Id; acceptanceId?: Id; cursor?: string }): Outcome<{ associations: TestAssociation[]; coverage: CoverageRecord[]; gaps: string[] }>;
  // gate, publication, delivery (2.J, 3.Q, 3.R)
  verifyFeature(ctx: Ctx, i: { contractHash: Hash; patchBindingHash: Hash; validationIds: Id[]; performanceAssessmentIds: Id[]; unresolvedFindingIds: Id[]; purpose: string }): PublicationDecision;
  exportFeaturePatch(ctx: Ctx, i: { candidateHash: Hash; decisionId: Id; format: string; exportPolicyHash: Hash }): Outcome<PatchExport>;
  checkPatchDestination(ctx: Ctx, i: { exportId: Id; destinationSnapshot: Snapshot; dirtyState: string[] }): Outcome<ApplicationAssessment>;
  applyPatchCandidate(ctx: Ctx, i: { exportId: Id; destinationSnapshot: Snapshot; assessmentId: Id; capabilities: string[]; idempotencyKey: string }): Job<ApplicationReceipt>;
  publishFeaturePR(ctx: Ctx, i: { proposalId: Id; decisionId: Id; expectedHeadHash: Hash; destination: string; idempotencyKey: string }): PublicationReceipt;
  ingestReviewFeedback(ctx: Ctx, i: { requestId: Id; pullRequestId: Id; externalEventId: string; headHash: Hash }): Outcome<ReviewFeedback>;
  scopeRevalidation(ctx: Ctx, i: { oldBinding: Hash; newBinding: Hash; feedbackIds: Id[]; coverage: CoverageRecord[] }): Outcome<RevalidationPlan>;
  // issue trail (2.O)
  bindRequestIssue(ctx: Ctx, i: { requestId: Id; repositoryId: Id; existingIssueId?: string; projectionHash: Hash; expectedVersion: number; idempotencyKey: string }): IssueBindingReceipt;
  syncRequestMilestones(ctx: Ctx, i: { requestId: Id; throughSequence: number; projectionPolicyHash: Hash }): IssueSyncReceipt;
  syncCapabilityRelations(ctx: Ctx, i: { requestId: Id; assessmentId: Id; relationIds: Id[] }): IssueSyncReceipt;
  getMutationOrigins(ctx: Ctx, i: { repositoryId: Id; path: string; revision: string }): Outcome<MutationLineage>;
  // concurrency (3.T) and scheduling (1.F)
  reserveMutationSurfaces(ctx: Ctx, i: { requestId: Id; surfaceIds: Id[]; expectedRevision: Hash; ttlMs: number }): Outcome<MutationLease>;
  assessConcurrentChanges(ctx: Ctx, i: { requestIds: Id[]; candidateBindings: Hash[]; snapshot: Snapshot }): Outcome<IntegrationAssessment>;
  cancelFeature(ctx: Ctx, i: { requestId: Id; reason: string }): CancellationReceipt;
  // models (1.G, 3.U)
  recordModelInvocation(ctx: Ctx, i: { modelIdentity: Omit<ModelInvocation, "id" | "outputHash">; inputRefs: Hash[]; parameters: Record<string, string | number | boolean>; outputHash: Hash }): ModelInvocation;
  evaluateBuilderVersion(ctx: Ctx, i: { modelIdentityHash: Hash; suiteHash: Hash; budget: { wallMs: number } }): Job<BuilderEvaluation>;
  // wizard (1.H, 2.N)
  openFeatureWorkspace(ctx: Ctx, i: { requestId: Id }): Outcome<FeatureWorkspace>;
  advanceWizard(ctx: Ctx, i: { requestId: Id; targetStage: WizardStage; expectedWorkspaceVersion: number }): Outcome<FeatureWorkspace>;
  compileChangeGraph(ctx: Ctx, i: { requestId: Id; candidateHash?: Hash; filters?: Record<string, string>; cursor?: string; budget: { nodes: number } }): Outcome<ChangeGraphPage>;
  investigateProductionAnomaly(ctx: Ctx, i: { requestId: Id; deploymentId: Id; evidenceIds: Id[] }): Outcome<InvestigationPlan>;
}

const op = (key: string, mutating: boolean, owner: string, note?: string): OpSpec => ({ key, mutating, owner, note });

/** One row per operation. Component prefixes follow the spec's ownership labels, not services (spec §21). */
export const OPS: OpSpec[] = [
  op("C02/submitFeature", true, "1.C"), op("C10/discoverFeatureContext", false, "1.C"), op("C02/resumeRequest", false, "1.B"),
  op("C15/normalizeRequirements", true, "2.I"), op("C15/detectSemanticConflicts", false, "2.I"), op("C25/checkRequirementConstraints", false, "2.I"),
  op("C23/assessFeatureImpact", false, "2.I"), op("C22/planClarifications", false, "2.I"),
  op("C02/recordDecision", true, "1.D"), op("C15/reviseContract", true, "1.D"),
  op("C10/findRelatedCapabilities", false, "2.I"), op("C15/compareRequestedBehaviour", false, "2.I"), op("C22/investigateOverlap", true, "2.I"),
  op("C23/assessReuseImpact", false, "2.I"), op("C16/verifyOverlap", false, "2.I"),
  op("C28/planFeatureChange", true, "1.E"), op("C28/planReuseChange", true, "1.E"), op("C28/materializeCandidate", true, "1.E"), op("C28/readCandidateFile", false, "1.E"),
  op("C27/runValidation", true, "2.J"), op("C27/runSecurityValidation", true, "2.K"), op("C25/reviewDependencyDiff", false, "2.K"),
  op("C26/assessPerformanceRisk", false, "2.M"), op("C27/runPairedBenchmark", true, "2.M"), op("C26/evaluatePerformance", false, "2.M"),
  op("C32/assessOperationalReadiness", false, "3.S"), op("C27/queryValidationResults", false, "2.J"), op("C23/queryRelatedTests", false, "3.P"),
  op("C16/verifyFeature", true, "2.J"), op("C28/exportFeaturePatch", true, "3.Q", "renamed from the spec's exportPatch: C28/exportPatch already exists for change proposals"), op("C28/checkPatchDestination", false, "3.Q"), op("C28/applyPatchCandidate", true, "3.Q"),
  op("C30/publishFeaturePR", true, "3.R"), op("C29/ingestReviewFeedback", true, "3.R"), op("C23/scopeRevalidation", false, "3.R"),
  op("C30/bindRequestIssue", true, "2.O"), op("C30/syncRequestMilestones", true, "2.O"), op("C30/syncCapabilityRelations", true, "3.T"), op("C23/getMutationOrigins", false, "3.T"),
  op("C07/reserveMutationSurfaces", true, "3.T"), op("C23/assessConcurrentChanges", false, "3.T"), op("C07/cancelFeature", true, "1.F"),
  op("C14/recordModelInvocation", true, "1.G"), op("C17/evaluateBuilderVersion", true, "3.U"),
  op("C01/openFeatureWorkspace", false, "1.H"), op("C02/advanceWizard", true, "1.H"), op("C19/compileChangeGraph", false, "2.N"),
  op("C22/investigateProductionAnomaly", true, "3.S", "schema only in slice 1 (PF-050)"),
];
