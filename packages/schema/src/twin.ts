// F10 — Bounded workflow digital twin: full data model.
// Result classes are the guide's; a prediction that is not inside a valid certificate's domain
// must never carry VALIDATED_MODEL_PREDICTION.
import { z } from "zod";

const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.iso.datetime();
const strings = z.array(z.string().max(4000)).max(10000);

// ------------------------------------------------------------------ vocabularies
export const RESULT_CLASSES = ["NARRATIVE", "MODEL_PREDICTION", "VALIDATED_MODEL_PREDICTION", "MEASURED_EXPERIMENT", "BOUNDED_CORRECTNESS_RESULT"] as const;
export type ResultClass = (typeof RESULT_CLASSES)[number];

export const INTERVENTION_CLASSES = ["POOL_CAPACITY", "WORKER_CONCURRENCY", "OFFERED_LOAD"] as const;
export type InterventionClass = (typeof INTERVENTION_CLASSES)[number];

export const CERTIFIED_METRICS = ["throughput", "p50", "p95", "p99", "errorRate", "utilisation"] as const;
export type CertifiedMetric = (typeof CERTIFIED_METRICS)[number];

export const DOMAIN_VERDICTS = ["IN_DOMAIN", "OUT_OF_DOMAIN", "INSUFFICIENT_EVIDENCE"] as const;
export type DomainVerdict = (typeof DOMAIN_VERDICTS)[number];

export const GATE_IDS = ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"] as const;
export type GateId = (typeof GATE_IDS)[number];

export type Basis = "STRUCTURAL" | "MEASURED" | "INTERPOLATED" | "EXTRAPOLATED" | "INFERRED";
export type RunRole = "TWIN_BASELINE" | "TWIN_CANDIDATE" | "MODEL_TRAINING" | "MODEL_HOLDOUT";

/** A measured interval, kept separate from a model prediction interval. */
export interface Interval { lower: number; upper: number; method: string; confidenceLevel: number }

// ------------------------------------------------------------------ workload and environment
export interface ArrivalModel {
  model: "POISSON" | "PIECEWISE" | "BURSTY" | "REPLAY" | "FIXED_RATE";
  segments?: { fromSec: number; toSec: number; ratePerSec: number }[];
  ratePerSec?: number;
  burst?: { onRate: number; offRate: number; pOnToOff: number; pOffToOn: number };
}
export interface WorkloadStream { name: string; purpose: string; distribution: { kind: string; parameters: Record<string, number> } }
export interface RequestRecord {
  operation: string; payloadSizeBucket: number; keyClass: string;
  /** Per-station exclusive (non-waiting) demand in ms, and the wait separately. */
  demands: Record<string, number>; waits: Record<string, number>;
  outcome: "SUCCESS" | "ERROR" | "TIMEOUT"; errorClass?: string; retryCount: number; censored: boolean;
}
export interface WorkloadSpec {
  arrival: ArrivalModel;
  operationMix: { operation: string; share: number }[];
  streams: WorkloadStream[];
  loadMultipliers: number[];
  durationSec: number; warmupSec: number;
  openLoop: boolean;
  derivedFrom: { windowIds: string[]; labelAllowlistApplied: boolean };
}
export interface EnvironmentSpec {
  platform: string; runtimeVersion: string; compilerVersion?: string; cores: number; memoryBytes: number;
  isolationProfile: string; clockModel: string; cachePolicy: "WARM" | "COLD" | "RESET"; resetPolicy: string;
  poolSizes: Record<string, number>; permittedNetworkTargets: string[]; weakMemoryModel: boolean;
}

