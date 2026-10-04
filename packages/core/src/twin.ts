// F10 — Bounded workflow digital twin: pure rules.
// No clock, no I/O. The service applies these; unit tests exercise them under node.
//
// The load-bearing rules:
//  - a prediction may carry VALIDATED_MODEL_PREDICTION only when a VALID certificate's binding
//    hash matches the current twin and the request lies inside the certified domain (§7.7, F10-A6);
//  - out-of-domain requests are blocked by default, and exploratory requests are MODEL_PREDICTION;
//  - draws are event-keyed, so changing the number of internal draws does not shift arrivals (F10-D1);
//  - a comparison policy that omits errorRate or completedWorkRate is rejected (F10-A4);
//  - a certificate is issued only when G2, G3 and G4 pass (F10-A2).
import { createHash } from "node:crypto";
import type {
  ApplicabilityDecision, ApplicabilityRequest, CertifiedMetric, EnvironmentSpec,
  GateResult, HeldOutIntervention, InterventionClass, ResultClass, TwinSnapshot, TwinStructure,
  ValidationCertificate, ValidationScope, WorkloadSpec,
} from "@cie/schema";

const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]))
      : v;
const h = (v: unknown): string => createHash("sha256").update(JSON.stringify(canonical(v))).digest("hex");

/** twinHash = H(snapshot, workflowStructureHash, baselineEvidenceIds[], workloadHash, environmentHash, modelSpecHash, oracleHash). */
export function computeTwinHash(parts: {
  snapshot: TwinSnapshot; structureHash: string; baselineEvidenceIds: string[];
  workloadHash: string; environmentHash: string; modelSpecHash: string; oracleHash: string;
}): string {
  return h({
    snapshot: parts.snapshot,
    structureHash: parts.structureHash,
    baselineEvidenceIds: [...parts.baselineEvidenceIds].sort(),
    workloadHash: parts.workloadHash,
    environmentHash: parts.environmentHash,
    modelSpecHash: parts.modelSpecHash,
    oracleHash: parts.oracleHash,
  });
}

/** bindingHash = H(twinHash, modelSpecHash, fitHash, workloadHashes, environmentHash, oracleHash, source/build hashes, policyIds). */
export function computeBindingHash(parts: {
  twinHash: string; modelSpecHash: string; fitHash: string; workloadHashes: string[];
  environmentHash: string; oracleHash: string; sourceHash: string; buildHash: string; policyIds: string[];
}): string {
  return h({ ...parts, workloadHashes: [...parts.workloadHashes].sort(), policyIds: [...parts.policyIds].sort() });
}

// ------------------------------------------------------------------ workload and environment validity
export interface SpecProblem { path: string; problem: string }

/** Structural checks on a workload fixture. Open-loop is required for capacity inference. */
export function validateWorkloadSpec(spec: WorkloadSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  if (!Number.isFinite(spec.durationSec) || spec.durationSec <= 0) problems.push({ path: "durationSec", problem: "duration must be positive" });
  if (!Number.isFinite(spec.warmupSec) || spec.warmupSec < 0 || spec.warmupSec >= spec.durationSec) problems.push({ path: "warmupSec", problem: "warm-up must be at least 0 and shorter than the run" });
  if (!spec.loadMultipliers.length || spec.loadMultipliers.some((m) => !(m > 0 && m <= 1000))) problems.push({ path: "loadMultipliers", problem: "at least one positive multiplier up to 1000 is required" });
  const share = spec.operationMix.reduce((a, b) => a + b.share, 0);
  if (spec.operationMix.length === 0) problems.push({ path: "operationMix", problem: "the fixture must name at least one operation" });
  else if (Math.abs(share - 1) > 1e-6) problems.push({ path: "operationMix", problem: `operation shares must sum to 1 (got ${share.toFixed(4)})` });
  if (spec.arrival.model === "PIECEWISE" && !(spec.arrival.segments?.length)) problems.push({ path: "arrival.segments", problem: "a piecewise arrival model needs segments" });
  if ((spec.arrival.model === "FIXED_RATE" || spec.arrival.model === "POISSON") && !(spec.arrival.ratePerSec && spec.arrival.ratePerSec > 0) && !spec.arrival.segments?.length) problems.push({ path: "arrival.ratePerSec", problem: "a rate is required" });
  const names = new Set<string>();
  for (const s of spec.streams) {
    if (names.has(s.name)) problems.push({ path: `streams.${s.name}`, problem: "duplicate stream name" });
    names.add(s.name);
    if (!s.purpose.trim()) problems.push({ path: `streams.${s.name}`, problem: "a stream needs a purpose" });
  }
  if (!spec.openLoop) problems.push({ path: "openLoop", problem: "capacity inference requires open-loop arrivals; a closed-loop fixture must be labelled and cannot certify capacity" });
  if (spec.derivedFrom.windowIds.length && !spec.derivedFrom.labelAllowlistApplied) problems.push({ path: "derivedFrom.labelAllowlistApplied", problem: "a fixture derived from traces must apply the label allowlist" });
  return problems;
}

