// Prompt-to-feature contracts (Wave 0, frozen). Source: Prompt-to-feature.md §18, §28, §40, §47 and the plan in
// docs/prompt-to-feature/IMPLEMENTATION_PLAN.md. Rules for later tasks:
//   * Add OPTIONAL fields freely; never rename, remove or retype a field or change a function signature without a
//     Wave-0 amendment (plan §5 rule 5).
//   * Persistence is the five record families below (plan §3). Everything else is a typed payload inside one of them.
//   * Every immutable payload carries `schemaVersion` and is identified with pf-canon-v1 (`./canon.ts`).
//   * A placeholder interface (marked OWNED BY) holds only identity fields; the owning task fills it in.
import type { CallContext } from "@cie/schema";

export type Id = string;
export type Hash = string;
export type Timestamp = string;
export type Ctx = CallContext;

export const FEATURE_SCHEMA_VERSION = 1 as const;

// ------------------------------------------------------------------------------------------------ primitives

export type SourceRef = { artifactId: Id; version: string; locator: string; contentHash: Hash };
export type Snapshot = { repositoryId: Id; commitHash: Hash; contentRootHash: Hash; indexGeneration: number; toolchainHash: Hash };
export type OutcomeStatus = "COMPLETE" | "PARTIAL" | "FAILED" | "CANCELLED" | "STALE";
export type Outcome<T> = { status: OutcomeStatus; value?: T; evidenceIds: Id[]; diagnostics: string[] };

export type OutcomeMode = "PLAN" | "BUILD_PREVIEW" | "CREATE_DRAFT_PR";
export type TrackingMode = "MANDATORY" | "OPTIONAL" | "OFFLINE_UNSYNCED";
export type EgressPolicy = "LOCAL_ONLY" | "CLOUD_ALLOWED";
/** Plan §2.4. Chosen from the actual change; T0 may skip executable gates with a rationale, T2 may not. */
export type Tier = "T0" | "T1" | "T2";

// §6.1
export type RequirementType = "FUNCTIONAL" | "ACCESS" | "INVARIANT" | "DATA" | "INTEGRATION" | "NONFUNCTIONAL" | "UX" | "COMPATIBILITY" | "OPERATIONAL";
export type RequirementOrigin = "USER" | "APPROVED_POLICY" | "APPROVED_REQUIREMENT" | "REPOSITORY_CONVENTION" | "OBSERVED_BEHAVIOUR" | "PROPOSED_ASSUMPTION";
export type Requirement = {
  id: Id; source: SourceRef; text: string; origin: RequirementOrigin; type: RequirementType;
  actorIds: Id[]; action?: string; resourceScope?: string; conditions: string[]; authorityBindingId?: Id;
  dependsOn: Id[]; acceptanceIds: Id[]; status: "ACTIVE" | "SUPERSEDED" | "PROPOSED";
  /** 2.I: how well the text is supported by the source it cites (0..1), computed by code; below the grounding threshold the requirement stays a PROPOSED assumption. */ grounding?: number;
};
/** Plan S6: where the expected result came from. A criterion backed only by GENERATED_UNREVIEWED cannot be verified. */
export type OracleOrigin = "USER_EXAMPLE" | "POLICY" | "EXISTING_TEST" | "REVIEWED_FIXTURE" | "GENERATED_UNREVIEWED";
export type AcceptanceCriterion = {
  id: Id; requirementIds: Id[]; scenario: string; expectedOutcome: string; mandatory: boolean;
  oracleSourceRefs: SourceRef[]; oracleOrigin: OracleOrigin; validationKinds: ValidationKind[]; performanceBudgetId?: Id;
};
export type Assumption = {
  id: Id; text: string; rationale: string; sourceRefs: SourceRef[]; reversible: boolean; affectedIds: Id[];
  state: "PROPOSED" | "ACCEPTED" | "REJECTED"; revisitTrigger: string;
};
export type FeatureContract = {
  schemaVersion: 1; id: Id; version: number; hash: Hash; requestId: Id; snapshot: Snapshot;
  requirements: Requirement[]; acceptance: AcceptanceCriterion[]; assumptions: Assumption[]; obligationIds: Id[];
  authorityPolicyHash: Hash; releasePlan?: ReleasePlan; overlap?: OverlapAssessment;
};

