// C22 deterministic reducers (design §6): evidence → hypothesis state, correlation groups, negative-evidence coverage,
// priority. Pure functions with no clock and no I/O, so the same inputs always give the same answer and a replay matches.
import { createHash } from "node:crypto";
import type { CoverageCertificate, EvidenceAssessment, EvidenceRelation, EvaluationReason, HypothesisEvaluation, HypothesisRecord, InvestigationScope, Observation, ObservationInput, OutcomeTag, Prediction, PriorityBreakdown } from "./types.ts";

export const hash = (...p: unknown[]) => createHash("sha256").update(JSON.stringify(p)).digest("hex").slice(0, 16);
export const RULE_VERSION = 1;

/**
 * Ten summaries of one trace are one piece of evidence. Lineage (trace id), then content hash, then the source event
 * identify a group; only the number of distinct groups counts as independent confirmation.
 */
export function correlationGroup(i: Pick<ObservationInput, "traceLineage" | "contentHash" | "sourceEventId">): string {
  return "grp:" + hash(i.traceLineage ?? i.contentHash ?? i.sourceEventId);
}

export interface Coverage { ok: boolean; why: string }
/**
 * Absence is a contradiction only if the collector attests that it looked everywhere the prediction could show up:
 * exhaustive for this predicate, the same revision, deployment and window, with no sampling. Anything less is "not observed".
 */
export function negativeEvidenceCoverage(o: Pick<Observation, "revision" | "deploymentId" | "window" | "quality">, cert: CoverageCertificate | null | undefined, scope: InvestigationScope): Coverage {
  if (!cert) return { ok: false, why: "no coverage certificate: absence is not evidence" };
  if (!cert.exhaustiveForPredicate) return { ok: false, why: "the collector did not attest exhaustive coverage of this predicate" };
  if (cert.sampling !== "NONE") return { ok: false, why: `sampling is ${cert.sampling}: a missing record may simply not have been kept` };
  if (cert.revision && cert.revision !== scope.revision) return { ok: false, why: "the certificate is for another revision" };
  if (scope.deploymentIds.length && cert.deploymentId && !scope.deploymentIds.includes(cert.deploymentId)) return { ok: false, why: "the certificate is for another deployment" };
  const w = scope.incidentWindow;
  if (w && cert.window && (cert.window.start > w.start || cert.window.end < w.end)) return { ok: false, why: "the certificate does not cover the whole incident window" };
  if (cert.exclusions.length) return { ok: false, why: `the certificate excludes: ${cert.exclusions.join(", ")}` };
  return { ok: true, why: "exhaustive for this predicate, revision, deployment and window" };
}

export interface RelationDecision { relation: EvidenceRelation; reasons: string[] }
/** How one observation bears on one prediction. Conservative by construction: when in doubt it is INCONCLUSIVE. */
export function assessPrediction(pred: Prediction | undefined, o: Observation, hypothesisId: string, cert: CoverageCertificate | null | undefined, scope: InvestigationScope): RelationDecision {
  if (o.retracted) return { relation: "NEUTRAL", reasons: ["RETRACTED"] };
  if (o.introducedByHypothesisId === hypothesisId) return { relation: "NEUTRAL", reasons: ["SELF_INTRODUCED: evidence a hypothesis introduced cannot confirm it"] };
  if (!pred) return { relation: "NEUTRAL", reasons: ["NO_PREDICTION: nothing this hypothesis predicted"] };
  if (o.revision && o.revision !== scope.revision) return { relation: "INCONCLUSIVE", reasons: ["INCOMPARABLE: another revision, with no verified mapping"] };
  if (scope.deploymentIds.length && o.deploymentId && !scope.deploymentIds.includes(o.deploymentId)) return { relation: "INCONCLUSIVE", reasons: ["INCOMPARABLE: another deployment"] };
  if (o.unknownContext) return { relation: "INCONCLUSIVE", reasons: ["UNKNOWN_CONTEXT: not attributed to code, so no code link is drawn"] };
  const t: OutcomeTag = o.outcome;
  if (t === "UNKNOWN" || t === "ERROR" || t === "NOT_OBSERVED") return { relation: "INCONCLUSIVE", reasons: [`${t}: the check did not settle it`] };
  if (t === "ABSENT_WITH_COVERAGE") {
    const c = negativeEvidenceCoverage(o, cert, scope);
    if (!c.ok) return { relation: "INCONCLUSIVE", reasons: [`NOT_OBSERVED: ${c.why}`] };
    return pred.outcomeIfFalse.includes(t) ? { relation: "CONTRADICTS", reasons: [`ABSENT_WITH_COVERAGE: ${c.why}`] } : pred.outcomeIfTrue.includes(t) ? { relation: "SUPPORTS", reasons: ["ABSENCE_PREDICTED"] } : { relation: "NEUTRAL", reasons: ["OUTCOME_NOT_RELEVANT"] };
  }
  if (pred.outcomeIfTrue.includes(t)) return { relation: "SUPPORTS", reasons: [`${t} was predicted`] };
  if (pred.outcomeIfFalse.includes(t)) return { relation: "CONTRADICTS", reasons: [`${t} contradicts the prediction`] };
  return { relation: "NEUTRAL", reasons: ["OUTCOME_NOT_RELEVANT"] };
}