export function validateEnvironmentSpec(spec: EnvironmentSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  if (!Number.isInteger(spec.cores) || spec.cores < 1) problems.push({ path: "cores", problem: "cores must be a positive integer" });
  if (!Number.isFinite(spec.memoryBytes) || spec.memoryBytes < 1) problems.push({ path: "memoryBytes", problem: "memory must be positive" });
  if (!spec.isolationProfile.trim()) problems.push({ path: "isolationProfile", problem: "an isolation profile is required" });
  for (const [name, size] of Object.entries(spec.poolSizes)) if (!Number.isInteger(size) || size < 0) problems.push({ path: `poolSizes.${name}`, problem: "pool sizes must be non-negative integers" });
  if (spec.permittedNetworkTargets.some((t) => !t.trim())) problems.push({ path: "permittedNetworkTargets", problem: "network targets must be non-empty" });
  return problems;
}

// ------------------------------------------------------------------ event-keyed streams (F10-D1)
/**
 * A draw keyed by (seed, stream, requestId, purpose). Because draws do not consume a shared
 * sequence, a candidate that performs more internal draws still sees the same arrivals and
 * request attributes. Returns a number in [0, 1).
 */
export function eventKeyedRandom(seed: string, stream: string, requestId: string, purpose: string): number {
  const digest = createHash("sha256").update(`${seed}|${stream}|${requestId}|${purpose}`).digest();
  return digest.readUInt32BE(0) / 2 ** 32;
}

/** Draws for several purposes of the same event; order of `purposes` never changes any value. */
export function eventKeyedDraws(seed: string, stream: string, requestId: string, purposes: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of purposes) out[p] = eventKeyedRandom(seed, stream, requestId, p);
  return out;
}

/** A deterministic integer in [min, max] keyed the same way, for attributes such as payload-size bucket. */
export function eventKeyedInt(seed: string, stream: string, requestId: string, purpose: string, min: number, max: number): number {
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) throw new Error("invalid integer range");
  return min + Math.floor(eventKeyedRandom(seed, stream, requestId, purpose) * (max - min + 1));
}

// ------------------------------------------------------------------ applicability (G5, F10-A3)
const metricIn = (certified: CertifiedMetric[], want: CertifiedMetric[] | undefined): { ok: boolean; missing: CertifiedMetric[] } => {
  if (!want || want.length === 0) return { ok: true, missing: [] };
  const set = new Set(certified);
  const missing = want.filter((m) => !set.has(m));
  return { ok: missing.length === 0, missing };
};

export interface ApplicabilityOptions {
  /** A request explicitly marked exploratory may return MODEL_PREDICTION instead of being blocked. */
  exploratory?: boolean;
  /** False when no executable model backend applies (returns NARRATIVE). */
  executableModel?: boolean;
}

/**
 * The whole of G5. Verifies certificate health, binding match, certified class/metrics/ranges,
 * workload span, environment class and checked assumptions. Never runs the model.
 */
