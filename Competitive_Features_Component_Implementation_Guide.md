# Competitive features: component implementation guide

Version 1.0 · 4 October 2026 · Proposed implementation instructions

## 1. Scope and evidence boundary

This guide covers eight competitive capabilities, the confirmed semantic-zoom defects, and a bounded digital-twin capability. It specifies changes, public contracts, interactions and feature acceptance checks. It is a feature-level implementation supplement, not a replacement for the master requirements or the existing component designs. Feature IDs below are new implementation tracking IDs; they are not original PRD requirement IDs. Original requirement-level completeness must be reconciled against the current master specification before release.

Implementation status comes from the maintainer reports in this conversation, not a repository audit performed for this document. Reported facts: C19 has a representation compiler, structural validation and 16 form renderers, but no presentation manifest, wording registry or chart surfaces. C27 has scenario operations and caller-supplied capacity data, but no isolated paired experiment runner or model-validation certificates. C28 has typed intents, exact edits, restricted compile/test execution, approvals and patch export; a separate defect pipeline records run/oracle/workload/environment identities. The canvas has browser-confirmed readability and clipping defects. Other capabilities are unconfirmed, not automatically absent.

All API signatures are proposed typed pseudocode. Extend or adapt existing contracts rather than creating a second implementation of an existing responsibility. Component IDs retain the architecture established in this conversation. Numerical targets in this guide are proposed acceptance targets, not measured capabilities.

## 2. Feature register and delivery order

| ID | Feature | First deliverable | Priority |
|---|---|---|---|
| F01 | Cross-repository search and precise navigation | Revision-bound search and references for the supported languages | P1 |
| F02 | PR analysis and quality gates | Changed-code findings and a forge check bound to the exact head revision | P1 |
| F03 | Deterministic data-flow and taint analysis | One language and a small versioned source/sink rule set | P1 integration, P2 deeper analysis |
| F04 | Dependency vulnerabilities and licences | Lockfile inventory plus scanner-backed findings | P1 integration |
| F05 | Trace-linked profiling | Import a real profile, correlate to a trace and display hotspots | P2 |
| F06 | Historical hotspots and change coupling | Git-history evidence with explainable ranking | P2 |
| F07 | Task-to-branch-to-PR workflow | One repository, exact validated patch and draft PR | P1 |
| F08 | Coordinated multi-repository changes | Parent campaign with independently reviewable child proposals | P3 |
| F09 | Readable semantic zoom | Fix initial fit, transitions, anchoring and off-screen disclosure | P0 |
| F10 | Workflow digital twin | One workflow, synchronized inputs and paired native experiments | P3 |

Build common identity and job contracts first, but keep that foundation small. Deliver F09 independently where possible. Build F02/F07 around one real defect and one PR. Integrate F03/F04 providers rather than waiting to implement entire analysis engines. Defer F08/F10 breadth until the single-repository evidence and execution path works.

## 3. Shared contracts and ownership

```typescript
type Context = {
  actorId: Id; tenantId: Id; authorizationScopeHash: Hash;
  purpose: 'SEARCH' | 'REVIEW' | 'INVESTIGATE' | 'EXECUTE' | 'EXPORT';
  correlationId: Id; deadline: Timestamp; cancellationId: Id;
};
type SnapshotRef = {
  repositoryId: Id; commitHash: Hash; contentRootHash: Hash;
  indexGeneration: number; analyzerVersion: string;
};
type EvidenceRef = {
  id: Id; snapshot: SnapshotRef; producer: string; producerVersion: string;
  artifactHash: Hash; coverage: Coverage; createdAt: Timestamp;
};
type Outcome<T> = {
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'STALE';
  value?: T; evidenceIds: Id[]; gaps: Diagnostic[];
};
type PatchBinding = {
  repositoryId: Id; baseCommitHash: Hash; baseContentHash: Hash;
  candidateContentHash: Hash; diffHash: Hash;
  originalOracleHash: Hash; candidateOracleHash: Hash;
  workloadHash?: Hash; environmentHash?: Hash; runManifestIds: Id[];
  propertyChangeReviewId?: Id;
};
type RunManifest = {
  id: Id; snapshot: SnapshotRef; candidateContentHash?: Hash;
  executableHash: Hash; toolchainHash: Hash; harnessHash: Hash;
  fixtureHash: Hash; workloadHash: Hash; environmentHash: Hash;
  oracleHash: Hash; seed?: string; scheduleArtifactHash?: Hash;
  outcomesArtifactHash: Hash; exitStatus: string;
};
```

C08 owns entity and snapshot identity; C06 owns artifact ingest and content identity; C31 stores immutable records and indexes; C07 owns deduplicated jobs, cancellation and priority. C18 owns claim/evidence relationships; C16 owns verification decisions. An external scanner finding is a tool finding, not automatically a proof. A measured value needs a traceable run; a caller-provided MEASURED enum is insufficient.