// §8
export type FindingKind = "CONTRADICTION" | "AMBIGUITY" | "GAP" | "TRADEOFF" | "ACCESS_CONFLICT" | "INVARIANT_VIOLATION" | "DEPENDENCY_GAP" | "IMPLEMENTATION_MISMATCH" | "DUPLICATE" | "TERMINOLOGY" | "CHANGE_IMPACT";
export type ResolutionOption = { id: Id; description: string; impacts: string[]; requiredAuthority: string };
export type RequirementFinding = {
  id: Id; kind: FindingKind; requirementIds: Id[]; sourceRefs: SourceRef[]; scope: string; explanation: string; witness?: string;
  status: "POTENTIAL" | "CONFIRMED" | "RESOLVED" | "DISMISSED"; blockingTaskIds: Id[]; options: ResolutionOption[]; decisionId?: Id;
  /** 2.I: who found it and by which rule. Only a DETERMINISTIC finding with a witness can be CONFIRMED; a model's concern stays POTENTIAL. */
  detector?: "DETERMINISTIC" | "MODEL"; rule?: string; impact?: "HIGH" | "MEDIUM" | "LOW";
};

// ------------------------------------------------------------------------------------------------ discovery (§30.1)

export type CoverageState = "COMPLETE_WITHIN_SCOPE" | "PARTIAL" | "UNSUPPORTED" | "NOT_SEARCHED" | "FAILED";
export type DiscoveryDomain = "CAPABILITIES" | "LANGUAGES" | "BUILD" | "TESTS" | "STARTUP" | "UI" | "API_CONVENTIONS" | "PERMISSIONS" | "TENANCY" | "DATA_ACCESS" | "WORKERS" | "MIGRATIONS" | "INTEGRATIONS" | "OBSERVABILITY";
export type CoverageRecord = {
  domain: DiscoveryDomain; state: CoverageState; searchedRoots: string[]; excluded: { root: string; reason: string }[];
  tools: string[]; found: "FOUND" | "NOT_FOUND_WITHIN_SEARCHED_SCOPE"; artifacts: string[]; unsupported: string[]; unresolved: string[];
};
/** OWNED BY 1.C. */
export type RepositoryAssessment = {
  schemaVersion: 1; id: Id; snapshot: Snapshot; coverage: CoverageRecord[]; conventions: string[];
  supportMatrix: { stack: string; supported: boolean; reason?: string }[]; existingDefects: string[]; uncovered: string[];
  /** Indexed entities whose names match the request's words (retrieval, not a claim of relevance). */
  relatedEntities?: { id: Id; name: string; file: string }[];
};

// ------------------------------------------------------------------------------------------------ the five record families

export type RequestState = "RECEIVED" | "DISCOVERING" | "CONTRACTING" | "IMPLEMENTING" | "VALIDATING" | "REVIEW_READY" | "PUBLISHED" | "CANCELLED" | "FAILED";
export type FeatureTaskState = "READY" | "RUNNING" | "BLOCKED" | "COMPLETE" | "FAILED" | "CANCELLED" | "STALE";
export type WizardStage = "DESCRIBE" | "CLARIFY" | "PLAN" | "CHANGES" | "VALIDATE" | "DELIVER";

export type IssueBinding = {
  repository: string; number?: number; nodeId?: string; syncState: "UNBOUND" | "TRACKING_BLOCKED" | "UNSYNCED" | "SYNCED" | "DIVERGED"; lastSyncedSequence: number; projectionRevision: number;
  /** 2.O: true when CIE opened the issue (only then may it close it); the destination's visibility decides how much is projected. */
  createdByCie?: boolean; visibility?: "PRIVATE" | "PUBLIC_OR_UNKNOWN"; projectionHash?: string; labels?: string[];
  /** Outbox pacing: the last comment time, and the earliest next attempt after a rate limit or outage. */
  lastSyncAt?: string; retryAfter?: string; failures?: number;
};
export type FeatureTask = { id: Id; componentId: string; requirementIds: Id[]; dependencyTaskIds: Id[]; obligationIds: Id[]; plannedEdits: string[]; capabilityIds: Id[]; state: FeatureTaskState; evidenceIds: Id[] };
export type FeatureWorkspace = {
  requestId: Id; stage: WizardStage; contractHash?: Hash; candidateHash?: Hash; issueRef?: string; blockers: Id[]; runningJobIds: Id[];
  validationSummaryRef?: Id; workspaceVersion: number;
  /** Read-model extras filled in by openFeatureWorkspace; never stored. */
  contractVersion?: number; state?: RequestState; mode?: OutcomeMode; candidateStatus?: CandidateRecord["status"];
  review?: import("./presentation.ts").FeatureReview;
};