export function checkApplicability(
  certificate: ValidationCertificate | null,
  currentBindingHash: string,
  request: ApplicabilityRequest,
  opts: ApplicabilityOptions = {},
): ApplicabilityDecision {
  const reasons: string[] = [], violated: string[] = [];
  const exploratory = !!opts.exploratory;
  const executableModel = opts.executableModel !== false;
  const blockedOrExploratory = (): ResultClass | null => (exploratory ? (executableModel ? "MODEL_PREDICTION" : "NARRATIVE") : null);

  if (!certificate) {
    return { verdict: "INSUFFICIENT_EVIDENCE", violatedRanges: [], reasons: ["no validation certificate exists for this twin"], allowedClass: blockedOrExploratory(), blocked: !exploratory };
  }
  if (certificate.state !== "VALID") {
    reasons.push(`certificate is ${certificate.state}${certificate.invalidationReason ? `: ${certificate.invalidationReason}` : ""}`);
    return { verdict: "INSUFFICIENT_EVIDENCE", violatedRanges: [], reasons, certificateId: certificate.certificateId, allowedClass: blockedOrExploratory(), blocked: !exploratory };
  }
  if (certificate.bindingHash !== currentBindingHash) {
    reasons.push("the certificate's binding no longer matches the current twin (model, workload, environment, oracle or source changed)");
    return { verdict: "INSUFFICIENT_EVIDENCE", violatedRanges: [], reasons, certificateId: certificate.certificateId, allowedClass: blockedOrExploratory(), blocked: !exploratory };
  }
  const scope = certificate.scope;
  // Material unresolved stations restrict the domain.
  if (scope.materialUnresolved.length) {
    reasons.push(`the structure has ${scope.materialUnresolved.length} material unresolved station(s): ${scope.materialUnresolved.slice(0, 3).join(", ")}`);
    return { verdict: "INSUFFICIENT_EVIDENCE", violatedRanges: [], reasons, certificateId: certificate.certificateId, allowedClass: blockedOrExploratory(), blocked: !exploratory };
  }
  if (request.intervention.class !== scope.interventionClass) {
    reasons.push(`intervention class ${request.intervention.class} is not certified (certified: ${scope.interventionClass})`);
  }
  const metricCheck = metricIn(scope.metrics, request.metrics);
  if (!metricCheck.ok) reasons.push(`uncertified metric(s): ${metricCheck.missing.join(", ")}`);
  for (const [parameter, value] of Object.entries(request.intervention.parameters)) {
    const range = scope.ranges.find((r) => r.parameter === parameter);
    if (!range) { violated.push(`${parameter}=${value} (not a certified parameter)`); continue; }
    if (value < range.min || value > range.max) violated.push(`${parameter}=${value} (validated ${range.min}–${range.max})`);
  }
  // Every certified parameter must be supplied so the request is unambiguous within the domain.
  for (const range of scope.ranges) if (!(range.parameter in request.intervention.parameters)) reasons.push(`parameter ${range.parameter} is not specified (certified range ${range.min}–${range.max})`);
  const mult = request.workload.rateMultiplier;
  if (mult < scope.workload.rateMultiplier.min || mult > scope.workload.rateMultiplier.max) violated.push(`load ${mult}× (validated ${scope.workload.rateMultiplier.min}–${scope.workload.rateMultiplier.max}×)`);
  if (request.workload.arrivalModel !== scope.workload.arrivalModel) reasons.push(`arrival model ${request.workload.arrivalModel} differs from the validated ${scope.workload.arrivalModel}`);
  if (request.workload.mixTolerance !== undefined && request.workload.mixTolerance > scope.workload.mixTolerance) violated.push(`operation-mix tolerance ${request.workload.mixTolerance} exceeds validated ${scope.workload.mixTolerance}`);
  if (request.environmentHash !== scope.environmentClass.environmentHash) {
    if (scope.environmentClass.allowedDifferences.includes(request.environmentHash)) reasons.push("environment differs but is within the class's allowed differences; prediction is allowed with the stated difference");
    else violated.push(`environment ${request.environmentHash.slice(0, 12)} is not the validated class ${scope.environmentClass.environmentHash.slice(0, 12)}`);
  }
  for (const ask of request.assumptions ?? []) {
    const checked = scope.assumptionsChecked.find((a) => a.id === ask.id);
    if (!checked) { violated.push(`assumption ${ask.id} was not checked`); continue; }
    if (ask.value < checked.checkedRange[0] || ask.value > checked.checkedRange[1]) violated.push(`assumption ${ask.id}=${ask.value} outside checked range ${checked.checkedRange[0]}–${checked.checkedRange[1]}`);
  }
  if (violated.length) {
    return { verdict: "OUT_OF_DOMAIN", violatedRanges: violated, reasons: reasons.concat(violated), certificateId: certificate.certificateId, allowedClass: blockedOrExploratory(), blocked: !exploratory };
  }
  if (reasons.length) {
    // Reasons that are not range violations still mean the request is not the certified one.
    return { verdict: "INSUFFICIENT_EVIDENCE", violatedRanges: [], reasons, certificateId: certificate.certificateId, allowedClass: blockedOrExploratory(), blocked: !exploratory };
  }
  return { verdict: "IN_DOMAIN", violatedRanges: [], reasons: [], certificateId: certificate.certificateId, allowedClass: "VALIDATED_MODEL_PREDICTION", blocked: false };
}