C03 enforces authorization before retrieval and again before rendering/export/execution. Cache keys include revision, analysis policy, relevant tool versions and authorization scope. C31 commits projection generation, job receipt and event outbox consistently. C07 rejects late results from superseded generations. Deletion/revocation invalidates derived authority immediately; expensive recomputation may follow asynchronously.

Errors must distinguish unsupported language, incomplete extraction, missing telemetry, authentication failure, timeout, stale snapshot and actual negative findings. No-results must never silently mean no-defects. Interactive work and invalidation take precedence over history scans and experiments. Rust subprocess/RPC responses carry request ID, snapshot, schema version and typed diagnostics; Node owns adapter orchestration and publication, not duplicate graph semantics.

## 4. F01 — Cross-repository search and precise navigation

### Component instructions

| Component | Required changes and high-level functions |
|---|---|
| C04 connectors | Enumerate authorized repositories and revisions; ingest incremental updates; resolve submodules and generated-source exclusions. Functions: listRepositories, fetchRevision, readFile, watchChanges. |
| C05 language services, Rust | Use compiler/LSP/SCIP-backed symbol information where available. Keep heuristic matches separate. Implement extractSymbols, resolveDefinition, extractReferences, resolveImports, reportCoverage. |
| C06 artifacts | Store file content and semantic index inputs by hash; reuse unchanged artifacts; maintain source locations. Functions: ingestSource, lookupContent, registerIndexArtifact. |
| C07 scheduler | Schedule repository/language partitions; coalesce edit bursts; expose index readiness; cancel superseded generations. Functions: enqueueIndex, deduplicateJob, cancelGeneration. |
| C08 registry | Give symbols stable identity with explicit revision bindings; track renames without treating every textual match as the same entity. Functions: bindSymbol, resolveRevisionIdentity. |
| C09 graph | Store resolved definitions, references and cross-repository dependencies with provenance. Functions: upsertResolvedEdge, queryReferences, queryCallers. |
| C10 retrieval | Combine exact/regex text search with symbol filters and optional semantic retrieval; return match kind, ranking rationale, coverage and bounded cursors. Functions: searchText, searchSymbols, mergeResults, paginate. |
| C01/C21 | Add search UI, keyboard navigation, open-source actions and reference drill-down; preserve selected repository/revision. Functions: openSearch, resolveSelection, openLocation. |
| C03/C16/C18/C31/C32 | Filter authorized results before ranking/counting; record evidence for generated explanations; store indexes; measure latency and indexing lag. |

### Public contract

```typescript
C10.search(ctx, {query, repositoryIds, revisionSelector, filters, cursor, limit})
  -> Outcome<{hits: SearchHit[], nextCursor?, coverageByRepository}>
C05.resolveDefinition(ctx, {snapshot, fileId, position})
  -> Outcome<{locations: SourceLocation[], resolution: 'PRECISE'|'HEURISTIC'}>
C09.findReferences(ctx, {snapshot, symbolId, scope, cursor})
  -> Outcome<{references: Reference[], nextCursor?}>
```

Flow: C04 → C06 → C07 → C05 → C08/C09 → C10 → C01. C15 may explain results after retrieval, but must not invent additional references.

### Acceptance

F01-A1: definitions and references match an independent compiler fixture for supported constructs. F01-A2: identical symbol names in different scopes do not merge. F01-A3: unauthorized repositories do not affect result bodies or counts. F01-A4: a rapid edit produces one current generation and no stale published result. F01-A5: cross-repository results disclose unresolved dependencies. F01-A6: benchmark cold/warm search on recorded small/medium/large corpora; establish budgets from measured data before promising latency.

## 5. F02 — PR analysis and quality gates

| Component | Required changes and high-level functions |
|---|---|
| C04/C23 | Ingest PR base/head, compute semantic and textual diffs, resolve changed symbols and affected dependencies. Functions: fetchPullRequest, compareSnapshots, classifyChanges, computeImpactScope. |
| C25/C26 | Run configured security, correctness and performance rules on affected code; label analysis coverage. Functions: analyzeChangedCode, evaluateInvariants, detectRegressionRisk. |
| C16 | Evaluate a versioned gate policy against exact evidence, mandatory checks and missing-data semantics. Functions: evaluateQualityGate, verifyPatchBinding, invalidateDecision. |
| C18 | Store findings with rule/version/location/status and deduplicate across analysis runs without discarding history. Functions: registerFinding, correlateFinding, recordDisposition. |
| C28 | Attach exact candidate validation and original-oracle results; distinguish waived issues from resolved issues. Functions: validateCandidate, compareOracles, attachRuns. |
| C19/C20 | Show base/head differences, gate conditions, evidence links and uncertainty without fact-styled hypotheses. Functions: compileReviewView, renderGateSummary. |
| C30 | Publish idempotent forge checks/comments bound to the exact head; revoke or replace stale results after a push. Functions: publishCheck, updateCheck, linkEvidence. |
| C03/C07/C31/C32 | Authorize forge writes, prioritize current heads, persist gate history and audit publication failures. |

