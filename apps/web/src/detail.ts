// F09 — per-form detail policy and rendered-level bookkeeping.
// Pure, unit-testable under node. The Canvas applies the plans this module produces.

import type { FormId, ViewSpec } from "@cie/schema";

export type LabelClass = "NODE_NAME" | "GROUP_CAPTION" | "BADGE" | "EDGE_RELATION" | "DETAIL_LINE";

export type DetailLevel = {
  n: number;
  name: string;
  hint: string;
  /** What a node at this level stands for. null = the form's own elements, unaggregated. */
  aggregation: null | { by: string; fallbackBy?: string };
  maxNodes?: number;
  labelClasses: Partial<Record<LabelClass, { essential: boolean; fontUnits: number }>>;
};

export type LabelFallback = "ABBREVIATE" | "SELECTED_ONLY" | "HIDE";

export type CaveatChannel = "BORDER" | "ICON" | "PATTERN" | "COUNT_BADGE" | "LABEL_ONLY";

export interface DetailPolicy {
  formId: FormId;
  aggregationSupported: boolean;
  levels: DetailLevel[];
  essentialLabelMinPx: number;
  hardMinPx: number;
  targetPx: number;
  landingMinPx: number;
  expandCandidateMinPx: number;
  labelFallback: LabelFallback;
  defaultLevel: number | "AUTO";
  caveatChannels: Record<string, CaveatChannel>;
}

export type RenderedBox = { x1: number; y1: number; x2: number; y2: number };

/** Per-class label metrics measured (or computed) for a RenderedLevel. */
export interface LabelStat {
  class: LabelClass;
  count: number;
  fontUnits: number;
  maxTextWidthUnits: number;
}

export interface RenderedLevel {
  level: number;
  nodes: { id: string; label: string; members: string[]; x: number; y: number; width: number; height: number; labelClass: LabelClass }[];
  edges: { id: string; label: string; from: string; to: string; labelClass: LabelClass }[];
  membership: Map<string, string[]>;
  bbox: RenderedBox;
  labelStats: LabelStat[];
  caveats: { kind: string; count: number; channel: CaveatChannel }[];
}

export interface Viewport { width: number; height: number }

export type ZoomIntent =
  | { kind: "WHEEL"; deltaY: number; pointer: { x: number; y: number } }
  | { kind: "STEPPER"; direction: 1 | -1 }
  | { kind: "KEYBOARD"; direction: 1 | -1 }
  | { kind: "SET_LEVEL"; level: number }
  | { kind: "AUTO_TOGGLE"; on: boolean }
  | { kind: "BRING_INTO_VIEW" };

export interface SemanticAnchor {
  entityIds: string[];
  screenPoint: { x: number; y: number };
  selectionId?: string;
  previousGroupId?: string;
  source: "POINTER" | "SELECTION" | "FOCUS" | "CENTRE";
}

export type TransitionKind = "SWITCH_COARSER" | "SWITCH_FINER" | "EXPLICIT_LEVEL" | "INITIAL_FIT" | "BRING_INTO_VIEW";

export interface TransitionPlan {
  camera: { zoom: number; pan: { x: number; y: number } };
  resolvedAnchor: { renderId: string; entityCount: number } | null;
  visibleNodeCount: number;
  offscreenNodeCount: number;
  drawingCoverage: number;
  minEssentialLabelPx: number;
  unmetConstraints: ("COVERAGE_BELOW_TARGET" | "LABELS_BELOW_LANDING_MIN" | "ANCHOR_UNRESOLVED" | "CANDIDATE_TOO_LARGE")[];
}

/** The canonical numeric thresholds from the original legibility policy. */
export const DEFAULT_THRESHOLDS = {
  aggregateBelowPx: 10,
  hardMinPx: 9,
  essentialLabelMinPx: 10,
  landingMinPx: 10.5,
  targetPx: 11.5,
  expandCandidateMinPx: 16,
} as const;

/** Default policy for forms that do not declare one. */
export function defaultDetailPolicy(formId: FormId): DetailPolicy {
  return {
    formId,
    aggregationSupported: false,
    levels: [],
    ...DEFAULT_THRESHOLDS,
    labelFallback: "HIDE",
    defaultLevel: 0,
    caveatChannels: {},
  };
}