/**
 * The single derivation of the allowed class from certificate state, binding match and domain verdict.
 * Used by the service when it sets the class and by C16 when it re-derives it at display/export;
 * a stored class that disagrees is rejected (F10-A6).
 */
export function deriveAllowedClass(input: {
  certificateState: ValidationCertificate["state"] | null;
  bindingMatches: boolean;
  verdict: ApplicabilityDecision["verdict"];
  exploratory: boolean;
  executableModel: boolean;
}): ResultClass | null {
  if (input.certificateState === "VALID" && input.bindingMatches && input.verdict === "IN_DOMAIN") return "VALIDATED_MODEL_PREDICTION";
  if (!input.exploratory) return null;
  return input.executableModel ? "MODEL_PREDICTION" : "NARRATIVE";
}

export function verifyResultClass(claimed: ResultClass, derived: ResultClass | null): { ok: boolean; reason?: string } {
  if (claimed === derived) return { ok: true };
  if (derived === null) return { ok: false, reason: `result class ${claimed} is unsupported: the request is outside the validated domain and was not marked exploratory` };
  return { ok: false, reason: `result class ${claimed} is not allowed here (allowed: ${derived})` };
}

// ------------------------------------------------------------------ comparison policy (F10-A4)
export interface ComparisonPolicyLike {
  id: string; primaryMetric: string; direction: "LOWER" | "HIGHER";
  minimumPairs: number; minimumImprovement: number; confidenceLevel: number;
  regressionLimits: Record<string, { direction: "LOWER" | "HIGHER"; maximumRelativeRegression: number }>;
}

/** A policy must include errorRate and completedWorkRate so failures cannot be dropped silently. */
export function validateComparisonPolicy(policy: ComparisonPolicyLike): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  for (const required of ["errorRate", "completedWorkRate"]) {
    if (!(required in policy.regressionLimits)) errors.push(`regressionLimits must include ${required}`);
  }
  if (!Number.isSafeInteger(policy.minimumPairs) || policy.minimumPairs < 3) errors.push("minimumPairs must be at least 3");
  if (!(policy.minimumImprovement > 0) || !Number.isFinite(policy.minimumImprovement)) errors.push("minimumImprovement must be positive and finite");
  if (!(policy.confidenceLevel > 0 && policy.confidenceLevel < 1)) errors.push("confidenceLevel must be between 0 and 1");
  for (const [metric, gate] of Object.entries(policy.regressionLimits)) if (!Number.isFinite(gate.maximumRelativeRegression) || gate.maximumRelativeRegression < 0) errors.push(`regression limit for ${metric} must be non-negative and finite`);
  return errors.length ? { ok: false, errors } : { ok: true };
}

// ------------------------------------------------------------------ certificate gates (F10-A2, A5)
export const REQUIRED_GATES_FOR_CERTIFICATE: GateResult["gate"][] = ["G0", "G1", "G2", "G3", "G4", "G6", "G7", "G8"];

export function allCertificateGatesPass(gates: GateResult[]): boolean {
  const byGate = new Map(gates.map((g) => [g.gate, g]));
  return REQUIRED_GATES_FOR_CERTIFICATE.every((gate) => byGate.get(gate)?.passed === true);
}

/** Predeclared acceptance for the G4 holdout protocol. */
export interface HoldoutCriterion {
  minPoints: number;
  /** Direction must agree at every point whose measured effect exceeds the noise floor. */
  noiseFloor: number;
  maxMagnitudeError: number;
  minIntervalCoverage: number;
  nominalCoverage: number;
}
export const DEFAULT_HOLDOUT_CRITERION: HoldoutCriterion = { minPoints: 3, noiseFloor: 0.02, maxMagnitudeError: 0.15, minIntervalCoverage: 0.8, nominalCoverage: 0.9 };

export interface HoldoutReport {
  passes: boolean;
  failures: string[];
  coverage: { nominal: number; observed: number; trials: number };
}