```typescript
C23.analyzePullRequest(ctx, {repositoryId, pullRequestId, baseHash, headHash})
  -> Job<Outcome<ChangeImpact>>
C16.evaluateQualityGate(ctx, {baseSnapshot, headSnapshot, policyHash,
  findingIds, runManifestIds, coverage})
  -> {decisionId, status:'PASS'|'FAIL'|'INCOMPLETE', reasons, bindingHash}
C30.publishCheck(ctx, {decisionId, repositoryId, pullRequestId, headHash,
  idempotencyKey}) -> PublicationReceipt
```

Gate policy must define blocking severity, new-versus-existing issues, required tests, coverage requirements, exceptions and expiry. Compilation success alone is not a safety verdict. Baseline comparison uses the same rule version or declares that the baseline was reanalyzed.

F02-A1: push a new head between analysis and publication; old PASS cannot become the current check. F02-A2: timeout of a mandatory analyzer yields INCOMPLETE, not PASS. F02-A3: existing findings are separated from newly introduced findings. F02-A4: repeated webhook delivery creates no duplicate check. F02-A5: every displayed condition links to its policy and evidence. F02-A6: an approved exception remains visible with actor, rationale, scope and expiry.

## 6. F03 — Deterministic data-flow and taint analysis

| Component | Required changes and high-level functions |
|---|---|
| C04/C06 | Capture scanner inputs, build configuration and generated sources; retain scanner artifacts and logs with version identities. |
| C05 | Provide typed control-flow/data-flow extraction or integrate an existing analyzer adapter. Functions: buildControlFlow, resolveCalls, extractDataFlow, identifyUnsupportedConstructs. |
| C09 | Represent source→propagation→sink paths, sanitizers and unresolved call boundaries. Functions: ingestFlowPath, queryFlowEvidence. Avoid eagerly storing every possible path. |
| C25 | Own versioned sources/sinks/sanitizers, rule configuration and invariants. Functions: loadRulePack, runTaintAnalysis, evaluatePath, normalizeScannerFinding. |
| C16/C18 | Verify evidence binding and presentation class; preserve scanner limitations. Functions: verifyAnalysisBinding, recordToolFinding. |
| C19/C20/C21 | Render bounded path explanations with file locations and branch conditions; allow drill-down without claiming that all paths execute. |
| C07/C17/C31/C32 | Run bounded analysis, independent positive/negative fixture evaluation, mutation checks, artifact retention and cost reporting. |

```typescript
C25.analyzeDataFlow(ctx, {snapshot, language, rulePackHash, entryPoints, budget})
  -> Job<Outcome<{findingIds, analysisCoverage, analyzerArtifactHash}>>
C09.getFindingPath(ctx, {findingId, cursor, limit}) -> Outcome<FlowPathPage>
```

Start with a supported language and a small vulnerability class such as untrusted input reaching a dangerous sink. Document field/context sensitivity, dynamic dispatch and reflection limits. Preserve path conditions and sanitizer assumptions; do not call a static potential path a runtime-observed exploit.

F03-A1: known source-to-sink fixture is found. F03-A2: validated sanitizer fixture is not reported incorrectly. F03-A3: an unresolved call is a gap, not a sanitization boundary. F03-A4: removing a sanitizer changes the expected result. F03-A5: findings survive display with identical rule/path identity. F03-A6: resource exhaustion produces PARTIAL with coverage.

## 7. F04 — Dependency vulnerability and licence scanning

| Component | Required changes and high-level functions |
|---|---|
| C04/C06 | Parse manifests and lockfiles, including workspace boundaries; retain package identities, exact versions and inventory hashes. Functions: discoverManifests, ingestLockfiles. |
| C05/C09 | Build direct/transitive dependency relationships through ecosystem adapters. Functions: resolveDependencyInventory, ingestDependencyPaths. |
| C25 | Integrate vulnerability and licence providers; version policy and database timestamps; evaluate severity, licence restrictions and exceptions. Functions: scanInventory, evaluateLicencePolicy, identifyFixVersions. |
| C16/C18 | Preserve scanner confidence, applicability and stale-feed status; bind finding to inventory. A vulnerable dependency is not automatically a reachable exploit. |
| C19/C20 | Display affected package, introduction path, advisory, remediation and licence rationale. Keep severity distinct from reachability. |
| C28/C27 | Produce exact manifest/lockfile changes and run build/test checks in isolation; report incompatible upgrades. |
| C07/C30/C31/C32/C03 | Rescan when feeds change without requiring source edits; publish PR checks; store inventory snapshots; apply egress policy to private package metadata. |

