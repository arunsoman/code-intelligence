import type { EvidenceBundle } from './index.ts';

/** A bounded collection, independent of diagram type and prompt size. Never a closed-world repository. */
export interface EvidenceSnapshot {
  version: 'evidence-snapshot.v1';
  id: string;
  revision: string;
  question: string;
  bundle: EvidenceBundle;
  findings: CanonicalFinding[];
  coverage: { scope: 'bounded-static'; exhaustive: false; gaps: string[] };
}
export interface CanonicalFinding {
  id: string;
  kind: 'relationship' | 'fact' | 'source-answer';
  subjectIds: string[];
  evidenceIds: string[];
  assertion: string;
  /** Citation validation is not independent semantic verification. */
  validation: 'static-evidence' | 'citation-checked';
}
export interface EvidenceProjection {
  snapshotId: string;
  omittedEntityIds: string[];
  omittedRelationshipIds: string[];
  omittedFactIds: string[];
}
export type Membership = 'present' | 'absent' | 'unknown';
export interface EvidenceSet {
  snapshotId: string;
  /** Absence must be explicit and justified by the set producer; missing keys are unknown. */
  members: Record<string, Membership>;
}
export type EvidenceSetOperation = 'union' | 'intersection' | 'difference';
/** Explicit planner output; natural-language decomposition is a separate responsibility. */
export type EvidenceSetExpression =
  | { kind: 'members'; entityIds: string[] }
  | { kind: 'neighbors'; subjectIds: string[]; relationshipKind: string; direction: 'outgoing' | 'incoming' }
  | { kind: 'operation'; operation: EvidenceSetOperation; left: EvidenceSetExpression; right: EvidenceSetExpression };
