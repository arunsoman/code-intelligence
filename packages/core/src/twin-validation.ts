// F10/WP-08 — validation gates, the G4 holdout protocol with locked predictions, and certificate issuance.
// A certificate certifies a metric, an intervention class and a range actually tested, and nothing else.
// Predictions for held-out points are written to an immutable, timestamped, hashed record before the
// held-out run; a prediction recorded after its measurement is refused (F10-D5).
import { createHash } from "node:crypto";
import type {
  CertifiedMetric, GateResult, HeldOutIntervention, Interval, InterventionClass, ModelArtifact, TwinModelSpec,
  ValidationCertificate, ValidationScope,
} from "@cie/schema";
import { allCertificateGatesPass, canIssueCertificate, computeBindingHash, evaluateHoldout, REQUIRED_GATES_FOR_CERTIFICATE, type HoldoutCriterion, type HoldoutReport } from "./twin.ts";

const h = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");

export interface GateInput {
  specConcrete: { ok: boolean; detail: string };
  identityComplete: { ok: boolean; detail: string };
  baselineReproduction: { passed: boolean; detail: string; evidenceIds: string[] };
  holdout: { passed: boolean; detail: string; evidenceIds: string[] };
  interventionValidation: { passed: boolean; detail: string; evidenceIds: string[] };
  applicability: { passed: boolean; detail: string; evidenceIds: string[] };
  correctness: { passed: boolean; detail: string; evidenceIds: string[] };
  precision: { passed: boolean; detail: string; evidenceIds: string[] };
  authorised: { passed: boolean; detail: string; evidenceIds: string[] };
  materialUnresolved: string[];
}
/** Build the G0–G8 gate vector. G5 is the applicability gate and is recorded here, not re-derived later. */
export function buildGates(input: GateInput): GateResult[] {
  return [
    { gate: "G0", passed: input.specConcrete.ok, detail: input.specConcrete.detail, evidenceIds: [] },
    { gate: "G1", passed: input.identityComplete.ok, detail: input.identityComplete.detail, evidenceIds: [] },
    { gate: "G2", passed: input.baselineReproduction.passed, detail: input.baselineReproduction.detail, evidenceIds: input.baselineReproduction.evidenceIds },
    { gate: "G3", passed: input.holdout.passed, detail: input.holdout.detail, evidenceIds: input.holdout.evidenceIds },
    { gate: "G4", passed: input.interventionValidation.passed, detail: input.interventionValidation.detail, evidenceIds: input.interventionValidation.evidenceIds },
    { gate: "G5", passed: input.applicability.passed, detail: input.applicability.detail, evidenceIds: input.applicability.evidenceIds },
    { gate: "G6", passed: input.correctness.passed, detail: input.correctness.detail, evidenceIds: input.correctness.evidenceIds },
    { gate: "G7", passed: input.precision.passed, detail: input.precision.detail, evidenceIds: input.precision.evidenceIds },
    { gate: "G8", passed: input.authorised.passed, detail: input.authorised.detail, evidenceIds: input.authorised.evidenceIds },
  ];
}

// ------------------------------------------------------------------ locked predictions (F10-D5)
export interface LockedPrediction {
  id: string; parameter: string; value: number; loadMultiplier: number;
  interval: Interval; baselineValue: number; predictedValue: number;
  recordedAtMs: number; hash: string;
}
export interface PredictionRecordStore { put(record: LockedPrediction): void; get(id: string): LockedPrediction | undefined; all(): LockedPrediction[] }
export function createPredictionStore(): PredictionRecordStore {
  const map = new Map<string, LockedPrediction>();
  return { put: (r) => { map.set(r.id, r); }, get: (id) => map.get(id), all: () => [...map.values()] };
}

/** Lock a prediction before its held-out measurement. The record is immutable and hashed as written. */
export function lockPrediction(input: { id: string; parameter: string; value: number; loadMultiplier: number; interval: Interval; baselineValue: number; predictedValue: number; recordedAtMs: number }): LockedPrediction {
  const record: LockedPrediction = { ...input, hash: "" };
  record.hash = h({ id: input.id, parameter: input.parameter, value: input.value, loadMultiplier: input.loadMultiplier, interval: input.interval, baselineValue: input.baselineValue, predictedValue: input.predictedValue, recordedAtMs: input.recordedAtMs });
  return record;
}

/** A held-out result is only trustworthy if its prediction was locked strictly before the measurement. */
export function predictionPrecedesMeasurement(prediction: LockedPrediction, measuredAtMs: number): { ok: boolean; reason?: string } {
  if (prediction.recordedAtMs >= measuredAtMs) return { ok: false, reason: `prediction for ${prediction.parameter}=${prediction.value} was recorded at ${prediction.recordedAtMs}, not before the measurement at ${measuredAtMs}` };
  return { ok: true };
}

/** Compute the relative change interval for a metric, given baseline and candidate intervals. */
export function deltaInterval(baseline: Interval, candidate: Interval, direction: "LOWER" | "HIGHER" = "LOWER"): Interval {
  const base = (baseline.lower + baseline.upper) / 2;
  const lo = (candidate.lower - baseline.upper) / Math.max(1e-9, base);
  const hi = (candidate.upper - baseline.lower) / Math.max(1e-9, base);
  const lower = direction === "LOWER" ? -hi : lo;
  const upper = direction === "LOWER" ? -lo : hi;
  return { lower: Math.min(lower, upper), upper: Math.max(lower, upper), method: "relative-change", confidenceLevel: 0.9 };
}