```typescript
C25.scanDependencies(ctx, {snapshot, inventoryHash, providerConfigId,
  vulnerabilityFeedVersion, licencePolicyHash}) -> Job<Outcome<DependencyReport>>
C28.proposeDependencyUpgrade(ctx, {findingId, targetVersion, snapshot})
  -> Outcome<ChangeProposal>
```

F04-A1: transitive vulnerability includes its introduction path. F04-A2: lockfile and manifest mismatch is disclosed. F04-A3: unknown licence is not silently accepted. F04-A4: feed update can change a finding without a code commit and preserves both assessments. F04-A5: upgrade re-locks and validates the exact resulting patch. F04-A6: no private package metadata leaves the machine when egress policy forbids it.

## 8. F05 — Trace-linked continuous profiling

| Component | Required changes and high-level functions |
|---|---|
| C04/C06 | Add trace/profile import adapters; retain build ID, symbol maps, sampling metadata and time ranges. Functions: ingestProfile, ingestTraceBatch, resolveBuildArtifact. |
| C24 | Correlate profile samples with services, threads/tasks, trace spans and revision. Functions: attributeSamples, correlateTraceProfile, queryRuntimeWindow. Parentage/time overlap alone is not causal proof. |
| C26 | Calculate CPU/wall-time/allocation/wait hotspots only when supported by the input format; compare equivalent populations. Functions: aggregateSamples, rankHotspots, compareProfiles. |
| C19 | Add typed metric, flamegraph, waterfall and hotspot table specifications. Bind units, population, time window and basis to every metric item. Functions: compileProfileView, bindMetricPresentation. |
| C20/C21 | Implement bounded chart adapters, virtualized tables, time selection and source drill-down; keep chart navigation separate from semantic graph levels. |
| C16/C18 | Verify measured-versus-inferred wording, manifest identities and metric denominators. Functions: verifyMetricPresentation, registerRuntimeEvidence. |
| C07/C31/C32/C03 | Query bounded external telemetry windows; retain aggregates/artifact references; enforce privacy and quotas; report dropped samples. |

```typescript
C24.correlateProfile(ctx, {profileArtifactId, traceSourceId, buildId, timeWindow})
  -> Outcome<ProfileCorrelation>
C26.queryHotspots(ctx, {correlationId, metric, filters, population, limit})
  -> Outcome<{rows, units, sampleCount, coverage, uncertainty}>
```

Use existing telemetry stores for raw high-volume data; do not import unlimited samples into the local graph or render one node per sample. Missing sample data must not become zero usage. Profile overhead and sampling bias are reported, not assumed negligible.

F05-A1: slow trace opens the corresponding profile population and source revision. F05-A2: symbol/build mismatch blocks precise source attribution. F05-A3: CPU and wall time remain distinct. F05-A4: dropped samples are disclosed. F05-A5: simulated metrics cannot appear as measured. F05-A6: an error-heavy candidate cannot look faster by dropping failed requests from the comparison.

## 9. F06 — Historical hotspots and change coupling

| Component | Required changes and high-level functions |
|---|---|
| C04/C23 | Ingest bounded Git history, rename mappings and merge policy; derive per-file/function change events. Functions: readHistory, normalizeCommitEvents, trackRenames. |
| C05/C08 | Resolve historical changes to symbol identities; disclose unavailable historical semantic resolution. |
| C26 | Calculate change frequency, code-health signals and co-change statistics. Functions: scoreHotspots, calculateCoupling, rankMaintenanceRisk. Store numerator, denominator, sample size and formula version. |
| C09 | Keep change-coupling edges separate from static dependencies and runtime causal edges. Functions: storeCoChangeRelation. |
| C11/C12 | Optionally use approved team/domain mappings to contextualize results; avoid interpreting authorship as individual productivity. |
| C19/C20/C21 | Display heatmap/table, explain ranking, filter history window and drill into supporting commits. |
| C16/C18/C17 | Check wording, evidence and ranking robustness; evaluate on histories with known rename/merge/churn cases. |
| C07/C31/C32/C03 | Cache by history boundary and policy; process incrementally; restrict contributor metadata. |

```typescript
C26.analyzeHistory(ctx, {repositoryIds, since, until, mergePolicyHash,
  generatedCodePolicyHash, scoringPolicyHash}) -> Job<Outcome<HotspotReport>>
C23.explainCoupling(ctx, {relationId, cursor}) -> Outcome<CommitEvidencePage>
```

Exclude or separately classify generated code, bulk formatting and automated dependency commits. A co-change edge is a statistical relationship, not proof of architectural coupling. A hotspot score is a prioritization heuristic, not a defect probability unless independently calibrated.