/** 1/5. Request, contract, requirements, criteria, blockers, issue binding, overlap and release payloads. */
export type FeatureRecord = {
  schemaVersion: 1; requestId: Id; repositoryId: Id; mode: OutcomeMode; state: RequestState; tier?: Tier;
  promptRef: { artifactId: Id; contentHash: Hash; redactedPreview: string; /** The full prompt, kept for the owner only; the issue projection uses `redactedPreview`. */ text?: string };
  inputRefs: SourceRef[]; source: Snapshot; contractVersion: number; contract?: FeatureContract;
  tasks: FeatureTask[]; blockers: { id: Id; kind: "QUESTION" | "FINDING" | "DEPENDENCY" | "TRACKING"; requirementIds: Id[]; text: string; /** Authority scope needed to resolve it (default "business"). */ scope?: string; /** 2.I: answering these question ids first unblocks this child question (§7.2). */ dependsOn?: Id[] }[];
  issue: IssueBinding; workspace: FeatureWorkspace; version: number; createdBy: Id; createdAt: Timestamp; updatedAt: Timestamp;
  /** 2.I: findings raised against the current contract (§8), deterministic first, model-proposed second. */ findings?: RequirementFinding[];
  /** 2.I: the stored overlap/reuse assessment (§37), set by compareRequestedBehaviour. */ overlap?: OverlapAssessment;
  /** 3.R: reviewer feedback received on the published draft PR, one entry per external event (idempotent). */
  reviewFeedback?: ReviewFeedback[];
  /** 1.G: append-only invocation snapshots, including intent persisted before provider calls. */
  modelInvocations?: ModelInvocation[];
  /** Set by discovery (1.C). */ assessment?: RepositoryAssessment;
  budget?: { modelTokens: number; wallMs: number };
  validationPlan?: import("./validation.ts").ValidationPlan;
};

/** 2/5. Questions and answers, authority binding, waivers and dispositions. Immutable; supersession is a new record. */
export type DecisionRecord = {
  schemaVersion: 1; id: Id; requestId: Id; kind: "ANSWER" | "ASSUMPTION" | "RESOLUTION" | "WAIVER" | "DISPOSITION";
  questionId?: Id; findingId?: Id; answer: string; actorId: Id; authorityBindingId?: Id; contractVersion: number; affectedIds: Id[];
  rationale: string; createdAt: Timestamp; supersedesId?: Id;
  waiver?: { owner: Id; criteria: Id[]; expiresAt: Timestamp; residualRisk: string };
};

export type FileMutation = {
  oldPath?: string; newPath?: string; kind: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED"; beforeHash?: Hash; afterHash?: Hash;
  requirementIds: Id[]; taskIds: Id[]; actionIds: Id[]; attribution: "COMPLETE" | "PARTIAL" | "UNATTRIBUTED"; supporting?: boolean;
};
export type ModelInvocation = {
  id: Id; provider: string; model: string; requestedVersion?: string; resolvedVersion: string | "UNKNOWN"; weightDigest?: Hash;
  parameters: Record<string, string | number | boolean>; toolSchemaVersions: string[]; promptTemplateHash: Hash; inputRefs: Hash[];
  outputHash: Hash; seed?: number; egress: EgressPolicy; startedAt: Timestamp; interrupted?: boolean;
  schemaVersion?: 1; identityHash?: Hash; inputHash?: Hash; tokenizerDigest?: Hash;
  stage?: "REQUIREMENTS" | "CONTRACT" | "EDIT_PLAN";
  status?: "STARTED" | "COMPLETE" | "FAILED"; supersedesId?: Id; completedAt?: Timestamp; failureCode?: string;
};
export type PatchBinding = {
  repositoryId: Id; baseCommitHash: Hash; baseContentHash: Hash; candidateContentHash: Hash; diffHash: Hash; contractHash: Hash;
  originalOracleHash: Hash; candidateOracleHash: Hash; propertyChangeReviewId?: Id; runManifestIds: Id[]; mutationInventoryHash: Hash;
  generationProvenanceHash: Hash;
};
/** 3/5. Candidate identity, inventory and generation provenance; embeds PatchBinding and optional PatchExport. */
export type CandidateRecord = {
  schemaVersion: 1; id: Id; requestId: Id; ordinal: number; binding: PatchBinding; bindingHash: Hash;
  mutations: FileMutation[]; invocationIds: Id[]; status: "PLANNED" | "MATERIALIZED" | "STALE" | "SUPERSEDED"; createdAt: Timestamp;
  exports?: PatchExport[]; publication?: PublicationReceipt;
  /** 1.E: text of every changed file as the candidate has it (null = deleted) and as the base had it, so review never depends on a tree that may have moved. */
  contents?: Record<string, string | null>; baseContents?: Record<string, string | null>;
  /** The live repository's content root when the candidate was built; a different value later means the candidate is stale. */
  baseSnapshotRoot?: Hash;
  oracleState?: "ORIGINAL_PRESERVED" | "PROPERTY_CHANGE_PENDING_REVIEW" | "NO_ORACLE";
  oracleChanges?: { kind: string; file: string; testCase: string; detail: string }[];
  notes?: string[];
};

