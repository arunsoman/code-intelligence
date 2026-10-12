// The bridge into the claim system: REA's confidence triad, mapped onto the repository's claim
// classes and display modes. The five gates (GROUNDING → CONSISTENCY → ADVERSARIAL → CALIBRATION →
// DISPLAY) still run upstream; this mapping only decides how a record that has already passed them
// may present itself. One house rule is re-stated here because it cannot be restated often enough:
// a model-authored claim never displays as FACT.
import type { DisplayMode } from "@cie/schema";
import type { ReConfidence } from "./schema.ts";

export type ReClaimClass = "FACT" | "INFERENCE" | "HYPOTHESIS";

/** observed→FACT-eligible, derived→INFERENCE, inferred→HYPOTHESIS. */
export const CONFIDENCE_TO_CLAIM_CLASS: Record<ReConfidence, ReClaimClass> = {
  observed: "FACT",
  derived: "INFERENCE",
  inferred: "HYPOTHESIS",
};

export function claimClassOf(record: { confidence: ReConfidence }): ReClaimClass {
  return CONFIDENCE_TO_CLAIM_CLASS[record.confidence];
}

export function displayModeFor(record: { confidence: ReConfidence }, opts: { modelAuthored?: boolean } = {}): DisplayMode {
  const claimClass = claimClassOf(record);
  // The C16 rule: model-authored claims never display as FACT. An "observed" confidence from a model
  // is still the model's word about an observation, so it presents as INFERENCE.
  if (opts.modelAuthored && claimClass === "FACT") return "INFERENCE";
  return claimClass;
}
