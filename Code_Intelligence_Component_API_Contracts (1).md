# Code Intelligence Component Implementation Contracts

Version 1.1 · 3 October 2026

This is the proposed implementation contract for all 32 logical components. It defines public operations, typed inputs and outputs, owned entities, internal high-level functions, component dependencies, and requirement-level traceability. The notation resembles TypeScript but is pseudocode, not executable generated code.

All requirements remain **Planned / Not verified**. Explicit requirements receive named operations; use-case assignments are proposed. Source-block assignments remain candidates requiring clause review. Calling an API alone does not satisfy a non-functional requirement: the implementation must also pass its original acceptance thresholds.

## 1 Shared execution contract

```typescript
// Every public operation uses this envelope, including read operations.
operation(ctx: CallContext, req: TypedRequest): Promise<ApiResult<TypedResponse>>

// Local rendering operations may return synchronously with the same result envelope.
// A long-running operation returns Job<T>. GetJob and streamed job events reveal progress.
// ctx.actor is established by the trusted transport; never accept it from request JSON.
```

- Validate request schemas and reject extra unsupported executable fields. SchemaValue carries a registry schema ID; it is not an unrestricted escape hatch.
- Authorize before retrieving content and again before model egress, sharing or export. Cache keys include tenant, permission epoch, repository revision, model/prompt version and schema version.
- A read is bound to a committed revision or an explicit working-tree overlay. An empty expectedRevision is allowed only for bootstrap operations that establish a revision; it does not mean “use whichever revision”.
- Every mutating request carries an idempotency key and expected resource version where applicable. An idempotency-key replay with different payload bytes is a conflict, never a new execution.
- Atomically store state transitions and outbox events. Use at-least-once delivery, deduplication and reconciled external side effects. Acknowledgement requires committed durable state.
- Forward deadlines and cancellation fences to every dependency. Cancelled work may finish an unavoidable provider request but cannot publish a result after its fence is invalidated.
- Errors preserve revision/version diagnostics. Never fall back from forbidden evidence to model speculation that reveals the denied source. Partial results retain explicit gaps.
- Job outputs are typed by registered result schema. The C31 persistence representation uses Job<SchemaValue>; the owning component decodes it to Job<T> after schema validation.
- Streaming responses carry requestId, viewId, baseVersion, newVersion, revision and monotonic sequence. Discard stale patches and request replay; do not overwrite newer user state.
- Raw code, secrets, PII and model prompts are excluded from ordinary logs. Rationale means a concise explanation, not hidden chain-of-thought.

### Transport binding

These APIs are logical service contracts, not 32 independent HTTP services. Within the TypeScript core they are module interfaces. Rust boundaries use the versioned JSON request/result envelopes and local IPC protocol defined in Section 10. The public gateway exposes authenticated `/api/v1/components/{componentId}/{operation}` command routes for allowlisted public operations, with asynchronous progress through job/event streams. Storage internals, provider credentials and privileged recovery functions are excluded from browser dispatch. Method allowlists are versioned separately from the interface catalogue.

## 2 Shared entities and closed enums

Byte offsets are zero-based and end-exclusive; timestamps are UTC; time-window ends are exclusive. Levels are integers 0–6. Monetary model budgets use exact decimal strings and an explicit currency. Model capability, form, tool and schema IDs are registry entries, not executable source supplied by a model.

```typescript
EntityRef { tenantId: Id; repoId: Id; branchId: Id; revision: RevisionId; entityId: Id }
RevisionRef { tenantId: Id; repoId: Id; branchId: Id; revision: RevisionId; overlayId: Option<Id> }
SourceSpan { sourceId: Id; contentHash: Hash; revision: RevisionId; startByte: Int; endByteExclusive: Int }
EvidenceRef { id: Id; sourceId: Id; location: EvidenceLocation; class: EvidenceClass; observedAt: Timestamp; accessScopeId: Id; state: EvidenceState }
EvidenceLocation = CodeLocation { span: SourceSpan } | RuntimeLocation { backendHandle: Id; deploymentId: Id; start: Timestamp; end: Timestamp } | DocumentLocation { documentId: Id; version: Id; locator: String } | TestLocation { runId: Id; testId: Id }
Entity { ref: EntityRef; kind: String; name: String; spans: List<SourceSpan>; aliases: List<Id>; validity: ValidityInterval }
Fact { id: Id; subject: EntityRef; predicate: String; object: FactValue; evidence: List<EvidenceRef>; resolution: ResolutionKind; analyzerVersion: String }
FactValue = EntityValue { ref: EntityRef } | ScalarValue { value: Scalar } | UnknownValue { reason: String }
Relationship { id: Id; from: EntityRef; to: EntityRef; kind: String; evidence: List<EvidenceRef>; resolution: ResolutionKind }
SourceEnvelope { sourceId: Id; sourceType: String; revision: RevisionRef; checksum: Hash; timestamp: Timestamp; accessScopeId: Id; contentHandle: Id; quality: List<String> }
MultiRevisionRef { snapshotId: Id; revisions: List<RevisionRef>; policyEpoch: Int }
MultiGraphProjection { id: Id; snapshot: MultiRevisionRef; projections: List<GraphProjection>; crossRepositoryLinks: List<Relationship>; unknownJoins: List<String> }
MultiEvidenceBundle { id: Id; snapshot: MultiRevisionRef; bundles: List<EvidenceBundle>; joinEvidence: List<EvidenceRef>; unresolved: List<String> }
MultiViewSpec { id: Id; version: Int; snapshot: MultiRevisionRef; panels: List<ViewSpec>; crossPanelEdges: List<ViewEdge>; cameraPolicy: CameraPolicy }
AnalysisBatch { revision: RevisionRef; entities: List<Entity>; facts: List<Fact>; relationships: List<Relationship>; diagnostics: List<Diagnostic>; analyzerVersion: String }
GraphProjection { id: Id; revision: RevisionRef; entities: List<Entity>; facts: List<Fact>; relationships: List<Relationship>; truncated: Bool; unknownRegions: List<String> }
EvidenceBundle { id: Id; revision: RevisionRef; evidence: List<EvidenceRef>; excerptHandles: List<Id>; coverage: List<String>; unresolved: List<String>; tokenEstimate: Int }
ConceptCard { id: Id; revision: RevisionRef; kind: String; summary: String; members: List<EntityRef>; evidence: List<EvidenceRef>; claimIds: List<Id>; confirmation: Option<Verdict>; dependencyIds: List<Id> }
ContextEvent { id: Id; sequence: Int; sessionId: Id; kind: ContextEventKind; refs: List<EntityRef>; viewRevision: Option<Int>; timeWindow: Option<TimeWindow>; text: Option<String>; privacyClass: String }
ContextSnapshot { id: Id; sequence: Int; sessionId: Id; revision: RevisionRef; selected: List<EntityRef>; pins: List<EntityRef>; taskId: Option<Id>; lensId: Id; timeWindow: Option<TimeWindow>; hypothesisIds: List<Id>; expiresAt: Timestamp }
TaskFrame { id: Id; question: String; revision: RevisionRef; roots: List<EntityRef>; goal: String; lensId: Id; constraints: List<String>; budget: Budget; timeWindow: Option<TimeWindow> }
SaliencePlan { id: Id; revision: RevisionRef; entries: List<SalienceEntry>; lensId: Id; protectedFacts: List<Id> }
SalienceEntry { entityId: Id; tier: SalienceTier; sixFactorScores: List<FactorScore>; explanation: String; manualOverride: Option<SalienceTier> }
FactorScore { factor: SalienceFactor; rawValue: Float; normalizedScore: Float; reason: String; evidenceIds: List<Id> }
Workspace { id: Id; name: String; version: Int; revision: RevisionRef; contextId: Id; viewIds: List<Id>; hypothesisIds: List<Id>; eventsThrough: Int; aclId: Id }
WorkspaceEvent { id: Id; workspaceId: Id; sequence: Int; actorId: Id; type: String; payload: WorkspacePayload; timestamp: Timestamp }
WorkspacePayload = PinPayload { refs: List<EntityRef> } | AnnotationPayload { entity: EntityRef; text: String } | HypothesisPayload { hypothesisId: Id; state: HypothesisState } | ViewPayload { viewId: Id } | ClaimPayload { claimId: Id; version: Int }
ModelRequest { id: Id; taskId: Id; evidenceBundleId: Id; schemaId: Id; purpose: ModelPurpose; modelPolicyId: Id; budget: Budget; egressGrantId: Id; promptTemplateId: Id; inputHandle: Id }
ModelOutput { requestId: Id; validatedValue: SchemaValue; schemaId: Id; usage: ModelUsage; provenance: ModelRunRef; refusal: Option<String> }
SchemaValue { schemaId: Id; json: JsonValue }
ModelUsage { inputTokens: Int; outputTokens: Int; elapsedMs: Int; billedCost: Decimal; currency: String }
ModelRunRef { runId: Id; provider: String; model: String; configurationHash: Hash; promptTemplateVersion: String }
ClaimDraft { id: Id; revision: RevisionRef; assertion: String; claimClass: String; evidenceIds: List<Id>; counterEvidenceIds: List<Id>; rationaleSummary: String; dependencies: List<Id>; modelRun: Option<ModelRunRef> }
Claim { draft: ClaimDraft; version: Int; state: ClaimState; gateReportId: Option<Id>; verdicts: List<Verdict>; invalidatedAt: Option<Timestamp> }
GateReport { id: Id; claimId: Id; gates: List<GateOutcome>; confidence: Confidence; displayMode: DisplayMode; alarmEligible: Bool; counterArgument: String; checkedRevision: RevisionRef }
GateOutcome { gate: ClaimGate; status: GateStatus; reasons: List<String>; evidenceIds: List<Id> }
Confidence { mode: ConfidenceMode; band: Option<ProbabilityBand>; calibrationId: Option<Id>; reasonCodes: List<String> }
ProbabilityBand { lower: Float; upper: Float; sampleCount: Int; confidenceLevel: Float }
Verdict { id: Id; actorId: Id; claimId: Id; verdict: VerdictKind; explanation: String; timestamp: Timestamp; evidenceIds: List<Id> }
RepresentationIntent { taskId: Id; suggestedForm: Option<FormId>; roots: List<EntityRef>; desiredLevel: Int; compareScenarioId: Option<Id>; preserveCamera: Bool }
ViewSpec { id: Id; version: Int; revision: RevisionRef; taskId: Id; formId: FormId; formVersion: Int; caption: String; lensId: Id; level: Int; nodes: List<ViewNode>; edges: List<ViewEdge>; groups: List<ViewGroup>; legend: List<LegendItem>; cameraPolicy: CameraPolicy }
ViewNode { id: Id; entityRefs: List<EntityRef>; label: String; claimIds: List<Id>; evidenceIds: List<Id>; tier: SalienceTier; displayMode: DisplayMode; geometry: Option<Geometry> }
ViewEdge { id: Id; fromNodeId: Id; toNodeId: Id; relationshipId: Option<Id>; claimId: Option<Id>; evidenceIds: List<Id>; displayMode: DisplayMode }
ViewGroup { id: Id; childNodeIds: List<Id>; collapsedNodeId: Id; level: Int; evidenceIds: List<Id> }
LegendItem { label: String; evidenceClass: EvidenceClass; encoding: List<String> }
ViewPatch { viewId: Id; baseVersion: Int; newVersion: Int; revision: RevisionRef; operations: List<ViewOperation>; preserveNodeIds: List<Id>; cameraPolicy: CameraPolicy }
ViewOperation = AddNode { node: ViewNode } | UpdateNode { node: ViewNode } | RemoveNode { nodeId: Id } | AddEdge { edge: ViewEdge } | RemoveEdge { edgeId: Id } | SetGroup { group: ViewGroup } | SetCaption { text: String }
Geometry { x: Float; y: Float; width: Float; height: Float }
Viewport { x: Float; y: Float; scale: Float; focusedNodeId: Option<Id> }
CameraPolicy { behavior: CameraBehavior; anchorNodeId: Option<Id>; userCameraSequence: Int }
ZoomIntent { viewId: Id; baseViewVersion: Int; anchorNodeId: Id; fromLevel: Int; toLevel: Int; gestureSequence: Int; trigger: ZoomTrigger; userCameraSequence: Int }
ZoomPolicy { version: Int; entryThresholds: List<Float>; exitThresholds: List<Float>; dwellMs: Int; maxForegroundNodes: Int; autoSemanticZoom: Bool; autoCameraMove: Bool }
Interaction { id: Id; kind: InteractionKind; viewId: Id; viewVersion: Int; selectedNodeIds: List<Id>; text: Option<String>; timeWindow: Option<TimeWindow>; gesture: Option<Gesture>; inputSequence: Int }
Gesture { kind: String; sourceNodeIds: List<Id>; targetNodeId: Option<Id>; x: Float; y: Float }
ResolvedInteraction { command: Command; contextEvents: List<ContextEvent>; ambiguous: Bool; clarification: Option<String> }
Command { id: Id; type: CommandKind; subjectId: Id; expectedVersion: Int; payload: SchemaValue }
Hypothesis { id: Id; workspaceId: Id; claimId: Id; state: HypothesisState; discriminatingEvidenceIds: List<Id>; proposedExperimentIds: List<Id> }
InvestigationPlan { id: Id; workspaceId: Id; version: Int; scope: List<EntityRef>; steps: List<PlanStep>; maxSteps: Int; remainingBudget: Budget; state: PlanState }
PlanStep { id: Id; tool: ToolId; request: SchemaValue; dependsOn: List<Id>; state: PlanState; resultHandle: Option<Id> }
ChangeSet { id: Id; base: RevisionRef; head: RevisionRef; changedEntities: List<EntityRef>; changedFacts: List<Id>; consequenceClaimIds: List<Id>; threadIds: List<Id> }
RuntimeEnvelope { id: Id; sourceId: Id; deploymentId: Option<Id>; codeRevision: Option<RevisionRef>; window: TimeWindow; backendHandle: Id; quality: List<String>; signalKind: String }
RuntimeAttribution { id: Id; runtimeId: Id; entityRefs: List<EntityRef>; evidenceIds: List<Id>; method: String; exact: Bool; uncertaintyReason: Option<String> }
Finding { id: Id; analysisKind: String; claimIds: List<Id>; evidenceIds: List<Id>; affected: List<EntityRef>; status: String; severity: String; alarmEligible: Bool; missingEvidence: List<String> }
Scenario { id: Id; baseline: RevisionRef; assumptions: List<Assumption>; changes: List<ScenarioChange>; resultClaimIds: List<Id>; measuredRunId: Option<Id>; state: String }
Assumption { id: Id; description: String; evidenceIds: List<Id>; confirmedBy: Option<Id> }
ScenarioChange { kind: String; target: EntityRef; replacement: Option<EntityRef>; value: Option<Scalar> }
IntentCandidate { id: Id; interactionId: Id; interpretation: String; targetRefs: List<EntityRef>; confidence: Confidence; ambiguous: Bool; clarification: Option<String> }
Proposal { id: Id; base: RevisionRef; intentId: Id; scenarioId: Option<Id>; patchHandle: Id; validationRunIds: List<Id>; state: ProposalState; requiredApprovalIds: List<Id> }
ShareGrant { id: Id; resourceId: Id; principalId: Id; role: String; sourceAccessCheckedAt: Timestamp; expiresAt: Option<Timestamp> }
ExportArtifact { id: Id; workspaceId: Id; snapshotVersion: Int; contentHandle: Id; format: String; evidenceManifestId: Id; expiresAt: Option<Timestamp> }
AuditEvent { id: Id; actorId: Id; action: String; resourceId: Id; metadataHandle: Id; timestamp: Timestamp; previousHash: Hash; eventHash: Hash }
PolicyDecision { allowed: Bool; reasonCodes: List<String>; policyVersion: Int; accessScopeId: Id; expiresAt: Timestamp }
EgressGrant { id: Id; destination: String; payloadHash: Hash; approvedFields: List<String>; policyVersion: Int; expiresAt: Timestamp }
EvalReport { id: Id; datasetVersion: String; modelRuns: List<ModelRunRef>; metricValues: List<MetricValue>; failures: List<Diagnostic>; releaseEligible: Bool }
MetricValue { name: String; value: Float; unit: String; cohort: String; sampleCount: Int }
CalibrationRecord { id: Id; claimClass: String; modelVersion: String; cohort: String; labelledCount: Int; bands: List<ProbabilityBand>; validUntil: Timestamp }
Job<T> { id: Id; ownerComponent: ComponentId; state: JobState; revision: RevisionRef; checkpointSequence: Int; progress: Float; output: Option<T>; error: Option<ApiError> }
CommitReceipt { commandId: Id; transactionId: Id; committedSequence: Int; resourceVersion: Int }
Diagnostic { code: String; message: String; relatedEntityIds: List<Id>; retryable: Bool }
ValidityInterval { from: Timestamp; toExclusive: Option<Timestamp> }
TimeWindow { start: Timestamp; endExclusive: Timestamp }
Budget { maxTokens: Int; maxCost: Decimal; currency: String; deadline: Timestamp; maxToolSteps: Int }
DependencyImpact { revision: RevisionRef; changedIds: List<Id>; invalidatedConceptIds: List<Id>; staleClaimIds: List<Id>; affectedViewIds: List<Id>; affectedWorkspaceIds: List<Id> }
RetentionPolicy { id: Id; workingTtlSeconds: Int; episodeTtlSeconds: Int; semanticTtlSeconds: Int; proceduralTtlSeconds: Int; backupExpirySeconds: Int; minimizedAuditTtlSeconds: Int }
HealthReport { component: ComponentId; state: String; lastSuccessfulRun: Option<Timestamp>; queueDepth: Int; diagnostics: List<Diagnostic> }
FormContract { formId: FormId; version: Int; inputSchemaId: Id; allowedPrimitives: List<String>; evidenceRules: List<String>; keyboardActions: List<String> }

CallContext { requestId: Id; idempotencyKey: Id; actor: ServerIdentity; expectedRevision: Option<RevisionRef>; deadline: Timestamp; cancellation: CancellationToken; traceId: Id }
ServerIdentity { principalId: Id; tenantId: Id; sessionId: Id; verifiedAt: Timestamp; policyVersion: Int }
CancellationToken { operationId: Id; fence: Int }
ApiError { code: ErrorCode; message: String; retryable: Bool; currentVersion: Option<Int>; diagnostics: List<Diagnostic> }
ApiResult<T> = Success { value: T; metadata: ResponseMetadata } | Failure { error: ApiError; metadata: ResponseMetadata }
ResponseMetadata { requestId: Id; revision: Option<RevisionRef>; resourceVersion: Option<Int>; completeness: Completeness; warnings: List<Diagnostic> }
TransactionPlan { expectedVersions: List<RecordVersion>; writes: List<RecordWrite>; eventWrites: List<WorkspaceEvent>; outbox: List<Command> }
RecordVersion { store: StoreKind; key: Id; version: Int }
RecordWrite { store: StoreKind; key: Id; schemaId: Id; value: SchemaValue; accessScopeId: Id }
GraphQuery { roots: List<EntityRef>; edgeKinds: List<String>; maxNodes: Int; maxDepth: Int; reverse: Bool; accessScopeId: Id }
SearchQuery { store: StoreKind; tenantId: Id; repoIds: List<Id>; revisions: List<RevisionId>; text: String; vectorHandle: Option<Id>; limit: Int; accessScopeId: Id }
Id = String; RevisionId = String; Hash = String; ComponentId = String; FormId = String; ToolId = String
Timestamp = String; Decimal = ExactDecimalString; Scalar = String | Bool | Int | Float | Decimal
JsonValue = Null | Bool | Int | Float | String | List<JsonValue> | Dictionary<String, JsonValue>
Option<T> = None | Some<T>; List<T> = ordered_collection<T>; Dictionary<K,V> = typed_map<K,V>
EvidenceClass = STATIC_PARSED | STATIC_RESOLVED | RUNTIME | TEST | HISTORY | DOCUMENT | HUMAN_JUDGMENT | INFERRED | SPECULATIVE
EvidenceState = CURRENT | STALE | UNAVAILABLE | ACCESS_REVOKED
ResolutionKind = PARSED | RESOLVED | OBSERVED | UNRESOLVED
SalienceTier = CRITICAL | RELEVANT | CONTEXT | HIDDEN
SalienceFactor = TASK_MATCH | RECENCY | STRUCTURAL_CENTRALITY | RUNTIME_HOTNESS | USER_OVERRIDE | SEMANTIC_JUDGMENT
ContextEventKind = SELECTION | OPEN_FILE | DIFF | BREAKPOINT | QUESTION | PIN | ZOOM | LENS | RUNTIME_SIGNAL
ClaimState = DRAFTED | EVIDENCED | DISPLAYED | CONFIRMED | REFUTED | PROMOTED | RETIRED | STALE
ClaimGate = GROUNDING | CONSISTENCY | ADVERSARIAL | CALIBRATION | DISPLAY
GateStatus = PASS | FAIL | INSUFFICIENT | NOT_APPLICABLE
ConfidenceMode = CALIBRATED | UNCALIBRATED | NOT_ESTIMATED
DisplayMode = FACT | INFERENCE | HYPOTHESIS | FOG | HIDDEN
VerdictKind = CONFIRM | REFUTE | DISPUTE
CameraBehavior = PRESERVE | USER_REQUESTED_FOCUS | USER_REQUESTED_FIT
ZoomTrigger = USER_EXPAND | USER_COLLAPSE | VIEWPORT_THRESHOLD | CONVERSATIONAL_REQUEST
InteractionKind = ASK | SELECT | LASSO | PIN | UNPIN | EXPAND | COLLAPSE | VIEWPORT | DRAG | CONFIRM | REFUTE | EXPLAIN | SCRUB
CommandKind = UPDATE_CONTEXT | UPDATE_WORKSPACE | UPDATE_CLAIM | INDEX_REVISION | PROPOSE_CHANGE | CONFIGURE | CANCEL
HypothesisState = OPEN | SUPPORTED | REFUTED | UNRESOLVED
PlanState = READY | RUNNING | BLOCKED | CANCELLED | FINISHED
ProposalState = DRAFT | NEEDS_CLARIFICATION | VALIDATING | REVIEWABLE | REJECTED | EXPORTED
JobState = QUEUED | RUNNING | WAITING | SUCCEEDED | FAILED | CANCELLED
ModelPurpose = EXTRACT | REASON | CHALLENGE | REPRESENT | PROPOSE_PATCH
ProjectionOperation = PROJECT | ABSTRACT | EXPAND | TRACE | COMPARE | SIMULATE_NARRATIVE
StoreKind = ENTITY | FACT | CONCEPT | CLAIM | EVIDENCE | CONTEXT | WORKSPACE | MODEL_USAGE | POLICY | AUDIT | JOB | FORM | EVALUATION | EXPORT | SCENARIO | PROPOSAL | CONNECTOR | HEALTH | VIEW | HYPOTHESIS | PLAN | MODEL_REQUEST | SOURCE | SHARE | RETENTION
BackupOperation = CREATE | RESTORE | VERIFY
Completeness = COMPLETE | PARTIAL | UNKNOWN
ErrorCode = UNAUTHORIZED | FORBIDDEN | STALE_REVISION | VERSION_CONFLICT | EVIDENCE_MISSING | EVIDENCE_STALE | AMBIGUOUS_INTENT | UNSUPPORTED_LANGUAGE | UNSUPPORTED_FORM | INVALID_SCHEMA | BUDGET_EXCEEDED | PROVIDER_UNAVAILABLE | CANCELLED | DEADLINE_EXCEEDED | RESOURCE_LIMIT | STORAGE_FAILURE | INSUFFICIENT_EVIDENCE | NOT_FOUND
```

## 3 Shared state transitions

| Object | Allowed transitions | Owner |
|---|---|---|
| Claim | DRAFTED → EVIDENCED → DISPLAYED; verdict → CONFIRMED or REFUTED; promotion/retirement under policy; source change → STALE then revalidated | C18 with C16 gates |
| Job | QUEUED → RUNNING → WAITING/RUNNING → SUCCEEDED/FAILED/CANCELLED | Owning component, persistence C31 |
| Proposal | DRAFT → NEEDS_CLARIFICATION or VALIDATING → REVIEWABLE/REJECTED → EXPORTED | C28 |
| Plan | READY → RUNNING → BLOCKED/RUNNING → FINISHED or CANCELLED | C22 |
| Evidence | CURRENT → STALE/UNAVAILABLE/ACCESS_REVOKED; successful re-fetch can restore availability only with current scope | C18 and adapters |

Transitions are commands with optimistic version checks; terminal states cannot be overwritten by an older asynchronous response. Confirmations cannot change the class of the underlying evidence from HUMAN_JUDGMENT to deterministic proof.

## 4 Component contracts

The operations below all use CallContext and ApiResult. In orchestration pseudocode, `await Cxx.operation(...)` means await the response, match ApiResult, propagate Failure unchanged, and bind only the Success value. Capitalized request builders return exactly the request record declared by the target API. Encoded persistence records are decoded only against their registered schema ID. Request records are inline so every field is visible. All listed internal functions belong to the component unless prefixed with a component ID. The pseudocode bodies outline orchestration; capitalized constructors are pure typed-request builders that must match the adjacent API declarations. They are not additional public endpoints. Functions use the request inputs, checked context and intermediate typed values; no mutable global repository revision is allowed.

### C01 Client shells and IDE bridge