export type ValidationKind = "BUILD" | "TYPECHECK" | "STATIC" | "UNIT" | "INTEGRATION" | "BROWSER" | "SECURITY" | "DEPENDENCY" | "MIGRATION" | "PERFORMANCE" | "OPERATIONAL" | "REAL_PROVIDER";
export type RunManifest = {
  id: Id; contractHash: Hash; contentHash: Hash; buildHash: Hash; harnessHash: Hash; fixtureHash: Hash; workloadHash: Hash;
  environmentHash: Hash; toolchainHash: Hash; oracleHash: Hash; outcomesArtifactHash: Hash; generationProvenanceHash: Hash;
  modelIdentityHashes: Hash[]; startedAt: Timestamp; completedAt?: Timestamp; exitStatus: string; isolation: IsolationClass;
};
/** PASS_UNREVIEWED_ORACLE is a PASS whose only oracle is GENERATED_UNREVIEWED (plan S6): useful, never "verified". */
export type ValidationStatus = "PASS" | "PASS_UNREVIEWED_ORACLE" | "FAIL" | "INCOMPLETE" | "STALE" | "NOT_RUN" | "NOT_APPLICABLE";
export type ValidationResult = {
  id: Id; acceptanceId?: Id; kind: ValidationKind; target?: string; runManifestId: Id; status: ValidationStatus; evidenceIds: Id[]; gaps: string[];
  notApplicableRationale?: string;
  checkId?: Id; runState?: string; baselineHealth?: string; waivedBy?: Id[];
};
/** 4/5. A validation, security, dependency, performance or operational result bound to an exact candidate. */
export type EvidenceRecord = {
  schemaVersion: 1; id: Id; requestId: Id; candidateId: Id; bindingHash: Hash; kind: ValidationKind; manifest: RunManifest;
  results: ValidationResult[]; toolVersions: Record<string, string>; coverage: { state: CoverageState; gaps: string[] }; outcomeRef: Id;
  createdAt: Timestamp; performance?: PairedExperiment; verdict?: PublicationDecision;
  validation?: import("./validation.ts").ValidationEvidence;
};

export type EventType =
  | "FeatureSubmitted" | "ContractVersionCreated" | "RequirementFindingRaised" | "DecisionRecorded" | "TaskBlocked" | "CandidateCreated"
  | "ValidationCompleted" | "PerformanceAssessed" | "VerificationInvalidated" | "PublicationRequested" | "PublicationReconciled"
  | "FILE_ADDED" | "FILE_MODIFIED" | "FILE_DELETED" | "FILE_RENAMED" | "DEPENDENCY_CHANGED" | "REVIEW_APPLIED" | "PR_UPDATED" | "DEPLOYED" | "REVERTED"
  | "ReviewFeedbackIngested" | "WizardAdvanced" | "PatchExported" | "PatchApplied" | "Cancelled" | "ModelIdentityChanged" | "RequestReconciled" | "StateChanged";
/** 5/5. Request-scoped milestones. `sync` is the outbox state for the GitHub projection (plan P7/P8). */
export type EventRecord = {
  schemaVersion: 1; eventId: Id; requestId: Id; sequence: number; type: EventType; actor: Id; producer: string;
  requirementIds: Id[]; decisionIds: Id[]; before?: Hash; after?: Hash; result: "OK" | "FAILED" | "BLOCKED"; rationale: string; at: Timestamp;
  sync: { state: "PENDING" | "SENT" | "SKIPPED" | "FAILED"; remoteId?: string; attempts: number };
};