export interface HeldOutPoint {
  parameter: string; value: number; loadMultiplier: number;
  prediction: LockedPrediction;
  measuredDelta: Interval;
  measuredAtMs: number;
}
/** Turn locked predictions and measurements into HeldOutIntervention rows, refusing leakage. */
export function assembleHeldOut(points: HeldOutPoint[]): { interventions: HeldOutIntervention[]; leakage: string[] } {
  const interventions: HeldOutIntervention[] = [];
  const leakage: string[] = [];
  for (const p of points) {
    const precedes = predictionPrecedesMeasurement(p.prediction, p.measuredAtMs);
    if (!precedes.ok) { leakage.push(precedes.reason!); continue; }
    const predictedMid = (p.prediction.interval.lower + p.prediction.interval.upper) / 2;
    const measuredMid = (p.measuredDelta.lower + p.measuredDelta.upper) / 2;
    const directionAgrees = Math.sign(predictedMid) === Math.sign(measuredMid) || Math.abs(measuredMid) < 1e-9;
    const withinTolerance = measuredMid >= p.prediction.interval.lower && measuredMid <= p.prediction.interval.upper;
    interventions.push({
      parameter: p.parameter, value: p.value, loadMultiplier: p.loadMultiplier,
      predictedDelta: p.prediction.interval, measuredDelta: p.measuredDelta,
      directionAgrees, withinTolerance,
      predictionRecordHash: p.prediction.hash, predictionRecordedAt: new Date(p.prediction.recordedAtMs).toISOString(),
    });
  }
  return { interventions, leakage };
}

// ------------------------------------------------------------------ certificate issuance
export interface CertificateInput {
  twinId: string; twinVersion: number; modelId: string;
  scope: ValidationScope;
  gates: GateResult[];
  heldOut: HeldOutIntervention[];
  holdoutCriterion?: HoldoutCriterion;
  bindingParts: { twinHash: string; modelSpecHash: string; fitHash: string; workloadHashes: string[]; environmentHash: string; oracleHash: string; sourceHash: string; buildHash: string; policyIds: string[] };
  issuedAtMs: number; issuedBy: string;
  /** The material assumptions actually checked, with the range each was checked over. */
  assumptionsChecked: ValidationScope["assumptionsChecked"];
}
export interface CertificateOutcome { certificate: ValidationCertificate | null; report: { gates: GateResult[]; holdout: HoldoutReport; bindingHash: string }; refusal?: string }

/** Issue a certificate only when the required gates and the holdout criteria pass. */
export function issueCertificate(input: CertificateInput): CertificateOutcome {
  const gates = input.gates;
  const holdout = evaluateHoldout(input.heldOut, input.holdoutCriterion);
  const scope: ValidationScope = { ...input.scope, assumptionsChecked: input.assumptionsChecked };
  const bindingHash = computeBindingHash(input.bindingParts);
  const report = { gates, holdout, bindingHash };
  if (input.scope.materialUnresolved.length) return { certificate: null, report, refusal: `material unresolved stations restrict the domain: ${input.scope.materialUnresolved.join(", ")}` };
  const issuance = canIssueCertificate(gates, holdout);
  if (!issuance.ok) return { certificate: null, report, refusal: issuance.reason };
  const certificate: ValidationCertificate = {
    certificateId: `vc-${h({ twinId: input.twinId, modelId: input.modelId, bindingHash }).slice(0, 16)}`,
    twinId: input.twinId, twinVersion: input.twinVersion, modelId: input.modelId,
    scope, bindingHash,
    validation: { gates, heldOutInterventions: input.heldOut, intervalCoverage: holdout.coverage },
    state: "VALID",
    issuedAt: new Date(input.issuedAtMs).toISOString(), issuedBy: input.issuedBy,
  };
  return { certificate, report };
}

/** Mark a certificate stale when any bound input changes, or on an explicit invalidation. */
export function invalidateCertificate(certificate: ValidationCertificate, reason: string, atMs: number, by: string): ValidationCertificate {
  return { ...certificate, state: "STALE", invalidatedBy: by, invalidatedAt: new Date(atMs).toISOString(), invalidationReason: reason };
}

/** The certificate's binding must match the current twin hash for it to be usable. */
export function certificateUsable(certificate: ValidationCertificate, currentBindingHash: string): boolean {
  return certificate.state === "VALID" && certificate.bindingHash === currentBindingHash;
}

export function metricDirection(metric: CertifiedMetric): "LOWER" | "HIGHER" {
  return metric === "throughput" || metric === "utilisation" ? "HIGHER" : "LOWER";
}

export function modelSpecHash(spec: TwinModelSpec): string { return h(spec); }
export function modelFitHash(model: ModelArtifact): string { return h({ parameters: model.parameters, chosenStructure: model.chosenStructure, modelSpecHash: model.modelSpecHash }); }
