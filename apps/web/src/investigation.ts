import type { EvidenceAssessment, HypothesisRecord, Observation } from "../../../packages/core/src/c22/types.ts";
type ComparedHypothesis = Pick<HypothesisRecord, "id" | "version"> & { evaluation: Pick<HypothesisRecord["evaluation"], "freshness"> };
type ComparedObservation = Pick<Observation, "id" | "retracted">;

/** A missing or rejected assessment cannot be presented as contradiction. */
export function comparison(h: ComparedHypothesis, observation: ComparedObservation, assessments: EvidenceAssessment[]) {
  const matches = assessments.filter((a) => a.hypothesisId === h.id && a.hypothesisVersion === h.version && a.observationId === observation.id);
  const current = matches.filter((a) => a.accepted && !a.stale && !observation.retracted && h.evaluation.freshness === "CURRENT");
  const relations = [...new Set(current.map((a) => a.relation))];
  return {
    label: relations.length ? relations.map((r) => ({ SUPPORTS: "Supports", CONTRADICTS: "Contradicts", NEUTRAL: "Neutral", INCONCLUSIVE: "Inconclusive" })[r]).join(" / ")
      : observation.retracted ? "Retracted" : matches.some((a) => a.stale) || h.evaluation.freshness !== "CURRENT" ? "Stale" : matches.length ? "Not accepted" : "Not assessed",
    relations,
    reasons: [...new Set(matches.flatMap((a) => a.reasonCodes))],
  };
}

export function discriminates(hypotheses: ComparedHypothesis[], observation: ComparedObservation, assessments: EvidenceAssessment[]) {
  const rows = hypotheses.map((h) => ({ id: h.id, relations: comparison(h, observation, assessments).relations }));
  return rows.some((a) => a.relations.includes("SUPPORTS") && rows.some((b) => b.id !== a.id && b.relations.includes("CONTRADICTS")));
}
