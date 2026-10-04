#!/usr/bin/env node
// Phase-0 fixture corpus generator: writes one JSON file per acceptance id (RC01–RC28, C24 design §19). Each fixture
// records its inputs, its class (positive / negative-control / missing-data), the design rule it derives from, the
// derivation method ("hand" | "oracle"), and the expected result expressed as assertions about the phase-1 engine.
// Algorithm-bearing expectations (RC03/RC04/RC11/RC15) were cross-checked against the independent oracles in
// c24-phase0-algorithms.test.ts; the generator itself encodes hand-derived values that those tests re-verify.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "c24-causality-fixtures");
mkdirSync(OUT, { recursive: true });

const ev = (id, kind, extra = {}) => ({ id, kind, clock: { domain: extra.domain ?? "wall", epoch: extra.cepoch ?? "1", observed: extra.t ?? null, earliest: extra.lo ?? null, latest: extra.hi ?? null, quality: extra.q ?? "BOUNDED" }, task: extra.task ?? null, attempt: extra.attempt ?? null, processEpoch: extra.processEpoch ?? null, deploymentId: extra.deploymentId ?? null, attributes: extra.attributes ?? null });
const send = (id, t, task = null) => ev(id, "SEND", { t, task });
const recv = (id, t, task = null) => ev(id, "RECEIVE", { t, task });