// ------------------------------------------------------------------------------------------------ validation, security, performance

export type IsolationClass = "LOCAL_PERMISSION_MODEL" | "CONTAINER" | "VM_BACKED";
export type PerformanceState = "WITHIN_BUDGET" | "REGRESSION" | "INCONCLUSIVE" | "UNVALIDATED" | "NOT_APPLICABLE";
export type PerformanceBudget = {
  id: Id; metric: string; units: string; aggregation: string; workloadDomainHash: Hash; absoluteLimit?: number; allowedDelta?: number;
  errorConstraints: string[]; measurementPlanHash: Hash; authorityBindingId?: Id;
};
export type PerfCase = "P0" | "P1" | "P2" | "P3";
/** One side of one pf-perf-core-v1 case: the complete outcome population (errors kept) plus per-metric samples. */
export type PerfOutcomeClass = "SUCCESS" | "ERROR" | "TIMEOUT" | "CANCELLED";
export type PerfCaseRun = {
  side: "BASELINE" | "CANDIDATE"; case: PerfCase; manifestId: Id; repetitions: number; completed: number;
  population: Record<PerfOutcomeClass, number>;
  metrics: Record<string, { samples: number[]; p50: number; p95: number; p99: number }>;
};
/** S11 verdict for one budget metric over one paired comparison. */
export type PerfBudgetVerdict = {
  budgetId: Id; state: PerformanceState; metric: string; comparison: string;
  repetitions: number; baselineP50: number; candidateP50: number; baselineP95: number; candidateP95: number;
  deltaP50: number; ciLow: number; ciHigh: number; limit?: number; reasons: string[];
};
export type PairedExperiment = {
  id: Id; profile: "pf-perf-core-v1"; baselineManifestIds: Id[]; candidateManifestIds: Id[]; populationHash: Hash; budgetIds: Id[];
  analysisPolicyHash: Hash; state: PerformanceState; cases: PerfCase[]; promotedBy: string[]; contended: boolean;
  /** 2.M additions (all optional). */
  requestId?: Id; candidateId?: Id; bindingHash?: Hash;
  createdAt?: Timestamp; measurementPlanHash?: Hash; workloadHash?: Hash; environmentHash?: Hash;
  /** False when no representative environment was recorded for the run (AT-19). */
  environmentRepresentative?: boolean;
  measurements?: Partial<Record<PerfCase, { baseline?: PerfCaseRun; candidate?: PerfCaseRun }>>;
  /** Cases the budget could not finish, with concrete reasons (AT-34; cost limits constrain execution, not truth). */
  caseStates?: Partial<Record<PerfCase, "COMPLETE" | "INCOMPLETE">>;
  incompleteReasons?: string[];
};
export type PublicationEligibility = "VERIFIED_WITHIN_SCOPE" | "REVIEW_ONLY_INCOMPLETE" | "BLOCKED";
export type PublicationDecision = {
  id: Id; purpose: string; contractHash: Hash; patchBindingHash: Hash; evidenceSetHash: Hash; authorityScopeHash: Hash; manifestHash: Hash;
  status: "ALLOW" | "BLOCK" | "INCOMPLETE" | "STALE"; eligibility: PublicationEligibility; reasons: string[];
};
export type ReleasePlan = {
  applicability: "APPLICABLE" | "NOT_APPLICABLE"; rationale?: string; flagStrategy?: string; deploymentOrder?: string[]; observationWindow?: string;
  stopCriteria?: string[]; operator?: string; killSwitch?: string; revertRunbook?: string; dataRecoveryLimits?: string;
  /** D001: the requester drafts; a plan is not a confirmed decision until a principal bound for release scope confirms it. */
  draftedBy?: Id; confirmedBy?: Id;
};

// ------------------------------------------------------------------------------------------------ overlap and concurrency (§37, §40)