F06-A1: rename does not reset history silently. F06-A2: bulk formatting cannot dominate rankings without disclosure. F06-A3: small-sample coupling shows support count. F06-A4: score is reproducible under the same policy. F06-A5: each ranking exposes contributing factors and commits. F06-A6: ownership metadata respects authorization.

## 10. F07 — Task-to-branch-to-PR execution

| Component | Required changes and high-level functions |
|---|---|
| C01/C02/C21 | Capture task, acceptance criteria, constraints and authorized operations; journal execution and allow cancellation. Functions: submitTask, confirmIntent, showProgress. |
| C10/C12/C15 | Retrieve relevant source and evidence; produce an implementation plan with explicit unknowns. Functions: retrieveTaskContext, draftPlan, proposeEdits. |
| C22 | Turn unknowns into bounded investigation obligations, not an unending reasoning loop. Functions: planInvestigation, resolveObligation. |
| C28 | Own exact edits, isolated checkout, patch binding, approvals, original/candidate oracle comparison and export. Functions: materializeCandidate, applyExactEdits, detectOracleWeakening, validatePatch. |
| C27 | Execute validation using the existing defect runner only after isolation semantics are audited; attach immutable run manifests. Functions: runCandidateValidation, collectOutcomes. |
| C16/C18 | Verify exact patch and evidence; block stale or mismatched certificates. Do not allow generated tests to silently replace the original failing oracle. |
| C04/C30 | Create branch and draft PR, publish exact diff, update status and return forge receipt. Functions: createBranch, pushCandidate, createDraftPullRequest. |
| C03/C07/C31/C32 | Enforce execution/forge scopes; isolate secrets and network access; persist resumable state and audit events. |

```typescript
C28.prepareChange(ctx, {taskId, snapshot, planId, editOperations})
  -> Outcome<{proposalId, patchBinding}>
C27.validatePatch(ctx, {proposalId, patchBinding, validationPlanHash, budget})
  -> Job<Outcome<{runManifestIds, outcomeSummary}>>
C30.publishDraftPR(ctx, {proposalId, certificateId, repositoryId,
  branchName, expectedBaseHash, idempotencyKey}) -> PublicationReceipt
```

State machine: RECEIVED → PLANNED → CANDIDATE_READY → VALIDATING → REVIEW_READY → PUBLISHED. Terminal alternatives: BLOCKED, CANCELLED, FAILED, STALE. Publication requires exact bound artifacts and the authorization applicable to the task. Publishing a draft does not authorize merge or deployment.

F07-A1: known defect reproduces before editing and original oracle passes after. F07-A2: weakening/removing original assertions blocks verified-fix status absent explicit property-change review. F07-A3: changing candidate content after validation invalidates publication eligibility. F07-A4: process crash resumes without duplicate branches/PRs. F07-A5: cancellation terminates execution and rejects late writes. F07-A6: missing mandatory validation produces BLOCKED/INCOMPLETE, not verified success.

## 11. F08 — Coordinated multi-repository changes

| Component | Required changes and high-level functions |
|---|---|
| C04/C10 | Select an authorized repository population using explicit selectors or search; freeze population before execution. Functions: resolveCampaignPopulation. |
| C08/C09/C23 | Capture each base revision and cross-repository compatibility relationships. Functions: bindCampaignSnapshots, buildCompatibilityPlan. |
| C22/C28 | Create a parent campaign and independent child proposals; support canary batches and dependency order. Functions: planCampaign, createChildProposal, advanceBatch. |
| C27/C16 | Validate each child and required joint compatibility cases. Never reuse a certificate across different diffs merely because the requested transformation is the same. |
| C29 | Assign reviewers/owners, track exceptions and discussions; changes in one child do not silently approve others. |
| C30 | Publish child draft PRs with parent links; track forge state and reconcile partial publication. |
| C07/C31/C32/C03 | Bound concurrency, persist receipts and retries, apply per-repository authorization and global cost budgets. |
| C19/C20/C01 | Show campaign population, completed/blocked/failed children and dependency order. |

```typescript
C28.createCampaign(ctx, {repositorySelector, transformationSpecHash,
  compatibilityPolicyHash, batchPolicy}) -> Outcome<Campaign>
C28.advanceCampaign(ctx, {campaignId, expectedVersion, batchId})
  -> Job<Outcome<CampaignProgress>>
```

There is no atomic transaction across independent forge PRs. Publish/merge order and compensating plans must be explicit. Reverting code is itself a new reviewed change; do not imply that external migrations or effects are automatically reversible.

F08-A1: mixed PASS/FAIL results remain distinct. F08-A2: adding a repository changes the population version and requires assessment. F08-A3: a changed child base is STALE independently. F08-A4: partial publication retries only unpublished children. F08-A5: incompatible producer/consumer versions fail the joint check. F08-A6: campaigns respect per-repository access and do not leak hidden population counts.