/** A policy is invalid if thresholds are out of order or a caveat is LABEL_ONLY. */
export function validatePolicy(p: DetailPolicy): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (p.hardMinPx > p.essentialLabelMinPx) errors.push(`hardMinPx (${p.hardMinPx}) must be <= essentialLabelMinPx (${p.essentialLabelMinPx})`);
  if (p.essentialLabelMinPx > p.landingMinPx) errors.push(`essentialLabelMinPx (${p.essentialLabelMinPx}) must be <= landingMinPx (${p.landingMinPx})`);
  if (p.landingMinPx > p.targetPx) errors.push(`landingMinPx (${p.landingMinPx}) must be <= targetPx (${p.targetPx})`);
  if (p.targetPx > p.expandCandidateMinPx) errors.push(`targetPx (${p.targetPx}) must be <= expandCandidateMinPx (${p.expandCandidateMinPx})`);
  for (const [kind, channel] of Object.entries(p.caveatChannels)) {
    if (channel === "LABEL_ONLY") errors.push(`caveat ${kind} uses forbidden LABEL_ONLY channel`);
  }
  if (p.aggregationSupported && p.levels.length === 0) errors.push("aggregationSupported forms must declare at least one level");
  if (!p.aggregationSupported && p.levels.length > 0) errors.push("non-aggregation forms must not declare levels");
  const names = new Set<string>();
  for (const l of p.levels) {
    if (!l.name.trim()) errors.push(`level ${l.n} has no name`);
    if (names.has(l.name)) errors.push(`duplicate level name "${l.name}"`);
    names.add(l.name);
  }
  return errors.length ? { ok: false, errors } : { ok: true };
}

/** The F09 §6.3 policy table for forms that support semantic levels. */
export function semanticMapPolicy(): DetailPolicy {
  return {
    formId: "SemanticMap",
    aggregationSupported: true,
    levels: [
      { n: 0, name: "System", hint: "the whole system and what it depends on", aggregation: { by: "SYSTEM" }, labelClasses: { NODE_NAME: { essential: true, fontUnits: 13 } } },
      { n: 1, name: "Domains", hint: "intermediate abstractions proposed over the concepts", aggregation: { by: "DOMAIN" }, labelClasses: { NODE_NAME: { essential: true, fontUnits: 12 } } },
      { n: 2, name: "Concepts", hint: "groups by responsibility", aggregation: { by: "CONCEPT" }, labelClasses: { NODE_NAME: { essential: true, fontUnits: 12 } } },
      { n: 3, name: "Files", hint: "one node per file", aggregation: { by: "FILE" }, labelClasses: { NODE_NAME: { essential: true, fontUnits: 11 } } },
      { n: 4, name: "Key symbols", hint: "the most relevant symbols", aggregation: null, labelClasses: { NODE_NAME: { essential: true, fontUnits: 11 } } },
      { n: 5, name: "All symbols", hint: "everything retrieved", aggregation: null, labelClasses: { NODE_NAME: { essential: true, fontUnits: 11 } } },
      { n: 6, name: "Detail", hint: "roles, notes and edge labels; double-click for code", aggregation: null, labelClasses: { NODE_NAME: { essential: true, fontUnits: 11 }, DETAIL_LINE: { essential: false, fontUnits: 10 } } },
    ],
    ...DEFAULT_THRESHOLDS,
    labelFallback: "HIDE",
    defaultLevel: "AUTO",
    caveatChannels: {
      badge: "COUNT_BADGE",
      fogCount: "BORDER",
      supportedSuspect: "ICON",
      aggregateWarning: "PATTERN",
    },
  };
}

