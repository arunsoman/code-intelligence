// Concept hierarchy (dual-axis): public surface of the module. See plan §1 for the file map.
export { CONCEPT_CONFIG, conceptConfig, parameterStatus, setConceptConfigForTest, type Calibrated, type ConceptConfig } from "./config.ts";
export * from "./types.ts";
export { BODY_KINDS, buildAllPdgs, buildPdgForFunction, clearPdgSourceCache, type BuildPdgsResult } from "./pdg.ts";
export { MOTIF_PATTERNS, matchMotifs, type MotifPattern } from "./motifs.ts";
export { canonicalJson, canonicalMotifHash, histogramShift, type CanonicalForm } from "./canonicalize.ts";
export { buildSemanticConcepts, type SemanticBuildResult } from "./semantic-concepts.ts";
export { LANGUAGE_SOUNDNESS_TIER, buildInvariants } from "./invariants.ts";
export { buildArchitecturalTree, exportSurfaceOf, packageOf, type ArchBuildResult } from "./architecture.ts";
export { linkAxes, type CrossAxisResult } from "./cross-axis.ts";
export { shouldRename, type AnchorDecision, type AnchorInput } from "./fingerprint.ts";
export { nameConcepts, type NamingAdapter, type NamingResult } from "./naming.ts";
export { fcaConcepts, nmfTopics, type FcaConcept, type NmfTopic } from "./tier2.ts";
export { buildHierarchy, persistHierarchy, type HierarchyBuildResult, type HierarchyProgress, type VersionSnapshot } from "./incremental.ts";