export type CapabilityRef = { id: Id; snapshot: Snapshot; requirementIds: Id[]; entryPoints: string[]; sourceRefs: SourceRef[]; configBindingHash: Hash; availability: "AVAILABLE" | "DISABLED" | "UNDEPLOYED" | "UNKNOWN" };
export type BehaviourMapping = { acceptanceId: Id; capabilityIds: Id[]; disposition: "REUSED" | "MODIFIED" | "NEW" | "BLOCKED"; differences: string[]; evidenceIds: Id[]; coverageState: CoverageState };
export type OverlapRelationship = "EQUIVALENT" | "REQUEST_EXTENDS_EXISTING" | "EXISTING_SUPERSET" | "CONFIGURATION_ONLY" | "PARTIAL_OVERLAP" | "RELATED_INCOMPATIBLE" | "EXISTING_DEFECT" | "UNCERTAIN" | "NO_MATCH_WITHIN_SCOPE";
export type ReuseStrategy = "NO_CHANGE" | "CONFIGURE" | "EXTEND" | "COMPOSE" | "REFACTOR_AND_REUSE" | "SEPARATE" | "REPLACE";
export type OverlapAssessment = {
  id: Id; contractHash: Hash; comparedSnapshots: Snapshot[]; relationship: OverlapRelationship; strategy: ReuseStrategy;
  mappings: BehaviourMapping[]; alternatives: string[]; unresolvedIds: Id[]; decisionId?: Id;
  /** 2.I: what the comparison rests on (static observations of source, tests and configuration), the capabilities compared and the dimensions that differed. */
  observations?: OverlapObservation[]; capabilities?: CapabilityRef[]; differences?: { acceptanceId: Id; dimension: string; detail: string }[];
  /** Set by verifyOverlap: true only when every REUSED mapping has verified evidence; the policy the verification used. */
  verified?: boolean; policyHash?: Hash; regressionObligations?: string[]; reasons?: string[];
};
/** A fact read from the repository (or a recorded decision) that a mapping cites. Staleness is detectable from `contentHash`. */
export type OverlapObservation = { id: Id; kind: "ENTRY_POINT" | "TEST_REFERENCE" | "CONFIG_FLAG" | "ACCESS_CHECK" | "TENANT_SCOPE" | "SIDE_EFFECT" | "FAILURE_HANDLING" | "SKIPPED_TEST" | "DECISION"; path: string; line?: number; detail: string; contentHash: Hash };
export type RequestRelation = { fromRequestId: Id; toRequestId: Id; relationship: "DUPLICATES" | "DEPENDS_ON" | "EXTENDS" | "CONFLICTS_WITH"; sourceRefs: SourceRef[]; state: "PROPOSED" | "VERIFIED" | "SUPERSEDED" };
export type MutationLease = { id: Id; requestId: Id; surfaceIds: Id[]; expectedRevision: Hash; fencingToken: number; expiresAt: Timestamp };

// ------------------------------------------------------------------------------------------------ wizard and delivery (§47)

export type TestAssociation = { testId: Id; acceptanceIds: Id[]; fileIds: Id[]; basis: "EXPLICIT" | "STATIC_DEPENDENCY" | "OBSERVED_COVERAGE" | "REVIEWED" | "HEURISTIC"; sourceStatus: "EXISTING" | "ADDED" | "MODIFIED"; evidenceIds: Id[] };
export type PatchExport = {
  id: Id; requestId: Id; patchArtifactHash: Hash; manifestHash: Hash; candidateHash: Hash; baseHash: Hash; format: string; eligibility: PublicationEligibility;
  /** 3.Q: the exact bytes that leave (text only), the manifest they are bound to, the decision they were exported under and what the export may be called. */
  patch?: string; manifest?: unknown; decisionId?: Id; reasons?: string[]; exportPolicyHash?: Hash; label?: string;
};
export type PublicationReceipt = {
  id: Id; kind: "DRAFT_PR" | "ISSUE_SYNC" | "PATCH_APPLY"; remoteRef?: string; headHash?: Hash; decisionId: Id; at: Timestamp;
  /** 3.R: where the draft PR is, the exact commit that was pushed, and what it was bound to. */
  repository?: string; branch?: string; prNumber?: number; commit?: Hash; eligibility?: PublicationEligibility; idempotencyKey?: string; updated?: boolean; notes?: string[]; /** D005: the publish binding that allowed this write. */ authorityBindingId?: Id;
};

// ------------------------------------------------------------------------------------------------ placeholders (fields added by the owning task)