/** Per-form policy lookup. Forms not listed use the default (no aggregation, labels hide when too small). */
export function detailPolicyFor(formId: FormId): DetailPolicy {
  switch (formId) {
    case "SemanticMap": return semanticMapPolicy();
    case "RuntimeOverlay": return { ...semanticMapPolicy(), formId: "RuntimeOverlay" };
    case "Ownership": return {
      formId: "Ownership",
      aggregationSupported: true,
      levels: [
        { n: 0, name: "Teams", hint: "ownership by team or directory", aggregation: { by: "ROLE" }, labelClasses: { NODE_NAME: { essential: true, fontUnits: 12 } } },
        { n: 1, name: "Directories", hint: "one node per directory", aggregation: { by: "DIRECTORY" }, labelClasses: { NODE_NAME: { essential: true, fontUnits: 11 } } },
        { n: 2, name: "Files", hint: "one node per file", aggregation: null, labelClasses: { NODE_NAME: { essential: true, fontUnits: 11 } } },
      ],
      ...DEFAULT_THRESHOLDS,
      labelFallback: "ABBREVIATE",
      defaultLevel: "AUTO",
      caveatChannels: { staleOwner: "ICON", thinKnowledge: "PATTERN" },
    };
    case "TransactionJourney": return {
      formId: "TransactionJourney",
      aggregationSupported: true,
      levels: [
        { n: 0, name: "Lanes", hint: "collapse lanes to summaries when many steps", aggregation: { by: "ROLE" }, labelClasses: { NODE_NAME: { essential: true, fontUnits: 12 }, GROUP_CAPTION: { essential: true, fontUnits: 12 } } },
        { n: 1, name: "Steps", hint: "one node per step", aggregation: null, labelClasses: { NODE_NAME: { essential: true, fontUnits: 11 } } },
      ],
      ...DEFAULT_THRESHOLDS,
      labelFallback: "ABBREVIATE",
      defaultLevel: "AUTO",
      caveatChannels: { asyncHandoff: "BORDER" },
    };
    default:
      return defaultDetailPolicy(formId);
  }
}

/** All FormIds. Used by F09-A7/D1 to assert every form exports a valid policy. */
const ALL_FORM_IDS: FormId[] = [
  "SemanticMap", "CausalGraph", "HypothesisGraph", "TransactionJourney", "DataLineage", "SemanticDiff",
  "Archaeology", "TrustBoundary", "RuntimeOverlay", "RaceWindow", "Counterfactual", "TestConfidence",
  "Ownership", "ConceptAtlas", "PolicyMap", "ChangeRisk", "TraceLinkedProfile",
];

/** Returns any forms whose policies fail validation. Empty array = F09-A7 passes. */
export function invalidPolicies(): { formId: FormId; errors: string[] }[] {
  const out: { formId: FormId; errors: string[] }[] = [];
  for (const f of ALL_FORM_IDS) {
    const p = detailPolicyFor(f);
    const v = validatePolicy(p);
    if (!v.ok) out.push({ formId: f, errors: v.errors });
  }
  return out;
}

/** True when this view's form supports semantic levels. */
export function semanticLevelsApply(view: ViewSpec): boolean {
  const p = detailPolicyFor(view.formId);
  return p.aggregationSupported;
}

/** Construct a RenderedLevel from a ViewSpec + level for the semantic-map compiler.
 *  This is a transitional adapter until graph.ts gains a per-form `compileDetailLevel`.
 */
export function renderLevelStub(view: ViewSpec, level: number): RenderedLevel {
  const nodes = view.nodes.map((n) => ({
    id: n.id,
    label: n.label,
    members: [n.id],
    x: n.pos?.x ?? 0,
    y: n.pos?.y ?? 0,
    width: n.pos ? 0 : 150,
    height: 28,
    labelClass: "NODE_NAME" as LabelClass,
  }));
  const edges = view.edges.map((e) => ({
    id: e.id,
    label: e.label ?? "",
    from: e.fromNodeId,
    to: e.toNodeId,
    labelClass: "EDGE_RELATION" as LabelClass,
  }));
  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const bbox: RenderedBox = {
    x1: Math.min(0, ...xs),
    y1: Math.min(0, ...ys),
    x2: Math.max(150, ...xs),
    y2: Math.max(28, ...ys),
  };
  return {
    level,
    nodes,
    edges,
    membership: new Map(nodes.map((n) => [n.id, n.members])),
    bbox,
    labelStats: [{ class: "NODE_NAME", count: nodes.length, fontUnits: 11, maxTextWidthUnits: 136 }],
    caveats: [],
  };
}

/** The form definition contract: a short summary exposed by the gallery (§8.1). */
export interface DetailSummary {
  formId: FormId;
  aggregationSupported: boolean;
  levelCount: number;
  labelFallback: LabelFallback;
}

export function detailSummary(formId: FormId): DetailSummary {
  const p = detailPolicyFor(formId);
  return { formId, aggregationSupported: p.aggregationSupported, levelCount: p.levels.length, labelFallback: p.labelFallback };
}