**Implementation:** React/TypeScript, VS Code API; browser shell; JetBrains adapter later

**Owns:** Canvas/chat layout, editor deep links, command palette, localization and accessible UI; capture selections, files, diffs and breakpoints.

**Invariant:** Client context is advisory; authorization and evidence decisions remain server-side.

#### Exposed APIs and typed requests

```typescript
interface C01 {
  captureEditorEvent(ctx: CallContext, req: { sessionId: Id; event: ContextEvent }): Promise<ApiResult<CommitReceipt>>;
  openEntity(ctx: CallContext, req: { ref: EntityRef }): Promise<ApiResult<SourceSpan>>;
  mountWorkspace(ctx: CallContext, req: { workspaceId: Id }): Promise<ApiResult<Workspace>>;
  executeKeyboardAction(ctx: CallContext, req: { interaction: Interaction }): Promise<ApiResult<ResolvedInteraction>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `captureEditorEvent` | `normalizeEditorEvent`, `minimizeClientPayload`, `attachSequence` | `C21.resolve`, `C02.submit` | S6/FR-407, S5/FR-3, S5/CE-4 |
| `openEntity` | `resolveDeepLink`, `openEditorLocation` | `C03.authorize`, `C08.getEntity` | Workflow / supporting obligation; see traceability register |
| `mountWorkspace` | `restoreShell`, `bindConversationAndCanvas` | `C13.resume`, `C20.mountView` | S6/UX-01 |
| `executeKeyboardAction` | `resolveCommandPaletteAction` | `C21.resolve` | S6/UX-07, S6/UX-08, S6/NFR-13 |

#### Main orchestration pseudocode

```typescript
C01.captureEditorEvent(ctx, req):
  validate event schema
  minimized = normalizeEditorEvent(req.event)
  resolved = await C21.resolve(ctx, InteractionFromEditor(minimized))
  return await C02.submit(ctx, { command: resolved.command })
