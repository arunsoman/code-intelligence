/** Revision-bound investigation diagnostics. Supported never means exhaustive runtime coverage. */
export interface InvestigationBudget {
  maxEntities: number; maxDepth: number; maxSourceFiles: number; maxSourceBytes: number; maxMs: number;
}
export interface InvestigationGap {
  code: "SUBJECT_UNBOUND" | "SUBJECT_AMBIGUOUS" | "SOURCE_UNAVAILABLE" | "SOURCE_STALE" | "UNSUPPORTED_LANGUAGE" | "CALL_UNRESOLVED" | "BUDGET_EXHAUSTED" | "CONTEXT_OMITTED";
  entityId?: string; message: string;
}
export interface InvestigationReport {
  version: "investigation.v1";
  revision: string;
  goal: "flow" | "structure";
  binding: { status: "bound" | "ambiguous" | "unbound"; roots: string[]; candidates: string[] };
  outcome: "supported" | "partial" | "ambiguous" | "unbound";
  scope: "bounded static neighborhood";
  budget: InvestigationBudget;
  counts: { entities: number; indexedRelationships: number; recoveredRelationships: number; sourceFiles: number; sourceBytes: number; unresolvedCalls: number };
  timings: { bindingMs: number; investigationMs: number };
  gaps: InvestigationGap[];
}