// ------------------------------------------------------------------ structure
export interface TwinSnapshot {
  repositoryId: string; revision: string;
  sourceHash: string; buildHash: string; configHash: string; dependencyLockHash: string; dataStateHash: string;
}
export interface TwinStation {
  id: string; name: string; entityId?: string; evidence: "MEASURED" | "MODELLED" | "UNKNOWN";
  resourceIds: string[]; unresolved: boolean; material: boolean; category?: "CPU" | "IO" | "LOCK" | "POOL" | "QUEUE" | "OTHER";
}
export interface TwinResource { id: string; kind: "POOL" | "LOCK" | "QUEUE" | "CPU" | "EXTERNAL"; capacity: number | null; source: string }
export interface TwinBranch { id: string; stationId: string; probabilitySource: string; to: string }
export interface TwinExternal { id: string; name: string; matchingKeys: string[]; unmatchedBehaviour: string; recordedResponseAdapter?: string }
export interface TwinUnresolved { id: string; description: string; material: boolean; stationId?: string }
export interface TwinStructure {
  entryStationId: string;
  stations: TwinStation[]; resources: TwinResource[]; branches: TwinBranch[]; externals: TwinExternal[]; unresolved: TwinUnresolved[];
}

// ------------------------------------------------------------------ model spec (§7.4)
export type ServiceTimeSource =
  | { kind: "FIXED"; ms: number }
  | { kind: "EXPONENTIAL"; meanMs: number }
  | { kind: "LOGNORMAL"; meanMs: number; sigma: number }
  | { kind: "EMPIRICAL"; samplesMs: number[] }
  | { kind: "CONTENTION"; baseMeanMs: number; factor: number; exponent: number };
export interface ModelResource { id: string; kind: "POOL" | "LOCK" | "QUEUE" | "CPU" | "EXTERNAL"; capacity: number; queuePolicy: "FIFO" | "LIFO"; queueLimit: number }
export interface ModelStation {
  id: string; name: string; resourceId: string | null;
  service: ServiceTimeSource;
  routing: { to: string; probability: number; attributeEquals?: { attribute: string; value: string } }[];
  timeoutMs?: number; retries?: { max: number; backoffMs: number };
  cache?: { keyClass: string; hitProbability: number };
  external?: { latencyMs: ServiceTimeSource; errorProbability: number };
}
export interface TwinModelSpec {
  schemaId: "workflow.twin.model.v1";
  entryStationId: string; stations: ModelStation[]; resources: ModelResource[];
  /** Pinned RNG algorithm and tie comparator, so a run is reproducible. */
  rng: "sha256-keyed/v1"; tieComparator: "sequence/v1";
  faults: { stationId: string; probability: number; errorClass: string }[];
}
export interface ModelParameters {
  serviceMeans: Record<string, number>;
  contentionFactor: number; contentionExponent: number;
  cacheHit: Record<string, number>;
  retryAmplification: number;
  externalLatency: Record<string, number>;
  externalError: Record<string, number>;
}
export type StructureCandidateId = "FIXED" | "CONTENTION" | "CACHE_DEPENDENCE" | "RETRY_AMPLIFICATION";
export interface StructureCandidate { id: StructureCandidateId; description: string; spec: TwinModelSpec; parameters: ModelParameters }

// ------------------------------------------------------------------ certificates
export interface ValidationScope {
  metrics: CertifiedMetric[];
  interventionClass: InterventionClass;
  ranges: { parameter: string; min: number; max: number }[];
  workload: { arrivalModel: string; rateMultiplier: { min: number; max: number }; mixTolerance: number };
  environmentClass: { environmentHash: string; allowedDifferences: string[] };
  assumptionsChecked: { id: string; statement: string; checkedRange: [number, number]; evidenceIds: string[] }[];
  materialUnresolved: string[];
}
export interface GateResult { gate: GateId; passed: boolean; detail: string; evidenceIds: string[] }
export interface HeldOutIntervention {
  parameter: string; value: number; loadMultiplier: number;
  predictedDelta: Interval; measuredDelta: Interval;
  directionAgrees: boolean; withinTolerance: boolean;
  predictionRecordHash: string; predictionRecordedAt: string;
}
export interface ValidationCertificate {
  certificateId: string; twinId: string; twinVersion: number; modelId: string;
  scope: ValidationScope;
  bindingHash: string;
  validation: {
    gates: GateResult[];
    heldOutInterventions: HeldOutIntervention[];
    intervalCoverage: { nominal: number; observed: number; trials: number };
  };
  state: "VALID" | "STALE" | "REVOKED";
  issuedAt: string; issuedBy: string;
  invalidatedBy?: string; invalidatedAt?: string; invalidationReason?: string;
}
export interface CalibrationRun {
  calibrationId: string; modelId: string;
  trainingDatasetIds: string[]; structureCandidates: StructureCandidateId[]; chosenStructure: StructureCandidateId;
  fitMetrics: Record<string, number>; policyId: string; createdAt: string;
}
export interface ModelArtifact {
  modelId: string; twinId: string; twinVersion: number; modelSpecHash: string;
  adapterId: string; adapterVersion: string; parentModelId?: string; fitHash: string;
  parameters: ModelParameters; chosenStructure: StructureCandidateId; state: "FITTED" | "SUPERSEDED"; createdAt: string;
}