```

**Domain entities crossing this boundary:** `ContextEvent`, `EntityRef`, `Interaction`, `ResolvedInteraction`, `SourceSpan`, `Workspace`. Full fields are defined in Section 2.

**Requirement coverage:** 13 primary entries; 29 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Keyboard-only complete investigation; screen-reader summaries; stale/reordered IDE event fixtures.

### C02 Event journal and command routing

**Implementation:** TypeScript; durable journal in SQLite/PostgreSQL

**Owns:** Sequence user commands, deduplicate connector events, order repository updates; replay commands and update subscribers.

**Invariant:** Acknowledged material changes are durably committed; replay cannot repeat external side effects.

#### Exposed APIs and typed requests

```typescript
interface C02 {
  submit(ctx: CallContext, req: { command: Command }): Promise<ApiResult<CommitReceipt>>;
  replay(ctx: CallContext, req: { resourceId: Id; afterSequence: Int; limit: Int }): Promise<ApiResult<List<WorkspaceEvent>>>;
  dispatchPending(ctx: CallContext, req: { limit: Int }): Promise<ApiResult<Int>>;
  cancelCommand(ctx: CallContext, req: { commandId: Id }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `submit` | `validateCommandVersion`, `deduplicateCommand`, `commitEventAndOutbox`, `lookupIdempotency`, `hash`, `validateExpectedVersion`, `buildTransactionAndOutbox` | `C03.authorize`, `C31.commit` | S6/FR-105, S6/FR-703 |
| `replay` | `readOrderedJournal`, `detectSequenceGaps` | `C31.readEvents` | Workflow / supporting obligation; see traceability register |
| `dispatchPending` | `claimOutboxBatch`, `deliverSubscribers`, `markDelivery` | `C31.readEvents`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `cancelCommand` | `markCancellation`, `reconcileInFlightOperation` | `C31.commit` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C02.submit(ctx, req):
  authorize command action
  existing = lookupIdempotency(ctx.idempotencyKey, hash(req.command))
  if existing: return existing
  validateExpectedVersion(req.command)
  plan = buildTransactionAndOutbox(req.command)
  return await C31.commit(ctx, { transaction: plan })
```

**Domain entities crossing this boundary:** `Command`, `WorkspaceEvent`. Full fields are defined in Section 2.

**Requirement coverage:** 6 primary entries; 77 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Crash after commit/before publish; duplicate event; stale revision; reconnect gap recovery.

### C03 Identity, authorization and egress policy

**Implementation:** TypeScript policy service; OIDC adapter, SSO/SCIM later

**Owns:** User/repository scopes, tenant boundaries, redaction, secret handles, per-provider egress rules and administrative policies.

**Invariant:** Permissions apply before retrieval and after derivation; revoked access invalidates caches and exports.

#### Exposed APIs and typed requests

```typescript
interface C03 {
  authorize(ctx: CallContext, req: { action: String; resourceId: Id }): Promise<ApiResult<PolicyDecision>>;
  filterEvidence(ctx: CallContext, req: { bundle: EvidenceBundle }): Promise<ApiResult<EvidenceBundle>>;
  approveEgress(ctx: CallContext, req: { destination: String; payloadHandle: Id; payloadHash: Hash; fieldNames: List<String> }): Promise<ApiResult<EgressGrant>>;
  scrubSource(ctx: CallContext, req: { source: SourceEnvelope }): Promise<ApiResult<SourceEnvelope>>;
  scrubRuntime(ctx: CallContext, req: { envelope: RuntimeEnvelope }): Promise<ApiResult<RuntimeEnvelope>>;
  revokeAccess(ctx: CallContext, req: { principalId: Id; resourceId: Id }): Promise<ApiResult<Job<DependencyImpact>>>;
  updatePolicy(ctx: CallContext, req: { policyId: Id; expectedVersion: Int; policy: SchemaValue }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `authorize` | `resolveIdentity`, `evaluateTenantAndRepoScope`, `evaluateInheritedAuthority`, `requireTrustedIdentity`, `decodePolicy`, `checkTenantRepositoryAndDerivedAuthority` | `C31.loadRecord` | S6/FR-603, S6/NFR-06, S5/FR-17 |
| `filterEvidence` | `checkEachEvidenceScope`, `removeDeniedDerivedContent` | `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `approveEgress` | `checkRepoOptIn`, `scrubSecretsAndPii`, `evaluateDestinationPolicy` | `C31.loadRecord` | S5/CE-9 |
| `scrubSource` | `resolveAuthorizedTransientContent`, `detectSecretAndPiiFields`, `replaceWithOpaqueHandles` | `C31.loadRecord` | S6/FR-604 |
| `scrubRuntime` | `scrubDerivedRuntimeMetadata`, `retainAuthorizedExternalHandles` | `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `revokeAccess` | `invalidateAuthorityCaches`, `enqueueDerivedAccessInvalidation` | `C07.computeImpact`, `C31.deleteDerived` | Workflow / supporting obligation; see traceability register |
| `updatePolicy` | `validatePolicySchema`, `compareAndSwapPolicy` | `C31.commit` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C03.authorize(ctx, req):
  identity = requireTrustedIdentity(ctx.actor)
  policy = decodePolicy(await C31.loadRecord(ctx, PolicyKey(req.resourceId)))
  checkTenantRepositoryAndDerivedAuthority(identity, policy, req.action)
  return PolicyDecisionWithVersionAndExpiry()
```

**Implementation boundary:** Secret handling is a dedicated preprocessing boundary: redact source/runtime content before persistence or embedding; store opaque handles to sensitive values. approveEgress rechecks the already scrubbed payload. Repository text remains untrusted even after scrubbing.

**Domain entities crossing this boundary:** `DependencyImpact`, `EgressGrant`, `EvidenceBundle`, `PolicyDecision`, `RuntimeEnvelope`, `SourceEnvelope`. Full fields are defined in Section 2.

**Requirement coverage:** 17 primary entries; 174 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Cross-tenant retrieval/embedding/cache tests; secret canaries; fail-closed egress; source-permission revocation.

### C04 Repository and external-source connectors

**Implementation:** Rust local Git adapter; TypeScript forge/CI/issue adapters

**Owns:** Local/git repository ingestion; commits, PRs, reviews, CODEOWNERS, test results, coverage, tickets and incident documents.

**Invariant:** Missing, corrupted or partial source data is labeled; untrusted repository text is never an instruction.

#### Exposed APIs and typed requests

```typescript
interface C04 {
  ingestRepository(ctx: CallContext, req: { source: SourceEnvelope }): Promise<ApiResult<Job<AnalysisBatch>>>;
  ingestExternal(ctx: CallContext, req: { source: SourceEnvelope }): Promise<ApiResult<Job<CommitReceipt>>>;
  readRevisionPair(ctx: CallContext, req: { base: RevisionRef; head: RevisionRef }): Promise<ApiResult<ChangeSet>>;
  connectorHealth(ctx: CallContext, req: { sourceId: Id }): Promise<ApiResult<HealthReport>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `ingestRepository` | `validateSource`, `resolveAuthorizedContent`, `normalizeRevision`, `normalizeAndValidateSource` | `C03.authorize`, `C03.scrubSource`, `C07.enqueue` | S6/FR-101, S5/FR-1, S5/CE-1 |
| `ingestExternal` | `validateConnectorPayload`, `normalizeForgeCiIssueRecords`, `recordDegradation` | `C03.authorize`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `readRevisionPair` | `readGitDiff`, `joinReviewAndIssueRecords` | `C03.authorize`, `C23.compare` | Workflow / supporting obligation; see traceability register |
| `connectorHealth` | `checkCursorAndCredentials`, `reportUnavailablePlane` | `C32.recordHealth` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C04.ingestRepository(ctx, req):
  await C03.authorize(ctx, ReadSource(req.source.sourceId))
  normalized = normalizeAndValidateSource(req.source)
  scrubbed = await C03.scrubSource(ctx, { source: normalized })
  return await C07.enqueue(ctx, { source: scrubbed })
```

**Domain entities crossing this boundary:** `AnalysisBatch`, `ChangeSet`, `HealthReport`, `RevisionRef`, `SourceEnvelope`. Full fields are defined in Section 2.

**Requirement coverage:** 3 primary entries; 43 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Recorded contract fixtures, corrupted fields, credentials expiry, pagination, rate limits and webhook replay.

### C05 Language analysis and semantic adapters

**Implementation:** Rust Tree-sitter; compiler/LSP/SCIP adapters

**Owns:** Syntax trees, declarations, imports, resolved references/types where supported; language coverage adapters and unsupported-syntax diagnostics.

**Invariant:** Parsed relationships and resolved relationships remain distinct; unresolved dynamic calls remain unknown.

#### Exposed APIs and typed requests

```typescript
interface C05 {
  analyzeSyntax(ctx: CallContext, req: { source: SourceEnvelope; language: String }): Promise<ApiResult<AnalysisBatch>>;
  resolveSemantics(ctx: CallContext, req: { batch: AnalysisBatch; language: String }): Promise<ApiResult<AnalysisBatch>>;
  compareWithCleanIndex(ctx: CallContext, req: { revision: RevisionRef }): Promise<ApiResult<EvalReport>>;
  languageCapabilities(ctx: CallContext, req: { language: String }): Promise<ApiResult<List<String>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `analyzeSyntax` | `selectParser`, `parseChangedRegions`, `extractDeclarationsAndImports`, `loadAuthorizedScrubbedContent`, `parseIncrementally`, `extractSyntaxFacts` | `C03.authorize` | Workflow / supporting obligation; see traceability register |
| `resolveSemantics` | `invokeLanguageAdapter`, `resolveReferencesAndTypes`, `markDynamicUnknowns` | No direct component call | Workflow / supporting obligation; see traceability register |
| `compareWithCleanIndex` | `rebuildOracleIndex`, `compareFactSets` | `C17.evaluate` | Workflow / supporting obligation; see traceability register |
| `languageCapabilities` | `listSupportedResolutionKinds`, `reportUnsupportedConstructs` | No direct component call | S6/NFR-09 |

#### Main orchestration pseudocode

```typescript
C05.analyzeSyntax(ctx, req):
  source = loadAuthorizedScrubbedContent(req.source.contentHandle)
  syntax = parseIncrementally(source, req.language)
  facts = extractSyntaxFacts(syntax)
  return AnalysisBatchWithParsedResolutionAndUnknowns(facts)
```

**Domain entities crossing this boundary:** `AnalysisBatch`, `EvalReport`, `RevisionRef`, `SourceEnvelope`. Full fields are defined in Section 2.

**Requirement coverage:** 2 primary entries; 24 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Golden multi-language repositories; cross-file references; dynamic dispatch; incremental vs clean-index equivalence.

### C06 Configuration, schema and artifact analyzers

**Implementation:** Rust/TypeScript adapters

**Owns:** Build/deploy configuration, IaC, API routes/contracts, database schemas, queues, topics, feature flags and test metadata.

**Invariant:** Configuration intent is not assumed to equal runtime deployment state.

#### Exposed APIs and typed requests

```typescript
interface C06 {
  extractArtifacts(ctx: CallContext, req: { source: SourceEnvelope }): Promise<ApiResult<AnalysisBatch>>;
  joinArtifacts(ctx: CallContext, req: { batch: AnalysisBatch }): Promise<ApiResult<AnalysisBatch>>;
  validateArtifacts(ctx: CallContext, req: { batch: AnalysisBatch }): Promise<ApiResult<List<Diagnostic>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `extractArtifacts` | `parseBuildAndIaC`, `extractRoutesSchemasQueuesFlags`, `recordConfigurationEvidence`, `loadAuthorizedScrubbedContent`, `parseArtifactsWithTypedAdapters` | No direct component call | Workflow / supporting obligation; see traceability register |
| `joinArtifacts` | `resolveArtifactReferences`, `retainAmbiguousBindings` | `C08.resolveAliases` | Workflow / supporting obligation; see traceability register |
| `validateArtifacts` | `validateSchemaAndRouteJoins`, `detectDeclaredRuntimeMismatch` | `C09.query` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C06.extractArtifacts(ctx, req):
  source = loadAuthorizedScrubbedContent(req.source.contentHandle)
  facts = parseArtifactsWithTypedAdapters(source)
  return AnalysisBatchWithDeclaredConfigurationEvidence(facts)
```

**Domain entities crossing this boundary:** `AnalysisBatch`, `Diagnostic`, `SourceEnvelope`. Full fields are defined in Section 2.

**Requirement coverage:** 0 primary entries; 19 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Route-to-handler, migration, queue binding and feature-flag fixtures with ambiguous and absent configuration.

### C07 Incremental indexing and invalidation scheduler

**Implementation:** Rust worker; persisted job queue

**Owns:** Hash chunks; debounce edits; compute dependency regions; invalidate facts, concepts, claims and cached views; progress, cancellation and resumption.

**Invariant:** No mixed-revision graph is presented as a consistent snapshot; invalidation travels through reverse dependencies.

#### Exposed APIs and typed requests

```typescript
interface C07 {
  enqueue(ctx: CallContext, req: { source: SourceEnvelope }): Promise<ApiResult<Job<AnalysisBatch>>>;
  runIndex(ctx: CallContext, req: { jobId: Id }): Promise<ApiResult<Job<AnalysisBatch>>>;
  computeImpact(ctx: CallContext, req: { revision: RevisionRef; changedIds: List<Id> }): Promise<ApiResult<DependencyImpact>>;
  invalidateAndRevalidate(ctx: CallContext, req: { impact: DependencyImpact }): Promise<ApiResult<Job<DependencyImpact>>>;
  getJob(ctx: CallContext, req: { jobId: Id }): Promise<ApiResult<Job<AnalysisBatch>>>;
  cancelJob(ctx: CallContext, req: { jobId: Id }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `enqueue` | `hashAndDeduplicate`, `debounceChanges`, `scheduleBoundedWorker` | `C31.commit` | Workflow / supporting obligation; see traceability register |
| `runIndex` | `loadCheckpoint`, `analyzeRegion`, `stageFacts`, `commitSnapshot`, `loadTypedIndexJob`, `checkCancellationAndGeneration`, `computeReverseDependencyImpact`, `checkpointJobAndScheduleRevalidation` | `C05.analyzeSyntax`, `C05.resolveSemantics`, `C06.extractArtifacts`, `C08.registerBatch`, `C09.commitFacts`, `C31.commit` | S6/NFR-02, S5/CE-3 |
| `computeImpact` | `walkReverseDependencies`, `includeDerivedClaimsViewsAndCaches` | `C09.dependents`, `C18.findDependents` | Workflow / supporting obligation; see traceability register |
| `invalidateAndRevalidate` | `markClaimsStale`, `regenerateConcepts`, `recheckClaims`, `publishPatches` | `C18.markStale`, `C11.refresh`, `C16.verify`, `C13.annotateStaleness` | S6/FR-104, S6/FR-207 |
| `getJob` | `loadJobProgress` | `C31.getJob` | Workflow / supporting obligation; see traceability register |
| `cancelJob` | `persistCancellation`, `stopAtSafeCheckpoint` | `C31.cancelJob` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C07.runIndex(ctx, req):
  job = loadTypedIndexJob(req.jobId)
  checkCancellationAndGeneration(job)
  syntax = await C05.analyzeSyntax(ctx, SourceAndLanguage(job))
  semantic = await C05.resolveSemantics(ctx, BatchAndLanguage(syntax))
  artifacts = await C06.extractArtifacts(ctx, SourceFromJob(job))
  registered = await C08.registerBatch(ctx, MergeBatches(semantic, artifacts))
  impact = computeReverseDependencyImpact(registered)
  await C18.markStale(ctx, { impact })
  receipt = await C09.commitFacts(ctx, BatchAndExpectedRevision(registered, job))
  checkpointJobAndScheduleRevalidation(receipt, impact)
  return UpdatedTypedJob()
```

**Implementation boundary:** Index snapshot commits and claim invalidation are coordinated through a generation fence: mark dependencies stale before a new fact revision becomes eligible for current views. Revalidation is asynchronous and never restores a claim whose inputs changed during the check.

**Domain entities crossing this boundary:** `AnalysisBatch`, `DependencyImpact`, `RevisionRef`, `SourceEnvelope`. Full fields are defined in Section 2.

**Requirement coverage:** 4 primary entries; 61 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Edit/deletion/rename/branch switch; crash recovery; bounded RAM; full-vs-incremental parity and freshness budgets.

### C08 Canonical entity and revision registry

**Implementation:** Rust/TypeScript shared schemas

**Owns:** Stable identities across files, domain concepts, services, tables and topics; cautious entity resolution; version and source lineage.

**Invariant:** Potential identity matches are proposals until supported; names alone never force a merge.

#### Exposed APIs and typed requests

```typescript
interface C08 {
  registerBatch(ctx: CallContext, req: { batch: AnalysisBatch }): Promise<ApiResult<AnalysisBatch>>;
  getEntity(ctx: CallContext, req: { ref: EntityRef }): Promise<ApiResult<Entity>>;
  resolveAliases(ctx: CallContext, req: { refs: List<EntityRef> }): Promise<ApiResult<List<Entity>>>;
  proposeMerge(ctx: CallContext, req: { refs: List<EntityRef>; evidence: List<EvidenceRef> }): Promise<ApiResult<ConceptCard>>;
  applyIdentityVerdict(ctx: CallContext, req: { verdict: Verdict; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `registerBatch` | `allocateStableIds`, `attachRevisionLineage`, `validateTenantKeys`, `validateBatchTenantRevisionAndResolution`, `allocateStableIdsAndRetainAmbiguousAliases` | `C31.commit` | S6/FR-201 |
| `getEntity` | `readRevisionedEntity`, `validateVisibility` | `C03.authorize`, `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `resolveAliases` | `compareNameAndStructuralEvidence`, `retainUnresolvedCandidates` | `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `proposeMerge` | `buildReversibleIdentityProposal` | `C11.extract` | Workflow / supporting obligation; see traceability register |
| `applyIdentityVerdict` | `validateMergeOrSplitVerdict`, `preserveAliasHistory` | `C18.recordVerdict`, `C31.commit` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C08.registerBatch(ctx, req):
  validateBatchTenantRevisionAndResolution(req.batch)
  registered = allocateStableIdsAndRetainAmbiguousAliases(req.batch)
  await C31.commit(ctx, EntityRegistryTransaction(registered))
  return registered
```

**Domain entities crossing this boundary:** `AnalysisBatch`, `ConceptCard`, `Entity`, `EntityRef`, `EvidenceRef`, `Verdict`. Full fields are defined in Section 2.

**Requirement coverage:** 1 primary entries; 49 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Rename continuity; duplicate names; entity split/merge; branch divergence; dispute reversals.

### C09 Fact graph and projection query engine

**Implementation:** Rust indexed adjacency; SQLite/PostgreSQL relations

**Owns:** Bounded traversal, path finding, dependency slices, cross-language/cross-repository links and deterministic graph projections.

**Invariant:** Every graph result is revision-scoped and authorization-filtered; bounds are visible rather than silently dropping paths.

#### Exposed APIs and typed requests

```typescript
interface C09 {
  query(ctx: CallContext, req: { revision: RevisionRef; roots: List<EntityRef>; edgeKinds: List<String>; maxNodes: Int; maxDepth: Int }): Promise<ApiResult<GraphProjection>>;
  commitFacts(ctx: CallContext, req: { batch: AnalysisBatch; expectedRevision: RevisionRef }): Promise<ApiResult<CommitReceipt>>;
  dependents(ctx: CallContext, req: { revision: RevisionRef; changedIds: List<Id> }): Promise<ApiResult<List<Id>>>;
  project(ctx: CallContext, req: { projection: GraphProjection; level: Int; operation: ProjectionOperation }): Promise<ApiResult<GraphProjection>>;
  queryAcrossRepositories(ctx: CallContext, req: { snapshot: MultiRevisionRef; roots: List<EntityRef>; maxNodes: Int; maxDepth: Int }): Promise<ApiResult<MultiGraphProjection>>;
  findPath(ctx: CallContext, req: { revision: RevisionRef; from: EntityRef; to: EntityRef; maxDepth: Int }): Promise<ApiResult<GraphProjection>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `query` | `authorizeRoots`, `traverseBoundedGraph`, `markTruncationAndUnknowns` | `C03.authorize`, `C31.queryFacts` | S6/NFR-03 |
| `commitFacts` | `validateBatchRevision`, `stageAndAtomicallyPublishGraph` | `C31.commit` | Workflow / supporting obligation; see traceability register |
| `dependents` | `walkReverseAdjacency`, `includeCrossRepoLinks` | `C31.queryFacts` | Workflow / supporting obligation; see traceability register |
| `project` | `projectAbstractExpandTraceCompare`, `retainMembershipLineage` | No direct component call | S6/FR-205 |
| `queryAcrossRepositories` | `authorizeEveryRepository`, `queryPerRevision`, `resolveEvidenceBackedCrossLinks` | `C03.authorize`, `C31.queryFacts` | Workflow / supporting obligation; see traceability register |
| `findPath` | `searchAuthorizedPaths`, `markBlockedOrUnknownSegments` | `C03.authorize`, `C31.queryFacts` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C09.query(ctx, req):
  await C03.authorize(ctx, GraphReadScope(req.revision, req.roots))
  q = GraphQueryWithScopeAndBounds(req)
  projection = await C31.queryFacts(ctx, { revision: req.revision, query: q })
  return ProjectionWithTruncationAndUnknownMarkers(projection)
```

**Implementation boundary:** Typed projection operations are deterministic. SIMULATE_NARRATIVE merely selects a scenario projection; it is not evidence of an executed simulation. Cross-repository traversal preserves each repository revision and permission scope.

**Domain entities crossing this boundary:** `AnalysisBatch`, `EntityRef`, `GraphProjection`, `MultiGraphProjection`, `MultiRevisionRef`, `ProjectionOperation`, `RevisionRef`. Full fields are defined in Section 2.

**Requirement coverage:** 2 primary entries; 146 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Known graph oracles; cycle handling; deep traversal limits; denied intermediate nodes; reproducible projections.

### C10 Hybrid retrieval and evidence selection

**Implementation:** TypeScript; FTS5 locally, PostgreSQL search/pgvector for teams

**Owns:** Combine symbol search, lexical search, concept cards, graph expansion and optional embeddings; rank and assemble bounded context.

**Invariant:** Similarity is relevance, not truth; permission and revision filtering precede model context construction.

#### Exposed APIs and typed requests

```typescript
interface C10 {
  retrieve(ctx: CallContext, req: { task: TaskFrame; context: ContextSnapshot }): Promise<ApiResult<EvidenceBundle>>;
  retrieveAcrossRepositories(ctx: CallContext, req: { tasks: List<TaskFrame>; contexts: List<ContextSnapshot>; snapshot: MultiRevisionRef }): Promise<ApiResult<MultiEvidenceBundle>>;
  validateBundle(ctx: CallContext, req: { bundle: EvidenceBundle }): Promise<ApiResult<EvidenceBundle>>;
  explainRetrieval(ctx: CallContext, req: { bundleId: Id }): Promise<ApiResult<List<Diagnostic>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `retrieve` | `searchExactAndLexical`, `searchConceptsAndOptionalVectors`, `expandGraph`, `rankAndBoundContext`, `rankAndAssembleWithinBudget` | `C03.authorize`, `C09.query`, `C11.find`, `C31.search` | Workflow / supporting obligation; see traceability register |
| `retrieveAcrossRepositories` | `retrieveEachAuthorizedRevision`, `validateJoinEvidence`, `enforceAggregateTokenBudget` | `C03.authorize`, `C09.queryAcrossRepositories` | Workflow / supporting obligation; see traceability register |
| `validateBundle` | `filterAccessAndRevision`, `verifyCitationHandles`, `exposeCoverageGaps` | `C03.filterEvidence`, `C18.resolveEvidence` | Workflow / supporting obligation; see traceability register |
| `explainRetrieval` | `explainSelectionAndTruncation` | `C31.loadRecord` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C10.retrieve(ctx, req):
  scope = await C03.authorize(ctx, EvidenceReadScope(req.task))
  lexical = await C31.search(ctx, AuthorizedLexicalQuery(req.task, scope))
  concepts = await C11.find(ctx, ConceptQuery(req.task))
  graph = await C09.query(ctx, BoundedEvidenceGraphQuery(req.task, concepts))
  bundle = rankAndAssembleWithinBudget(lexical, concepts, graph)
  return await C03.filterEvidence(ctx, { bundle })
```

**Domain entities crossing this boundary:** `ContextSnapshot`, `Diagnostic`, `EvidenceBundle`, `MultiEvidenceBundle`, `MultiRevisionRef`, `TaskFrame`. Full fields are defined in Section 2.

**Requirement coverage:** 7 primary entries; 164 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Retrieval gold sets; adversarial distractors; evidence recall; inaccessible matches; token-budget truncation disclosures.

### C11 Concept extraction and semantic memory

**Implementation:** TypeScript extraction workers

**Owns:** Extract bounded concept cards, workflows, invariants, business rules and ownership; confirmed concepts versioned with code.

**Invariant:** Concepts remain inferred unless their specific assertion has independent supporting evidence; confirmation is attributed.

#### Exposed APIs and typed requests

```typescript
interface C11 {
  extract(ctx: CallContext, req: { revision: RevisionRef; evidence: EvidenceBundle; conceptKind: String }): Promise<ApiResult<List<ConceptCard>>>;
  refresh(ctx: CallContext, req: { impact: DependencyImpact }): Promise<ApiResult<Job<List<ConceptCard>>>>;
  find(ctx: CallContext, req: { revision: RevisionRef; query: String; limit: Int }): Promise<ApiResult<List<ConceptCard>>>;
  confirm(ctx: CallContext, req: { conceptId: Id; verdict: Verdict; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `extract` | `selectConceptSchema`, `requestGroundedExtraction`, `resolveEntityCandidates`, `buildExtractionRequest`, `validateAndDecodeConceptCandidates`, `buildConceptClaimDraft` | `C14.generate`, `C18.registerDraft` | S6/FR-204, S5/FR-2, S5/CE-2 |
| `refresh` | `selectAffectedCards`, `regenerateOrRetireCards` | `C10.retrieve`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `find` | `searchAuthorizedConceptCards` | `C03.authorize`, `C31.search` | Workflow / supporting obligation; see traceability register |
| `confirm` | `attributeHumanCorrection`, `versionConceptWithCode` | `C18.recordVerdict`, `C31.commit` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C11.extract(ctx, req):
  modelReq = buildExtractionRequest(req.evidence, req.conceptKind)
  out = await C14.generate(ctx, { request: modelReq })
  candidates = validateAndDecodeConceptCandidates(out)
  for candidate in candidates:
      draft = buildConceptClaimDraft(candidate)
      await C18.registerDraft(ctx, { draft, report: None })
  return VersionedUnconfirmedConceptCards(candidates)
```

**Implementation boundary:** Concept confirmation invokes the ledger once. The ledger emits ConceptVerdictChanged; the concept consumer updates its own version using the event idempotency key. Do not call confirm recursively from the ledger.

**Domain entities crossing this boundary:** `ConceptCard`, `DependencyImpact`, `EvidenceBundle`, `RevisionRef`, `Verdict`. Full fields are defined in Section 2.

**Requirement coverage:** 3 primary entries; 49 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Seeded business concepts; incorrect merges; correction propagation; regeneration after changed cited code.

### C12 Developer context, salience and persona engine

**Implementation:** TypeScript reducers and scoring

**Owns:** Versioned CDC; task frames; working/episodic/semantic/procedural memory policies; six-factor relevance; hidden-item reasons; persona lenses.

**Invariant:** Important safety facts cannot be hidden by persona; raw sensitive context is minimized; every omission is explainable.

#### Exposed APIs and typed requests

```typescript
interface C12 {
  applyContextEvent(ctx: CallContext, req: { event: ContextEvent; expectedSequence: Int }): Promise<ApiResult<ContextSnapshot>>;
  snapshotAt(ctx: CallContext, req: { sessionId: Id; sequence: Int }): Promise<ApiResult<ContextSnapshot>>;
  scoreSalience(ctx: CallContext, req: { task: TaskFrame; projection: GraphProjection; context: ContextSnapshot }): Promise<ApiResult<SaliencePlan>>;
  explainHidden(ctx: CallContext, req: { planId: Id; entityId: Id }): Promise<ApiResult<SalienceEntry>>;
  changeLens(ctx: CallContext, req: { contextId: Id; lensId: Id; expectedSequence: Int }): Promise<ApiResult<ContextSnapshot>>;
  setMemoryPolicy(ctx: CallContext, req: { policy: RetentionPolicy; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `applyContextEvent` | `filterSensitiveContext`, `reduceOrderedEvent`, `applyMemoryTierPolicy` | `C03.authorize`, `C31.commit` | S6/FR-102 |
| `snapshotAt` | `reconstructContextFromEvents` | `C31.readEvents` | Workflow / supporting obligation; see traceability register |
| `scoreSalience` | `scoreSixNamedFactors`, `applyPinsAndProtectedFacts`, `assignTiersWithReasons`, `validateContextRevisionAndEntityScope`, `computeSixFactorScores`, `applyPinsProtectedFactsAndConfiguredWeights`, `recordExplainableTier` | `C09.query`, `C11.find` | S6/UX-11, S6/FR-103, S6/FR-305, S5/CE-7 |
| `explainHidden` | `returnScoreBreakdownAndOmissionReason` | `C31.loadRecord` | S6/NFR-11 |
| `changeLens` | `validateLensPermission`, `preserveDangerousFacts` | `C03.authorize`, `C31.commit` | S6/FR-306, S5/FR-15 |
| `setMemoryPolicy` | `validateTierTriggersAndRetention` | `C03.authorize`, `C31.commit` | S6/FR-107 |

#### Main orchestration pseudocode

```typescript
C12.scoreSalience(ctx, req):
  validateContextRevisionAndEntityScope(req)
  for entity in req.projection.entities:
      factors = computeSixFactorScores(entity, req.task, req.context)
      tier = applyPinsProtectedFactsAndConfiguredWeights(factors)
      recordExplainableTier(entity, factors, tier)
  return VersionedSaliencePlan()
```

**Implementation boundary:** The six factors listed here are an explicit implementation proposal. Sources describe salience factors differently; factor names, weights and persona-protected facts require a baseline decision. Weights are versioned configuration, not invented runtime constants.

**Domain entities crossing this boundary:** `ContextEvent`, `ContextSnapshot`, `GraphProjection`, `RetentionPolicy`, `SalienceEntry`, `SaliencePlan`, `TaskFrame`. Full fields are defined in Section 2.

**Requirement coverage:** 36 primary entries; 151 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** All six salience factors; why-hidden query; pin override; retention; persona fidelity; event-to-context latency.

### C13 Investigation workspace and visual memory

**Implementation:** TypeScript domain module

**Owns:** Named investigations, hypotheses, pins, selections, transcript, branch anchors, belief history, autosave, resurfacing, replay and handover.

**Invariant:** Resuming restores evidence revisions and uncertainty, not merely node coordinates; conflicts are surfaced.

#### Exposed APIs and typed requests

```typescript
interface C13 {
  create(ctx: CallContext, req: { name: String; revision: RevisionRef; contextId: Id }): Promise<ApiResult<Workspace>>;
  append(ctx: CallContext, req: { workspaceId: Id; event: WorkspaceEvent; expectedVersion: Int }): Promise<ApiResult<Workspace>>;
  resume(ctx: CallContext, req: { workspaceId: Id; atSequence: Option<Int> }): Promise<ApiResult<Workspace>>;
  annotateStaleness(ctx: CallContext, req: { impact: DependencyImpact }): Promise<ApiResult<CommitReceipt>>;
  resurface(ctx: CallContext, req: { refs: List<EntityRef>; limit: Int }): Promise<ApiResult<List<Workspace>>>;
  checkpoint(ctx: CallContext, req: { workspaceId: Id; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `create` | `initializeInvestigation`, `bindEvidenceRevision` | `C03.authorize`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `append` | `validateWorkspaceEvent`, `commitMaterialChange`, `checkpointWithinPolicy` | `C02.submit`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `resume` | `restoreEventsAndViews`, `reconcileEvidenceAvailability`, `markStaleAnchors`, `reduceWorkspaceEvents`, `checkEvidenceAvailabilityAndRevision` | `C03.authorize`, `C18.findDependents`, `C31.readEvents` | S6/UX-09, S6/FR-506, S5/FR-10 |
| `annotateStaleness` | `annotateAffectedInvestigations`, `publishRefreshAvailability` | `C31.commit` | Workflow / supporting obligation; see traceability register |
| `resurface` | `findRelevantPastInvestigations`, `filterAccess` | `C03.authorize`, `C31.search` | Workflow / supporting obligation; see traceability register |
| `checkpoint` | `persistConsistentWorkspaceSnapshot` | `C31.commit` | S6/NFR-04 |

#### Main orchestration pseudocode

```typescript
C13.resume(ctx, req):
  await C03.authorize(ctx, ReadWorkspace(req.workspaceId))
  events = await C31.readEvents(ctx, WorkspaceReplayQuery(req))
  workspace = reduceWorkspaceEvents(events)
  checkEvidenceAvailabilityAndRevision(workspace)
  return AnnotatedRestoredWorkspace(workspace)
```

**Domain entities crossing this boundary:** `DependencyImpact`, `EntityRef`, `RevisionRef`, `Workspace`, `WorkspaceEvent`. Full fields are defined in Section 2.

**Requirement coverage:** 12 primary entries; 49 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Kill/restart; five-second checkpoint bound; missing source; stale claims; undo/redo and concurrent workspace edits.

### C14 Model gateway and budget controller

**Implementation:** TypeScript provider adapters

**Owns:** Hosted/private/local inference, capability negotiation, structured output, timeouts, retries, rate limits, routing and per-user budgets.

**Invariant:** Every outbound payload crosses policy checks; no provider fallback can silently change privacy guarantees.

#### Exposed APIs and typed requests

```typescript
interface C14 {
  generate(ctx: CallContext, req: { request: ModelRequest }): Promise<ApiResult<ModelOutput>>;
  capabilities(ctx: CallContext, req: { policyId: Id }): Promise<ApiResult<List<String>>>;
  setRoutingPolicy(ctx: CallContext, req: { policyId: Id; expectedVersion: Int; policy: SchemaValue }): Promise<ApiResult<CommitReceipt>>;
  usage(ctx: CallContext, req: { principalId: Id; window: TimeWindow }): Promise<ApiResult<List<MetricValue>>>;
  cancelRequest(ctx: CallContext, req: { requestId: Id }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `generate` | `reserveBudget`, `validateEgressGrant`, `invokeProvider`, `validateSchema`, `settleUsage`, `reserveEnforceableBudget`, `expectedApprovedFields`, `invokeAllowedProviderWithDeadline`, `validateRegisteredSchema`, `settleActualUsageAndAudit` | `C03.approveEgress`, `C31.commit` | S6/FR-605, S6/NFR-05 |
| `capabilities` | `negotiateStructuredOutputAndToolCapabilities` | `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `setRoutingPolicy` | `validatePrivacyPreservingFallbacks`, `storeRoutingAndBudgetRules` | `C03.authorize`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `usage` | `aggregateSanitizedProviderUsage` | `C03.authorize`, `C31.search` | Workflow / supporting obligation; see traceability register |
| `cancelRequest` | `stopProviderRequestWhenSupported`, `reconcileCharges` | `C31.commit` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C14.generate(ctx, req):
  reserve = reserveEnforceableBudget(req.request)
  grant = await C03.approveEgress(ctx, ActualDestinationAndPayload(req.request))
  if grant.approvedFields != expectedApprovedFields(req.request): return INVALID_SCHEMA
  response = invokeAllowedProviderWithDeadline(req.request, grant)
  output = validateRegisteredSchema(response, req.request.schemaId)
  settleActualUsageAndAudit(reserve, response)
  return output
```

**Implementation boundary:** The gateway owns the enforceable budget and egress check. A caller cannot self-authorize an egressGrantId. Cached responses are retrieved only after fresh scope checks. Provider-specific charging and failed-request reconciliation remain adapter responsibilities.

**Domain entities crossing this boundary:** `MetricValue`, `ModelOutput`, `ModelRequest`, `TimeWindow`. Full fields are defined in Section 2.

**Requirement coverage:** 5 primary entries; 184 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Provider failure; invalid JSON; token caps; local-model feature degradation; budget exhaustion and opt-in enforcement.

### C15 Task planner and grounded reasoning

**Implementation:** TypeScript bounded pipelines

**Owns:** Interpret questions; make plans; select tools; synthesize answer, view intent, alternatives and counterarguments from evidence.

**Invariant:** No unsupported evidence IDs, arbitrary executable renderer code, or direct source-code write capability.

#### Exposed APIs and typed requests

```typescript
interface C15 {
  interpret(ctx: CallContext, req: { question: String; context: ContextSnapshot; budget: Budget }): Promise<ApiResult<TaskFrame>>;
  answer(ctx: CallContext, req: { task: TaskFrame; context: ContextSnapshot }): Promise<ApiResult<Job<ViewSpec>>>;
  answerAcrossRepositories(ctx: CallContext, req: { tasks: List<TaskFrame>; contexts: List<ContextSnapshot>; snapshot: MultiRevisionRef }): Promise<ApiResult<Job<MultiViewSpec>>>;
  draftClaims(ctx: CallContext, req: { task: TaskFrame; evidence: EvidenceBundle }): Promise<ApiResult<List<ClaimDraft>>>;
  abstain(ctx: CallContext, req: { task: TaskFrame; missingEvidence: List<String> }): Promise<ApiResult<RepresentationIntent>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `interpret` | `resolveConversationalReferents`, `inferGoalAndScope`, `askOnAmbiguity` | `C12.snapshotAt` | Workflow / supporting obligation; see traceability register |
| `answer` | `retrieveGrounding`, `synthesizeClaims`, `verifyClaims`, `compileRepresentation`, `groundedDraftClaims`, `fetchAuthorizedProjectionForClaims`, `deriveIntent` | `C10.retrieve`, `C09.query`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C18.registerDraft`, `C19.compile` | S5/FR-4 |
| `answerAcrossRepositories` | `retrieveCrossRepoEvidence`, `verifySourceAndJoinClaims`, `compileMultiView` | `C10.retrieveAcrossRepositories`, `C16.verify`, `C19.compileMultiView` | Workflow / supporting obligation; see traceability register |
| `draftClaims` | `validateAssertionSchema`, `attachEvidenceIdsAndRationale` | `C14.generate` | Workflow / supporting obligation; see traceability register |
| `abstain` | `stateUnknownsAndResolutionOptions`, `requestFogRepresentation` | No direct component call | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C15.answer(ctx, req):
  bundle = await C10.retrieve(ctx, { task: req.task, context: req.context })
  drafts = groundedDraftClaims(req.task, bundle)
  claims = []
  reports = []
  for draft in drafts:
      report = await C16.verify(ctx, { draft, bundle })
      claim = await C18.registerDraft(ctx, { draft, report: Some(report) })
      claims.append(claim)
      reports.append(report)
  projection = fetchAuthorizedProjectionForClaims(claims)
  salience = await C12.scoreSalience(ctx, { task: req.task, projection, context: req.context })
  view = await C19.compile(ctx, { intent: deriveIntent(req.task), projection, salience, reports })
  return CompleteJobWithView(view)
```

**Domain entities crossing this boundary:** `Budget`, `ClaimDraft`, `ContextSnapshot`, `EvidenceBundle`, `MultiRevisionRef`, `MultiViewSpec`, `RepresentationIntent`, `TaskFrame`, `ViewSpec`. Full fields are defined in Section 2.

**Requirement coverage:** 74 primary entries; 33 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Authentication question; lasso referents; insufficient evidence; prompt injection; bounded steps and cancellation.

### C16 Claim verifier and display gates

**Implementation:** TypeScript deterministic checks plus independent reasoning pass

**Owns:** Grounding, fact consistency, adversarial counterargument, calibrated status and final display gating; alarm eligibility.

**Invariant:** Referenced evidence must exist and support the assertion; independent LLM agreement is never formal proof.

#### Exposed APIs and typed requests

```typescript
interface C16 {
  verify(ctx: CallContext, req: { draft: ClaimDraft; bundle: EvidenceBundle }): Promise<ApiResult<GateReport>>;
  validateAlarm(ctx: CallContext, req: { report: GateReport; proofEvidenceIds: List<Id>; verdicts: List<Verdict> }): Promise<ApiResult<GateReport>>;
  revalidate(ctx: CallContext, req: { claimId: Id; revision: RevisionRef }): Promise<ApiResult<GateReport>>;
  verifyView(ctx: CallContext, req: { view: ViewSpec }): Promise<ApiResult<List<Diagnostic>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `verify` | `checkRetrievalGrounding`, `checkFactConsistency`, `runIndependentChallenge`, `applyCalibration`, `decideDisplayEligibility`, `checkEvidenceExistenceSupportAndAccess`, `checkAgainstRevisionedFacts`, `runSeparateAdversarialInvocation`, `applyPolicyFloorsAndHypothesisContract` | `C09.query`, `C14.generate`, `C17.calibrate`, `C18.resolveEvidence` | S6/FR-602 |
| `validateAlarm` | `requireDeterministicProofOrTwoAuthorizedConfirmations` | `C03.authorize`, `C18.resolveEvidence` | Workflow / supporting obligation; see traceability register |
| `revalidate` | `reloadSupportingFacts`, `detectContradictionsAndDrift` | `C18.getClaim`, `C10.retrieve` | Workflow / supporting obligation; see traceability register |
| `verifyView` | `rejectUnevidencedStructureAndInvalidDisplayModes` | `C18.getClaim` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C16.verify(ctx, req):
  grounding = checkEvidenceExistenceSupportAndAccess(req.draft, req.bundle)
  consistency = checkAgainstRevisionedFacts(req.draft)
  challenge = runSeparateAdversarialInvocation(req.draft, req.bundle)
  confidence = await C17.calibrate(ctx, ClaimClassModelAndCohort(req.draft))
  display = applyPolicyFloorsAndHypothesisContract(grounding, consistency, confidence)
  return GateReportIncludingCounterargumentAndUnknowns()
```

**Implementation boundary:** The adversarial pass uses a separate invocation and preferably a distinct configuration; agreement is not independent empirical proof. Without sufficient calibration data, return UNCALIBRATED. Alarm gating and hypothesis display are separate decisions.

**Domain entities crossing this boundary:** `ClaimDraft`, `Diagnostic`, `EvidenceBundle`, `GateReport`, `RevisionRef`, `Verdict`, `ViewSpec`. Full fields are defined in Section 2.

**Requirement coverage:** 1 primary entries; 252 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Fabricated spans; contradictory graph edge; planted counterarguments; low-confidence hypothesis styling; alarm without proof/required approvals rejected.

### C17 Evaluation, calibration and research registry

**Implementation:** TypeScript test harness; offline analysis jobs

**Owns:** Golden claims, known incidents, reliability diagrams, retrieval/visual utility studies, drift, performance and cost benchmarks; research maturity records.

**Invariant:** Self-reported model confidence is not calibrated probability; sparse-data classes display uncalibrated status.

#### Exposed APIs and typed requests

```typescript
interface C17 {
  evaluate(ctx: CallContext, req: { datasetId: Id; configuration: SchemaValue }): Promise<ApiResult<EvalReport>>;
  calibrate(ctx: CallContext, req: { claimClass: String; modelRun: Option<ModelRunRef>; cohort: String }): Promise<ApiResult<Confidence>>;
  recordOutcome(ctx: CallContext, req: { claimId: Id; verdict: Verdict; independentLabel: Bool }): Promise<ApiResult<CommitReceipt>>;
  researchMaturity(ctx: CallContext, req: { capabilityId: Id }): Promise<ApiResult<EvalReport>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `evaluate` | `loadIndependentOracle`, `runPositiveNegativeCorruptionCases`, `calculateMetrics`, `loadIndependentLabelledDataset`, `runGoldenPositiveNegativeSiblingAndCorruptionCases`, `calculateAccuracyRecallCalibrationLatencyCostAndUtility` | `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `calibrate` | `lookupHeldOutCalibration`, `returnUncalibratedWhenSparse` | `C31.search` | S6/NFR-12 |
| `recordOutcome` | `validateLabelProvenance`, `updateEvaluationDataset` | `C31.commit` | Workflow / supporting obligation; see traceability register |
| `researchMaturity` | `checkEvidenceRegistryAndPromotionCriteria` | `C31.loadRecord` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C17.evaluate(ctx, req):
  data = loadIndependentLabelledDataset(req.datasetId)
  results = runGoldenPositiveNegativeSiblingAndCorruptionCases(data, req.configuration)
  metrics = calculateAccuracyRecallCalibrationLatencyCostAndUtility(results)
  return EvalReportWithExplicitSampleCountsAndReleaseGates(metrics)
```

**Domain entities crossing this boundary:** `Confidence`, `EvalReport`, `ModelRunRef`, `Verdict`. Full fields are defined in Section 2.

**Requirement coverage:** 36 primary entries; 81 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Held-out expert labels; planted failures; confidence-bin intervals; changed-model regression; measurable task-completion study.

### C18 Claim lifecycle and provenance ledger

**Implementation:** TypeScript append-only claim domain

**Owns:** Draft/evidence/display/confirm/refute/promote/retire transitions; rationale, citations, counterevidence, source classes, attribution and dependency links.

**Invariant:** Refutations propagate; factual evidence and human judgments have separate classes; history is never silently rewritten.

#### Exposed APIs and typed requests

```typescript
interface C18 {
  registerDraft(ctx: CallContext, req: { draft: ClaimDraft; report: Option<GateReport> }): Promise<ApiResult<Claim>>;
  getClaim(ctx: CallContext, req: { claimId: Id; version: Option<Int> }): Promise<ApiResult<Claim>>;
  resolveEvidence(ctx: CallContext, req: { evidenceIds: List<Id> }): Promise<ApiResult<List<EvidenceRef>>>;
  recordVerdict(ctx: CallContext, req: { verdict: Verdict; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
  markStale(ctx: CallContext, req: { impact: DependencyImpact }): Promise<ApiResult<CommitReceipt>>;
  findDependents(ctx: CallContext, req: { ids: List<Id>; revision: RevisionRef }): Promise<ApiResult<List<Id>>>;
  appendAudit(ctx: CallContext, req: { event: AuditEvent }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `registerDraft` | `validateEvidenceDependencies`, `appendDraftAndGateEvents` | `C31.commit` | S6/FR-202, S6/FR-203 |
| `getClaim` | `loadAuthorizedClaimAndBeliefHistory` | `C03.authorize`, `C31.loadRecord` | S6/UX-06 |
| `resolveEvidence` | `validateEvidenceLocationAndAccess`, `reportUnavailableSources` | `C03.authorize`, `C31.loadRecord` | S6/FR-405, S6/NFR-08, S5/FR-5 |
| `recordVerdict` | `validateLifecycleTransition`, `appendAttributedVerdict`, `propagateCorrections`, `validateClaimVersionAndLifecycle`, `appendVerdictWithCorrectionOutbox` | `C03.authorize`, `C13.annotateStaleness`, `C31.commit` | S6/FR-108, S6/FR-406, S5/FR-16, S5/CE-8 |
| `markStale` | `invalidateDependentClaims`, `retainHistoricalBeliefs` | `C31.commit` | Workflow / supporting obligation; see traceability register |
| `findDependents` | `queryClaimViewWorkspaceDependencyIndex` | `C31.search` | Workflow / supporting obligation; see traceability register |
| `appendAudit` | `minimizeAuditPayload`, `appendHashChainedEvent` | `C31.commit` | S6/FR-606 |

#### Main orchestration pseudocode

```typescript
C18.recordVerdict(ctx, req):
  await C03.authorize(ctx, VerdictWriteScope(req.verdict))
  validateClaimVersionAndLifecycle(req.expectedVersion, req.verdict)
  transaction = appendVerdictWithCorrectionOutbox(req.verdict)
  return await C31.commit(ctx, { transaction })
```

**Implementation boundary:** Refutations append history and emit ClaimVerdictChanged plus DependencyInvalidated. Consumers C11/C13/C19 apply these events; do not synchronously recurse through confirmation APIs. Hash chaining provides tamper evidence; operational immutability also needs storage ACLs and append-only retention controls.

**Domain entities crossing this boundary:** `AuditEvent`, `Claim`, `ClaimDraft`, `DependencyImpact`, `EvidenceRef`, `GateReport`, `RevisionRef`, `Verdict`. Full fields are defined in Section 2.

**Requirement coverage:** 29 primary entries; 222 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Lifecycle transition matrix; disputed claims; correction updates all dependent views; full evidence chain and historical replay.

### C19 Representation planner and compiler

**Implementation:** TypeScript schemas and pure compiler

**Owns:** Compile forms, scope, zoom, grouping, salience, uncertainty, provenance and morph directives into validated ViewSpec; custom form contracts.

**Invariant:** Unevidenced structural claims cannot compile; speculative content uses explicit hypothesis modes; collapses retain full membership/evidence.

#### Exposed APIs and typed requests

```typescript
interface C19 {
  compile(ctx: CallContext, req: { intent: RepresentationIntent; projection: GraphProjection; salience: SaliencePlan; reports: List<GateReport> }): Promise<ApiResult<ViewSpec>>;
  compileMultiView(ctx: CallContext, req: { intent: RepresentationIntent; projection: MultiGraphProjection; salience: List<SaliencePlan>; reports: List<GateReport> }): Promise<ApiResult<MultiViewSpec>>;
  semanticZoom(ctx: CallContext, req: { intent: ZoomIntent; current: ViewSpec; context: ContextSnapshot }): Promise<ApiResult<ViewPatch>>;
  getCompiledView(ctx: CallContext, req: { viewId: Id; version: Option<Int> }): Promise<ApiResult<ViewSpec>>;
  registerForm(ctx: CallContext, req: { contract: FormContract; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
  compareScenario(ctx: CallContext, req: { current: ViewSpec; scenario: Scenario }): Promise<ApiResult<ViewSpec>>;
  explainRepresentation(ctx: CallContext, req: { viewId: Id; elementId: Id }): Promise<ApiResult<List<Diagnostic>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `compile` | `selectFormAndLens`, `validateMembershipAndEvidence`, `applyEpistemicGrammar`, `validateBoundedView`, `validateAuthorizedRevisionAlignment`, `selectRegisteredForm`, `assembleBoundedIdentityPreservingSpec`, `validateClaimGateReportsAndProvenance`, `validateGroupMembershipNoOrphansAndEvidenceTransport`, `validateDangerousFactVisibility` | `C03.authorize`, `C16.verifyView`, `C18.getClaim` | S6/FR-301, S6/FR-601 |
| `compileMultiView` | `compileEachRevisionPanel`, `namespacePanelNodeIds`, `verifyCrossPanelEdges` | `C03.authorize`, `C16.verifyView`, `C18.getClaim` | Workflow / supporting obligation; see traceability register |
| `semanticZoom` | `validateRevisionAndAnchor`, `loadNextProjection`, `preserveIdentityAndEvidence`, `compileIncrementalPatch` | `C09.project`, `C12.scoreSalience`, `C16.verifyView` | S6/FR-206, S6/FR-304, S5/FR-6 |
| `getCompiledView` | `authorizeViewAndSourceScopes`, `loadCompiledSchema`, `markStaleEvidence` | `C03.authorize`, `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `registerForm` | `validateSafeDeclarativeFormContract`, `storeVersionedRecipe` | `C03.authorize`, `C31.commit` | S6/FR-308, S6/NFR-10 |
| `compareScenario` | `compileLevelLockedDualRepresentation`, `labelSpeculativeConsequences` | `C16.verifyView` | Workflow / supporting obligation; see traceability register |
| `explainRepresentation` | `returnFormScopeGroupingAndEvidenceReasons` | `C12.explainHidden`, `C18.resolveEvidence` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C19.compile(ctx, req):
  validateAuthorizedRevisionAlignment(req.intent, req.projection, req.salience, req.reports)
  form = selectRegisteredForm(req.intent, req.projection)
  spec = assembleBoundedIdentityPreservingSpec(form, req)
  validateClaimGateReportsAndProvenance(spec)
  validateGroupMembershipNoOrphansAndEvidenceTransport(spec)
  validateDangerousFactVisibility(spec)
  return spec
```

**Implementation boundary:** compile validates an assembled in-memory spec using a private verifier helper; verifyView is not allowed to invoke compile. semanticZoom returns a patch with stable identity, evidence transport and grouping membership. Custom forms are safe declarative recipes; executable renderer extensions require an independently reviewed plugin.

**Domain entities crossing this boundary:** `ContextSnapshot`, `Diagnostic`, `FormContract`, `GateReport`, `GraphProjection`, `MultiGraphProjection`, `MultiViewSpec`, `RepresentationIntent`, `SaliencePlan`, `Scenario`, `ViewPatch`, `ViewSpec`, `ZoomIntent`. Full fields are defined in Section 2.

**Requirement coverage:** 52 primary entries; 160 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Invalid evidence reference; orphan-free collapse/expand; identity-preserving zoom; persona safety; form-plugin conformance.

### C20 Canvas, layout and visualization forms

**Implementation:** React Flow + ELK.js worker; renderer abstraction

**Owns:** Semantic maps, causal/failure graphs, hypothesis boards, PR diffs, lineage/timelines, journey/trust/runtime/test/coupling/policy forms; fog and provenance styles.

**Invariant:** Render only permitted bounded projections; typography/badges/patterns supplement color; render state cannot edit repository files.

#### Exposed APIs and typed requests

```typescript
interface C20 {
  mountView(ctx: CallContext, req: { viewId: Id; spec: Option<ViewSpec> }): Promise<ApiResult<ViewSpec>>;
  mountMultiView(ctx: CallContext, req: { spec: MultiViewSpec }): Promise<ApiResult<MultiViewSpec>>;
  applyPatch(ctx: CallContext, req: { patch: ViewPatch; currentVersion: Int }): Promise<ApiResult<ViewSpec>>;
  setViewport(ctx: CallContext, req: { viewId: Id; viewport: Viewport; inputSequence: Int }): Promise<ApiResult<Viewport>>;
  renderRuntimeOverlay(ctx: CallContext, req: { viewId: Id; attribution: RuntimeAttribution; baseVersion: Int }): Promise<ApiResult<ViewPatch>>;
  exportViewSnapshot(ctx: CallContext, req: { viewId: Id; version: Int }): Promise<ApiResult<ViewSpec>>;
  renderNumericalChart(ctx: CallContext, req: { form: FormContract; data: SchemaValue }): Promise<ApiResult<ViewSpec>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `mountView` | `validateFormContract`, `layoutInWorker`, `renderAccessibleGraph` | `C19.getCompiledView` | S6/UX-02, S6/UX-10, S6/UX-12, S6/FR-302, S6/FR-303, S6/FR-307 |
| `mountMultiView` | `validateSnapshotAndAllPanels`, `renderEvidenceBackedCrossPanelLinks` | `C03.authorize` | Workflow / supporting obligation; see traceability register |
| `applyPatch` | `rejectStalePatch`, `retainStableNodeIdentity`, `morphPreservingSelectionAndCamera`, `currentViewVersion`, `validateNodeAndEdgeReferences`, `computeAffectedRegionLayoutInWorker`, `applyPatchPreservingSelectionPinsAndManualCamera` | No direct component call | S6/UX-03, S6/UX-04, S6/NFR-01 |
| `setViewport` | `applyLocalCameraTransform`, `recordManualCameraSequence` | No direct component call | Workflow / supporting obligation; see traceability register |
| `renderRuntimeOverlay` | `styleObservedAndFogRegions`, `mergeWithoutCameraJump` | No direct component call | Workflow / supporting obligation; see traceability register |
| `exportViewSnapshot` | `captureAccessibleEvidenceFaithfulView` | `C03.authorize` | Workflow / supporting obligation; see traceability register |
| `renderNumericalChart` | `validateNumericalAdapterContract`, `bindMeasuredSeriesAndUnits` | No direct component call | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C20.applyPatch(ctx, req):
  if req.patch.baseVersion != currentViewVersion(): return VERSION_CONFLICT
  validateNodeAndEdgeReferences(req.patch)
  layout = computeAffectedRegionLayoutInWorker(req.patch)
  applyPatchPreservingSelectionPinsAndManualCamera(layout)
  return UpdatedRenderedViewSpec()
```

**Implementation boundary:** React Flow renders graph forms. Numerical charts require a separate renderer adapter; its library is not yet selected. renderNumericalChart is a reserved contract until that choice is made. mountView receives a spec or loads an authorized persisted compiled spec; it does not invoke model reasoning.

**Domain entities crossing this boundary:** `FormContract`, `MultiViewSpec`, `RuntimeAttribution`, `ViewPatch`, `ViewSpec`, `Viewport`. Full fields are defined in Section 2.

**Requirement coverage:** 9 primary entries; 122 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Forms V1–V15 contracts; 50 foreground/2k bounded elements where required; p95 latency; layout stability; accessibility and fog.

### C21 Interaction and referent resolver

**Implementation:** TypeScript shared event schemas

**Owns:** Text↔visual loop, lasso groups, pins, zoom, hover, hidden-tier interrogation, temporal selections, multimodal operands and keyboard equivalents.

**Invariant:** Selection refers to entity IDs in a particular view revision; ambiguous intent requires clarification.

#### Exposed APIs and typed requests

```typescript
interface C21 {
  resolve(ctx: CallContext, req: { interaction: Interaction }): Promise<ApiResult<ResolvedInteraction>>;
  requestSemanticZoom(ctx: CallContext, req: { interaction: Interaction; policy: ZoomPolicy; current: ViewSpec }): Promise<ApiResult<Option<ZoomIntent>>>;
  handleViewportZoom(ctx: CallContext, req: { viewId: Id; viewport: Viewport; inputSequence: Int }): Promise<ApiResult<Viewport>>;
  interrogate(ctx: CallContext, req: { viewId: Id; version: Int; elementId: Id; question: String }): Promise<ApiResult<List<Diagnostic>>>;
  confirmOrRefute(ctx: CallContext, req: { verdict: Verdict; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `resolve` | `bindRevisionSpecificReferents`, `translateGestureToTypedCommand`, `clarifyAmbiguity` | `C03.authorize`, `C12.applyContextEvent` | S6/UX-05, S6/FR-401, S5/FR-7 |
| `requestSemanticZoom` | `applyHysteresisAndDwell`, `resolveAnchorAndLevel`, `coalesceRequests`, `requireMatchingViewRevision`, `gestureOnlyChangesCamera`, `semanticThresholdNotStable`, `anchorHasNewerRequest`, `coalesceToNewestInput` | No direct component call | Workflow / supporting obligation; see traceability register |
| `handleViewportZoom` | `routeImmediateViewportChange` | `C20.setViewport` | Workflow / supporting obligation; see traceability register |
| `interrogate` | `routeEvidenceOrHiddenReasonQuery` | `C19.explainRepresentation`, `C12.explainHidden`, `C18.resolveEvidence` | Workflow / supporting obligation; see traceability register |
| `confirmOrRefute` | `routeAttributedHumanVerdict` | `C18.recordVerdict` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C21.requestSemanticZoom(ctx, req):
  current = requireMatchingViewRevision(req.interaction, req.current)
  if gestureOnlyChangesCamera(): return None
  if semanticThresholdNotStable(req.policy): return None
  if anchorHasNewerRequest(): coalesceToNewestInput()
  return Some(ZoomIntentWithAnchorRevisionAndCameraSequence())
```

**Implementation boundary:** Viewport zoom is immediate C20 work. Semantic zoom applies separate entry/exit thresholds, hysteresis, a dwell window and at most one active expansion per anchor. Threshold values are versioned product configuration, not established acceptance numbers. User camera moves fence off older focus updates.

**Domain entities crossing this boundary:** `Diagnostic`, `Interaction`, `ResolvedInteraction`, `Verdict`, `ViewSpec`, `Viewport`, `ZoomIntent`, `ZoomPolicy`. Full fields are defined in Section 2.

**Requirement coverage:** 18 primary entries; 36 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** I-01…I-20 catalogues; stale selection; lasso relation query; referent carryover; equivalent mouse/keyboard commands.

### C22 Hypothesis and agentic investigation engine

**Implementation:** TypeScript; LangGraph.js for long-running plans

**Owns:** Living hypotheses, discrimination evidence, test suggestions, agent scope/step budgets, interrupt/resume, live canvas and honest completion.

**Invariant:** Read-only tools by default; no completion claim while material unknowns remain; cancelled tasks cannot continue external actions.

#### Exposed APIs and typed requests

```typescript
interface C22 {
  start(ctx: CallContext, req: { workspaceId: Id; goal: TaskFrame }): Promise<ApiResult<InvestigationPlan>>;
  advance(ctx: CallContext, req: { planId: Id; expectedVersion: Int }): Promise<ApiResult<Job<InvestigationPlan>>>;
  steer(ctx: CallContext, req: { planId: Id; instruction: String; expectedVersion: Int }): Promise<ApiResult<InvestigationPlan>>;
  interrupt(ctx: CallContext, req: { planId: Id; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
  conclude(ctx: CallContext, req: { planId: Id }): Promise<ApiResult<List<Finding>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `start` | `declareScopeAndStepBudget`, `seedHypotheses`, `checkpointPlan` | `C03.authorize`, `C13.resume`, `C15.draftClaims`, `C31.commit` | S6/FR-501, S5/FR-9, S5/CE-6 |
| `advance` | `selectReadyStep`, `callAllowlistedReadTool`, `updateHypotheses`, `checkpointBeforePublish`, `loadPlanAtExpectedVersion`, `checkDeadlineCancellationScopeAndStepBudget`, `selectDependencyReadyAllowlistedStep`, `invokeReadOnlyTypedToolWithIdempotency`, `updateHypothesesWithEvidenceAndUnknowns`, `checkpointAndPublishWorkspaceEvents` | `C10.retrieve`, `C15.answer`, `C16.verify`, `C13.append` | S6/FR-505, S5/FR-14 |
| `steer` | `reconcileInFlightSteps`, `reviseRemainingScope` | `C31.commit` | Workflow / supporting obligation; see traceability register |
| `interrupt` | `persistStopIntent`, `preventFurtherToolDispatch` | `C31.cancelJob` | Workflow / supporting obligation; see traceability register |
| `conclude` | `separateConfirmedRefutedAndUnresolved`, `assessHonestCompletion` | `C18.getClaim`, `C13.append` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C22.advance(ctx, req):
  plan = loadPlanAtExpectedVersion(req.planId, req.expectedVersion)
  checkDeadlineCancellationScopeAndStepBudget(plan)
  step = selectDependencyReadyAllowlistedStep(plan)
  result = invokeReadOnlyTypedToolWithIdempotency(step)
  updated = updateHypothesesWithEvidenceAndUnknowns(plan, result)
  checkpointAndPublishWorkspaceEvents(updated)
  return UpdatedPlanJob()
```

**Implementation boundary:** Allowlist tools by ToolId and request schema, including permission and budget ceilings. The plan executor owns interruption and resumption; the reasoning component does not get arbitrary shell access. Completion includes unresolved evidence gaps.

**Domain entities crossing this boundary:** `Finding`, `InvestigationPlan`, `TaskFrame`. Full fields are defined in Section 2.

**Requirement coverage:** 31 primary entries; 0 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Seeded root cause; competing hypotheses; crash between steps; mid-flight steering; bounded tools; unresolved conclusion.

### C23 History, semantic PR and archaeology engine

**Implementation:** TypeScript Git/forge joins

**Owns:** Conceptual before/after changes, blast radius, contract/dependency upgrades, rationale chains and review threads surviving merge.

**Invariant:** Commit chronology is observed; causal rationale remains inferred unless evidenced; force-push and merge anchors survive explicitly.

#### Exposed APIs and typed requests

```typescript
interface C23 {
  compare(ctx: CallContext, req: { base: RevisionRef; head: RevisionRef }): Promise<ApiResult<ChangeSet>>;
  archaeology(ctx: CallContext, req: { entity: EntityRef; window: TimeWindow }): Promise<ApiResult<List<ClaimDraft>>>;
  assessChangeImpact(ctx: CallContext, req: { changeSet: ChangeSet }): Promise<ApiResult<List<Finding>>>;
  reanchorThreads(ctx: CallContext, req: { changeSet: ChangeSet; mergedRevision: RevisionRef }): Promise<ApiResult<ChangeSet>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `compare` | `compareFactAndConceptSnapshots`, `enumerateConsequences`, `retainReviewAnchors`, `compareRevisionedFacts`, `compareVersionedConceptCards`, `draftEvidenceLinkedChangeConsequences`, `verifyEachConsequenceWithoutAssumingCausality` | `C09.query`, `C11.find`, `C16.verify`, `C18.registerDraft` | S6/FR-502, S5/FR-12 |
| `archaeology` | `joinCommitsIssuesIncidents`, `separateChronologyFromCausalNarrative` | `C04.ingestExternal`, `C14.generate`, `C16.verify` | S6/FR-504 |
| `assessChangeImpact` | `traceContractsTestsDependenciesAndTeamCoupling` | `C09.dependents`, `C26.analyze` | Workflow / supporting obligation; see traceability register |
| `reanchorThreads` | `preserveThreadIdentityAcrossMergeRenameAndDeletion` | `C08.resolveAliases`, `C31.commit` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C23.compare(ctx, req):
  facts = compareRevisionedFacts(req.base, req.head)
  concepts = compareVersionedConceptCards(req.base, req.head)
  consequences = draftEvidenceLinkedChangeConsequences(facts, concepts)
  verifyEachConsequenceWithoutAssumingCausality(consequences)
  return ChangeSetWithStableReviewAnchors()
```

**Domain entities crossing this boundary:** `ChangeSet`, `ClaimDraft`, `EntityRef`, `Finding`, `RevisionRef`, `TimeWindow`. Full fields are defined in Section 2.

**Requirement coverage:** 25 primary entries; 2 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Architectural change with tiny text diff; issue evidence gap; merge/rename; deleted symbols; test-impact comparison.

### C24 Runtime ingestion, attribution and replay

**Implementation:** TypeScript OTel connectors; bounded buffers; existing telemetry backends

**Owns:** Trace/log/metric/test joins, deployment markers, timestamp quality, runtime overlays, temporal scrubbing, unattributed fog and proactive relevance.

**Invariant:** No guessed span-to-code join is labeled deterministic; raw billion-span storage stays in an external telemetry backend.

#### Exposed APIs and typed requests

```typescript
interface C24 {
  ingest(ctx: CallContext, req: { envelope: RuntimeEnvelope }): Promise<ApiResult<CommitReceipt>>;
  attribute(ctx: CallContext, req: { envelope: RuntimeEnvelope }): Promise<ApiResult<RuntimeAttribution>>;
  queryWindow(ctx: CallContext, req: { revision: RevisionRef; window: TimeWindow; roots: List<EntityRef> }): Promise<ApiResult<List<RuntimeAttribution>>>;
  replay(ctx: CallContext, req: { viewId: Id; window: TimeWindow; cursor: Timestamp }): Promise<ApiResult<ViewPatch>>;
  notifyRelevantContext(ctx: CallContext, req: { attribution: RuntimeAttribution; context: ContextSnapshot }): Promise<ApiResult<ContextSnapshot>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `ingest` | `validateTimeAndQuality`, `storeExternalBackendHandles`, `applyBackpressure` | `C03.authorize`, `C03.scrubRuntime`, `C31.commit` | S5/CE-5 |
| `attribute` | `joinDeploymentRevisionEndpointFacts`, `markUnknownTrafficAsFog`, `validateWindowSamplingAndDeploymentMarkers`, `missingAuthoritativeJoin` | `C08.getEntity`, `C09.query` | Workflow / supporting obligation; see traceability register |
| `queryWindow` | `queryAuthorizedExternalBackend`, `applySamplingAndQualityDisclosure` | `C03.authorize`, `C31.search` | Workflow / supporting obligation; see traceability register |
| `replay` | `buildTemporalProjection`, `preserveTimeAndViewAnchors` | `C19.compile` | S6/FR-507, S5/FR-13 |
| `notifyRelevantContext` | `matchTaskAndExceptionSignatures`, `appendRuntimeContextEvent` | `C12.applyContextEvent` | S6/FR-106 |

#### Main orchestration pseudocode

```typescript
C24.attribute(ctx, req):
  quality = validateWindowSamplingAndDeploymentMarkers(req.envelope)
  if missingAuthoritativeJoin(quality): return UnattributedFog(req.envelope)
  entities = joinDeploymentRevisionEndpointFacts(req.envelope)
  return AttributionWithEvidenceAndExactness(entities, quality)
```

**Implementation boundary:** Runtime backends retain raw large-volume spans. C24 stores bounded metadata/handles and authoritative joins. Timestamp corruption or missing deployment/revision markers produces fog, not guessed deterministic attribution.

**Domain entities crossing this boundary:** `ContextSnapshot`, `EntityRef`, `RevisionRef`, `RuntimeAttribution`, `RuntimeEnvelope`, `TimeWindow`, `ViewPatch`. Full fields are defined in Section 2.

**Requirement coverage:** 15 primary entries; 78 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Missing marker; impossible timestamp; sampling; out-of-order spans; revision mismatch; replay and backpressure.

### C25 Security, policy and invariant analysis

**Implementation:** Rule/adaptor layer plus grounded reasoning

**Owns:** PII lineage, trust boundaries, privileges, egress, policy enforcement gaps, audit narrative, invariant candidates and evidence-gated alarms.

**Invariant:** An LLM security accusation cannot become an alarm without the mandated evidence/approval gate; no certification implied.

#### Exposed APIs and typed requests

```typescript
interface C25 {
  analyze(ctx: CallContext, req: { task: TaskFrame; projection: GraphProjection; policyIds: List<Id> }): Promise<ApiResult<List<Finding>>>;
  gateSecurityAlarm(ctx: CallContext, req: { finding: Finding; proofEvidenceIds: List<Id>; verdicts: List<Verdict> }): Promise<ApiResult<Finding>>;
  buildAuditNarrative(ctx: CallContext, req: { findingIds: List<Id>; workspaceId: Id }): Promise<ApiResult<ExportArtifact>>;
  checkInvariant(ctx: CallContext, req: { claimId: Id; testRunIds: List<Id> }): Promise<ApiResult<Finding>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `analyze` | `traceSensitiveDataAndTrustBoundaries`, `findPolicyEnforcementGaps`, `generateInvariantCandidates`, `findAuthorizedSensitiveDataAndPrivilegePaths`, `joinDeclaredPoliciesAndEnforcementEvidence`, `deriveEvidenceLinkedGapsAndInvariantCandidates`, `requireSecuritySpecificGateBeforeAlarm` | `C06.extractArtifacts`, `C09.findPath`, `C14.generate`, `C16.verify` | S6/FR-503 |
| `gateSecurityAlarm` | `applySecuritySpecificDisplayEligibility` | `C16.validateAlarm` | Workflow / supporting obligation; see traceability register |
| `buildAuditNarrative` | `assembleEvidenceAndMissingControls`, `retainInferenceLabels` | `C18.getClaim`, `C30.export` | Workflow / supporting obligation; see traceability register |
| `checkInvariant` | `joinTestOrFormalVerifierEvidence`, `retainProofAssumptions` | `C18.resolveEvidence`, `C17.evaluate` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C25.analyze(ctx, req):
  paths = findAuthorizedSensitiveDataAndPrivilegePaths(req.projection)
  controls = joinDeclaredPoliciesAndEnforcementEvidence(req.policyIds)
  findings = deriveEvidenceLinkedGapsAndInvariantCandidates(paths, controls)
  for finding in findings: requireSecuritySpecificGateBeforeAlarm(finding)
  return findings
```

**Implementation boundary:** Invariant proof requires a separately configured formal verifier or independently validated test evidence with stated assumptions. A verbal model argument is not proof. Alarming requires the documented proof or authorized confirmation gate.

**Domain entities crossing this boundary:** `ExportArtifact`, `Finding`, `GraphProjection`, `TaskFrame`, `Verdict`. Full fields are defined in Section 2.

**Requirement coverage:** 11 primary entries; 1 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Seeded leak/authz gaps; false paths; missing policy; alarm gating; rule version traceability and proof/test evidence.

### C26 Performance, concurrency and lifecycle analysis

**Implementation:** Deterministic adapters plus TypeScript reasoning

**Owns:** Latency paths, hotspots, contention, race windows, ownership/lifecycle timelines, heisenbug hypotheses, scaling and dependency risks.

**Invariant:** Measured durations, possible races and predicted scaling remain distinct; absence of evidence does not establish safety.

#### Exposed APIs and typed requests

```typescript
interface C26 {
  analyze(ctx: CallContext, req: { task: TaskFrame; projection: GraphProjection; runtimeIds: List<Id> }): Promise<ApiResult<List<Finding>>>;
  testConfidence(ctx: CallContext, req: { revision: RevisionRef; entityIds: List<Id> }): Promise<ApiResult<List<Finding>>>;
  scalingEvidence(ctx: CallContext, req: { scenario: Scenario }): Promise<ApiResult<List<Finding>>>;
  designReproduction(ctx: CallContext, req: { findingId: Id; budget: Budget }): Promise<ApiResult<InvestigationPlan>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `analyze` | `findMeasuredCriticalPaths`, `enumerateConcurrencyAndLifecycleMechanisms`, `proposeDiscriminatingExperiments`, `fetchMeasuredRuntimeEvidence`, `analyzeStaticConcurrencyAndLifecycleFacts`, `separateObservedBottlenecksFromPossibleMechanisms`, `attachDiscriminatingExperimentAndCounterevidence` | `C24.queryWindow`, `C09.query`, `C16.verify` | Workflow / supporting obligation; see traceability register |
| `testConfidence` | `joinAssertionsCoverageAndFailureHistory`, `identifyUnsupportedConfidence` | `C04.ingestExternal`, `C18.resolveEvidence` | Workflow / supporting obligation; see traceability register |
| `scalingEvidence` | `separateMeasuredCapacityFromNarrativePrediction` | `C24.queryWindow`, `C17.evaluate` | Workflow / supporting obligation; see traceability register |
| `designReproduction` | `proposeBoundedRaceOrHeisenbugExperiments` | `C22.start` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C26.analyze(ctx, req):
  observations = fetchMeasuredRuntimeEvidence(req.runtimeIds)
  mechanisms = analyzeStaticConcurrencyAndLifecycleFacts(req.projection)
  findings = separateObservedBottlenecksFromPossibleMechanisms(observations, mechanisms)
  attachDiscriminatingExperimentAndCounterevidence(findings)
  return findings
```

**Domain entities crossing this boundary:** `Budget`, `Finding`, `GraphProjection`, `InvestigationPlan`, `RevisionRef`, `Scenario`, `TaskFrame`. Full fields are defined in Section 2.

**Requirement coverage:** 18 primary entries; 16 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Known N+1/lock/race fixtures; sampled traces; lifecycle leak; controlled stress experiment and false-positive controls.

### C27 Counterfactual scenario and simulation engine

**Implementation:** TypeScript scenario model; isolated test/simulation runner later

**Owns:** Dual current/proposed views; monolith split, async migration, dependency removal, failure injection and capacity scenarios.

**Invariant:** Narrative prediction is never labeled measured simulation; original graph remains immutable; side effects isolated.

#### Exposed APIs and typed requests

```typescript
interface C27 {
  createScenario(ctx: CallContext, req: { baseline: RevisionRef; assumptions: List<Assumption>; changes: List<ScenarioChange> }): Promise<ApiResult<Scenario>>;
  evaluateScenario(ctx: CallContext, req: { scenario: Scenario; budget: Budget }): Promise<ApiResult<Scenario>>;
  runIsolatedExperiment(ctx: CallContext, req: { scenarioId: Id; experimentSchema: SchemaValue; budget: Budget }): Promise<ApiResult<Job<Scenario>>>;
  compare(ctx: CallContext, req: { scenarioId: Id; currentView: ViewSpec }): Promise<ApiResult<ViewSpec>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `createScenario` | `validateBaselineAndAssumptions`, `cloneLogicalScenarioWithoutMutatingFacts` | `C03.authorize`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `evaluateScenario` | `queryBaseline`, `reasonAboutConsequences`, `markNarrativeOrMeasuredMode`, `checkExplicitAssumptionsAndImmutableBaseline`, `reasonFromAssumptionsAndMeasuredEvidence`, `verifyAndLabelNarrativeVersusMeasuredConsequences` | `C09.query`, `C26.scalingEvidence`, `C14.generate`, `C16.verify`, `C18.registerDraft` | S6/FR-508 |
| `runIsolatedExperiment` | `authorizeIsolatedRunner`, `enforceResourceAndNetworkBounds`, `captureMeasuredEvidence` | `C03.authorize`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `compare` | `requestLevelLockedDualView` | `C19.compareScenario` | S6/FR-309, S5/FR-11 |

#### Main orchestration pseudocode

```typescript
C27.evaluateScenario(ctx, req):
  baseline = await C09.query(ctx, BoundedScenarioBaseline(req.scenario))
  checkExplicitAssumptionsAndImmutableBaseline(req.scenario)
  consequences = reasonFromAssumptionsAndMeasuredEvidence(baseline, req.scenario)
  verifyAndLabelNarrativeVersusMeasuredConsequences(consequences)
  return UpdatedScenarioWithUncertainty()
```

**Implementation boundary:** evaluateScenario is read-only and may produce inferred consequences. runIsolatedExperiment is a later runner interface and needs approved tool schemas, resource limits and explicit evidence capture. No production fault injection is implied.

**Domain entities crossing this boundary:** `Assumption`, `Budget`, `RevisionRef`, `Scenario`, `ScenarioChange`, `ViewSpec`. Full fields are defined in Section 2.

**Requirement coverage:** 16 primary entries; 12 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Level-locked comparison; assumption tracking; invalid scenario; measured-vs-inferred capacity; sandbox escape/timeout tests.

### C28 Visual intent and change-proposal engine

**Implementation:** TypeScript intent schemas; patch/test runner isolated

**Owns:** Drag/reorder/merge/extract gestures → candidate intents → clarification → consequences → reviewable change proposals.

**Invariant:** Visualization has no code-write path; optional apply command lives in separate scoped executor with explicit authorization.

#### Exposed APIs and typed requests

```typescript
interface C28 {
  interpretGesture(ctx: CallContext, req: { interaction: Interaction; baseline: RevisionRef }): Promise<ApiResult<List<IntentCandidate>>>;
  analyzeIntent(ctx: CallContext, req: { candidate: IntentCandidate; baseline: RevisionRef }): Promise<ApiResult<Scenario>>;
  buildProposal(ctx: CallContext, req: { candidate: IntentCandidate; scenario: Scenario }): Promise<ApiResult<Proposal>>;
  validateProposal(ctx: CallContext, req: { proposalId: Id; budget: Budget }): Promise<ApiResult<Proposal>>;
  exportProposal(ctx: CallContext, req: { proposalId: Id; recipientId: Id }): Promise<ApiResult<ExportArtifact>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `interpretGesture` | `enumerateInterpretations`, `scoreWithoutFalseCertainty`, `askOnAmbiguity` | `C14.generate`, `C09.query` | S6/FR-402, S5/FR-8 |
| `analyzeIntent` | `deriveProposedChanges`, `analyzeConsequences` | `C27.createScenario`, `C27.evaluateScenario` | S6/FR-403 |
| `buildProposal` | `generateReviewablePatch`, `attachInterfaceAndTestChanges`, `preserveBaseRevision`, `requireUnambiguousOrExplicitlySelectedInterpretation`, `generatePatchAgainstBaseRevision`, `attachProposedTestsInterfacesRisksAndMissingValidations`, `persistProposalInInvestigation` | `C14.generate`, `C13.append` | S6/FR-404 |
| `validateProposal` | `runIsolatedCompileTestsAndPolicyChecks`, `attachFailures` | `C03.authorize`, `C27.runIsolatedExperiment` | Workflow / supporting obligation; see traceability register |
| `exportProposal` | `exportAfterPermissionRecheck` | `C30.export` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C28.buildProposal(ctx, req):
  requireUnambiguousOrExplicitlySelectedInterpretation(req.candidate)
  patch = generatePatchAgainstBaseRevision(req.scenario.baseline)
  attachProposedTestsInterfacesRisksAndMissingValidations(patch)
  proposal = ProposalWithNoWriteCapability(patch)
  persistProposalInInvestigation(proposal)
  return proposal
```

**Implementation boundary:** There is intentionally no applyPatchToRepository API in the canvas or proposal module. If later authorized, a separate execution component/adapter must validate approvals, rebase conflicts, policies and rollback before writing.

**Domain entities crossing this boundary:** `Budget`, `ExportArtifact`, `IntentCandidate`, `Interaction`, `Proposal`, `RevisionRef`, `Scenario`. Full fields are defined in Section 2.

**Requirement coverage:** 12 primary entries; 18 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Ambiguous drag; stale patch base; conflicting edits; compile/test failure; no-edit invariant; approvals and audit.

### C29 Team collaboration and organization knowledge

**Implementation:** TypeScript; PostgreSQL team deployment

**Owns:** Shared investigations, lenses, attributed annotations, confirmed concept reuse, conflict resolution and access-aware handover.

**Invariant:** Sharing cannot broaden underlying source access; durable operation history retained within deletion policy.

#### Exposed APIs and typed requests

```typescript
interface C29 {
  share(ctx: CallContext, req: { workspaceId: Id; principalId: Id; role: String }): Promise<ApiResult<ShareGrant>>;
  applyOperation(ctx: CallContext, req: { workspaceId: Id; event: WorkspaceEvent; expectedVersion: Int }): Promise<ApiResult<Workspace>>;
  handover(ctx: CallContext, req: { workspaceId: Id; principalId: Id; expectedVersion: Int }): Promise<ApiResult<Workspace>>;
  confirmSharedConcept(ctx: CallContext, req: { conceptId: Id; verdict: Verdict; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `share` | `checkRecipientAndUnderlyingSourceAccess`, `createBoundedGrant`, `checkRecipientUnderlyingSourceScopes`, `boundedShareGrant` | `C03.authorize`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `applyOperation` | `resolveOrRejectConcurrentOperation`, `retainAttribution` | `C03.authorize`, `C13.append` | S6/FR-701 |
| `handover` | `prepareContextAndUnresolvedFindings`, `discloseRecipientEvidenceGaps` | `C03.authorize`, `C13.resume` | Workflow / supporting obligation; see traceability register |
| `confirmSharedConcept` | `propagateTeamConfirmationWithoutBroadeningAccess` | `C11.confirm`, `C18.recordVerdict` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C29.share(ctx, req):
  await C03.authorize(ctx, WorkspaceShareScope(req.workspaceId, req.principalId))
  checkRecipientUnderlyingSourceScopes()
  grant = boundedShareGrant(req)
  await C31.commit(ctx, ShareTransaction(grant))
  return grant
```

**Implementation boundary:** Sharing a workspace does not grant repository access. Handover reveals evidence gaps to the recipient without disclosing protected excerpts. Concurrent edits require compare-and-swap or explicit merge operations; this contract does not implicitly choose a CRDT.

**Domain entities crossing this boundary:** `ShareGrant`, `Verdict`, `Workspace`, `WorkspaceEvent`. Full fields are defined in Section 2.

**Requirement coverage:** 2 primary entries; 32 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Concurrent edits; denied recipient; correction in shared concept; tenant boundary; handover source-access mismatch.

### C30 Evidence-faithful exports and notifications

**Implementation:** TypeScript exporters; connector adapters

**Owns:** ADR/audit/report/image/PR exports, provenance legends, signed evidence manifests where applicable, in-app notifications and optional outbound delivery.

**Invariant:** Export filtering is reevaluated at delivery; external notifications require configured recipient authorization; secrets never leak.

#### Exposed APIs and typed requests

```typescript
interface C30 {
  export(ctx: CallContext, req: { workspaceId: Id; snapshotVersion: Int; format: String; recipientId: Option<Id> }): Promise<ApiResult<ExportArtifact>>;
  notify(ctx: CallContext, req: { artifactId: Id; recipientId: Id; channel: String }): Promise<ApiResult<CommitReceipt>>;
  revokeManagedExport(ctx: CallContext, req: { artifactId: Id }): Promise<ApiResult<CommitReceipt>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `export` | `freezeAuthorizedSnapshot`, `attachProvenanceLegendAndManifest`, `renderArtifact`, `buildPermissionFilteredEvidenceManifest`, `renderRequestedFormatWithLegend`, `persistExportAndSanitizedAudit` | `C03.authorize`, `C13.resume`, `C18.resolveEvidence`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `notify` | `verifyConfiguredRecipientAuthority`, `deliverIdempotently` | `C03.authorize`, `C18.appendAudit`, `C31.commit` | Workflow / supporting obligation; see traceability register |
| `revokeManagedExport` | `expireControlledDownloadHandles`, `recordExternalCopyLimit` | `C03.authorize`, `C31.deleteDerived` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C30.export(ctx, req):
  await C03.authorize(ctx, ExportDeliveryScope(req))
  workspace = await C13.resume(ctx, WorkspaceVersionQuery(req))
  if workspace.version != req.snapshotVersion: return VERSION_CONFLICT
  manifest = buildPermissionFilteredEvidenceManifest(workspace)
  artifact = renderRequestedFormatWithLegend(workspace, manifest)
  persistExportAndSanitizedAudit(artifact)
  return artifact
```

**Implementation boundary:** Notification sending occurs only for explicitly configured recipients and subscribed/authorized events. Export privileges are checked at delivery. Revoking a controlled handle cannot retract an externally downloaded copy.

**Domain entities crossing this boundary:** `ExportArtifact`. Full fields are defined in Section 2.

**Requirement coverage:** 0 primary entries; 31 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Export preserves confidence/revision; forbidden source removal; revoked access; webhook retry without duplicate delivery.

### C31 Storage, retention and content lifecycle

**Implementation:** SQLite/WAL + FTS5; PostgreSQL/pgvector for teams; hash-addressed blobs

**Owns:** Transactions, durable jobs/events, typed entity tables, indexes, caches, snapshots, backup/restore, retention and derived-data deletion.

**Invariant:** Blob hashes do not bypass tenant ACL; deletion follows derived artifacts/caches/embeddings; audit minimization reconciled with retention.

#### Exposed APIs and typed requests

```typescript
interface C31 {
  commit(ctx: CallContext, req: { transaction: TransactionPlan }): Promise<ApiResult<CommitReceipt>>;
  loadRecord(ctx: CallContext, req: { store: StoreKind; key: Id; version: Option<Int> }): Promise<ApiResult<SchemaValue>>;
  queryFacts(ctx: CallContext, req: { revision: RevisionRef; query: GraphQuery }): Promise<ApiResult<GraphProjection>>;
  search(ctx: CallContext, req: { request: SearchQuery }): Promise<ApiResult<List<SchemaValue>>>;
  readEvents(ctx: CallContext, req: { resourceId: Id; afterSequence: Int; limit: Int }): Promise<ApiResult<List<WorkspaceEvent>>>;
  getJob(ctx: CallContext, req: { jobId: Id }): Promise<ApiResult<Job<SchemaValue>>>;
  cancelJob(ctx: CallContext, req: { jobId: Id; expectedVersion: Int }): Promise<ApiResult<CommitReceipt>>;
  deleteDerived(ctx: CallContext, req: { resourceId: Id; policy: RetentionPolicy }): Promise<ApiResult<Job<DependencyImpact>>>;
  backupAndRestore(ctx: CallContext, req: { operation: BackupOperation; backupId: Option<Id> }): Promise<ApiResult<Job<CommitReceipt>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `commit` | `validateExpectedVersions`, `writeRecordsAndOutboxAtomically`, `fsyncAccordingToDurabilityPolicy`, `validateStoreSchemasTenantKeysAndExpectedVersions`, `beginDatabaseTransaction`, `writeRecordsEventsAndOutbox`, `commitWithConfiguredDurability` | No direct component call | Workflow / supporting obligation; see traceability register |
| `loadRecord` | `loadTypedAuthorizedRecord`, `verifySchemaVersion` | No direct component call | Workflow / supporting obligation; see traceability register |
| `queryFacts` | `queryRevisionedEntityAndEdgeIndexes` | No direct component call | Workflow / supporting obligation; see traceability register |
| `search` | `applyScopeFilterBeforeLexicalOrVectorSearch` | No direct component call | Workflow / supporting obligation; see traceability register |
| `readEvents` | `readOrderedEventPage` | No direct component call | Workflow / supporting obligation; see traceability register |
| `getJob` | `loadTypedJobEnvelope` | No direct component call | Workflow / supporting obligation; see traceability register |
| `cancelJob` | `persistCancellationAndCheckpointFence` | No direct component call | Workflow / supporting obligation; see traceability register |
| `deleteDerived` | `walkDerivationLineage`, `deleteIndexesCachesEmbeddingsAndGovernedPayloads` | No direct component call | S6/NFR-07 |
| `backupAndRestore` | `createConsistentBackupOrRestore`, `validateSchemaAndHashes` | No direct component call | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C31.commit(ctx, req):
  validateStoreSchemasTenantKeysAndExpectedVersions(req.transaction)
  beginDatabaseTransaction()
  writeRecordsEventsAndOutbox(req.transaction)
  commitWithConfiguredDurability()
  return CommitReceiptAfterDurabilityBarrier()
```

**Implementation boundary:** Only trusted domain modules use these persistence APIs. All stores validate schema, tenant keys and optimistic versions. A transaction cannot atomically update external providers. SQLite uses one batched writer; PostgreSQL supports the team concurrency mode.

**Domain entities crossing this boundary:** `BackupOperation`, `DependencyImpact`, `GraphProjection`, `GraphQuery`, `RetentionPolicy`, `RevisionRef`, `SearchQuery`, `StoreKind`, `TransactionPlan`, `WorkspaceEvent`. Full fields are defined in Section 2.

**Requirement coverage:** 1 primary entries; 122 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Crash recovery; backup restore; reference-count garbage collection; deletion propagation; schema migration and multi-writer contention.

### C32 Operations, administration and release engineering

**Implementation:** OpenTelemetry for product; Docker; IaC; CI

**Owns:** Health, cost/routing dashboards, installation/update, fault isolation, model/index health, deployment modes, API versioning and operational SLOs.

**Invariant:** Repository-only mode remains useful during model/runtime outages; upgrades cannot discard investigation history.

#### Exposed APIs and typed requests

```typescript
interface C32 {
  recordHealth(ctx: CallContext, req: { report: HealthReport }): Promise<ApiResult<CommitReceipt>>;
  health(ctx: CallContext, req: { componentId: Option<ComponentId> }): Promise<ApiResult<List<HealthReport>>>;
  configure(ctx: CallContext, req: { target: ComponentId; expectedVersion: Int; configuration: SchemaValue }): Promise<ApiResult<CommitReceipt>>;
  releaseReadiness(ctx: CallContext, req: { evalIds: List<Id>; baselineId: Id }): Promise<ApiResult<EvalReport>>;
  recover(ctx: CallContext, req: { componentId: ComponentId; checkpointId: Option<Id> }): Promise<ApiResult<Job<CommitReceipt>>>;
}
```

#### High level function inventory

| Public operation | Internal functions | Dependency APIs | Primary explicit requirements |
|---|---|---|---|
| `recordHealth` | `minimizeTelemetry`, `writeOperationalStatus` | `C31.commit` | Workflow / supporting obligation; see traceability register |
| `health` | `aggregateIndexerModelAndStoreHealth` | `C31.search` | S6/NFR-14 |
| `configure` | `validateAdminPolicy`, `dispatchVersionedConfiguration` | `C03.authorize`, `C14.setRoutingPolicy`, `C12.setMemoryPolicy` | S6/FR-702 |
| `releaseReadiness` | `checkRequiredAcceptanceEvidenceAndMigrations`, `blockUnsupportedClaims`, `loadVersionedRequirementBaseline`, `loadEvalReportsWithIndependentDatasetVersions`, `checkRequiredFunctionalContractsAndNumericSloThresholds`, `checkMigrationRestoreAndPrivacyGates` | `C17.evaluate`, `C31.loadRecord` | Workflow / supporting obligation; see traceability register |
| `recover` | `applyRecoveryRunbook`, `verifyInvestigationContinuity` | `C07.getJob`, `C13.resume`, `C31.backupAndRestore` | Workflow / supporting obligation; see traceability register |

#### Main orchestration pseudocode

```typescript
C32.releaseReadiness(ctx, req):
  baseline = loadVersionedRequirementBaseline(req.baselineId)
  evidence = loadEvalReportsWithIndependentDatasetVersions(req.evalIds)
  checkRequiredFunctionalContractsAndNumericSloThresholds(baseline, evidence)
  checkMigrationRestoreAndPrivacyGates()
  return EvalReportWithUnmetRequirementsAndReleaseDecision()
```

**Implementation boundary:** Health and evaluation data are sanitized. A release baseline identifies exact requirement IDs and tests; scoped or deferred requirements cannot be silently marked complete. Recovery preserves job fences and workspace sequence.

**Domain entities crossing this boundary:** `ComponentId`, `EvalReport`, `HealthReport`. Full fields are defined in Section 2.

**Requirement coverage:** 47 primary entries; 48 supporting entries. Primary and supporting operation mappings are listed in Section 7.

**Acceptance suite:** Dependency outages; disk full; migration rollback; restore drill; load/cost gates; host/extension compatibility checks.

## 5 Cross component event contracts

| Event | Producer | Consumers | Payload | Required handling |
|---|---|---|---|---|
| SourceRevisionAvailable | C04 | C07 | SourceEnvelope | Deduplicate by source revision and hash; authorize before ingest |
| FactSnapshotCommitted | C07/C09 | C11,C12,C23 | revision, generation, changed entity IDs | Update only matching repository generation |
| DependencyInvalidated | C07 | C11,C18,C13,C19 | DependencyImpact | Mark stale before publishing a new current view |
| ClaimVerdictChanged | C18 | C11,C12,C13,C19,C29 | verdict, claim version, dependent IDs | Preserve attribution; propagate corrections idempotently |
| ContextChanged | C12 | C15,C19 | context ID, sequence, privacy-filtered changed fields | Coalesce rapid updates; do not move camera by default |
| ViewCompiled | C19 | C20,C13 | ViewSpec or ViewPatch | Enforce base/new versions; retain selected identities |
| RuntimeAttributed | C24 | C12,C22,C26,C19 | RuntimeAttribution | Exact joins or explicit fog; bounded batch/backpressure |
| PlanCheckpointed | C22 | C13,C20 | plan ID/version, hypothesis changes, workspace sequence | Publish only after durable checkpoint |
| ProposalReviewable | C28 | C13,C30 | proposal ID/base revision/validation result IDs | Export only; no implicit repository write |
| AccessRevoked | C03 | all affected stores/views/workspaces | principal/scope/policy epoch | Cancel unauthorized work; invalidate derivative caches |
| DeletionRequested | C03/C31 | all data owners | resource ID, retention policy, deletion fence | Cascade to governed derived artifacts and backups per policy |

Events use the same tenant, revision, idempotency and schema-version envelope as commands. Notification delivery is a separate subscribed and authorized action, not an automatic consequence of every event.

## 6 Semantic zoom and live rendering contract

```typescript
onViewportGesture(viewId, nextViewport, sequence):
  C21.handleViewportZoom(ctx, { viewId, viewport: nextViewport, inputSequence: sequence })
  // No LLM request and no graph expansion on ordinary camera movement.

onStableSemanticThreshold(interaction, current, context, policy):
  intent = C21.requestSemanticZoom(ctx, { interaction, policy, current })
  if intent is None: return
  cancelOlderExpansionForSameAnchor(intent.anchorNodeId)
  patch = C19.semanticZoom(ctx, { intent, current, context })
  if inputRevisionOrCameraFenceIsStale(patch): discardAndReconcile()
  else: C20.applyPatch(ctx, { patch, currentVersion: current.version })
```

C19 owns abstraction changes; C20 owns camera geometry; C21 owns the gesture-to-intent decision; C12 supplies salience and persona; C09 supplies the bounded next-level projection. User-selected expand/collapse bypasses automatic dwell but still checks revisions and permissions. New runtime evidence can update an overlay without changing camera or abstraction. Conversational zoom is an explicit request to C15/C19, not a hidden automatic transition.

Enter and exit thresholds differ to prevent oscillation. Level transitions preserve anchor identity, pin state, grouping membership and provenance. Missing evidence yields fog or a scoped refusal; it never creates invented detail. Automatic camera motion is disabled unless explicitly requested by the user or an approved follow-execution mode is active.

## 7 Requirement to API and function traceability

Each row retains its original source-qualified identifier. An explicit API is responsible for the obligation, while its function inventory and supporting APIs implement the required checks. Non-functional requirements also require measured test evidence: API names are not latency, scale, privacy or reliability guarantees.

Supporting-API assignments are **contract checkpoints**, not a claim that a single function satisfies an entire cross-cutting requirement. Candidate source-block rows may include metadata or research goals; they are preserved for audit and must not automatically create implementation tickets.

| Requirement ID | Requirement or source section | Accountable API | Supporting API checkpoints | Mapping status |
|---|---|---|---|---|
| S6/UX-01 | UX-01 — Canvas-first layout: generated view occupies the primary surface; conversation is a persistent side channel; either can be expande | `C01.mountWorkspace` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S6/UX-02 | UX-02 — Every view displays its provenance legend, lens/persona badge, scope statement, and the question it answers — the view's “caption  | `C20.mountView` | `C01.executeKeyboardAction`, `C12.scoreSalience`, `C18.resolveEvidence`, `C19.compile`, `C21.resolve` | Explicit requirement contract |
| S6/UX-03 | UX-03 — All four salience tiers are visually distinct at a glance and individually suppressible; ghost tier exposes count and explain acti | `C20.applyPatch` | `C01.executeKeyboardAction`, `C12.scoreSalience`, `C18.resolveEvidence`, `C19.compile`, `C21.resolve` | Explicit requirement contract |
| S6/UX-04 | UX-04 — View transitions are morph-preserving: identity continuity (S12.2) with animations under 300 ms; no full- canvas reflash on refine | `C20.applyPatch` | `C01.executeKeyboardAction`, `C12.scoreSalience`, `C18.resolveEvidence`, `C19.compile`, `C21.resolve` | Explicit requirement contract |
| S6/UX-05 | UX-05 — Every question input accepts references to visual state (selection, pins, time window) without manual description | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Explicit requirement contract |
| S6/UX-06 | UX-06 — Provenance ledger opens in under two interactions from any element; ledger shows sources, rationale, confidence, counter- evidence | `C18.getClaim` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S6/UX-07 | UX-07 — Keyboard parity: every mouse interaction has a command-palette equivalent; full navigation without pointer | `C01.executeKeyboardAction` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S6/UX-08 | UX-08 — Accessibility: WCAG 2.1 AA contrast; provenance never encoded by color alone (style + badge + texture); screen-reader summaries fo | `C01.executeKeyboardAction` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S6/UX-09 | UX-09 — Investigation workspaces are named, resumed, shared, and exported with full evidence trails | `C13.resume` | `C03.authorize`, `C18.resolveEvidence`, `C29.applyOperation`, `C30.export`, `C31.commit` | Explicit requirement contract |
| S6/UX-10 | UX-10 — Empty states teach: when no evidence exists, the canvas says what is missing and how to provide it (fog, not blankness) | `C20.mountView` | `C01.executeKeyboardAction`, `C12.scoreSalience`, `C18.resolveEvidence`, `C19.compile`, `C21.resolve` | Explicit requirement contract |
| S6/UX-11 | UX-11 — Cognitive load budgets: default views render no more than 50 foreground elements before tiering; progressive disclosure is automat | `C12.scoreSalience` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Explicit requirement contract |
| S6/UX-12 | UX-12 — Trust strip: every narrative answer carries its evidence-class mix as a compact visual summary (how much of this answer is proven  | `C20.mountView` | `C01.executeKeyboardAction`, `C12.scoreSalience`, `C18.resolveEvidence`, `C19.compile`, `C21.resolve` | Explicit requirement contract |
| S6/FR-101 | FR-101 — Ingest and normalize the five context planes (repository, semantic, user, runtime, historical) into the canonical entity graph | `C04.ingestRepository` | `C03.authorize`, `C05.resolveSemantics`, `C06.extractArtifacts`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C11.find`, `C12.scoreSalience`, `C23.compare`, `C24.attribute` | Explicit requirement contract |
| S6/FR-102 | FR-102 — Maintain the CDC as a versioned, diffable, privacy-filtered object; reconstructible at any past sequence number | `C12.applyContextEvent` | `C01.executeKeyboardAction`, `C02.submit`, `C03.authorize`, `C13.append`, `C31.commit` | Explicit requirement contract |
| S6/FR-103 | FR-103 — Compute salience per entity/relationship from the six required factors; expose the breakdown on demand | `C12.scoreSalience` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Explicit requirement contract |
| S6/FR-104 | FR-104 — Incremental re-index on commit/PR within NFR-02 budgets; affected claims revalidated automatically | `C07.invalidateAndRevalidate` | `C04.ingestExternal`, `C05.resolveSemantics`, `C06.extractArtifacts`, `C09.query`, `C11.find`, `C16.verify`, `C18.resolveEvidence`, `C19.compile` | Explicit requirement contract |
| S6/FR-105 | FR-105 — Sub-second propagation of user-plane events (selection, question, pin) into the working context | `C02.submit` | `C01.executeKeyboardAction`, `C12.scoreSalience`, `C21.resolve`, `C31.commit` | Explicit requirement contract |
| S6/FR-106 | FR-106 — Runtime signal correlation into working context within seconds when task-relevant (exception signature match) | `C24.notifyRelevantContext` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-107 | FR-107 — Memory tiers with policy: working, episodic, semantic, procedural — each with stated write triggers and retention | `C12.setMemoryPolicy` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Explicit requirement contract |
| S6/FR-108 | FR-108 — Correction propagation: a refuted claim updates or annotates all dependent views and investigations | `C18.recordVerdict` | `C07.computeImpact`, `C11.find`, `C13.append`, `C16.verify`, `C19.compile`, `C20.applyPatch`, `C29.applyOperation` | Explicit requirement contract |
| S6/FR-201 | FR-201 — Maintain the three-layer CSM (Facts, Concepts, Claims) with typed joins across planes | `C08.registerBatch` | `C05.resolveSemantics`, `C06.extractArtifacts`, `C09.query`, `C11.find`, `C18.resolveEvidence`, `C31.commit` | Explicit requirement contract |
| S6/FR-202 | FR-202 — Claim lifecycle: drafted → evidenced → displayed → confirmed/refuted → promoted/retired; append-only ledger | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S6/FR-203 | FR-203 — Every claim stores rationale summary, evidence links, confidence with reason codes, and adversarial counter-argument | `C18.registerDraft` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C17.evaluate` | Explicit requirement contract |
| S6/FR-204 | FR-204 — Concept extraction with human confirmation workflow; confirmed concepts versioned with the code | `C11.extract` | `C07.computeImpact`, `C08.getEntity`, `C14.generate`, `C16.verify`, `C18.resolveEvidence` | Explicit requirement contract |
| S6/FR-205 | FR-205 — Projection operations: project, abstract, expand, trace, compare, simulate- narrative, register/confirm/refute | `C09.project` | `C08.getEntity`, `C18.resolveEvidence`, `C19.compile`, `C27.evaluateScenario` | Explicit requirement contract |
| S6/FR-206 | FR-206 — Invented abstractions: generate ephemeral intermediate levels that satisfy collapse-fidelity (no orphaned elements) | `C19.semanticZoom` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-207 | FR-207 — Claim revalidation on entity change; staleness annotations with belief history | `C07.invalidateAndRevalidate` | `C08.getEntity`, `C09.query`, `C11.find`, `C18.resolveEvidence`, `C31.commit` | Explicit requirement contract |
| S6/FR-301 | FR-301 — Representation plan compiled for every response: form, scope, levels, emphasis, provenance channels, morph directive; plans inspec | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-302 | FR-302 — Ship visualization forms V1–V4 and V6 with their specified grammars | `C20.mountView` | `C18.resolveEvidence`, `C19.compile`, `C21.resolve` | Explicit requirement contract |
| S6/FR-303 | FR-303 — Ship forms V5, V8, V9 (lineage, trust map, runtime overlay) with evidence contracts | `C20.mountView` | `C18.resolveEvidence`, `C19.compile`, `C23.compare`, `C24.attribute`, `C25.analyze` | Explicit requirement contract |
| S6/FR-304 | FR-304 — Semantic zoom across L0–L6 with identity continuity and evidence transport | `C19.semanticZoom` | `C08.getEntity`, `C09.query`, `C18.resolveEvidence`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S6/FR-305 | FR-305 — Salience tiering (Critical/Relevant/Contex t/Hidden) applied to every view; hidden tier countable and explainable | `C12.scoreSalience` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Explicit requirement contract |
| S6/FR-306 | FR-306 — Persona lenses with mandated guards (lens disclosure, dangerous- fact immunity, drift proposal) | `C12.changeLens` | `C03.authorize`, `C16.verify`, `C19.compile`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-307 | FR-307 — Fog rendering: unattributed runtime and unindexed regions displayed as explicit uncertainty | `C20.mountView` | `C01.executeKeyboardAction`, `C12.scoreSalience`, `C18.resolveEvidence`, `C19.compile`, `C21.resolve` | Explicit requirement contract |
| S6/FR-308 | FR-308 — Supervised generative forms: sandbox pane, accept/adjust/reject, recipe storage on acceptance | `C19.registerForm` | `C03.authorize`, `C13.append`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-309 | FR-309 — Counterfactual overlay with level-locked dual rendering and consequence anchoring | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Explicit requirement contract |
| S6/FR-401 | FR-401 — Implement interaction catalogue I-01…I-11 (conversation ↔ canvas loop) with context writes per the catalogue | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C13.append`, `C18.resolveEvidence`, `C19.compile`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-402 | FR-402 — Implement manipulation intents I-12…I-15 producing typed intent candidates | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Explicit requirement contract |
| S6/FR-403 | FR-403 — Intent interpretation pipeline: gesture → candidate intents with confidence → clarify-on- ambiguity → consequence analysis → chang | `C28.analyzeIntent` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Explicit requirement contract |
| S6/FR-404 | FR-404 — Structural no-silent-edit guarantee: no code write path in the visualization runtime; proposals only | `C28.buildProposal` | `C01.executeKeyboardAction`, `C03.authorize`, `C19.compile`, `C20.applyPatch`, `C21.resolve`, `C32.recordHealth` | Explicit requirement contract |
| S6/FR-405 | FR-405 — Provenance interrogation I-06 and hiding explanation I-09 for every element | `C18.resolveEvidence` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S6/FR-406 | FR-406 — Claim confirm/refute (I-08) with attribution and propagation | `C18.recordVerdict` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S6/FR-407 | FR-407 — IDE plugin: selection, diff, breakpoint events into CDC (I-17…I-19) | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S6/FR-501 | FR-501 — Hypothesis debugging: seed, hypothesize with discrimination evidence, live refine from runtime signals, resolve to visual memory | `C22.start` | `C10.retrieve`, `C13.append`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Explicit requirement contract |
| S6/FR-502 | FR-502 — Semantic PR view: conceptual change event, consequence enumeration with evidence, review threads surviving merge | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C09.query`, `C13.append`, `C18.resolveEvidence`, `C29.applyOperation` | Explicit requirement contract |
| S6/FR-503 | FR-503 — PII/trust analysis: lineage × boundary × egress exposure surface with provenance-gated alarming | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Explicit requirement contract |
| S6/FR-504 | FR-504 — Code archaeology chain with fact/narrative separation and counterfactual spawn | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Explicit requirement contract |
| S6/FR-505 | FR-505 — Agentic investigation with declared scope, live canvas, interruptible plan, no-write guarantee, honest completion criteria | `C22.advance` | `C03.authorize`, `C13.append`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C19.compile`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-506 | FR-506 — Visual memory: named investigations, replay, entity-linked resurfacing, team handover with attribution | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Explicit requirement contract |
| S6/FR-507 | FR-507 — Runtime attribution with fog for unattributed traffic; time scrubbing over temporal forms | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-508 | FR-508 — Counterfactual scenarios incl. scale variant joining measured bottlenecks vs inferred ones | `C27.evaluateScenario` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Explicit requirement contract |
| S6/FR-601 | FR-601 — Provenance classes applied to every rendered element; epistemic styling enforced by the representation compiler | `C19.compile` | `C16.verify`, `C17.evaluate`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S6/FR-602 | FR-602 — Claim pipeline gates 1–5 enforced at render time; unevidenced claims unrenderable | `C16.verify` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C17.evaluate`, `C18.resolveEvidence`, `C19.compile` | Explicit requirement contract |
| S6/FR-603 | FR-603 — Authority inheritance: all views execute under the requesting user's permissions | `C03.authorize` | `C09.query`, `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C19.compile`, `C29.applyOperation`, `C30.export`, `C31.commit` | Explicit requirement contract |
| S6/FR-604 | FR-604 — Secret scrubbing at ingestion with opaque handles; minimization for personal data | `C03.scrubSource` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Explicit requirement contract |
| S6/FR-605 | FR-605 — Deployment modes: local inference, private-cloud inference, hosted API with per-repo opt-in and content filtering | `C14.generate` | `C03.authorize`, `C10.retrieve`, `C17.evaluate`, `C31.commit`, `C32.recordHealth` | Explicit requirement contract |
| S6/FR-606 | FR-606 — Immutable audit log of model invocations, egress, confirmations, scope changes, exports; exportable packs | `C18.appendAudit` | `C03.authorize`, `C14.generate`, `C28.analyzeIntent`, `C30.export`, `C31.commit`, `C32.recordHealth` | Explicit requirement contract |
| S6/FR-701 | FR-701 — Team collaboration: shared lenses, shared concept confirmations, attributed annotations, investigation handover | `C29.applyOperation` | `C03.authorize`, `C13.append`, `C18.resolveEvidence`, `C31.commit` | Explicit requirement contract |
| S6/FR-702 | FR-702 — Admin console: index health, claim dashboards, cost controls, model routing policy | `C32.configure` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S6/FR-703 | FR-703 — Full API for every CSM operation and interaction type (extension surface for teams and partners) | `C02.submit` | `C03.authorize`, `C13.append`, `C31.commit` | Explicit requirement contract |
| S6/NFR-01 | NFR-01 — Structural re-emphasis (tiering, pinning, filters) perceptible within 150 ms; provenance ledger open within 1 s; typical question  | `C20.applyPatch` | `C01.executeKeyboardAction`, `C09.query`, `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C19.compile`, `C21.resolve`, `C32.recordHealth` | Explicit requirement contract |
| S6/NFR-02 | NFR-02 — Incremental re-index of a typical PR under 60 s at 100k-symbol repository scale; full cold index under 2 h with progress reporting | `C07.runIndex` | `C04.ingestExternal`, `C05.resolveSemantics`, `C06.extractArtifacts`, `C09.query`, `C11.find`, `C16.verify`, `C18.resolveEvidence`, `C32.recordHealth` | Explicit requirement contract |
| S6/NFR-03 | NFR-03 — Repositories to 10^6 symbols and annual trace volumes to 10^9 spans supported with the tiered index of S10.2; views operate on sal | `C09.query` | `C07.computeImpact`, `C08.getEntity`, `C10.retrieve`, `C19.compile`, `C20.applyPatch`, `C24.attribute`, `C31.commit`, `C32.recordHealth` | Explicit requirement contract |
| S6/NFR-04 | NFR-04 — Session continuity across backend interruptions; investigations auto- checkpoint within 5 s of material change; no evidence loss o | `C13.checkpoint` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit`, `C32.recordHealth` | Explicit requirement contract |
| S6/NFR-05 | NFR-05 — Per-developer daily inference budget with configurable policy; CDC scoping keeps median question cost within budget; cost meter vi | `C14.generate` | `C03.authorize`, `C10.retrieve`, `C17.evaluate`, `C31.commit`, `C32.recordHealth` | Explicit requirement contract |
| S6/NFR-06 | NFR-06 — Authority inheritance enforced server-side for every view and query; secrets never persisted in plaintext; egress policy enforced  | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Explicit requirement contract |
| S6/NFR-07 | NFR-07 — Working-context bounds and retention defaults per S9.4; deletion requests propagate to derived artifacts within one index cycle | `C31.deleteDerived` | `C03.authorize`, `C07.computeImpact`, `C11.find`, `C13.append`, `C18.resolveEvidence`, `C29.applyOperation`, `C30.export` | Explicit requirement contract |
| S6/NFR-08 | NFR-08 — Every rendered claim traceable to evidence chain (UX-06); audit logs immutable and exportable (FR-606) | `C18.resolveEvidence` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S6/NFR-09 | NFR-09 — Language coverage at MVP: TypeScript/JavaScript, Python, Go, Java (tree-sitter + LSP); storage and model layers abstracted behind  | `C05.languageCapabilities` | `C01.executeKeyboardAction`, `C04.ingestExternal`, `C06.extractArtifacts`, `C14.generate`, `C31.commit`, `C32.recordHealth` | Explicit requirement contract |
| S6/NFR-10 | NFR-10 — New visualization forms addable without core changes (form contract: data binding, grammar, provenance rules); custom lenses and s | `C19.registerForm` | `C12.scoreSalience`, `C18.resolveEvidence`, `C20.applyPatch`, `C21.resolve`, `C32.recordHealth` | Explicit requirement contract |
| S6/NFR-11 | NFR-11 — 100% of hidden/emphasis decisions answerable via I-09/I-06 (tested by sampling); salience breakdowns human-readable | `C12.explainHidden` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Explicit requirement contract |
| S6/NFR-12 | NFR-12 — Displayed confidence within calibrated band of observed accuracy per claim class (measured continuously; see M-09) | `C17.calibrate` | `C14.generate`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S6/NFR-13 | NFR-13 — WCAG 2.1 AA; UI string externalization ready (MVP ships English); provenance multi- encoded (not color-only) | `C01.executeKeyboardAction` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S6/NFR-14 | NFR-14 — Deployment via operator-owned infrastructure (container images + IaC templates); health dashboard for indexers, gateways, model ro | `C32.health` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S5/FR-1 | FR-1 | `C04.ingestRepository` | `C03.authorize`, `C05.resolveSemantics`, `C06.extractArtifacts`, `C07.computeImpact` | Explicit requirement contract |
| S5/FR-2 | FR-2 | `C11.extract` | `C07.computeImpact`, `C08.getEntity`, `C14.generate`, `C16.verify`, `C18.resolveEvidence` | Explicit requirement contract |
| S5/FR-3 | FR-3 | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S5/FR-4 | FR-4 | `C15.answer` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Explicit requirement contract |
| S5/FR-5 | FR-5 | `C18.resolveEvidence` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S5/FR-6 | FR-6 | `C19.semanticZoom` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S5/FR-7 | FR-7 | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Explicit requirement contract |
| S5/FR-8 | FR-8 | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Explicit requirement contract |
| S5/FR-9 | FR-9 | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Explicit requirement contract |
| S5/FR-10 | FR-10 | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Explicit requirement contract |
| S5/FR-11 | FR-11 | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Explicit requirement contract |
| S5/FR-12 | FR-12 | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Explicit requirement contract |
| S5/FR-13 | FR-13 | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S5/FR-14 | FR-14 | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Explicit requirement contract |
| S5/FR-15 | FR-15 | `C12.changeLens` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Explicit requirement contract |
| S5/FR-16 | FR-16 | `C18.recordVerdict` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S5/FR-17 | FR-17 | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Explicit requirement contract |
| S5/CE-1 | CE-1 | `C04.ingestRepository` | `C03.authorize`, `C05.resolveSemantics`, `C06.extractArtifacts`, `C07.computeImpact` | Explicit requirement contract |
| S5/CE-2 | CE-2 | `C11.extract` | `C07.computeImpact`, `C08.getEntity`, `C14.generate`, `C16.verify`, `C18.resolveEvidence` | Explicit requirement contract |
| S5/CE-3 | CE-3 | `C07.runIndex` | `C08.getEntity`, `C09.query`, `C11.find`, `C18.resolveEvidence`, `C31.commit` | Explicit requirement contract |
| S5/CE-4 | CE-4 | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Explicit requirement contract |
| S5/CE-5 | CE-5 | `C24.ingest` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Explicit requirement contract |
| S5/CE-6 | CE-6 | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Explicit requirement contract |
| S5/CE-7 | CE-7 | `C12.scoreSalience` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Explicit requirement contract |
| S5/CE-8 | CE-8 | `C18.recordVerdict` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Explicit requirement contract |
| S5/CE-9 | CE-9 | `C03.approveEgress` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Explicit requirement contract |
| S1/UC-A01 | Intent-relative authentication map | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A02 | Failure causal chain | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S1/UC-A03 | Blast radius of removal | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A04 | PII escape paths | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S1/UC-A05 | Why this ugly code exists | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A06 | Role-adaptive view of same code | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A07 | Visual intent for risk insertion | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S1/UC-A08 | Counterfactual async conversion | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Proposed workflow contract |
| S1/UC-A09 | Scattered business rule discovery | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A10 | Progressive onboarding map | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S1/UC-A11 | Test confidence overlay | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S1/UC-A12 | Implicit state machine extraction | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A13 | Concurrency / race hypothesis | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S1/UC-A14 | Change-aware PR conceptual diff | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S1/UC-A15 | Persistent investigation workspace | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A16 | Agentic “find every way balance can become inconsistent” | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S1/UC-A17 | Ownership transfer / responsibility map | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S1/UC-A18 | Policy enforcement gaps | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S1/UC-A19 | Temporal execution movie | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A20 | Uncertainty / confidence map | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S1/UC-A21 | Duplicated concept detection | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A22 | User-journey to code mapping | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S1/UC-A23 | Hidden coupling discovery | `C12.explainHidden` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Proposed workflow contract |
| S1/UC-A24 | Invariant map | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A25 | Migration impact visualization | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S1/UC-A26 | Visual memory of past decisions | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Proposed workflow contract |
| S1/UC-A27 | Personalized relevance filtering | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Proposed workflow contract |
| S1/UC-A28 | Cross-domain synthesis (code + infra + data) | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A29 | Speculative load / scale view | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S1/UC-A30 | Collaborative visual investigation | `C29.share` | `C03.authorize`, `C13.append`, `C18.resolveEvidence`, `C31.commit` | Proposed workflow contract |
| S2/UC-01 | Intent-Relative Authentication Flow | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-02 | Causal Failure Analysis | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-03 | Visual Blast Radius with Semantic Grouping | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-04 | PR as Architectural Diff | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S2/UC-05 | Visual Hypothesis Debugging | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-06 | Code Archaeology Timeline | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S2/UC-07 | Trust-Boundary Data Flow | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-08 | Counterfactual Architecture Exploration | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Proposed workflow contract |
| S2/UC-09 | Visual Memory / Investigation Persistence | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Proposed workflow contract |
| S2/UC-10 | Personalized Representation by Role | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Proposed workflow contract |
| S2/UC-11 | Agentic Balance Consistency Investigation | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-12 | Test Confidence Map | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S2/UC-13 | Implicit Workflow Discovery | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-14 | Runtime-Grounded Architecture | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S2/UC-15 | Change-Aware Living Model | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S2/UC-16 | Visual Intent Specification via Manipulation | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Proposed workflow contract |
| S2/UC-17 | Onboarding Walkthrough Generation | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S2/UC-18 | Concurrency Hazard Map | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-19 | Dependency Risk Map | `C10.retrieve` | `C03.authorize`, `C09.query`, `C11.find`, `C14.generate` | Proposed workflow contract |
| S2/UC-20 | API Journey Visualization | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S2/UC-21 | Policy Enforcement Gap Analysis | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-22 | Security Invariant Map | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-23 | Temporal Execution Reconstruction | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-24 | Monorepo Service Boundary Discovery | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-25 | Feature Flag Topology | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-26 | Contract Evolution Tracking | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S2/UC-27 | Cross-Language Semantic Bridge | `C05.analyzeSyntax` | `C06.extractArtifacts`, `C07.computeImpact`, `C08.getEntity`, `C09.query` | Proposed workflow contract |
| S2/UC-28 | Incident Postmortem Visualization | `C24.ingest` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S2/UC-29 | Dependency Upgrade Impact | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S2/UC-30 | Visual Uncertainty Map | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S2/UC-31 | Conversational Visual Refinement | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Proposed workflow contract |
| S2/UC-32 | Cross-Repository Dependency Reasoning | `C15.answerAcrossRepositories` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-33 | Performance Regression Investigation | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S2/UC-34 | Documentation Gap Discovery | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S2/UC-35 | Multi-Modal Interaction with Runtime State | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S5/UC-01 | Intent-Relative Semantic Map | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S5/UC-02 | Failure Causal Map | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S5/UC-03 | Invariant Violation Map | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-04 | Semantic Blast Radius | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-05 | Cross-Layer Journey | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S5/UC-06 | Feature Location | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-07 | Onboarding Narrative | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S5/UC-08 | Incident Relevance Collapse | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-09 | Hypothesis Workspace (Living Investigation) | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S5/UC-10 | Trace-to-Code Temporal Replay | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-11 | Cross-Service Causality Stitching | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-12 | Performance Hypothesis Map | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S5/UC-13 | Concurrency & Race Map | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S5/UC-14 | Semantic Breakpoints / Invariant Watch | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-15 | Code Archaeology | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S5/UC-16 | Conceptual PR Diff | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S5/UC-17 | Migration Progress Map | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-18 | Refactoring Journey Plan | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Proposed workflow contract |
| S5/UC-19 | Architecture Evolution Movie | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S5/UC-20 | Regression Archaeology | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S5/UC-21 | Counterfactual Architecture | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Proposed workflow contract |
| S5/UC-22 | Visual Intent Compilation | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-23 | Cohesion & Extraction Proposal | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-24 | Decoupling Cost Analysis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-25 | Design Review Canvas | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-26 | Implicit Concept Mining | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-27 | Invariant & Enforcement-Point Map | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-28 | Security Privilege & Egress Map | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S5/UC-29 | Documentation Drift Map | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-30 | Ownership Reality Map | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S5/UC-31 | Uncertainty / Debt Terrain | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S5/UC-32 | Persona-Relative Re-Representation | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Proposed workflow contract |
| S5/UC-33 | Visual Investigation Memory | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-34 | Agentic Investigation with Mid-Flight Steering | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S5/UC-35 | Environment / Config Behavioral Diff | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S5/UC-36 | Test-Confidence Map | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S6/UC-01 | Intent-Relative Architecture View | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S6/UC-02 | Failure-Space Map | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-03 | Invariant Hunt (Balance Correctness) | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-04 | Blast-Radius Interrogation | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S6/UC-05 | UI-to-Data Path Trace | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S6/UC-06 | PII Escape Analysis | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-07 | New-Joiner Narrative Tour | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S6/UC-08 | Exception-Minimal View | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Proposed workflow contract |
| S6/UC-09 | Domain Concept Dictionary | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S6/UC-10 | Role-Relative Mental-Model Translation | `C14.generate` | `C03.authorize`, `C10.retrieve`, `C17.evaluate`, `C31.commit`, `C32.recordHealth` | Proposed workflow contract |
| S6/UC-11 | Causal Graph of an Incident | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Proposed workflow contract |
| S6/UC-12 | Transaction Journey Map | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S6/UC-13 | Trust-Boundary and Privilege Map | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-14 | Concurrency and Race-Window Map | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-15 | Ownership and Lifecycle Timeline | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-16 | Semantic PR Review | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S6/UC-17 | Code Archaeology Timeline | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S6/UC-18 | Incident Post-Mortem Reconstruction | `C24.ingest` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S6/UC-19 | Deprecation Impact Forecast | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S6/UC-20 | Cross-Team Coupling Radar | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Proposed workflow contract |
| S6/UC-21 | Living Hypothesis Board | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-22 | Runtime Overlay Interrogation | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S6/UC-23 | Agentic Root-Cause Investigation | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-24 | Test-Confidence and Coverage Gap Map | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Proposed workflow contract |
| S6/UC-25 | Heisenbug Reproduction Designer | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-26 | Drag-to-Intent Refactoring | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Proposed workflow contract |
| S6/UC-27 | Counterfactual Sandbox (Monolith Split) | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Proposed workflow contract |
| S6/UC-28 | Scaling Stress Preview | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-29 | Async Migration Planner | `C27.createScenario` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Proposed workflow contract |
| S6/UC-30 | Policy Enforcement Gap Map | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-31 | Audit Narrative Generator | `C25.analyze` | `C03.authorize`, `C06.extractArtifacts`, `C09.query`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Proposed workflow contract |
| S6/UC-32 | Production Incident War-Room View | `C24.ingest` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Proposed workflow contract |
| S1/BLOCK-001 | Source introduction and document metadata | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-002 | 1. Executive Summary | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-003 | 2. Product Thesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-004 | 3. Problem Definition | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-005 | 4. Target Users / Personas | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-006 | 5. Jobs-to-be-Done | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-007 | 6. Existing-Tool Limitations | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S1/BLOCK-008 | 7. LLM-Native Differentiation | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S1/BLOCK-009 | 8. Context-Engine Requirements | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-010 | 9. Interaction Model | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S1/BLOCK-011 | 10. Visualization Model | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S1/BLOCK-012 | 11. Semantic Zoom Model | `C19.semanticZoom` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S1/BLOCK-013 | 12. Visual + Conversational Interaction | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S1/BLOCK-014 | 13. Visual Manipulation of Code Intent | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Candidate source block contract |
| S1/BLOCK-015 | 14. Debugging Workflows | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S1/BLOCK-016 | 15. Architecture Exploration | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S1/BLOCK-017 | 16. Security Analysis | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-018 | 17. Performance Analysis | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S1/BLOCK-019 | 18. Code Archaeology | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S1/BLOCK-020 | 19. Change / PR Visualization | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S1/BLOCK-021 | 20. Runtime Visualization | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S1/BLOCK-022 | 21. Counterfactual Architecture | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S1/BLOCK-023 | 22. Agentic Investigation | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S1/BLOCK-024 | 23. Visual Memory | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-025 | 24. Evidence / Provenance Model | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-026 | 25. Hallucination Controls | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-027 | 26. Permissions / Privacy | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-028 | 27. UX Requirements | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Candidate source block contract |
| S1/BLOCK-029 | 28. Functional Requirements (high level) | `C02.submit` | `C03.authorize`, `C13.append`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-030 | 29. Non-Functional Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-031 | 30. Integration Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-032 | 31. MVP Definition | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-033 | 32. Post-MVP Roadmap | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-034 | 33. Success Metrics | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S1/BLOCK-035 | 34. Risks | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-036 | 35. Open Research Questions | `C10.retrieve` | `C03.authorize`, `C09.query`, `C11.find`, `C14.generate` | Candidate source block contract |
| S1/BLOCK-037 | LLM-Native Use-Case Catalogue | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-038 | C. Visualization Catalogue (selected high-value types) | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S1/BLOCK-039 | D. Interaction Catalogue | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S1/BLOCK-040 | E. Context Model | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S1/BLOCK-041 | F. Innovation Matrix | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S1/BLOCK-042 | G. MVP | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S1/BLOCK-043 | H. Future Vision | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-044 | Source introduction and document metadata | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-045 | 1. Executive Summary | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-046 | 2. Product Thesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-047 | 3. Problem Definition | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-048 | 4. Target Users & Personas | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-049 | 5. Jobs-to-be-Done | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-050 | 6. Existing Tool Limitations | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S2/BLOCK-051 | 7. LLM-Native Differentiation | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S2/BLOCK-052 | 8. Context Engine Requirements | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-053 | 9. Interaction Model | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S2/BLOCK-054 | 10. Visualization Model | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S2/BLOCK-055 | 11. Evidence & Provenance Model | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-056 | 12. Security, Privacy & Prompt Injection Defenses | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-057 | 13. LLM-Native Use-Case Catalogue | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-058 | 14. Innovation Matrix | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S2/BLOCK-059 | 15. Competitive Reality Check | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S2/BLOCK-060 | 16. Visualization Catalogue | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S2/BLOCK-061 | 17. Interaction Catalogue | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S2/BLOCK-062 | 18. Context Model | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S2/BLOCK-063 | 19. Debugging Workflows | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S2/BLOCK-064 | 20. Architecture Exploration | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S2/BLOCK-065 | 21. Security Analysis | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-066 | 22. Performance Analysis | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S2/BLOCK-067 | 23. Code Archaeology | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S2/BLOCK-068 | 24. Change & PR Visualization | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S2/BLOCK-069 | 25. Runtime Visualization | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S2/BLOCK-070 | 26. Counterfactual Architecture | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S2/BLOCK-071 | 27. Agentic Investigation | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S2/BLOCK-072 | 28. Visual Memory | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-073 | 29. UX Requirements | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Candidate source block contract |
| S2/BLOCK-074 | 30. Functional Requirements | `C02.submit` | `C03.authorize`, `C13.append`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-075 | 31. Non-Functional Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-076 | 32. Integration Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-077 | 33. MVP Definition | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-078 | 34. Post-MVP Roadmap | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-079 | 35. Success Metrics | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S2/BLOCK-080 | 36. Risks | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S2/BLOCK-081 | 37. Open Research Questions | `C10.retrieve` | `C03.authorize`, `C09.query`, `C11.find`, `C14.generate` | Candidate source block contract |
| S2/BLOCK-082 | Appendix A: Unexpected Representations | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S2/BLOCK-083 | Appendix B: Critical Design Principle Validation | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S2/BLOCK-084 | Appendix C: Competitive Positioning Summary | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S3/BLOCK-085 | Source introduction and document metadata | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S3/BLOCK-086 | LLM-Native Interactive Code Intelligence & Visualization System | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S3/BLOCK-087 | 1. Product Thesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S3/BLOCK-088 | 2. Continuous Context Awareness | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S3/BLOCK-089 | 3. Discover LLM-Exclusive Use Cases | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S3/BLOCK-090 | 4. Generative Visualizations | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S3/BLOCK-091 | 5. Semantic Zoom | `C19.semanticZoom` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S3/BLOCK-092 | 6. Conversational + Visual Interaction | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S3/BLOCK-093 | 7. Visual Manipulation as a Programming Interface | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Candidate source block contract |
| S3/BLOCK-094 | 8. Counterfactual Code Visualization | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S3/BLOCK-095 | 9. Debugging as Visual Hypothesis Exploration | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S3/BLOCK-096 | 10. Code Archaeology | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S3/BLOCK-097 | 11. Visualize What Is NOT Explicitly Written | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S3/BLOCK-098 | 12. Personalized Representation | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S3/BLOCK-099 | 13. Progressive Disclosure | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Candidate source block contract |
| S3/BLOCK-100 | 14. Multi-Modal Interaction | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S3/BLOCK-101 | 15. Visual Memory | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Candidate source block contract |
| S3/BLOCK-102 | 16. Confidence and Epistemic Visualization | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S3/BLOCK-103 | 17. Agentic Investigation | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S3/BLOCK-104 | 18. Change-Aware Living Model | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S3/BLOCK-105 | 19. PRD Deliverables | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S3/BLOCK-106 | 20. Use-Case Catalogue | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S3/BLOCK-107 | 21. Innovation Matrix | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S3/BLOCK-108 | 22. Competitive Reality Check | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S3/BLOCK-109 | 23. Search for Unexpected Representations | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S3/BLOCK-110 | 24. The Ultimate Test | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S3/BLOCK-111 | 25. Final Deliverables | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S3/BLOCK-112 | Critical Design Principle | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S4/BLOCK-113 | Source introduction and document metadata | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S4/BLOCK-114 | 1. Executive Summary | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S4/BLOCK-115 | 2. Competitive Reality Check (Evidence Base for Novelty Claims) | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S4/BLOCK-116 | 3. Tier 1 — Apparently Novel (No Incumbent Found) | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S4/BLOCK-117 | 4. Tier 2 — Novel Fusions (Adjacent Fragments Exist; the Idea as Specified Is New) | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S4/BLOCK-118 | 5. Tier 3 — Research Frontier (Novel, But Not Yet Buildable as Described) | `C10.retrieve` | `C03.authorize`, `C09.query`, `C11.find`, `C14.generate` | Candidate source block contract |
| S4/BLOCK-119 | 6. Innovation Matrix | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S4/BLOCK-120 | 7. The Ultimate Test, Applied | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S4/BLOCK-121 | 8. Honest Caveats | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S5/BLOCK-122 | CARTOGRAPH | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-123 | Product Requirements Document & Design Dossier — An LLM-Native Interactive Code Intelligence & Visualization System | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-124 | PART 0 — THE CORE IDEA, STATED ONCE, PRECISELY | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-125 | PART I — PRD SECTIONS 1–7: FOUNDATIONS | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-126 | 1. Executive Summary | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-127 | 2. Product Thesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-128 | 3. Problem Definition | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-129 | 4. Target Users / Personas | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-130 | 5. Jobs-to-be-Done | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-131 | 6. Existing-Tool Limitations (see also Part VI — Competitive Reality Check) | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S5/BLOCK-132 | 7. LLM-Native Differentiation — and the Ultimate Test | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S5/BLOCK-133 | PART II — PRD SECTIONS 8–12: THE ENGINE AND THE CANVAS | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-134 | 8. Context-Engine Requirements | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-135 | 9. Interaction Model | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S5/BLOCK-136 | 10. Visualization Model | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-137 | 11. Semantic Zoom Model | `C19.semanticZoom` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-138 | 12. Visual + Conversational Interaction (Bidirectional Protocol) | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S5/BLOCK-139 | PART III — PRD SECTIONS 13–21: THE KILLER WORKFLOWS | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-140 | 13. Visual Manipulation as an Intent Specification Interface | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Candidate source block contract |
| S5/BLOCK-141 | 14. Debugging as Visual Hypothesis Exploration (UC-09) | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S5/BLOCK-142 | 15. Architecture Exploration (UC-01/04/06/21/24) | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-143 | 16. Security Analysis (two meanings) | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-144 | 17. Performance Analysis (two meanings) | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S5/BLOCK-145 | 18. Code Archaeology (UC-15) | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S5/BLOCK-146 | 19. Change / PR Visualization (UC-16) | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-147 | 20. Runtime Visualization (UC-10/11/20-adjacent) | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-148 | 21. Counterfactual Architecture (UC-21) | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S5/BLOCK-149 | 22. Agentic Investigation (UC-34) | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S5/BLOCK-150 | 23. Visual Memory (UC-33) | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-151 | 24. Evidence / Provenance Model (core product feature) | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-152 | 25. Hallucination Controls | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-153 | 26. Permissions / Privacy | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-154 | 27. UX Requirements | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Candidate source block contract |
| S5/BLOCK-155 | PART IV — PRD SECTIONS 28–35: REQUIREMENTS & PROGRAM | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-156 | 28. Functional Requirements (top-level; full traceability in use-case catalogue) | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-157 | 29. Non-Functional Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-158 | 30. Integration Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-159 | 31. MVP Definition — summary | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-160 | 32. Post-MVP Roadmap | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-161 | 33. Success Metrics | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S5/BLOCK-162 | 34. Risks | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-163 | 35. Open Research Questions | `C10.retrieve` | `C03.authorize`, `C09.query`, `C11.find`, `C14.generate` | Candidate source block contract |
| S5/BLOCK-164 | PART V — COMPETITIVE REALITY CHECK | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S5/BLOCK-165 | PART VI — LLM-NATIVE USE-CASE CATALOGUE (36) | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-166 | PART VII — SEARCH FOR UNEXPECTED REPRESENTATIONS (borrowed-domain synthesis) | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-167 | PART VIII — VISUALIZATION CATALOGUE | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S5/BLOCK-168 | PART IX — INTERACTION CATALOGUE (typed) | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S5/BLOCK-169 | PART X — CONTEXT MODEL (precise) | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S5/BLOCK-170 | PART XI — INNOVATION MATRIX | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S5/BLOCK-171 | PART XII — MVP: "THE QUESTIONABLE MAP" | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S5/BLOCK-172 | PART XIII — FUTURE VISION: THE LIVE SEMANTIC DIGITAL TWIN | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-173 | Meridian cover, table of contents and front matter | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-174 | 1 Executive Summary | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-175 | 2 Product Thesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-176 | 3 Problem Definition | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-177 | 4 Target Users and Personas | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-178 | 5 Jobs-to-be-Done | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-179 | 6 Existing-Tool Limitations and Competitive Reality Check | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-180 | 7 LLM-Native Differentiation | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-181 | 8 Context-Engine Requirements: The Five Planes | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-182 | 9 The Context Model: Lifecycle, Salience, and Memory (Deliverable E) | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-183 | 10 The Continuous Semantic Model (CSM) | `C14.generate` | `C03.authorize`, `C10.retrieve`, `C17.evaluate`, `C31.commit`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-184 | 11 The Visualization Model: Representation as a Decision | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-185 | 12 The Semantic Zoom Model | `C19.semanticZoom` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-186 | 13 Generative Visualizations and Borrowed Lenses | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-187 | 14 Visualization Catalogue (Deliverable C) | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-188 | 15 Interaction Model and Interaction Catalogue (Deliverable D) | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S6/BLOCK-189 | 16 Visual Manipulation as an Intent Specification Interface | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Candidate source block contract |
| S6/BLOCK-190 | 17 Progressive Disclosure and Personalized Representation | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-191 | 18 Multi-Modal Interaction | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S6/BLOCK-192 | 19 Debugging as Visual Hypothesis Exploration | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-193 | 20 Architecture Exploration and the Counterfactual Sandbox | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S6/BLOCK-194 | 21 Security and Policy Analysis | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-195 | 22 Performance Analysis | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-196 | 23 Code Archaeology | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S6/BLOCK-197 | 24 The Change-Aware Living Model and PR Visualization | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S6/BLOCK-198 | 25 Runtime Visualization | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-199 | 26 Agentic Investigation | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-200 | 27 Visual Memory: The Persistent Reasoning Workspace | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-201 | 28 The Evidence and Provenance Model | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-202 | 29 Hallucination Controls | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-203 | 30 Permissions, Privacy, and Security of the Tool Itself | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-204 | 31 UX Requirements | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Candidate source block contract |
| S6/BLOCK-205 | 32 Functional Requirements | `C02.submit` | `C03.authorize`, `C13.append`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-206 | 33 Non-Functional Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-207 | 34 Integration Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-208 | 35 Group A — Intent-Relative Understanding | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-209 | 36 Group B — Onboarding and Comprehension | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-210 | 38 Group C — Generative Representations | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-211 | 39 Group D — Change and Evolution | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-212 | 40 Group E — Debugging and Investigation | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-213 | 41 Group F — Design and Counterfactuals | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S6/BLOCK-214 | 42 Group G — Security, Compliance, and Operations | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-215 | 43 Catalogue Synthesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-216 | 44 Innovation Matrix (Deliverable F) | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-217 | 45 MVP Definition (Deliverable G) | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-218 | 46 Post-MVP Roadmap | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-219 | 47 Success Metrics | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-220 | 48 Risks and Mitigations | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-221 | 49 Open Research Questions | `C10.retrieve` | `C03.authorize`, `C09.query`, `C11.find`, `C14.generate` | Candidate source block contract |
| S6/BLOCK-222 | 50 Future Vision: The Live Semantic Digital Twin (Deliverable H) | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-223 | Appendix A — Glossary | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-224 | Appendix B — Extended Investigation Transcript | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-225 | 1 Executive Summary | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-226 | 2 Product Thesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-227 | 3 Problem Definition | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-228 | 4 Target Users and Personas | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-229 | 5 Jobs-to-be-Done | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-230 | 6 Existing-Tool Limitations and Competitive Reality Check | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-231 | 7 LLM-Native Differentiation | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-232 | 8 Context-Engine Requirements: The Five Planes | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-233 | 9 The Context Model: Lifecycle, Salience, and Memory | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-234 | 10 The Continuous Semantic Model (CSM) | `C14.generate` | `C03.authorize`, `C10.retrieve`, `C17.evaluate`, `C31.commit`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-235 | 11 The Visualization Model: Representation as a Decision | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-236 | 12 The Semantic Zoom Model | `C19.semanticZoom` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-237 | 13 Generative Visualizations and Borrowed Lenses | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-238 | 14 Visualization Catalogue (Deliverable C) | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-239 | 15 Interaction Model and Interaction Catalogue (Deliverable | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S6/BLOCK-240 | 16 Visual Manipulation as an Intent Specification Interface | `C28.interpretGesture` | `C03.authorize`, `C09.query`, `C21.resolve`, `C27.evaluateScenario`, `C30.export` | Candidate source block contract |
| S6/BLOCK-241 | 17 Progressive Disclosure and Personalized Representation | `C12.applyContextEvent` | `C02.submit`, `C03.authorize`, `C10.retrieve`, `C11.find`, `C13.append`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-242 | 18 Multi-Modal Interaction | `C21.resolve` | `C01.executeKeyboardAction`, `C02.submit`, `C12.scoreSalience`, `C19.compile`, `C28.analyzeIntent` | Candidate source block contract |
| S6/BLOCK-243 | 19 Debugging as Visual Hypothesis Exploration | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-244 | 20 Architecture Exploration and the Counterfactual Sandbox | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S6/BLOCK-245 | 21 Security and Policy Analysis | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-246 | 22 Performance Analysis | `C26.analyze` | `C05.resolveSemantics`, `C09.query`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-247 | 23 Code Archaeology | `C23.archaeology` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S6/BLOCK-248 | 24 The Change-Aware Living Model and PR Visualization | `C23.compare` | `C04.ingestExternal`, `C07.computeImpact`, `C08.getEntity`, `C09.query`, `C18.resolveEvidence` | Candidate source block contract |
| S6/BLOCK-249 | 25 Runtime Visualization | `C24.replay` | `C03.authorize`, `C04.ingestExternal`, `C08.getEntity`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-250 | 26 Agentic Investigation | `C22.advance` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-251 | 27 Visual Memory: The Persistent Reasoning Workspace | `C13.resume` | `C02.submit`, `C18.resolveEvidence`, `C29.applyOperation`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-252 | 28 The Evidence and Provenance Model | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-253 | 29 Hallucination Controls | `C18.registerDraft` | `C03.authorize`, `C07.computeImpact`, `C16.verify`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-254 | 30 Permissions, Privacy, and Security of the Tool Itself | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-255 | 31 UX Requirements | `C01.captureEditorEvent` | `C02.submit`, `C20.applyPatch`, `C21.resolve` | Candidate source block contract |
| S6/BLOCK-256 | 32 Functional Requirements | `C02.submit` | `C03.authorize`, `C13.append`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-257 | 33 Non-Functional Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-258 | 34 Integration Requirements | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-259 | 35 Group A — Intent-Relative Understanding | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-260 | 36 Group B — Onboarding and Comprehension | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-261 | 38 Group C — Generative Representations | `C19.compile` | `C09.query`, `C12.scoreSalience`, `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch` | Candidate source block contract |
| S6/BLOCK-262 | 39 Group D — Change and Evolution | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-263 | 40 Group E — Debugging and Investigation | `C22.start` | `C10.retrieve`, `C14.generate`, `C15.draftClaims`, `C16.verify`, `C18.resolveEvidence`, `C24.attribute` | Candidate source block contract |
| S6/BLOCK-264 | 41 Group F — Design and Counterfactuals | `C27.compare` | `C09.query`, `C16.verify`, `C19.compile`, `C24.attribute`, `C26.analyze` | Candidate source block contract |
| S6/BLOCK-265 | 42 Group G — Security, Compliance, and Operations | `C03.authorize` | `C10.retrieve`, `C14.generate`, `C29.applyOperation`, `C30.export`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-266 | 43 Catalogue Synthesis | `C15.interpret` | `C10.retrieve`, `C12.scoreSalience`, `C14.generate`, `C16.verify`, `C19.compile` | Candidate source block contract |
| S6/BLOCK-267 | 44 Innovation Matrix (Deliverable F) | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-268 | 45 MVP Definition (Deliverable G) | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-269 | 46 Post-MVP Roadmap | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-270 | 47 Success Metrics | `C17.evaluate` | `C16.verify`, `C18.resolveEvidence`, `C20.applyPatch`, `C32.recordHealth` | Candidate source block contract |
| S6/BLOCK-271 | 48 Risks and Mitigations | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-272 | 49 Open Research Questions | `C10.retrieve` | `C03.authorize`, `C09.query`, `C11.find`, `C14.generate` | Candidate source block contract |
| S6/BLOCK-273 | 50 Future Vision: The Live Semantic Digital Twin (Deliverable | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-274 | Appendix A — Glossary | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |
| S6/BLOCK-275 | Appendix B — Extended Investigation Transcript | `C32.recordHealth` | `C03.authorize`, `C14.generate`, `C17.evaluate`, `C31.commit` | Candidate source block contract |

## 8 Implementation exit criteria and unresolved decisions

1. Approve exact MVP languages, forms, runtime/PR scope and performance baselines; conflicting source proposals remain explicit obligations until resolved.
2. Freeze entity, schema, event and API versions. Register forms, model prompts, tool schemas and error policies.
3. Add public-operation contract tests with authorization failure, stale revision, version conflict, missing/corrupt evidence, cancellation and budget exhaustion cases.
4. Verify incremental-vs-clean indexing, permission-safe retrieval, claim state transitions, five display gates, calibration/abstention, identity-preserving semantic zoom, and durable investigation resumption.
5. Test all supplied numerical targets on a named hardware/repository/model profile. Preserve partial-source degradation and runtime attribution fog.
6. Reject cyclic synchronous side-effect calls. Use ledger events for concept corrections and scenario results for dual-view compilation.
7. Select and validate the numerical chart adapter; advanced agents, simulations, formal verifiers and any future code-apply executor remain separately gated interfaces.
8. Refine every candidate source block into reviewed clauses before calling the implementation baseline complete. All implementation and acceptance status in this document remains Planned / Not verified.

### Contract limitations to close before production

- The primitive operation catalogue is specified, but concrete registered JSON schemas for generic SchemaValue inputs, source adapters and event payloads must be finalized per integration. A missing schema is a build-time integration gap, never permissive runtime JSON.
- Internal function names express requirement-level behavior. Parser-specific algorithms, query plans, chart renderer internals, protocol retries and transactional implementations are intentionally below this document's abstraction level.
- Cross-repository operations use MultiRevisionRef, MultiGraphProjection, MultiEvidenceBundle and MultiViewSpec. Authorize every member repository and every cross-link before compilation. Panel node IDs are namespaced by panel ID; cross-panel edges reference those qualified IDs. Failure to resolve a join yields an explicit unknown, not an invented dependency.
- Full source requirements and acceptance thresholds remain authoritative in the consolidated specification; the traceability register preserves identifiers and summaries rather than replacing those originals.


## 10 Rust modules and complete RPC boundary

This section extends Sections 1–9 without removing their APIs or traceability. It is a normative **proposed design**, not executable Rust or proof of implementation. The Rust forms below bind the existing logical operations to implementation modules; shared domain types retain Section 2 meanings and field names on the wire. The numeric types shown require schema bounds: graph depth and level must fit their allowed ranges, and expected versions cannot be negative.

### 10.1 Deployment and responsibility split

One supervised Rust worker process contains C04–C09 modules. These are not six independently deployed services. The TypeScript core owns identity, model calls, claim verification, workspace state and external provider credentials. The browser cannot call the worker directly.

| Component | Rust module | Boundary ownership |
|---|---|---|
| C04 | `repository` | Local repository ingestion, immutable Git revision reads and connector health. External forge/CI/issue ingestion remains TypeScript. |
| C05 | `language` | Syntax parsing, compiler/LSP/SCIP adapters, resolution diagnostics and clean-index comparison. C17 owns evaluation records. |
| C06 | `artifacts` | Deterministic configuration, schema, route and build artifact analysis. Unsupported adapters return explicit diagnostics. |
| C07 | `indexing` | Bounded analysis queue, checkpoints, generation fences and reverse dependency impact. TypeScript orchestrates claim/concept revalidation. |
| C08 | `registry` | Stable entity IDs, revision lineage, visibility-filtered entity reads and alias candidates. Concept merge proposals and human verdict orchestration remain TypeScript. |
| C09 | `graph` | Revision-bound graph reads, path search, projections and atomic fact publication through C31. |

The default local protocol is length-prefixed UTF-8 JSON over a parent-owned duplex process channel. Each frame has a four-byte unsigned big-endian length followed by that many bytes. Protocol v1 rejects frames above 8 MiB before allocation. Large source bodies and analysis batches use tenant-scoped content handles rather than oversized frames. Remote/team deployment must add authenticated transport; this local channel must never be exposed as a public TCP endpoint.

### 10.2 Shared Rust execution and ownership types

```rust
// Pseudocode: domain DTO definitions come from the shared schema registry.
struct WorkerContext {
    request_id: RequestId,
    trace_id: TraceId,
    deadline: Timestamp,
    cancellation: CancellationToken,
    generation: Generation,
    authority: VerifiedScope, // authenticated parent capability, never browser JSON
    expected_revision: Option<RevisionRef>,
    idempotency_key: Option<Id>,
}
struct WorkerError {
    code: WorkerErrorCode,
    message: String, // sanitized, no raw source or secrets
    retryable: bool,
    expected_revision: Option<RevisionRef>,
    actual_revision: Option<RevisionRef>,
    diagnostics: Vec<Diagnostic>,
}
enum WorkerErrorCode {
    InvalidRequest, Unauthorized, NotFound, UnsupportedLanguage,
    UnsupportedArtifact, RevisionConflict, GenerationConflict,
    Cancelled, DeadlineExceeded, BudgetExceeded, PayloadTooLarge,
    AdapterUnavailable, CorruptCheckpoint, StorageUnavailable, Internal,
}
type WorkerResult<T> = Result<T, WorkerError>;
```

Requests own their DTOs. Immutable parsed trees and graph snapshots can be borrowed within a call or shared with `Arc<Snapshot>` inside the worker. No reference, pointer, cancellation token, trait object or filesystem descriptor appears in RPC JSON. ID, timestamp and hash newtypes serialize to the Section 2 string representations. Options serialize to explicit null; lists to arrays; closed enums use registered string variants. A schema registry/code generation step must guarantee the Rust and TypeScript forms agree; handwritten duplicate DTO definitions are not authoritative.

Async methods represent asynchronous orchestration; CPU parsing and traversals execute in bounded CPU tasks rather than blocking the IPC reader. The examples use async trait notation as pseudocode; the eventual implementation must choose a compatible trait-dispatch approach.

### 10.3 Rust module API catalogue

Each request below contains exactly the fields of its existing logical API. Every method also takes `WorkerContext`; the transport wraps outputs into the shared ApiResult envelope. Internal function inventories and requirement IDs are inherited from the corresponding Section 4 operation; the RPC trace table below makes that binding explicit.

#### C04 `RepositoryModule`

```rust
struct RepositoryIngestRepositoryRequest {
    source: SourceEnvelope,
}
struct RepositoryReadRevisionPairRequest {
    base: RevisionRef,
    head: RevisionRef,
}
struct RepositoryConnectorHealthRequest {
    source_id: Id,
}

trait RepositoryModule: Send + Sync {
    async fn ingest_repository(&self, ctx: &WorkerContext, req: RepositoryIngestRepositoryRequest)
        -> WorkerResult<Job<AnalysisBatch>>;
    async fn read_revision_pair(&self, ctx: &WorkerContext, req: RepositoryReadRevisionPairRequest)
        -> WorkerResult<ChangeSet>;
    async fn connector_health(&self, ctx: &WorkerContext, req: RepositoryConnectorHealthRequest)
        -> WorkerResult<HealthReport>;
}
```

#### C05 `LanguageModule`

```rust
struct LanguageAnalyzeSyntaxRequest {
    source: SourceEnvelope,
    language: String,
}
struct LanguageResolveSemanticsRequest {
    batch: AnalysisBatch,
    language: String,
}
struct LanguageCompareWithCleanIndexRequest {
    revision: RevisionRef,
}
struct LanguageLanguageCapabilitiesRequest {
    language: String,
}

trait LanguageModule: Send + Sync {
    async fn analyze_syntax(&self, ctx: &WorkerContext, req: LanguageAnalyzeSyntaxRequest)
        -> WorkerResult<AnalysisBatch>;
    async fn resolve_semantics(&self, ctx: &WorkerContext, req: LanguageResolveSemanticsRequest)
        -> WorkerResult<AnalysisBatch>;
    async fn compare_with_clean_index(&self, ctx: &WorkerContext, req: LanguageCompareWithCleanIndexRequest)
        -> WorkerResult<EvalReport>;
    async fn language_capabilities(&self, ctx: &WorkerContext, req: LanguageLanguageCapabilitiesRequest)
        -> WorkerResult<Vec<String>>;
}
```

#### C06 `ArtifactsModule`

```rust
struct ArtifactsExtractArtifactsRequest {
    source: SourceEnvelope,
}
struct ArtifactsJoinArtifactsRequest {
    batch: AnalysisBatch,
}
struct ArtifactsValidateArtifactsRequest {
    batch: AnalysisBatch,
}

trait ArtifactsModule: Send + Sync {
    async fn extract_artifacts(&self, ctx: &WorkerContext, req: ArtifactsExtractArtifactsRequest)
        -> WorkerResult<AnalysisBatch>;
    async fn join_artifacts(&self, ctx: &WorkerContext, req: ArtifactsJoinArtifactsRequest)
        -> WorkerResult<AnalysisBatch>;
    async fn validate_artifacts(&self, ctx: &WorkerContext, req: ArtifactsValidateArtifactsRequest)
        -> WorkerResult<Vec<Diagnostic>>;
}
```

#### C07 `IndexingModule`

```rust
struct IndexingEnqueueRequest {
    source: SourceEnvelope,
}
struct IndexingRunIndexRequest {
    job_id: Id,
}
struct IndexingComputeImpactRequest {
    revision: RevisionRef,
    changed_ids: Vec<Id>,
}
struct IndexingGetJobRequest {
    job_id: Id,
}
struct IndexingCancelJobRequest {
    job_id: Id,
}

trait IndexingModule: Send + Sync {
    async fn enqueue(&self, ctx: &WorkerContext, req: IndexingEnqueueRequest)
        -> WorkerResult<Job<AnalysisBatch>>;
    async fn run_index(&self, ctx: &WorkerContext, req: IndexingRunIndexRequest)
        -> WorkerResult<Job<AnalysisBatch>>;
    async fn compute_impact(&self, ctx: &WorkerContext, req: IndexingComputeImpactRequest)
        -> WorkerResult<DependencyImpact>;
    async fn get_job(&self, ctx: &WorkerContext, req: IndexingGetJobRequest)
        -> WorkerResult<Job<AnalysisBatch>>;
    async fn cancel_job(&self, ctx: &WorkerContext, req: IndexingCancelJobRequest)
        -> WorkerResult<CommitReceipt>;
}
```

#### C08 `RegistryModule`

```rust
struct RegistryRegisterBatchRequest {
    batch: AnalysisBatch,
}
struct RegistryGetEntityRequest {
    ref: EntityRef,
}
struct RegistryResolveAliasesRequest {
    refs: Vec<EntityRef>,
}

trait RegistryModule: Send + Sync {
    async fn register_batch(&self, ctx: &WorkerContext, req: RegistryRegisterBatchRequest)
        -> WorkerResult<AnalysisBatch>;
    async fn get_entity(&self, ctx: &WorkerContext, req: RegistryGetEntityRequest)
        -> WorkerResult<Entity>;
    async fn resolve_aliases(&self, ctx: &WorkerContext, req: RegistryResolveAliasesRequest)
        -> WorkerResult<Vec<Entity>>;
}
```

#### C09 `GraphModule`

```rust
struct GraphQueryRequest {
    revision: RevisionRef,
    roots: Vec<EntityRef>,
    edge_kinds: Vec<String>,
    max_nodes: u64,
    max_depth: u64,
}
struct GraphCommitFactsRequest {
    batch: AnalysisBatch,
    expected_revision: RevisionRef,
}
struct GraphDependentsRequest {
    revision: RevisionRef,
    changed_ids: Vec<Id>,
}
struct GraphProjectRequest {
    projection: GraphProjection,
    level: u64,
    operation: ProjectionOperation,
}
struct GraphQueryAcrossRepositoriesRequest {
    snapshot: MultiRevisionRef,
    roots: Vec<EntityRef>,
    max_nodes: u64,
    max_depth: u64,
}
struct GraphFindPathRequest {
    revision: RevisionRef,
    from: EntityRef,
    to: EntityRef,
    max_depth: u64,
}

trait GraphModule: Send + Sync {
    async fn query(&self, ctx: &WorkerContext, req: GraphQueryRequest)
        -> WorkerResult<GraphProjection>;
    async fn commit_facts(&self, ctx: &WorkerContext, req: GraphCommitFactsRequest)
        -> WorkerResult<CommitReceipt>;
    async fn dependents(&self, ctx: &WorkerContext, req: GraphDependentsRequest)
        -> WorkerResult<Vec<Id>>;
    async fn project(&self, ctx: &WorkerContext, req: GraphProjectRequest)
        -> WorkerResult<GraphProjection>;
    async fn query_across_repositories(&self, ctx: &WorkerContext, req: GraphQueryAcrossRepositoriesRequest)
        -> WorkerResult<MultiGraphProjection>;
    async fn find_path(&self, ctx: &WorkerContext, req: GraphFindPathRequest)
        -> WorkerResult<GraphProjection>;
}
```

C04 `readRevisionPair` returns deterministic Git changes and available authorized cached metadata; the TypeScript facade calls C23 for semantic comparison. C05 `compareWithCleanIndex` produces the comparison report locally, then the facade records evaluation through C17. C07 `computeImpact` combines Rust graph dependencies with C18-derived dependency IDs supplied by the trusted core. C08 alias resolution returns evidence-backed candidate entities; it does not silently merge identities.

### 10.4 Core-to-worker RPC calls and requirement bindings

RPC method names retain camelCase to match the existing logical API. Rust method names use snake_case. Each row maps to the **same** Section 4 operation and the same full Section 8/9 traceability rows, including use cases and candidate source clauses. A listed requirement remains Planned / Not verified.

| Logical API | RPC method | Request DTO | Result value | Explicit requirement binding |
|---|---|---|---|---|
| `C04.ingestRepository` | `c04.ingestRepository` | `RepositoryIngestRepositoryRequest` | `Job<AnalysisBatch>` | S6/FR-101, S5/FR-1, S5/CE-1 |
| `C04.readRevisionPair` | `c04.readRevisionPair` | `RepositoryReadRevisionPairRequest` | `ChangeSet` | Workflow / supporting obligation; see traceability register |
| `C04.connectorHealth` | `c04.connectorHealth` | `RepositoryConnectorHealthRequest` | `HealthReport` | Workflow / supporting obligation; see traceability register |
| `C05.analyzeSyntax` | `c05.analyzeSyntax` | `LanguageAnalyzeSyntaxRequest` | `AnalysisBatch` | Workflow / supporting obligation; see traceability register |
| `C05.resolveSemantics` | `c05.resolveSemantics` | `LanguageResolveSemanticsRequest` | `AnalysisBatch` | Workflow / supporting obligation; see traceability register |
| `C05.compareWithCleanIndex` | `c05.compareWithCleanIndex` | `LanguageCompareWithCleanIndexRequest` | `EvalReport` | Workflow / supporting obligation; see traceability register |
| `C05.languageCapabilities` | `c05.languageCapabilities` | `LanguageLanguageCapabilitiesRequest` | `List<String>` | S6/NFR-09 |
| `C06.extractArtifacts` | `c06.extractArtifacts` | `ArtifactsExtractArtifactsRequest` | `AnalysisBatch` | Workflow / supporting obligation; see traceability register |
| `C06.joinArtifacts` | `c06.joinArtifacts` | `ArtifactsJoinArtifactsRequest` | `AnalysisBatch` | Workflow / supporting obligation; see traceability register |
| `C06.validateArtifacts` | `c06.validateArtifacts` | `ArtifactsValidateArtifactsRequest` | `List<Diagnostic>` | Workflow / supporting obligation; see traceability register |
| `C07.enqueue` | `c07.enqueue` | `IndexingEnqueueRequest` | `Job<AnalysisBatch>` | Workflow / supporting obligation; see traceability register |
| `C07.runIndex` | `c07.runIndex` | `IndexingRunIndexRequest` | `Job<AnalysisBatch>` | S6/NFR-02, S5/CE-3 |
| `C07.computeImpact` | `c07.computeImpact` | `IndexingComputeImpactRequest` | `DependencyImpact` | Workflow / supporting obligation; see traceability register |
| `C07.getJob` | `c07.getJob` | `IndexingGetJobRequest` | `Job<AnalysisBatch>` | Workflow / supporting obligation; see traceability register |
| `C07.cancelJob` | `c07.cancelJob` | `IndexingCancelJobRequest` | `CommitReceipt` | Workflow / supporting obligation; see traceability register |
| `C08.registerBatch` | `c08.registerBatch` | `RegistryRegisterBatchRequest` | `AnalysisBatch` | S6/FR-201 |
| `C08.getEntity` | `c08.getEntity` | `RegistryGetEntityRequest` | `Entity` | Workflow / supporting obligation; see traceability register |
| `C08.resolveAliases` | `c08.resolveAliases` | `RegistryResolveAliasesRequest` | `List<Entity>` | Workflow / supporting obligation; see traceability register |
| `C09.query` | `c09.query` | `GraphQueryRequest` | `GraphProjection` | S6/NFR-03 |
| `C09.commitFacts` | `c09.commitFacts` | `GraphCommitFactsRequest` | `CommitReceipt` | Workflow / supporting obligation; see traceability register |
| `C09.dependents` | `c09.dependents` | `GraphDependentsRequest` | `List<Id>` | Workflow / supporting obligation; see traceability register |
| `C09.project` | `c09.project` | `GraphProjectRequest` | `GraphProjection` | S6/FR-205 |
| `C09.queryAcrossRepositories` | `c09.queryAcrossRepositories` | `GraphQueryAcrossRepositoriesRequest` | `MultiGraphProjection` | Workflow / supporting obligation; see traceability register |
| `C09.findPath` | `c09.findPath` | `GraphFindPathRequest` | `GraphProjection` | Workflow / supporting obligation; see traceability register |

The core-only functions are `C04.ingestExternal`, `C07.invalidateAndRevalidate`, and the two identity orchestration functions `C08.proposeMerge`/`C08.applyIdentityVerdict` (four operations in total). They retain their Section 4 TypeScript APIs. They may call Rust operations but are not RPC worker methods. In particular C07 cannot execute model verification within Rust.

### 10.5 Per-operation internal function inventory

These are high-level implementation responsibilities, not additional public RPC methods. The earlier inventories remain applicable, with cross-component calls mediated by the core where ownership is TypeScript.

| Rust operation | Internal high-level functions | Logical dependencies |
|---|---|---|
| `C04.ingestRepository` | `validate_source`, `resolve_authorized_content`, `normalize_revision` | C03.authorize,C03.scrubSource,C07.enqueue |
| `C04.readRevisionPair` | `read_git_diff`, `join_review_and_issue_records` | C03.authorize,C23.compare |
| `C04.connectorHealth` | `check_cursor_and_credentials`, `report_unavailable_plane` | C32.recordHealth |
| `C05.analyzeSyntax` | `select_parser`, `parse_changed_regions`, `extract_declarations_and_imports` | C03.authorize |
| `C05.resolveSemantics` | `invoke_language_adapter`, `resolve_references_and_types`, `mark_dynamic_unknowns` | Local module only |
| `C05.compareWithCleanIndex` | `rebuild_oracle_index`, `compare_fact_sets` | C17.evaluate |
| `C05.languageCapabilities` | `list_supported_resolution_kinds`, `report_unsupported_constructs` | Local module only |
| `C06.extractArtifacts` | `parse_build_and_ia_c`, `extract_routes_schemas_queues_flags`, `record_configuration_evidence` | Local module only |
| `C06.joinArtifacts` | `resolve_artifact_references`, `retain_ambiguous_bindings` | C08.resolveAliases |
| `C06.validateArtifacts` | `validate_schema_and_route_joins`, `detect_declared_runtime_mismatch` | C09.query |
| `C07.enqueue` | `hash_and_deduplicate`, `debounce_changes`, `schedule_bounded_worker` | C31.commit |
| `C07.runIndex` | `load_checkpoint`, `analyze_region`, `stage_facts`, `commit_snapshot` | C05.analyzeSyntax,C05.resolveSemantics,C06.extractArtifacts,C08.registerBatch,C09.commitFacts,C31.commit |
| `C07.computeImpact` | `walk_reverse_dependencies`, `include_derived_claims_views_and_caches` | C09.dependents,C18.findDependents |
| `C07.getJob` | `load_job_progress` | C31.getJob |
| `C07.cancelJob` | `persist_cancellation`, `stop_at_safe_checkpoint` | C31.cancelJob |
| `C08.registerBatch` | `allocate_stable_ids`, `attach_revision_lineage`, `validate_tenant_keys` | C31.commit |
| `C08.getEntity` | `read_revisioned_entity`, `validate_visibility` | C03.authorize,C31.loadRecord |
| `C08.resolveAliases` | `compare_name_and_structural_evidence`, `retain_unresolved_candidates` | C31.loadRecord |
| `C09.query` | `authorize_roots`, `traverse_bounded_graph`, `mark_truncation_and_unknowns` | C03.authorize,C31.queryFacts |
| `C09.commitFacts` | `validate_batch_revision`, `stage_and_atomically_publish_graph` | C31.commit |
| `C09.dependents` | `walk_reverse_adjacency`, `include_cross_repo_links` | C31.queryFacts |
| `C09.project` | `project_abstract_expand_trace_compare`, `retain_membership_lineage` | Local module only |
| `C09.queryAcrossRepositories` | `authorize_every_repository`, `query_per_revision`, `resolve_evidence_backed_cross_links` | C03.authorize,C31.queryFacts |
| `C09.findPath` | `search_authorized_paths`, `mark_blocked_or_unknown_segments` | C03.authorize,C31.queryFacts |

### 10.6 Request, response, event and control protocol

```typescript
RpcRequest<T> {
  protocolVersion: 1; schemaId: Id; kind: "request";
  requestId: Id; method: RpcMethod; payload: T;
  traceId: Id; deadline: Timestamp; scopeCapability: Id;
  expectedRevision: Option<RevisionRef>;
  idempotencyKey: Option<Id>; generation: Int;
}
RpcResponse<T> {
  protocolVersion: 1; schemaId: Id; kind: "response";
  requestId: Id; result: ApiResult<T>;
}
RpcEvent<T> {
  protocolVersion: 1; schemaId: Id; kind: "event";
  subscriptionId: Id; sequence: Int; jobId: Option<Id>;
  generation: Int; revision: Option<RevisionRef>; payload: T;
}
CancelRequest { targetRequestId: Id; jobId: Option<Id> }
CancelAck { accepted: Bool; terminal: Bool; committedReceipt: Option<CommitReceipt> }
SubscribeRequest { jobId: Id; afterSequence: Int }
SubscribeAck { subscriptionId: Id; replayFrom: Int; currentSequence: Int }
UnsubscribeRequest { subscriptionId: Id }
UnsubscribeAck { removed: Bool }
HandshakeRequest { supportedProtocolVersions: List<Int>; schemaDigest: Hash }
HandshakeReply { selectedProtocolVersion: Int; schemaDigest: Hash; workerVersion: String; maxFrameBytes: Int; capabilities: List<String> }
PingRequest { nonce: Id }
PingReply { nonce: Id; health: HealthReport }
JobProgress { jobId: Id; stage: String; completedUnits: Int; totalUnits: Option<Int> }
SnapshotCommitted { receipt: CommitReceipt; revision: RevisionRef; generation: Int; changedEntityIds: List<Id>; impact: DependencyImpact }
ReplayRequired { jobId: Id; earliestSequence: Int; currentSequence: Int }
```

| Control RPC | Input | Output | Behavior |
|---|---|---|---|
| `worker.handshake` | HandshakeRequest | HandshakeReply | Before any domain call; reject incompatible protocol/schema digest. |
| `worker.ping` | PingRequest | PingReply | Liveness without source content. |
| `worker.cancel` | CancelRequest | CancelAck | Fence active request; for durable jobs call the same persisted cancellation path as C07.cancelJob. |
| `worker.subscribeJob` | SubscribeRequest | SubscribeAck | Authorized replay and bounded live progress. |
| `worker.unsubscribe` | UnsubscribeRequest | UnsubscribeAck | Release subscription; does not cancel job. |

Exactly one terminal response per request on a live connection. After connection loss, read calls may be retried against the same revision; mutations reuse their original idempotency key and canonical payload hash. A timeout is not evidence of rollback. `worker.cancel` reports a committed receipt if the commit won the race. Event sequence is monotonic per durable job; slow consumers receive ReplayRequired rather than unlimited buffering. Progress can coalesce, committed events cannot silently disappear. Durable replay uses C31 and falls back to getJob plus a snapshot when retention has expired.

Scope capabilities are short-lived opaque grants issued by C03 to the parent. The worker verifies tenant, repository, policy epoch, operation and expiry at dispatch and again at commit. It does not trust an actorId supplied inside payloads. Parent revocation invalidates associated worker capabilities and cached authorized snapshots. Method-specific schemas reject unknown fields and unknown methods; diagnostics cannot disclose denied entities.

### 10.7 Worker-to-core dependencies

These are reverse RPC requests over the same channel, routed only to a privileged parent dispatcher. They use the same envelopes, schemas, deadline, cancellation and authorization rules. Direction-specific method allowlists prevent the browser from invoking them. Outbound request IDs have a different namespace from inbound IDs.

| Reverse RPC | Exact logical request/result contract | Reason |
|---|---|---|
| `core.c03.authorize` | C03.authorize, Section 4 | Refresh/check authority for a scoped resource. |
| `core.c03.scrubSource` | C03.scrubSource, Section 4 | Obtain source safe for indexing and persistence. |
| `core.c31.loadRecord` | C31.loadRecord, Section 4 | Resolve authorized source handles, checkpoints or registry records. |
| `core.c31.queryFacts` | C31.queryFacts, Section 4 | Read committed, scoped fact data. |
| `core.c31.commit` | C31.commit, Section 4 | Atomically persist staged registry/graph/job updates and outbox. |
| `core.c31.getJob` | C31.getJob, Section 4 | Reload durable job state after restart. |
| `core.c31.cancelJob` | C31.cancelJob, Section 4 | Persist cancellation and generation fence. |
| `core.c18.findDependents` | C18.findDependents, Section 4 | Combine fact impact with derived claims and concepts. |

The Rust process must not open a second SQLite writer. C31 owns the single local writer, or the team transaction boundary. Local read-only snapshot access may be optimized behind C31's interface later. Reverse RPCs must never wait while holding a write lock or invoke the same worker operation recursively. C11/C16/C17/C18 verdict updates, C23 semantic comparisons and C32 health recording are parent orchestration after a worker response or committed event, rather than recursive worker callbacks.

### 10.8 Indexing, publication and invalidation pseudocode

```rust
async fn run_index(ctx, req) -> WorkerResult<Job<AnalysisBatch>> {
    let job = load_checkpoint_or_job(req.job_id).await?;
    verify_scope_revision_generation_and_deadline(ctx, &job)?;
    let source = resolve_and_scrub_source_handle(ctx, &job).await?;
    let syntax = language.analyze_syntax(ctx, source_and_language(source)).await?;
    let resolved = language.resolve_semantics(ctx, batch_and_language(syntax)).await?;
    let artifacts = artifacts.extract_artifacts(ctx, source_request(&job)).await?;
    let candidate = merge_without_promoting_unknowns(resolved, artifacts)?;
    let registered = registry.register_batch(ctx, batch_request(candidate)).await?;
    let impact = compute_graph_and_derived_impact(ctx, &registered).await?;
    recheck_authority_and_generation(ctx, &job).await?;
    // Registry preparation above is staged, not independently visible.
    let receipt = commit_one_transaction(
        staged_registry_and_graph(registered),
        job_checkpoint(),
        generation_compare_and_swap(),
        stale_dependency_markers(impact),
        outbox_snapshot_and_invalidation_events()
    ).await?;
    return completed_job_bound_to_receipt(receipt);
}
```

This refines Section 4's schematic call order: ID preparation must not expose a registry revision before its graph commit. `registerBatch` can durably prepare an idempotent candidate, but only C09.commitFacts through C31 publishes that candidate together with its revision/checkpoint. A standalone registration cannot make a snapshot current. C07.runIndex owns the publication generation; direct C09.commitFacts is privileged and follows the same transaction invariants.

The commit transaction installs dependency staleness markers or a committed invalidation watermark that readers enforce before serving derived data. The outbox drives C18/C11/C13/C19 refreshes asynchronously. Consumers lagging that watermark serve explicit stale state or refuse a fresh claim, avoiding a period in which a newly committed graph appears with falsely current derived claims. Derived refresh failure does not roll back facts; it leaves explicit stale status and retryable work.

Incremental parsing maintains revision-bound parse snapshots internally. Edits are byte-range validated against the old content hash; an invalid base forces a clean parse. Parse snapshots never mix different repository revisions. Rename ambiguity is retained as candidates; parsed references are not promoted to compiler-resolved facts. Missing/dynamic constructs return diagnostics and unknown regions.

### 10.9 Lifecycle, limits and acceptance checks

- Parent launches the worker, completes handshake, loads durable jobs and checkpoints, and resumes only current generations. On crash it restarts with bounded backoff; old responses and unpublished stages cannot become current.
- Admission limits include frame bytes, queued jobs, concurrent CPU tasks, parse cache bytes, graph node/depth limits and per-call time. Actual concurrency/cache defaults are deployment configuration; a missing limit is invalid configuration. Requested graph limits cannot exceed the server ceiling.
- Cancellation is checked between bounded work units, before dependencies and inside commit compare-and-swap. Non-interruptible parser work may finish privately; its invalid generation cannot publish.
- Rust adapters read only authorized immutable source handles or sandboxed repository roots. Compiler/LSP subprocess commands come from an administrator allowlist; repository config cannot inject arbitrary process commands.
- Conformance checks cover shared DTO round trips, unsupported protocol/schema/method rejection, tenant isolation, frame limits, cancellation-versus-commit race, crash recovery, duplicate mutations, revision mismatch, incremental-versus-clean equivalence, atomic registry/graph publication and stale dependency enforcement.
- Performance and language acceptance criteria retain their original requirement IDs and benchmark thresholds. These contracts do not resolve the previously recorded MVP scope conflicts or establish supported-language parity automatically.

All Rust calls inherit the complete component-level traceability already present in this document. Candidate source mappings remain candidates; RPC availability does not establish requirement satisfaction.