type Placeholder = { schemaVersion: 1; id: Id };
export type FeatureRequest = Placeholder & { requestId: Id; state: RequestState; replayed: boolean; mode?: OutcomeMode; warnings?: string[] }; // OWNED BY 1.C
export type FeatureContractDraft = Placeholder & { contract: FeatureContract; findingIds: Id[] };                 // OWNED BY 1.G / 2.I
export type ImpactAssessment = Placeholder & { affectedIds: Id[]; staleIds: Id[]; reasons?: string[]; regressionObligations?: string[]; consumers?: string[]; gaps?: string[] };                               // OWNED BY 2.I
export type QuestionBatch = Placeholder & { questions: { id: Id; text: string; choices: string[]; whyNeeded: string; blocks: Id[]; scope?: string; dependsOn?: Id[] }[]; assumptions?: Id[]; deferred?: Id[]; independentTaskIds?: Id[] }; // OWNED BY 2.I
export type FeaturePlan = Placeholder & { tasks: FeatureTask[]; tier: Tier; reuse: BehaviourMapping[] };          // OWNED BY 2.I / 1.E
export type PerformanceRiskAssessment = Placeholder & { applicable: boolean; triggers: string[]; rationale?: string[]; contractHash?: Hash; patchBindingHash?: Hash }; // OWNED BY 2.M
export type PerformanceAssessment = Placeholder & { state: PerformanceState; reasons: string[]; pairedExperimentId?: Id; evidenceIds?: Id[]; verdicts?: PerfBudgetVerdict[] }; // OWNED BY 2.M
export type DependencyReview = Placeholder & { status: "PASS" | "BLOCKED" | "INCOMPLETE"; findings: string[] };   // OWNED BY 2.K
export type SecurityAssessment = Placeholder & { status: "PASS" | "BLOCKED" | "INCOMPLETE"; findings: string[] }; // OWNED BY 2.K
export type OperationalAssessment = Placeholder & {
  status: "PASS" | "INCOMPLETE" | "NOT_APPLICABLE" | "BLOCKED"; gaps: string[];
  /** 3.S: what was checked and on what basis (static patterns on the added lines, or the declared release plan). */
  checks?: { id: string; state: "PASS" | "GAP" | "BLOCKING" | "NOT_APPLICABLE"; detail: string; basis: "STATIC_PATTERN" | "DECLARED" | "RULE"; paths: string[] }[];
  blocking?: string[]; tier?: Tier; rationale?: string;
}; // OWNED BY 3.S
export type ReviewFeedback = Placeholder & {
  classification: "REQUIREMENT" | "CORRECTION" | "PREFERENCE" | "POLICY"; headHash: Hash;
  /** 3.R: the external event it came from (idempotency key), the PR, a redacted excerpt, whether it targets the head now published, and where it must go next. */
  externalEventId?: string; pullRequestId?: string; author?: string; excerpt?: string; path?: string; onCurrentHead?: boolean;
  status?: "OPEN" | "ON_OLDER_HEAD" | "UNKNOWN_HEAD"; routing?: string; requiresAuthority?: string; receivedAt?: Timestamp;
}; // OWNED BY 3.R
export type RevalidationPlan = Placeholder & { rerun: ValidationKind[]; reuse: Id[]; broaderBecause: string[] };  // OWNED BY 3.R
export type BuilderEvaluation = Placeholder & {
  modelIdentityHash: Hash; suiteHash: Hash; passed: boolean;
  /** 3.U: one row per conformance case, the identities the route actually reported, and why it did not pass. */
  cases?: { id: string; state: "PASS" | "FAIL" | "NOT_RUN"; detail: string }[]; observedIdentityHashes?: Hash[]; reasons?: string[]; evaluatedAt?: Timestamp;
};      // OWNED BY 3.U
export type IssueBindingReceipt = Placeholder & { issue: IssueBinding; created?: boolean; labelsApplied?: string[]; warnings?: string[] };                                           // OWNED BY 2.O
export type IssueSyncReceipt = Placeholder & { throughSequence: number; remoteIds: string[]; deferredUntil?: string; skipped?: number; sent?: number; state?: IssueBinding["syncState"]; warnings?: string[] };                    // OWNED BY 2.O
export type MutationLineage = Placeholder & { path: string; origins: { requestId: Id; eventId: Id; commit?: Hash }[] }; // OWNED BY 3.T
export type InvestigationPlan = Placeholder & { steps: string[] };                                                 // OWNED BY 3.S (schema only in slice 1)
export type ApplicationAssessment = Placeholder & { applies: boolean; conflicts: string[]; dirty: string[]; exportId?: Id; baseExact?: boolean; destinationRoot?: Hash; blocked?: string[] };    // OWNED BY 3.Q
export type ApplicationReceipt = Placeholder & { applied: string[]; notApplied: string[]; resultContentHash?: Hash; worktree?: string; exportId?: Id; matchesCandidate?: boolean }; // OWNED BY 3.Q
export type IntegrationAssessment = Placeholder & {
  compatible: boolean; conflicts: string[];
  /** 3.T: individually verified candidates are NOT verified together; `reverify` is true whenever more than one candidate is combined, and `integratedContentHash` names the combined tree to verify. */
  reverify?: boolean; integratedContentHash?: Hash; overlaps?: { path: string; requestIds: Id[] }[]; order?: Id[]; notes?: string[];
};                  // OWNED BY 3.T
export type OverlapEvidence = Placeholder & { evidenceIds: Id[]; observations?: OverlapObservation[]; stepsUsed?: number; unresolvedIds?: Id[] };                                                // OWNED BY 2.I
export type VerifiedOverlapAssessment = Placeholder & { assessment: OverlapAssessment; verified: boolean };      // OWNED BY 2.I
export type ValidationPage = { results: ValidationResult[]; nextCursor?: string; coverage: { state: CoverageState; gaps: string[] } }; // OWNED BY 2.J
export type CancellationReceipt = Placeholder & { requestId: Id; stoppedJobIds: Id[]; externalEffects: string[] };// OWNED BY 1.F
export type ChangeGraphPage = { viewSpec: unknown; presentationManifest: unknown; nextCursor?: string };          // OWNED BY 2.N