// ------------------------------------------------------------------ experiments
export interface OutcomesRecord {
  requestId: string; operation: string; intendedAtMs: number; sentAtMs: number; completedAtMs: number;
  outcome: "SUCCESS" | "ERROR" | "TIMEOUT" | "CANCELLED"; errorClass?: string; retryCount: number;
  /** Latency is measured from the intended send time, never from when the generator got to it. */
  intendedLatencyMs: number; observedLatencyMs: number;
  generatorDelayMs: number; correctnessPassed: boolean; instrumented: boolean;
}
export interface OutcomesArtifact {
  hash: string; role: RunRole; buildHash: string; environmentHash: string; workloadHash: string; oracleHash: string;
  scheduledRatePerSec: number; achievedRatePerSec: number;
  generatorSaturated: boolean; coordinatedOmissionDetected: boolean; instrumentationPresent: boolean;
  records: OutcomesRecord[];
}
export interface TrialMetrics {
  throughput: number; p50: number; p95: number; p99: number; errorRate: number; completedWorkRate: number;
  successOnlyP95: number; allRequestsP95: number;
  utilisation: Record<string, number>; effectiveBlocks: number;
}
export interface RunCell {
  cellId: string; pairId: string; role: RunRole; runManifestId: string; orderIndex: number;
  comparable: boolean; incomparableReason?: string;
}
export interface ExperimentPlan {
  planId: string; twinId: string; twinVersion: number;
  interventionHash: string; validationPlanHash: string; seedPlanHash: string;
  repetitions: number; state: "PLANNED" | "RUNNING" | "COMPARED" | "BUDGET_STOPPED" | "CANCELLED" | "FAILED";
  generation: number; cells: RunCell[]; createdAt: string; budgetStopReason?: string;
}
export interface TwinReport {
  reportId: string; planId?: string;
  kind: "PAIRED" | "PREDICTION" | "SENSITIVITY" | "RACE";
  resultClass: ResultClass; content: unknown; certificateId?: string; createdAt: string;
}

// ------------------------------------------------------------------ prediction / applicability
export interface MetricPrediction { metric: CertifiedMetric; baseline: number; predicted: number; interval: Interval; delta: number }
export interface UncertaintyBreakdown {
  parameter: Interval; structural: { structure: StructureCandidateId; delta: number }[]; runToRun: Interval | null;
}
export interface AssumptionStatus { id: string; statement: string; value: number; checkedRange: [number, number]; withinRange: boolean; canReverseSign: boolean }
export interface ApplicabilityRequest {
  intervention: { class: InterventionClass; parameters: Record<string, number> };
  workload: { arrivalModel: string; rateMultiplier: number; mixTolerance?: number };
  metrics?: CertifiedMetric[];
  environmentHash: string;
  assumptions?: { id: string; value: number }[];
}
export interface ApplicabilityDecision {
  verdict: DomainVerdict;
  violatedRanges: string[];
  reasons: string[];
  certificateId?: string;
  allowedClass: ResultClass | null;
  blocked: boolean;
}
export interface PredictionResult {
  resultClass: ResultClass;
  predictions: MetricPrediction[];
  uncertainty: UncertaintyBreakdown;
  assumptions: AssumptionStatus[];
  domainAssessment: { verdict: DomainVerdict; violatedRanges: string[]; certificateId?: string };
}