/** Evaluates held-out interventions against the predeclared criterion (F10-A2). */
export function evaluateHoldout(heldOut: HeldOutIntervention[], criterion: HoldoutCriterion = DEFAULT_HOLDOUT_CRITERION): HoldoutReport {
  const failures: string[] = [];
  if (heldOut.length < criterion.minPoints) failures.push(`only ${heldOut.length} held-out point(s); at least ${criterion.minPoints} are required`);
  let covered = 0;
  for (const point of heldOut) {
    const predictedMid = (point.predictedDelta.upper + point.predictedDelta.lower) / 2;
    const measuredMid = (point.measuredDelta.upper + point.measuredDelta.lower) / 2;
    if (Math.abs(measuredMid) > criterion.noiseFloor && !point.directionAgrees) failures.push(`${point.parameter}=${point.value}: direction disagrees with the measured change`);
    // Magnitude error is relative to the larger effect, with the noise floor as a denominator so a near-zero effect is stable.
    const scale = Math.max(Math.abs(measuredMid), Math.abs(predictedMid), criterion.noiseFloor);
    if (Math.abs(predictedMid - measuredMid) / scale > criterion.maxMagnitudeError) failures.push(`${point.parameter}=${point.value}: magnitude error exceeds ${criterion.maxMagnitudeError}`);
    if (!point.withinTolerance) failures.push(`${point.parameter}=${point.value}: measured change outside the prediction interval`);
    const insideInterval = measuredMid >= point.predictedDelta.lower && measuredMid <= point.predictedDelta.upper;
    if (insideInterval) covered++;
  }
  const observed = heldOut.length ? covered / heldOut.length : 0;
  if (heldOut.length && observed < criterion.minIntervalCoverage) failures.push(`interval coverage ${(observed * 100).toFixed(0)}% below required ${(criterion.minIntervalCoverage * 100).toFixed(0)}%`);
  return { passes: failures.length === 0, failures, coverage: { nominal: criterion.nominalCoverage, observed, trials: heldOut.length } };
}

/** A certificate may be issued only from passing required gates and a passing holdout. */
export function canIssueCertificate(gates: GateResult[], holdout: HoldoutReport): { ok: boolean; reason?: string } {
  if (!allCertificateGatesPass(gates)) {
    const failed = gates.filter((g) => REQUIRED_GATES_FOR_CERTIFICATE.includes(g.gate) && !g.passed).map((g) => g.gate);
    return { ok: false, reason: `required gate(s) failed: ${failed.join(", ") || "missing"}` };
  }
  if (!holdout.passes) return { ok: false, reason: `holdout criteria not met: ${holdout.failures.slice(0, 3).join("; ")}` };
  return { ok: true };
}

// ------------------------------------------------------------------ demand/wait double counting (F10-D3)
export interface StationDemandModel { stationId: string; serviceTimeIncludesWait: boolean; hasModelledQueue: boolean }
/** A station whose sampled service time already includes queue wait must not also have a modelled queue. */
export function findDemandWaitDoubleCounting(stations: StationDemandModel[]): string[] {
  return stations.filter((s) => s.serviceTimeIncludesWait && s.hasModelledQueue).map((s) => s.stationId);
}

// ------------------------------------------------------------------ structure → material unresolved (F10 §7.1)
/** Unresolved items lying on the observed critical path are MATERIAL and restrict the domain. */
export function materialUnresolvedStations(structure: TwinStructure, criticalPathStationIds: string[]): string[] {
  const onPath = new Set(criticalPathStationIds);
  return structure.unresolved.filter((u) => u.material || onPath.has(u.id)).map((u) => u.id);
}

// ------------------------------------------------------------------ certificate/scope validation
export function validateScope(scope: ValidationScope): SpecProblem[] {
  const problems: SpecProblem[] = [];
  if (!scope.metrics.length) problems.push({ path: "metrics", problem: "a certificate must certify at least one metric" });
  if (!scope.ranges.length) problems.push({ path: "ranges", problem: "a certificate must state the tested range of each parameter" });
  for (const r of scope.ranges) {
    if (!(r.min <= r.max)) problems.push({ path: `ranges.${r.parameter}`, problem: "min must not exceed max" });
  }
  if (!(scope.workload.rateMultiplier.min <= scope.workload.rateMultiplier.max)) problems.push({ path: "workload.rateMultiplier", problem: "min must not exceed max" });
  if (scope.workload.mixTolerance < 0) problems.push({ path: "workload.mixTolerance", problem: "tolerance must be non-negative" });
  return problems;
}

/** True when a certificate should be marked STALE because its binding no longer matches the current twin. */
export function certificateBindingMatches(certificate: ValidationCertificate, currentBindingHash: string): boolean {
  return certificate.state === "VALID" && certificate.bindingHash === currentBindingHash;
}