// ------------------------------------------------------------------------------------------------ frozen interfaces

export type RunnerCapabilities = {
  /** Allowed argv prefixes; anything else is refused before spawn. */
  commands: string[][]; readRoots: string[]; writeRoots: string[]; network: "DENY" | { allow: string[] }; secretRefs: string[];
  limits: { wallMs: number; cpuMs?: number; memoryBytes?: number; outputBytes: number; processes?: number };
};
export type RunRequest = { capabilities: RunnerCapabilities; argv: string[]; cwd: string; env?: Record<string, string>; fencingToken?: number };
export type RunStatus = "PASSED" | "FAILED" | "TIMEOUT" | "INFRA_ERROR" | "CANCELLED" | "RESOURCE_LIMIT" | "REFUSED";
export type RunResult = {
  status: RunStatus; exitCode: number | null; stdout: string; stderr: string; truncated: boolean; isolation: IsolationClass;
  /** Guarantees the runner does NOT provide (e.g. no cpu/memory limit); always disclosed with the result. */
  omissions: string[]; usage: { wallMs: number; peakRssBytes?: number };
  /** Boundary violations found around the run (for example a symlink that escapes the roots). A run with violations is never a pass. */
  violations?: string[];
  /** Why the runner refused or stopped the run, when it did. */
  reason?: string;
};
/** OWNED BY 1.F. Generated code only ever runs through this interface; nothing falls back to an unrecorded boundary. */
export interface Runner { readonly isolation: IsolationClass; readonly omissions: readonly string[]; run(req: RunRequest, signal?: AbortSignal): Promise<RunResult> }

/** OWNED BY 1.B. All writes are atomic with their outbox event; pointers move by compare-and-swap on `version`. */
export interface FeatureStore {
  createRequest(rec: FeatureRecord, firstEvent: Omit<EventRecord, "sequence" | "sync">, idempotencyKey: string): { record: FeatureRecord; replayed: boolean };
  getRequest(requestId: Id): FeatureRecord | null;
  /** Throws VERSION_CONFLICT when `expectedVersion` is not current. */
  updateRequest(requestId: Id, expectedVersion: number, next: FeatureRecord, event?: Omit<EventRecord, "sequence" | "sync">): FeatureRecord;
  putDecision(rec: DecisionRecord, event?: Omit<EventRecord, "sequence" | "sync">): DecisionRecord;
  listDecisions(requestId: Id): DecisionRecord[];
  putCandidate(rec: CandidateRecord, event?: Omit<EventRecord, "sequence" | "sync">): CandidateRecord;
  getCandidate(id: Id): CandidateRecord | null;
  listCandidates(requestId: Id): CandidateRecord[];
  putEvidence(rec: EvidenceRecord, event?: Omit<EventRecord, "sequence" | "sync">): EvidenceRecord;
  listEvidence(candidateId: Id): EvidenceRecord[];
  appendEvent(ev: Omit<EventRecord, "sequence" | "sync">): EventRecord;
  listEvents(requestId: Id, afterSequence?: number, limit?: number): EventRecord[];
  pendingSync(limit: number): EventRecord[];
  markSynced(eventId: Id, result: EventRecord["sync"]): void;
}