## 12. F09 — Readable semantic zoom and camera transitions

| Component | Required changes and high-level functions |
|---|---|
| C19 | Define a per-form DetailPolicy, meaningful aggregations, essential-label priorities and stable membership mappings. Functions: enumerateDetailCandidates, compileDetailLevel, resolveContainingGroup. |
| C20 | Replace relative-fit boundaries with screen-space readability checks. Evaluate candidate font sizes and camera before switching. Functions: measureLabels, chooseInitialLevel, evaluateCandidateCamera, applyTransition, computeVisibility. |
| C21 | Capture wheel intent, pointer screen position, selected entity and explicit level override; expose Auto detail. Functions: captureAnchor, resolveAnchor, handleZoomIntent. |
| C13 | Persist workspace preference and selection; do not replay obsolete camera positions against a changed layout without rebinding. |
| C16/C18 | Ensure aggregation and label suppression retain required caveats, warning classes and provenance. |
| C01/C17/C32 | Expose off-screen disclosure and reduced-motion behaviour; run actual-browser regression probes and record transition churn. |

```typescript
type DetailPolicy = {levels: DetailLevel[]; essentialLabelMinPx: number;
  expandCandidateMinPx: number; labelFallback: 'ABBREVIATE'|'SELECTED_ONLY'|'HIDE';
  aggregationSupported: boolean};
type SemanticAnchor = {entityIds: Id[]; screenPoint: Point;
  selectionId?: Id; previousGroupId?: Id};
C19.compileDetail(ctx, {viewId, level, snapshot})
  -> Outcome<{viewSpec, membershipMap, presentationManifest}>
C20.planTransition({currentCamera, viewport, anchor, candidate, policy})
  -> {camera, resolvedAnchor, visibleNodeCount, offscreenNodeCount,
      drawingCoverage, unmetConstraints}
```

Proposed initial values: target 11–12 CSS px; aggregate before essential labels fall below 10 px; 9 px hard protection boundary; expand only when the finer candidate can support 16 px essential labels. Make policy configurable for accessibility. Measure actual rendered font rules, not one assumed font size for every form. Exempt decorative/nonessential suppressed labels explicitly.

Keep continuous camera zoom. On aggregation map anchor entity IDs to the containing group; on expansion choose selected or previously focused descendant. Re-anchor before a bounded visibility adjustment. If 80% drawing coverage cannot coexist with readability and the anchor, disclose the conflict and off-screen count. Apply transition coverage tests to automatic transitions, not deliberate user panning. Initial fit chooses a readable representation instead of top-left cropping. Non-aggregating forms use meaningful label fallback, with accessible inspection. Essential caveats cannot disappear with labels.

Prevent feedback loops: fit/camera correction must not be interpreted as a fresh user wheel event; retain transition generation and hysteresis state. A stability timer cannot leave essential 4 px text visible while waiting. Prefer cached candidate layouts; reject late layout results. Reduced motion uses instant anchor-preserving transitions.

F09-A1: replay the reported 10-node, ownership and 92-file cases in a browser. F09-A2: inspect label sizes and camera after each wheel step. F09-A3: essential text is >=9 px or intentionally suppressed/replaced with accessible detail. F09-A4: automatic transitions achieve >=80% drawing coverage or disclose unmet constraints; separately assert visible-node counts. F09-A5: selected/pointer entity maps correctly through merges/splits. F09-A6: zoom correction does not oscillate levels. F09-A7: every form declares a detail policy. F09-A8: resize, manual levels and reduced motion retain usable context.

## 13. F10 — Bounded workflow digital twin

| Component | Required changes and high-level functions |
|---|---|
| C04–C09 | Bind workflow structure to exact source/build/configuration snapshots; identify external systems and unresolved behaviour. Functions: extractWorkflow, bindTwinSnapshot. |
| C24 | Supply observed execution paths, service durations, waits and workload populations with coverage. Functions: buildObservedBaseline, attributeResourceUse. |
| C26 | Propose bottleneck/concurrency hypotheses with explicit invariants and alternative explanations. Functions: identifyCandidateMechanisms. |
| C22 | Choose informative interventions, holdouts and stopping conditions. Functions: planInterventionValidation. |
| C27 | Own workload fixtures, paired native runs, bounded queue/resource models, holdout validation and domain certificates. Functions: runPairedExperiment, fitModel, validateInterventionClass, predictScenario. |
| C16/C18 | Verify run binding, calibration domain, uncertainty and allowed claim class. Native measured results and model predictions remain different classes. |
| C19/C20/C21 | Display baseline/candidate comparisons, assumptions, error rates and uncertainty; expose drill-down to runs. |
| C28 | Convert supported improvements into exact candidate proposals; preserve invariants/oracles. |
| C07/C31/C32/C03 | Cap resources, isolate execution, retain manifests, invalidate changed domains and enforce telemetry/egress policy. |

