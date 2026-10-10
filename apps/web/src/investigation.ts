/**
 * Web helpers for Living Investigation MVP.
 */
import type { EvidenceAssessment, HypothesisRecord, Observation } from "../../../packages/core/src/c22/types.ts";
import type { EpistemicGrade, HypothesisCard, LivingCaseFile, NextCheckCard, ViewHint } from "../../../packages/core/src/living/living-investigation.ts";
import {
  GRADE_HINT,
  GRADE_LABEL,
  buildCaseFile,
  completionHonestyLine,
  demoAssessCompletion,
  demoCaseFile,
  demoRunCheck,
  demoSteer,
  openLivingInvestigationCommand,
  proposeHypothesisCommand,
  requestCompletionCommand,
  retireHypothesisCommand,
  runNextCheckCommand,
  steerCommand,
} from "../../../packages/core/src/living/living-investigation.ts";

export {
  GRADE_HINT,
  GRADE_LABEL,
  buildCaseFile,
  completionHonestyLine,
  demoAssessCompletion,
  demoCaseFile,
  demoRunCheck,
  demoSteer,
  openLivingInvestigationCommand,
  proposeHypothesisCommand,
  requestCompletionCommand,
  retireHypothesisCommand,
  runNextCheckCommand,
  steerCommand,
};
export type { EpistemicGrade, HypothesisCard, LivingCaseFile, NextCheckCard, ViewHint };

type ComparedHypothesis = Pick<HypothesisRecord, "id" | "version"> & { evaluation: Pick<HypothesisRecord["evaluation"], "freshness"> };
type ComparedObservation = Pick<Observation, "id" | "retracted">;

export function comparison(h: ComparedHypothesis, observation: ComparedObservation, assessments: EvidenceAssessment[]) {
  const matches = assessments.filter((a) => a.hypothesisId === h.id && a.hypothesisVersion === h.version && a.observationId === observation.id);
  const current = matches.filter((a) => a.accepted && !a.stale && !observation.retracted && h.evaluation.freshness === "CURRENT");
  const relations = [...new Set(current.map((a) => a.relation))];
  return {
    label: relations.length
      ? relations.map((r) => ({ SUPPORTS: "Supports", CONTRADICTS: "Contradicts", NEUTRAL: "Neutral", INCONCLUSIVE: "Inconclusive" })[r]).join(" / ")
      : observation.retracted
        ? "Retracted"
        : matches.some((a) => a.stale) || h.evaluation.freshness !== "CURRENT"
          ? "Stale"
          : matches.length
            ? "Not accepted"
            : "Not assessed",
    relations,
    reasons: [...new Set(matches.flatMap((a) => a.reasonCodes))],
  };
}

export function discriminates(hypotheses: ComparedHypothesis[], observation: ComparedObservation, assessments: EvidenceAssessment[]) {
  const rows = hypotheses.map((h) => ({ id: h.id, relations: comparison(h, observation, assessments).relations }));
  return rows.some((a) => a.relations.includes("SUPPORTS") && rows.some((b) => b.id !== a.id && b.relations.includes("CONTRADICTS")));
}

export function assessmentCounts(assessments: EvidenceAssessment[]): Map<string, { support: number; contradict: number }> {
  const m = new Map<string, { support: number; contradict: number }>();
  for (const a of assessments) {
    if (!a.accepted || a.stale) continue;
    const cur = m.get(a.hypothesisId) ?? { support: 0, contradict: 0 };
    if (a.relation === "SUPPORTS") cur.support += 1;
    if (a.relation === "CONTRADICTS") cur.contradict += 1;
    m.set(a.hypothesisId, cur);
  }
  return m;
}

export function gradeClass(grade: EpistemicGrade): string {
  switch (grade) {
    case "FACT": return "grade-fact";
    case "INFERENCE": return "grade-inference";
    case "HYPOTHESIS": return "grade-hypothesis";
    case "FOG": return "grade-fog";
    default: return "grade-hidden";
  }
}