export interface ReduceInput { h: HypothesisRecord; assessments: EvidenceAssessment[]; stale: boolean; revoked: boolean; humanVerdict: { id: string; verdict: string } | null; calibration: HypothesisEvaluation["calibration"]; rank: PriorityBreakdown; gapIds: string[] }
/** Evidence + assumptions + verdicts → evaluation (design §6 table). Contradictory evidence is kept, never averaged away. */
export function reduceHypothesis(i: ReduceInput): HypothesisEvaluation {
  const live = i.assessments.filter((a) => a.accepted && !a.stale && a.hypothesisVersion === i.h.version);
  const sup = live.filter((a) => a.relation === "SUPPORTS"), con = live.filter((a) => a.relation === "CONTRADICTS");
  const groups = (xs: EvidenceAssessment[]) => new Set(xs.map((a) => a.correlationGroupId)).size;
  const essential = new Set(i.h.predictions.filter((p) => p.essentialForHypothesis).map((p) => p.id));
  const essentialContradicted = con.some((a) => a.predictionId && essential.has(a.predictionId));
  const assumptionsOk = i.h.assumptions.every((a) => a.verification === "EVIDENCED");
  const assumptionBroken = i.h.assumptions.some((a) => a.verification === "CONTRADICTED");
  const reasons: EvaluationReason[] = [];
  let state: HypothesisEvaluation["state"];
  if (sup.length && con.length) { state = "CONTESTED"; reasons.push("MIXED_EVIDENCE"); }
  else if (con.length && essentialContradicted) { state = "REFUTED"; reasons.push("ESSENTIAL_PREDICTION_CONTRADICTED"); }
  else if (con.length) { state = "UNRESOLVED"; reasons.push("MIXED_EVIDENCE"); }
  else if (sup.length) {
    if (assumptionBroken) { state = "REFUTED"; reasons.push("ESSENTIAL_PREDICTION_CONTRADICTED"); }
    else if (!assumptionsOk) { state = "UNRESOLVED"; reasons.push("UNVERIFIED_ASSUMPTION"); }
    else { state = "SUPPORTED"; reasons.push("GROUNDED_SUPPORT"); }
  } else if (i.assessments.some((a) => a.accepted && !a.stale && a.relation === "INCONCLUSIVE")) { state = "UNRESOLVED"; reasons.push("INCOMPLETE_COVERAGE"); }
  else state = "OPEN";
  if (sup.length > groups(sup)) reasons.push("CORRELATED_SOURCES");
  if (i.stale) reasons.push("STALE_SNAPSHOT");
  const verdict = i.humanVerdict;
  if (verdict) reasons.push("HUMAN_VERDICT");
  // A person can confirm what the evidence does not support; both stay visible.
  const disputed = !!verdict && ((verdict.verdict === "CONFIRM" && (state === "REFUTED" || state === "CONTESTED" || state === "UNRESOLVED" || state === "OPEN")) || (verdict.verdict === "REFUTE" && state === "SUPPORTED"));
  return {
    state, freshness: i.revoked ? "ACCESS_RESTRICTED" : i.stale ? "STALE" : "CURRENT",
    supportingAssessmentIds: sup.map((a) => a.id), contradictingAssessmentIds: con.map((a) => a.id),
    independentSupportGroups: groups(sup), independentContradictionGroups: groups(con),
    unresolvedGapIds: i.gapIds, reasonCodes: [...new Set(reasons)], verdictIds: verdict ? [verdict.id] : [], disputed, calibration: i.calibration, rank: i.rank,
  };
}

const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
/**
 * For ordering work, not for probability: 0.30 relevance + 0.25 impact + 0.25 discriminability + 0.20 evidence quality.
 * A refuted or stale hypothesis is filtered out of scheduling by policy; strong relevance cannot buy it back.
 */
export function priority(f: { relevance: number; impact: number; discriminability: number; evidenceQuality: number }, state: HypothesisEvaluation["state"], freshness: HypothesisEvaluation["freshness"], pinned: boolean): PriorityBreakdown {
  const [relevance, impact, discriminability, evidenceQuality] = [f.relevance, f.impact, f.discriminability, f.evidenceQuality].map(clamp);
  const raw = 0.3 * relevance + 0.25 * impact + 0.25 * discriminability + 0.2 * evidenceQuality;
  const filtered = state === "REFUTED" || freshness !== "CURRENT";
  const reasons = [`relevance ${relevance.toFixed(2)} × 0.30`, `impact ${impact.toFixed(2)} × 0.25`, `discriminability ${discriminability.toFixed(2)} × 0.25`, `evidence quality ${evidenceQuality.toFixed(2)} × 0.20`];
  if (filtered) reasons.push(`not scheduled: ${state === "REFUTED" ? "refuted" : freshness.toLowerCase().replace("_", " ")}`);
  if (pinned) reasons.push("pinned by you: shown first; truth status unchanged");
  return { investigationPriority: filtered ? 0 : clamp(raw) + (pinned ? 1 : 0), impact, relevance, discriminability, evidenceQuality, reasons };
}