```typescript
C27.createTwin(ctx, {workflowId, snapshot, baselineEvidenceIds,
  workloadFixtureHash, environmentHash, modelSpecHash}) -> Outcome<Twin>
C27.runPairedExperiment(ctx, {twinId, interventionSpecHash, repetitions,
  seedPlanHash, validationPlanHash, budget}) -> Job<Outcome<PairedResult>>
C27.predictScenario(ctx, {twinId, intervention, workload, certificateId})
  -> Outcome<{predictions, uncertainty, assumptions, domainAssessment}>
```

Start with one workflow and one intervention class. Reuse the audited defect isolation runner for native experiments. Keep experiment execution, model fitting and model validation separate. Specify scheduling semantics for race exploration; a queue simulation cannot establish absence of data races. Paired performance runs use equivalent workload/environment and capture every outcome including failures/timeouts. Fit on training observations, evaluate on held-out workloads and held-out interventions; baseline fit alone does not validate predicted deltas. Domain changes revoke prediction authority until revalidated.

F10-A1: baseline reproduces the selected real workload within a declared tolerance. F10-A2: holdout interventions meet predeclared error/coverage criteria. F10-A3: out-of-domain request is blocked or explicitly exploratory. F10-A4: failures/timeouts stay in the population. F10-A5: changed model/workload/environment/oracle invalidates the certificate. F10-A6: unsupported predictions never receive VALIDATED_MODEL_PREDICTION. F10-A7: race findings include reproducible schedules where the runner supports them, with bounded exploration disclosed.

## 14. Component-level assignment index

This index lists direct delivery responsibilities. Shared authorization, storage and operations apply even when not repeated in every feature table. C11/C12/C14/C15/C29 participation is conditional; do not build unrelated capabilities simply to assign every component a task.

| Component | Feature assignments | Required component deliverable |
|---|---|---|
| C01 Shell/IDE | F01,F02,F05,F07,F08,F09,F10 | Source navigation, task/review surfaces, accessible detail and off-screen actions |
| C02 Journal/commands | F07,F08 | Durable user intent and resumable execution journal |
| C03 Authorization/egress | All | Purpose-bound checks across retrieval, execution and publication |
| C04 Connectors | F01–F08,F10 | Revision/forge/history/telemetry adapters with normalized receipts |
| C05 Language services | F01,F03,F04,F06,F10 | Precise symbols and bounded semantic extraction; ecosystem adapters |
| C06 Artifacts | F01,F03,F04,F05,F10 | Content-addressed source, scanner and runtime inputs |
| C07 Scheduler | All | Priority, quotas, deduplication, cancellation and generation fences |
| C08 Registry | F01,F06,F08,F10 | Stable entities and immutable revision bindings |
| C09 Graph | F01,F03,F04,F06,F08,F10 | Typed relations with distinct static/statistical/runtime meanings |
| C10 Retrieval | F01,F07,F08 | Authorized bounded search and task context |
| C11 Concepts/memory | F06,F07 optional | Approved domain context with provenance and deletion handling |
| C12 Context/salience | F07 optional | Relevant bounded context; no authorization expansion |
| C13 Workspaces | F09; other views | Revision-aware selection, camera and view preferences |
| C14 Model gateway | F07; explanations optional | Provider/budget/egress controls for model-assisted work |
| C15 Grounded reasoning | F01,F07; explanations optional | Evidence-linked plans/explanations, never replacement for deterministic checks |
| C16 Verification | All | Exact evidence/patch/presentation decisions, freshness and revocation |
| C17 Evaluation | F01,F03,F06,F09,F10 | Independent fixtures, mutation and actual-browser conformance |
| C18 Claim ledger | All analytical features | Evidence, finding disposition, class and decision lineage |
| C19 Representation compiler | All visual features | Typed representations, manifests, templates and detail policies |
| C20 Renderer | All visual features | Faithful display, chart adapters, readability and bounded layout |
| C21 Interactions | F01,F05,F07,F09,F10 | Stable referents, anchors and typed user intents |
| C22 Investigation | F07,F08,F10 | Bounded obligations and informative experiment plans |
| C23 History/semantic PR | F02,F06,F08 | Diff/history evidence and affected-scope analysis |
| C24 Runtime causality | F05,F10 | Trace/profile attribution with causality limitations |
| C25 Security/invariants | F02,F03,F04,F07,F10 | Scanner/rule integrations and explicit invariant checks |
| C26 Performance/concurrency | F02,F05,F06,F10 | Measured hotspots, historical priorities and mechanism hypotheses |
| C27 Experiments/simulation | F04,F07,F08,F10 | Isolated native validation, paired runs and calibrated model domains |
| C28 Change proposals | F02,F04,F07,F08,F10 | Exact edits, PatchBinding, oracle preservation and review state |
| C29 Collaboration | F08; F02/F07 optional | Reviewer assignments and scoped exception decisions |
| C30 Publication | F02,F04,F07,F08 | Idempotent forge checks, drafts and export receipts |
| C31 Storage | All | Immutable records, bounded indexes, atomic outbox and retention |
| C32 Operations | All | Latency/cost/lag instrumentation and failure diagnostics |