// ------------------------------------------------------------------ races
export interface RaceWindow {
  id: string; description: string; stationIds: string[]; stateKeys: string[];
  detector: "UNTRANSACTED_WRITERS" | "LOCK_ORDER_CYCLE" | "ASYNC_SHARED_STATE";
}
export interface RaceFinding {
  explorationId: string; twinId: string; window: RaceWindow;
  bounds: { maxSchedules: number; maxSteps: number };
  status: "SUCCEEDED" | "PROPERTY_FAILED" | "BUDGET_STOPPED" | "INCONCLUSIVE" | "CANCELLED";
  exploredSchedules: number; completedSearch: boolean;
  schedule: string[] | null; scheduleArtifactHash: string | null;
  harnessHash?: string; oracleHash?: string;
  replaySupported: boolean; oracleReviewedBy: string | null;
  wording: string;
}

// ------------------------------------------------------------------ twins
export interface Twin {
  twinId: string; workflowId: string; name: string;
  version: number; twinHash: string;
  snapshot: TwinSnapshot; structure: TwinStructure; structureHash: string;
  baselineEvidenceIds: string[];
  workloadHash: string; environmentHash: string; modelSpecHash: string; oracleHash: string;
  state: "DRAFT" | "BASELINED" | "FITTED" | "VALIDATED" | "STALE" | "RETIRED";
  createdAt: string; createdBy: string;
}
export interface EnvironmentClass { environmentHash: string; allowedDifferences: string[] }

// ------------------------------------------------------------------ zod schemas (wire)
export const WorkloadSpecSchema = z.object({
  arrival: z.object({ model: z.enum(["POISSON", "PIECEWISE", "BURSTY", "REPLAY", "FIXED_RATE"]), segments: z.array(z.object({ fromSec: z.number(), toSec: z.number(), ratePerSec: z.number() }).strict()).optional(), ratePerSec: z.number().optional(), burst: z.object({ onRate: z.number(), offRate: z.number(), pOnToOff: z.number(), pOffToOn: z.number() }).strict().optional() }).strict(),
  operationMix: z.array(z.object({ operation: id, share: z.number().gt(0).lte(1) }).strict()).min(1),
  streams: z.array(z.object({ name: id, purpose: z.string().max(400), distribution: z.object({ kind: id, parameters: z.record(z.string(), z.number()) }).strict() }).strict()),
  loadMultipliers: z.array(z.number().gt(0).lte(1000)).min(1),
  durationSec: z.number().gt(0), warmupSec: z.number().min(0),
  openLoop: z.boolean(),
  derivedFrom: z.object({ windowIds: z.array(id), labelAllowlistApplied: z.boolean() }).strict(),
}).strict();

export const EnvironmentSpecSchema = z.object({
  platform: id, runtimeVersion: id, compilerVersion: id.optional(), cores: z.number().int().min(1), memoryBytes: z.number().int().min(1),
  isolationProfile: id, clockModel: id, cachePolicy: z.enum(["WARM", "COLD", "RESET"]), resetPolicy: id,
  poolSizes: z.record(z.string(), z.number().int().min(0)), permittedNetworkTargets: strings, weakMemoryModel: z.boolean(),
}).strict();

const intervalSchema = z.object({ lower: z.number(), upper: z.number(), method: id, confidenceLevel: z.number().gt(0).lt(1) }).strict().refine((x) => x.lower <= x.upper, "interval lower must not exceed upper");

