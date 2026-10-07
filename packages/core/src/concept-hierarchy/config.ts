// Concept-hierarchy configuration (plan §0.4). Every threshold the hierarchy uses is declared here
// exactly once, and every one of them is explicitly UNCALIBRATED: no number below has been tuned
// against labelled ground truth. Reading a threshold always goes through conceptConfig(), so a future
// calibration pass changes values in one place and the PARAMETER_STATUS register reports what is known.
// Tests may override values through setConceptConfigForTest; production code may not.

export interface Calibrated<T> {
  value: T;
  /** "uncalibrated" until the parameter has been tuned and evaluated against labelled data. */
  status: "uncalibrated" | "calibrated";
  /** What the number currently guards, and what calibrating it would need. */
  note: string;
}

export interface ConceptConfig {
  /** Changed-file ratio above which the whole revision is rebuilt instead of patching phase by phase. */
  fullRebuildThreshold: Calibrated<number>;
  /** T_stable: member Jaccard similarity above which a kept concept keeps its name. */
  jaccardStable: Calibrated<number>;
  /** T_histogram: feature-histogram shift below which a kept concept keeps its name even though members moved. */
  histogramShift: Calibrated<number>;
  /** Maximum concepts offered to the model in one naming request. */
  namingBatchSize: Calibrated<number>;
  /** Statements per function the PDG builder walks before it truncates (bounds the worst case). */
  pdgMaxStatements: Calibrated<number>;
  /** Functions per revision the PDG builder processes; beyond it the function gets no graph (reported as a gap). */
  pdgMaxFunctions: Calibrated<number>;
  /** Files the architecture builder parses for export surfaces; beyond it surfaces are reported missing. */
  exportSurfaceMaxFiles: Calibrated<number>;
  /** Bump to invalidate every cached name at once (prompt or model changed). */
  namingPromptVersion: Calibrated<number>;
  /** Minimum members a composed concept (e.g. transfer-form) needs before it is emitted. */
  composedMinMembers: Calibrated<number>;
  /** Tier-2 semantic topics (NMF): off until a deterministic implementation is calibrated. */
  enableNmf: Calibrated<boolean>;
  /** Tier-3 formal concepts (FCA): off until an implementation exists. */
  enableFca: Calibrated<boolean>;
}

export const CONCEPT_CONFIG: ConceptConfig = {
  fullRebuildThreshold: { value: 0.4, status: "uncalibrated", note: "ratio of changed files that forces a full rebuild; 0.4 chosen by intuition only" },
  jaccardStable: { value: 0.7, status: "uncalibrated", note: "T_stable: above this member overlap a kept concept keeps its name" },
  histogramShift: { value: 0.2, status: "uncalibrated", note: "T_histogram: below this normalised histogram shift a kept name stands" },
  namingBatchSize: { value: 40, status: "uncalibrated", note: "concepts per naming request; bounded by schema max(40)" },
  pdgMaxStatements: { value: 400, status: "uncalibrated", note: "statements walked per function before truncation" },
  pdgMaxFunctions: { value: 5000, status: "uncalibrated", note: "functions graphed per revision before the rest are reported as gaps" },
  exportSurfaceMaxFiles: { value: 2000, status: "uncalibrated", note: "modules parsed for export surfaces per revision" },
  namingPromptVersion: { value: 1, status: "calibrated", note: "not a tuned threshold: a cache-version counter, bumped by hand when the prompt changes" },
  composedMinMembers: { value: 2, status: "uncalibrated", note: "members needed before a composed (e.g. transfer-form) concept is emitted" },
  enableNmf: { value: false, status: "uncalibrated", note: "tier-2 NMF topics: the stub throws; nothing may enable this before calibration" },
  enableFca: { value: false, status: "uncalibrated", note: "tier-3 FCA concepts: the stub throws; nothing may enable this before calibration" },
};

/** The register the review checklist (plan §8) reads: what is calibrated, and what is not. */
export function parameterStatus(): { parameter: string; status: string; value: unknown }[] {
  return Object.entries(CONCEPT_CONFIG).map(([parameter, c]) => ({ parameter, status: c.status, value: c.value }));
}

let override: ConceptConfig | null = null;

/** Every threshold read goes through here; nothing reads CONCEPT_CONFIG's fields directly. */
export function conceptConfig(): ConceptConfig {
  return override ?? CONCEPT_CONFIG;
}

/** Test seam. Pass null to reset. Never call from production code. */
export function setConceptConfigForTest(patch: Partial<ConceptConfig> | null) {
  if (!patch) { override = null; return; }
  const base: ConceptConfig = { ...CONCEPT_CONFIG, ...(override ?? {}) };
  override = { ...base, ...patch };
}