## 15. Presentation and verification prerequisite

Before declaring a verified finding or patch publication complete, implement the minimum C16/C19/C20 binding path:

1. C19 registers wording templates by ID, version, content and hash. Templates constrain allowed claim class; changing “may contribute” to “caused” must require stronger authority.
2. Every rendered claim-bearing item has a locator, claim ID, certificate ID/version, intended class, display mode and caveat IDs. Metric items additionally carry units, population hash, workload/time range and basis. Hash the manifest and artifact.
3. C16 issues a purpose-bound PublicationDecision tied to those hashes and current authority/freshness, rather than a generic PASS boolean.
4. C20 renders only the approved item bindings. Missing caveats or mismatched content blocks that item or falls back to explicitly unverified presentation.
5. C30 rechecks exact binding at publication. Revocation/staleness invalidates display/export eligibility immediately; do not repeat expensive model verification on every frame.
6. C28 binds base/candidate/diff and original/candidate oracle identity to the verification decision. Legitimate property changes require explicit reviewed semantics rather than claiming automatic weakening detection is complete.

A minimal real metric table is enough to start metric conformance; a chart library is not a prerequisite. A sidecar manifest that the renderer ignores does not satisfy this contract.

## 16. Implementation work-package template

For every feature/component pair, create a work item with: feature ID; existing code evidence; precise gap; input/output schema; functions to implement or reuse; upstream/downstream dependencies; state/persistence changes; authorization and egress; cancellation and stale-result handling; bounded-work policy; relevant acceptance IDs; migration/compatibility plan; owner; demonstrated result.

The implementation team should first locate existing symbols and tests in the actual repository. Classify each proposed function as EXISTING_REUSE, EXISTING_EXTEND, NEW or NOT_NEEDED. Do not duplicate the reported defect runner, graph identity registry or verification ledger. If current contracts differ, record an adapter or explicit versioned migration.

Each completed slice needs a runnable demonstration using real inputs, not only self-authored unit fixtures. Record fixture/corpus hashes, tool versions, exact revisions and browser dimensions where relevant. Synthetic tests remain useful for negative controls but do not establish production adapter coverage.

## 17. Shared release checks

| Check | Applies to | Required result |
|---|---|---|
| Revision mutation | F01–F08,F10 | Superseded findings/certificates are stale; no late current-state publication |
| Authorization revocation | All | Results and counts no longer expose revoked scope; export blocked |
| Original-oracle mutation | F02,F04,F07,F08,F10 | Change detected and reviewed; no silent verified-fix promotion |
| Population mutation | F05,F08,F10 | Denominator changes visible; errors/timeouts not excluded silently |
| Presentation mutation | All visual findings | Stronger wording, omitted caveat or wrong metric basis rejected |
| Cancellation/crash | All jobs | Durable resumable state; no duplicate external publication |
| Budget exhaustion | F01,F03,F05,F06,F08,F10 | Bounded work and explicit partial/incomplete results |
| Browser conformance | F05,F09,F10 | Actual rendered camera, label and chart behaviour inspected |

## 18. Official competitor references

These references support the competitive capabilities, not the proposed component assignments or claims of feature-level usage frequency.

- Sourcegraph search/navigation: https://sourcegraph.com/docs and https://sourcegraph.com/docs/code-navigation
- Sourcegraph batch changes: https://6.10.sourcegraph.com/batch-changes
- Sonar quality gates: https://docs.sonarsource.com/sonarqube-cloud/standards/managing-quality-gates/introduction-to-quality-gates
- CodeQL data flow: https://codeql.github.com/docs/writing-codeql-queries/about-data-flow-analysis/
- Snyk dependency analysis: https://docs.snyk.io/supported-languages/technical-specifications-and-guidance
- Datadog profiling: https://docs.datadoghq.com/profiler/
- CodeScene hotspots: https://codescene.io/docs/guides/technical/hotspots.html
- GitHub agent: https://github.com/github/docs/blob/main/content/copilot/concepts/agents/cloud-agent/about-cloud-agent.md

## 19. Completion definition

A feature is complete only when its declared scope works end-to-end, relevant acceptance checks pass, unsupported coverage is exposed, exact evidence survives rendering/publication, and authorized users can recover from failures. Designed APIs, passing compilation and raw test counts alone are insufficient. Reconcile this feature supplement with original requirement IDs before using it as a full-product completion matrix.