export const ValidationScopeSchema = z.object({
  metrics: z.array(z.enum(CERTIFIED_METRICS)).min(1),
  interventionClass: z.enum(INTERVENTION_CLASSES),
  ranges: z.array(z.object({ parameter: id, min: z.number(), max: z.number() }).strict()).min(1),
  workload: z.object({ arrivalModel: id, rateMultiplier: z.object({ min: z.number(), max: z.number() }).strict(), mixTolerance: z.number().min(0) }).strict(),
  environmentClass: z.object({ environmentHash: hash, allowedDifferences: strings }).strict(),
  assumptionsChecked: z.array(z.object({ id, statement: z.string().max(4000), checkedRange: z.tuple([z.number(), z.number()]), evidenceIds: strings }).strict()),
  materialUnresolved: strings,
}).strict();

export const ValidationCertificateSchema = z.object({
  certificateId: id, twinId: id, twinVersion: z.number().int().min(1), modelId: id,
  scope: ValidationScopeSchema, bindingHash: hash,
  validation: z.object({
    gates: z.array(z.object({ gate: z.enum(GATE_IDS), passed: z.boolean(), detail: z.string().max(4000), evidenceIds: strings }).strict()),
    heldOutInterventions: z.array(z.object({ parameter: id, value: z.number(), loadMultiplier: z.number(), predictedDelta: intervalSchema, measuredDelta: intervalSchema, directionAgrees: z.boolean(), withinTolerance: z.boolean(), predictionRecordHash: hash, predictionRecordedAt: timestamp }).strict()),
    intervalCoverage: z.object({ nominal: z.number().gt(0).lt(1), observed: z.number().min(0).max(1), trials: z.number().int().min(0) }).strict(),
  }).strict(),
  state: z.enum(["VALID", "STALE", "REVOKED"]),
  issuedAt: timestamp, issuedBy: id, invalidatedBy: id.optional(), invalidatedAt: timestamp.optional(), invalidationReason: z.string().max(4000).optional(),
}).strict();

export const ServiceTimeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("FIXED"), ms: z.number().min(0) }).strict(),
  z.object({ kind: z.literal("EXPONENTIAL"), meanMs: z.number().min(0) }).strict(),
  z.object({ kind: z.literal("LOGNORMAL"), meanMs: z.number().min(0), sigma: z.number().min(0) }).strict(),
  z.object({ kind: z.literal("EMPIRICAL"), samplesMs: z.array(z.number().min(0)).min(1) }).strict(),
  z.object({ kind: z.literal("CONTENTION"), baseMeanMs: z.number().min(0), factor: z.number(), exponent: z.number() }).strict(),
]);

export const TwinModelSpecSchema = z.object({
  schemaId: z.literal("workflow.twin.model.v1"),
  entryStationId: id,
  stations: z.array(z.object({
    id, name: id, resourceId: id.nullable(),
    service: ServiceTimeSourceSchema,
    routing: z.array(z.object({ to: id, probability: z.number().min(0).max(1), attributeEquals: z.object({ attribute: id, value: id }).strict().optional() }).strict()),
    timeoutMs: z.number().min(0).optional(), retries: z.object({ max: z.number().int().min(0), backoffMs: z.number().min(0) }).strict().optional(),
    cache: z.object({ keyClass: id, hitProbability: z.number().min(0).max(1) }).strict().optional(),
    external: z.object({ latencyMs: ServiceTimeSourceSchema, errorProbability: z.number().min(0).max(1) }).strict().optional(),
  }).strict()),
  resources: z.array(z.object({ id, kind: z.enum(["POOL", "LOCK", "QUEUE", "CPU", "EXTERNAL"]), capacity: z.number().int().min(0), queuePolicy: z.enum(["FIFO", "LIFO"]), queueLimit: z.number().int().min(0) }).strict()),
  rng: z.literal("sha256-keyed/v1"), tieComparator: z.literal("sequence/v1"),
  faults: z.array(z.object({ stationId: id, probability: z.number().min(0).max(1), errorClass: id }).strict()),
}).strict();

export type WorkloadSpecInput = z.infer<typeof WorkloadSpecSchema>;
export type EnvironmentSpecInput = z.infer<typeof EnvironmentSpecSchema>;
export type ValidationCertificateInput = z.infer<typeof ValidationCertificateSchema>;
export type TwinModelSpecInput = z.infer<typeof TwinModelSpecSchema>;