const fixtures = {
  "rc01-exact-rpc-skewed-clocks.json": { id: "RC01", title: "Exact RPC send/receive with skewed clocks", "class": "positive",
    derivation: { method: "hand", rule: "§6 SEND_RECEIVE: authenticated matching with destination/broker/context agreement; §7: trusted relation retained, clock contradiction flagged instead of repairing chronology" },
    input: { events: [send("e:send", 100), recv("e:recv", 91)], certificates: [{ id: "cert:rpc-1", kind: "SEND_RECEIVE", matchesIds: ["e:send", "e:recv"], valid: true }], proposedEdges: [{ id: "ed rpc-1", from: "e:send", to: "e:recv", kind: "SEND_RECEIVE", certificate: "cert:rpc-1" }] },
    expected: { acceptedEdges: ["ed rpc-1"], quarantinedEdges: [], disclosed: ["CLOCK_CONTRADICTION"], noEdgeDropped: true } },

  "rc02-earlier-timestamp-no-relation.json": { id: "RC02", title: "Earlier timestamp without relation evidence", "class": "positive",
    derivation: { method: "hand", rule: "§2/§7: temporal precedence is supported only as a time statement, never as an execution edge" },
    input: { events: [ev("e:a", "OP_START", { t: 90 }), ev("e:b", "OP_START", { t: 100 })], certificates: [], proposedEdges: [] },
    expected: { acceptedEdges: [], quarantinedEdges: [], orderDecision: { relation: "UNKNOWN", note: "temporal order may be displayed as time evidence only" }, noExecutionEdge: true } },

  "rc03-smaller-lamport-no-path.json": { id: "RC03", title: "Smaller Lamport stamp without path", "class": "positive",
    derivation: { method: "oracle", rule: "§2: a smaller Lamport timestamp does not imply happens-before; no path ⇒ UNKNOWN", oracle: "phase-0 orderRelation + Floyd–Warshall closure agree" },
    input: { events: [ev("e:l1", "OP_START", { q: "LOCAL_MONOTONIC_ONLY" }), ev("e:l2", "OP_START", { q: "LOCAL_MONOTONIC_ONLY" })], attributes: { logicalStamps: { "e:l1": 1, "e:l2": 2 } }, certificates: [], proposedEdges: [] },
    expected: { orderDecision: { relation: "UNKNOWN" }, noHappensBefore: true, noConcurrencyAssertion: true } },

  "rc04-missing-path-sampled.json": { id: "RC04", title: "Missing path under sampled trace", "class": "missing-data",
    derivation: { method: "oracle", rule: "§2/§6: no path in an incomplete graph means UNKNOWN; concurrency needs a completeness certificate", oracle: "orderRelation returns UNKNOWN without certificate; CONCURRENT_CERTIFIED only when valid+covering" },
    input: { events: [ev("e:p", "OP_START"), ev("e:q", "OP_END")], certificates: [], proposedEdges: [], sampling: "HEAD" },
    expected: { orderDecision: { relation: "UNKNOWN" }, gapNodes: ["SAMPLED_REGION"], noConcurrencyAssertion: true } },

  "rc05-fanout-partial-join.json": { id: "RC05", title: "Fan-out and actual partial join", "class": "positive",
    derivation: { method: "hand", rule: "§7: continuation depends on the completions actually awaited; sibling sequence is not invented" },
    input: { events: [ev("e:s", "SPAWN", { task: "t0" }), ev("e:c1", "TASK_COMPLETE", { task: "t1" }), ev("e:c2", "TASK_COMPLETE", { task: "t2" }), ev("e:j", "JOIN", { task: "t0", attributes: { awaited: "t1" } })], certificates: [], proposedEdges: [{ id: "ed j-c1", from: "e:c1", to: "e:j", kind: "COMPLETE_JOIN" }] },
    expected: { acceptedEdges: ["ed j-c1"], quarantinedEdges: [], noSiblingOrder: ["e:c1", "e:c2"], noFictitiousAwait: "e:c2" } },

  "rc06-retry-redelivery-batch.json": { id: "RC06", title: "Message retry/redelivery/batch", "class": "positive",
    derivation: { method: "hand", rule: "§6/§7: retries keep one logical operation with distinct attempt identities; batching is many-to-one with per-message lineage; no false exactly-once" },
    input: { events: [ev("e:enq", "ENQUEUE", { attempt: "op:pay!a1", attributes: { messageId: "m1" } }), ev("e:deq1", "DEQUEUE", { attempt: "op:pay!a1", attributes: { messageId: "m1" } }), ev("e:deq2", "DEQUEUE", { attempt: "op:pay!a2", attributes: { messageId: "m1", redeliveryOf: "op:pay!a1" } }), ev("e:batch", "DEQUEUE", { attempt: "batch:b1", attributes: { messages: ["m1", "m2"] } })], certificates: [], proposedEdges: [] },
    expected: { acceptedEdges: ["ed rc-1", "ed rc-2"], attemptsDistinct: ["op:pay!a1", "op:pay!a2"], batchLineage: "per-message", noExactlyOnceClaim: true } },

  "rc07-context-link-no-semantics.json": { id: "RC07", title: "Context link without semantics", "class": "positive",
    derivation: { method: "hand", rule: "§5/§6: a span link is not assumed to mean waiting or data dependence; kept in CONTEXT layer outside ordering closure" },
    input: { events: [send("e:cs"), recv("e:cr")], certificates: [], proposedEdges: [{ id: "ed ctx", from: "e:cs", to: "e:cr", kind: "CONTEXT_ASSOCIATION" }] },
    expected: { acceptedEdges: ["ed ctx"], layers: { "ed ctx": "CONTEXT" }, notInOrderingClosure: ["ed ctx"] } },

  "rc08-id-reuse-epochs.json": { id: "RC08", title: "PID/task/lock/trace ID reuse", "class": "negative-control",
    derivation: { method: "hand", rule: "§6: process epoch prevents PID/task/lock reuse from merging unrelated executions" },
    input: { events: [ev("e:x1", "LOCK_ACQUIRE", { task: "t:lock", processEpoch: "ep1", attributes: { lock: "lock:L" } }), ev("e:x2", "LOCK_RELEASE", { task: "t:lock2", processEpoch: "ep2", attributes: { lock: "lock:L" } })], certificates: [{ id: "cert:lock-1", adapterId: "adapter:lock", kind: "RELEASE_ACQUIRE", matchesEventIds: ["e:x1", "e:x2"] }], proposedEdges: [] },
    expected: { quarantinedEdges: ["ed reuse"], identityNote: "different process epochs; the same pid number is not one execution", noMergedIdentity: true } },

  "rc09-rolling-deployment-wrong-sourcemap.json": { id: "RC09", title: "Rolling deployment and wrong source map", "class": "positive",
    derivation: { method: "hand", rule: "§8: resolve event→deployment→build→revision; query the deployment revision set, never the current checkout; wrong/missing artifacts stay candidate or fog" },
    input: { events: [ev("e:w1", "OP_START", { deploymentId: "dep:checkout", attributes: { revision: "rev-a", build: "b:rev-a", file: "src/checkout.ts", line: 10 } })], deploymentRevisionSet: ["rev-a", "rev-b"], deploymentMarker: { sourceId: "src:otel", deploymentId: "dep:checkout", revision: "rev-a" }, sourceMaps: { "b:rev-a": { mappings: [{ file: "src/checkout.ts", line: 10, entityId: "function:src/checkout.ts#charge" }] } }, revisionUnderAnalysis: "rev-b", certificates: [], proposedEdges: [] },
    expected: { attribution: { "e:w1": { revision: "rev-a", exact: true } }, notForcedToCurrentRevision: true, alternativesAllowed: true } },

  "rc10-clock-uncertainty-unknown.json": { id: "RC10", title: "Clock uncertainty unknown", "class": "missing-data",
    derivation: { method: "hand", rule: "§7: if uncertainty bounds are unknown, cross-host temporal comparison is UNKNOWN" },
    input: { events: [ev("e:h1", "OP_END", { q: "UNKNOWN", attributes: { op: "op:x" } }), ev("e:h2", "OP_START", { q: "UNKNOWN", attributes: { op: "op:x" } })], certificates: [], proposedEdges: [] },
    expected: { noPreciseCrossHostLatency: true, timeQuality: "UNKNOWN", noInventedBounds: true } },

  "rc11-ordering-cycle-contradictory.json": { id: "RC11", title: "Ordering cycle with contradictory sources", "class": "negative-control",
    derivation: { method: "oracle", rule: "§13: quarantine the affected component with provenance; no first-edge-wins; deterministic regardless of ingest order", oracle: "phase-0 reconcileProposedOrdering verified permutation-invariant over 120 shuffles and against Floyd–Warshall SCC computation" },
    input: { events: [ev("e:cyc1", "SEND"), ev("e:cyc2", "RECEIVE")], certificates: [], proposedEdges: [{ id: "ed o1", from: "e:cyc1", to: "e:cyc2", kind: "SEND_RECEIVE" }, { id: "ed o2", from: "e:cyc2", to: "e:cyc1", kind: "PROGRAM_ORDER" }] },
    expected: { quarantinedEdges: ["ed o1", "ed o2"], conflictReportRetains: ["ed o1", "ed o2"], permutationInvariant: true, acceptedEdges: [] } },

  "rc12-wait-for-cycle-legitimate.json": { id: "RC12", title: "Legitimate wait-for cycle", "class": "positive",
    derivation: { method: "hand", rule: "§6: wait-for graphs may contain cycles; analyzed separately for deadlock/liveness with escape conditions; never quarantined as an execution cycle" },
    input: { events: [ev("e:wa", "LOCK_WAIT", { task: "t1", attributes: {resource: "r1"} }), ev("e:wb", "LOCK_WAIT", { task: "t2", attributes: {resource: "r2"} })], waitRelations: [{ id: "wr:1", task: "t1", resource: "r1", owners: ["t2"], escape: ["owner may release; timeouts unknown"] }, { id: "wr:2", task: "t2", resource: "r2", owners: ["t1"], escape: ["acquire is try-lock in fixture"] }], certificates: [], proposedEdges: [] },
    expected: { waitLayerCycle: ["wr:1", "wr:2"], notQuarantined: true, deadlockAnalysable: true, escapeConditionsPresent: true } },

  "rc13-sampled-cpu-stacks.json": { id: "RC13", title: "Sampled CPU stacks", "class": "positive",
    derivation: { method: "hand", rule: "§5/§9: CPU samples are attribution, not elapsed-time measurements; no fabricated task ordering" },
    input: { events: [ev("e:s1", "SAMPLE", { q: "BOUNDED", attributes: { stackTop: "hot-loop", task: "t9" } }), ev("e:s2", "SAMPLE", { attributes: { stackTop: "hot-loop", task: "t9" } })], certificates: [], proposedEdges: [] },
    expected: { cpuAttributionOnly: true, noFabricatedOrdering: true, notInOrderingClosure: ["e:s1", "e:s2"] } },

  "rc14-missing-spans-retention.json": { id: "RC14", title: "Missing spans/retention/drop", "class": "missing-data",
    derivation: { method: "hand", rule: "§7: material gap nodes; absence-based exoneration blocked without an exhaustive coverage certificate" },
    input: { events: [ev("e:seen", "OP_START")], certificates: [{ id: "cert:cov1", exhaustiveForPredicate: false, predicate: "all service-x events", window: { from: 0, to: 1000 } }], proposedEdges: [], queriedAbsentService: "service-x" },
    expected: { gapNodes: ["MISSING_EVENT", "RETENTION_EXPIRED"], material: true, noExoneration: true, absenceIsNotProofOfAbsence: true } },

  "rc15-nested-overlapping.json": { id: "RC15", title: "Nested/overlapping operations", "class": "positive",
    derivation: { method: "oracle", rule: "§9: nested/overlapping durations are not summed; exclusive time is unattributed until stronger evidence", oracle: "accountDurations union verified against integer-grid scan; re-segmentation invariant" },
    input: { events: [], segments: [{ fromMs: 0, toMs: 100, covered: true }, { fromMs: 10, toMs: 20, covered: true }], observation: { fromMs: 0, toMs: 100 }, certificates: [], proposedEdges: [] },
    expected: { coveredMs: 100, unresolvedMs: 0, noDoubleCounting: true } },

  "rc16-tailsampled-failures-control.json": { id: "RC16", title: "Tail-sampled failures versus control", "class": "missing-data",
    derivation: { method: "hand", rule: "§9/§16: selection bias disclosed; absence of errors in a control cohort is not evidence of equivalence; no automatic causal effect" },
    input: { events: [ev("e:f1", "EXCEPTION", { attributes: { cohort: "tail-kept" } })], sampling: "TAIL", controlCohort: { sampled: true, errorsObserved: 0 }, certificates: [], proposedEdges: [] },
    expected: { selectionBiasDisclosed: true, noAutomaticCausalEffect: true, controlNotEquivalent: true } },

  "rc17-correction-retraction.json": { id: "RC17", title: "Source event correction/retraction", "class": "positive",
    derivation: { method: "hand", rule: "§15: persist correction and invalidation atomically; dependent edges/claims/views are stale before asynchronous refresh; readers enforce freshness" },
    input: { events: [ev("e:orig", "SEND"), ev("e:fixed", "SEND")], correctionOf: { "e:fixed": "e:orig" }, derivedEdges: ["ed:from-orig"], derivedClaims: ["claim:from-orig"], certificates: [], proposedEdges: [] },
    expected: { dependentEdgesInvalidated: ["ed:from-orig"], dependentClaimsStale: ["claim:from-orig"], atomic: true, staleBeforeRefresh: true } },

  "rc18-cancel-requested-child-completes.json": { id: "RC18", title: "Cancellation requested but child completes", "class": "positive",
    derivation: { method: "hand", rule: "§7: requesting cancellation does not prove the child stopped or rolled back its effect; facts retained separately" },
    input: { events: [ev("e:cancel", "CANCEL_REQUEST", { task: "tX" }), ev("e:done", "TASK_COMPLETE", { task: "tX" })], certificates: [], proposedEdges: [] },
    expected: { noRollbackAssertion: true, factsRetained: ["CANCEL_REQUEST delivered", "TASK_COMPLETE observed"], noFictitiousCancelEdge: true } },

  "rc19-shared-dependency-interference.json": { id: "RC19", title: "Shared dependency interference", "class": "negative-control",
    derivation: { method: "hand", rule: "§10: do not assume request-level independence; experiments may need whole-instance allocation; report tested population and spillover scope" },
    input: { events: [ev("e:w1", "LOCK_WAIT", { task: "t1", t: 5, attributes: { resource: "r1" } })], experiment: { design: "request-level-randomized", sharedDependencies: ["db:pool", "queue:checkout"] }, waitRelations: [{ id: "wr:1", task: "t1", resource: "r1", owners: ["t2"], escape: ["owner may release", "acquire may time out"] }], certificates: [], proposedEdges: [] },
    expected: { populationLimitsRetained: true, spilloverScopeRecorded: true, noRequestIndependenceAssumption: true, wholeInstanceAllocationMayBeRequired: true } },

  "rc20-forged-trace-context.json": { id: "RC20", title: "Unauthorized forged trace context", "class": "negative-control",
    derivation: { method: "hand", rule: "§5/§16: client-provided trace IDs are not identity/authorization tokens; collection identity is authenticated; no authority grant, no private topology disclosure" },
    input: { events: [ev("e:forge", "OP_START", { attributes: { traceparent: "00-forged...", claimed: "tenant:other" } })], collectorIdentity: { authenticated: false }, certificates: [], proposedEdges: [], grantsIssued: [] },
    expected: { sourceTrust: "UNTRUSTED_CONTEXT", noAuthorityGrant: true, noPrivateTopologyDisclosure: true, rejected: true } },

  "rc21-oversized-ingestion.json": { id: "RC21", title: "Oversized ingestion/query slice", "class": "negative-control",
    derivation: { method: "hand", rule: "§15: bounded slices; beyond limits return explicit truncation/continuation/backpressure; no unbounded local persistence (existing ingest already refuses oversize; RC21 restates it for graph intake)" },
    input: { events: Array.from({ length: 400 }, (_, i) => ev("e:big" + i, "OP_START")), limits: { maxEventsPerSlice: 100 }, certificates: [], proposedEdges: [] },
    expected: { truncated: true, continuationHandle: true, noUnboundedPersistence: true, backpressureSignaled: true } },

  "rc22-crash-boundaries.json": { id: "RC22", title: "Crash between source cursor/projection/outbox", "class": "negative-control",
    derivation: { method: "hand", rule: "§15: on crash reconcile accepted source cursors and outbox checkpoints; dedup and payload hashes prevent duplicate authoritative events; no mixed snapshot (existing failpoint harness replays this)" },
    input: { events: [ev("e:k1", "OP_START"), ev("e:k2", "SEND")], failpoints: ["after-cursor-accept", "before-projection-commit", "after-outbox-append"], certificates: [], proposedEdges: [] },
    expected: { noDuplicateAuthoritativeResult: true, noMixedSnapshot: true, durableReplay: true } },

  "rc23-revoked-source-deleted-handle.json": { id: "RC23", title: "Revoked source/deleted raw handle", "class": "negative-control",
    derivation: { method: "hand", rule: "§15/§16: governance deletes raw/derived payload handles; views show restricted/unavailable rather than stale trusted conclusions; no historic payload recovery" },
    input: { events: [ev("e:r1", "OP_START")], sourceMappingURL: { "e:r1": "src:sensitive" }, revokedSourceIds: ["src:sensitive"], certificates: [], proposedEdges: [], deletedHandles: ["raw:blob-77"] },
    expected: { stateAfterRevocation: "RESTRICTED", noHistoricPayloadRecovery: true, noStaleTrustedConclusion: true } },

  "rc24-late-event-after-watermark.json": { id: "RC24", title: "Late event after finalized watermark", "class": "missing-data",
    derivation: { method: "hand", rule: "§15: beyond-watermark corrections remain possible and produce invalidation; versioned correction, not silent ignore" },
    input: { events: [ev("e:late", "RECEIVE", { t: 50 })], watermark: { sourceSequence: "s42", eventTimeWatermark: 40, finalForWindow: true }, certificates: [], proposedEdges: [] },
    expected: { newSnapshotVersion: true, affectedEdgesInvalidated: true, notSilentlyIgnored: true } },

  "rc25-replay-playback-only.json": { id: "RC25", title: "Telemetry replay requested", "class": "positive",
    derivation: { method: "hand", rule: "§3/§17: C24 replay is evidence/timeline playback; executable replay belongs to C27 with its own coverage manifest" },
    input: { events: [], certificates: [], proposedEdges: [], requestedReplay: { kind: "telemetry", cursorMs: 120 } },
    expected: { playbackLabel: true, noExecutableReplayPromise: true } },

  "rc26-llm-unsupported-root-cause.json": { id: "RC26", title: "LLM proposes unsupported root cause", "class": "negative-control",
    derivation: { method: "hand+oracle", rule: "§12/§19: buildMechanismEvidence assembles paths for C22/C26, never an accepted root-cause finding; C16/C18 gates block display", oracle: "phase-0 claim-gates test shows non-grounded/model-authored causal claims never display as FACT and relation claims stay relation-level" },
    input: { events: [], llmProposal: { assertion: "the payment service caused the outage", evidence: [] }, certificates: [], proposedEdges: [] },
    expected: { hypothesisOnly: true, gatesBlockDisplay: true, noAutomaticAcceptedRootCause: true } },

  "rc27-intervention-mismatched-scope.json": { id: "RC27", title: "Intervention mismatched workload/revision", "class": "negative-control",
    derivation: { method: "hand+oracle", rule: "§10/§12: linkInterventionEvidence verifies matching scope; a label cannot declare any experiment causal unconditionally", oracle: "phase-0 claim-gates test: experiment-less intervention assertions never reach intervention-grade display" },
    input: { events: [ev("e:w1", "LOCK_WAIT", { task: "t1", t: 5 })], experiment: { reportId: "c27:report:1", workload: "burst", revision: "rev-a" }, targetScope: { workload: "steady", revision: "rev-b" }, waitRelations: [{ id: "wr:1", task: "t1", resource: "r1", owners: ["t2"], escape: ["owner may release"] }], certificates: [], proposedEdges: [] },
    expected: { scopeGatePreventsPromotion: true, noInterventionSupportsInTargetScope: true, disclosedMismatch: true } },

  "rc28-confounded-before-after.json": { id: "RC28", title: "Confounded before/after deployment", "class": "negative-control",
    derivation: { method: "hand+oracle", rule: "§10: confounded before/after release comparisons remain observational unless a defensible identification design exists", oracle: "phase-0 claim-gates test: confounded comparison stays inference-or-below, never FACT" },
    input: { events: [ev("e:before", "EXCEPTION", { t: 10 }), ev("e:after", "EXCEPTION", { t: 20 }), ev("e:w1", "LOCK_WAIT", { task: "t1", t: 5 })], experiment: { design: "before-after-release", confounds: ["load difference", "queue load"] }, waitRelations: [{ id: "wr:1", task: "t1", resource: "r1", owners: ["t2"], escape: ["owner may release"] }], certificates: [], proposedEdges: [] },
    expected: { observationalAssociationOnly: true, noConfirmedInterventionEffect: true, confoundsDisclosed: true } },
};

for (const [name, fx] of Object.entries(fixtures)) writeFileSync(join(OUT, name), JSON.stringify(fx, null, 2) + "\n");
const ids = Object.values(fixtures).map((f) => parseInt(f.id.slice(2), 10));
console.log(`wrote ${Object.keys(fixtures).length} fixtures; RC coverage complete: ${ids.every((n, i) => n === i + 1)}`);