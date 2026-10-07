// Tier-2/3 concept discovery (plan §0.6): NMF over feature histograms and FCA over the
// motif×function incidence context. SIGNATURES ONLY, by decision: the tier-1 path (exact canonical
// hashing plus composition rules) is what ships, and these are stubs that throw when called. They
// exist so the orchestrator's seam and the config switches are already shaped correctly when (and
// only when) real implementations are calibrated — see enableNmf/enableFca in concept-config, both
// false by default, and the review checklist: nothing here may run uninvited.
export interface NmfTopic {
  /** Component weights over feature names. */
  components: Record<string, number>;
  /** Entity ids assigned to this topic. */
  members: string[];
}

export interface FcaConcept {
  /** Entity ids sharing the intent. */
  extent: string[];
  /** Motif/feature names shared by the extent. */
  intent: string[];
}

/**
 * Tier-2: factor a feature-histogram matrix into `rank` topics. NOT IMPLEMENTED: always throws.
 * An implementation must be deterministic for a given seed, bounded in iterations, and evaluated
 * against labelled data before `enableNmf` is turned on.
 */
export function nmfTopics(_features: Record<string, number>[], _rank: number, _seed: number): NmfTopic[] {
  throw new Error("nmfTopics is a tier-2 stub: disabled by default and not implemented");
}

/**
 * Tier-3: enumerate the formal concepts of a motif×function incidence (extent/intent pairs).
 * NOT IMPLEMENTED: always throws. `enableFca` stays false until an implementation exists.
 */
export function fcaConcepts(_incidence: Record<string, string[]>): FcaConcept[] {
  throw new Error("fcaConcepts is a tier-3 stub: disabled by default and not implemented");
}
