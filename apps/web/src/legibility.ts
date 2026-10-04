// When should a map change its level of detail, and where should the camera be afterwards? Decided by what a person can read, not by how far
// the wheel has turned: the on-screen size of a label is the label's size in the drawing times the camera zoom, and below about 10 px it cannot be read.
// F09 additions: chooseInitialLevel, planTransition, evaluateCandidateCamera, measureLabels.
// Pure functions, so the rules are tested under node; Canvas.tsx applies them.
//
// Rules (sizes are CSS pixels of an essential node label):
//  - zooming out, once labels fall below `aggregateBelowPx` the next coarser level replaces the content, and the zoom is raised again so the labels
//    are readable (never larger than `targetPx`, and no lower than `landingMinPx`); if the new content still does not fit at that size, the rest is
//    announced as off-screen rather than drawn too small;
//  - zooming in, once labels pass `expandAbovePx` the next finer level replaces the content, with the zoom brought back to `targetPx`;
//  - each switch puts the labels back in the middle of the band, so the same gesture cannot switch twice, and the distance between the two
//    thresholds is the hysteresis;
//  - below `hardMinPx` labels are not drawn at all (Cytoscape `min-zoomed-font-size`): shapes, borders and edges keep the provenance and
//    uncertainty encoding, the text outline keeps the names.

/** Size of an essential node label in the drawing, in the units of the Canvas stylesheet (`font-size: 11`). */
export const FONT_UNITS = 11;
/** The smallest on-screen size an essential label may be left at by a fit: below this the drawing is unreadable. */
export const MIN_READABLE_PX = 11;
/** `landingMinPx` is the smallest size a switch may leave labels at: a little above `aggregateBelowPx`, so the next tick of the same gesture does not switch again. */
export const POLICY = { aggregateBelowPx: 10, hardMinPx: 9, landingMinPx: 10.5, targetPx: 11.5, expandAbovePx: 16 } as const;
export type Policy = typeof POLICY;

export const fontPx = (zoom: number): number => FONT_UNITS * zoom;
export const zoomForPx = (px: number): number => px / FONT_UNITS;

export type Move = "coarser" | "finer" | "none";
/**
 * Which way should the level move for this zoom? `moving` is the direction the camera has just been going: a view the person chose at a small
 * text size (the stepper, a fit) is not changed by zooming in, and a view is not aggregated by zooming in.
 */
export function levelMove(zoom: number, moving: "out" | "in", level: number, maxLevel: number, policy: Policy = POLICY): Move {
  const px = fontPx(zoom);
  if (moving === "out" && px < policy.aggregateBelowPx && level > 0) return "coarser";
  if (moving === "in" && px > policy.expandAbovePx && level < maxLevel) return "finer";
  return "none";
}

/**
 * The zoom to use after the level has changed. `zFit` is the zoom at which the new content just fits the viewport.
 * Coarser: show all of the new content if that keeps the text readable, but never larger than the target size, and never below the landing minimum.
 * Finer: the person is looking into a region, so the text goes back to the target size.
 */
export function zoomAfterSwitch(move: Exclude<Move, "none">, zFit: number, policy: Policy = POLICY): number {
  const target = zoomForPx(policy.targetPx), floor = zoomForPx(policy.landingMinPx);
  return move === "finer" ? target : Math.max(floor, Math.min(target, zFit));
}

export interface AnchorNode { id: string; members: string[]; x: number; y: number }
/**
 * Which node of the new representation stands for what the person was looking at? The one that contains the most of the old node's elements
 * (several nodes merging: the group; a group expanding: the first descendant that was selected or focused, passed first in `ids`).
 */
export function resolveAnchor(ids: string[], nodes: AnchorNode[]): AnchorNode | null {
  if (!ids.length) return null;
  // Count dominates; among equal counts the node holding the earliest id wins (callers list the selected or focused element first).
  const weight = new Map(ids.map((id, i) => [id, 1 + 1 / (2 + i)]));
  let best: AnchorNode | null = null, score = 0;
  for (const n of nodes) { const s = n.members.reduce((k, m) => k + (weight.get(m) ?? 0), 0); if (s > score) { best = n; score = s; } }
  return best;
}

export interface Box { x1: number; y1: number; x2: number; y2: number }
export interface Visibility { total: number; inView: number; offscreen: number; clipped: number; drawingInViewPct: number }
/** How much of a drawing is inside a w by h viewport: whole nodes outside, nodes cut by the edge, and the share of the drawing's area that is visible. */
export function boxesCoveragePct(boxes: Box[], w: number, h: number): number {
  if (!boxes.length) return 100;
  const x1 = Math.min(...boxes.map((b) => b.x1)), y1 = Math.min(...boxes.map((b) => b.y1)), x2 = Math.max(...boxes.map((b) => b.x2)), y2 = Math.max(...boxes.map((b) => b.y2));
  const area = (x2 - x1) * (y2 - y1);
  const ix = Math.max(0, Math.min(x2, w) - Math.max(x1, 0)), iy = Math.max(0, Math.min(y2, h) - Math.max(y1, 0));
  return area > 0 ? (ix * iy) / area : 1;
}
export function visibility(boxes: Box[], w: number, h: number): Visibility {
  let inView = 0, clipped = 0;
  for (const b of boxes) {
    const outside = b.x2 <= 0 || b.x1 >= w || b.y2 <= 0 || b.y1 >= h;
    if (outside) continue;
    inView++;
    if (b.x1 < 0 || b.y1 < 0 || b.x2 > w || b.y2 > h) clipped++;
  }
  let pct = 100;
  if (boxes.length) {
    const x1 = Math.min(...boxes.map((b) => b.x1)), y1 = Math.min(...boxes.map((b) => b.y1)), x2 = Math.max(...boxes.map((b) => b.x2)), y2 = Math.max(...boxes.map((b) => b.y2));
    const area = (x2 - x1) * (y2 - y1);
    const ix = Math.max(0, Math.min(x2, w) - Math.max(x1, 0)), iy = Math.max(0, Math.min(y2, h) - Math.max(y1, 0));
    pct = area > 0 ? Math.round((100 * ix * iy) / area) : 100;
  }
  return { total: boxes.length, inView, offscreen: boxes.length - inView, clipped, drawingInViewPct: pct };
}

/**
 * The pan (in screen pixels) that puts a model point at a screen point, at a zoom.
 */
export const panFor = (model: { x: number; y: number }, screen: { x: number; y: number }, zoom: number) => ({ x: screen.x - model.x * zoom, y: screen.y - model.y * zoom });

/**
 * The smallest pan change that brings a drawing (its bounding box in model units) inside a w by h viewport at `zoom`, with `pad` pixels around it.
 * A drawing larger than the viewport on an axis is left as it is on that axis: the anchor decides there.
 */
export function pullInside(pan: { x: number; y: number }, bb: { x1: number; y1: number; x2: number; y2: number }, zoom: number, w: number, h: number, pad = 24) {
  const axis = (p: number, a: number, b: number, size: number) => {
    const lo = a * zoom + p, hi = b * zoom + p;
    if (hi - lo > size - 2 * pad) return p;
    if (lo < pad) return p + (pad - lo);
    if (hi > size - pad) return p - (hi - (size - pad));
    return p;
  };
  return { x: axis(pan.x, bb.x1, bb.x2, w), y: axis(pan.y, bb.y1, bb.y2, h) };
}

// ------------------------------------------------------------------ F09 planner (§7)
import type { DetailPolicy, RenderedBox, RenderedLevel, SemanticAnchor, TransitionKind, TransitionPlan, Viewport } from "./detail.ts";
export * from "./detail.ts";

/** Measure on-screen label sizes per class from a rendered level and a zoom. */
export function measureLabels(level: RenderedLevel, zoom: number): { class: string; px: number; essential: boolean; truncated: boolean }[] {
  return level.labelStats.map((s) => ({
    class: s.class,
    px: s.fontUnits * zoom,
    essential: level.labelStats.find((x) => x.class === s.class)?.fontUnits === s.fontUnits ? level.nodes.some((n) => n.labelClass === s.class) : false,
    truncated: s.maxTextWidthUnits > 0 && s.maxTextWidthUnits * zoom < s.fontUnits * 4,
  }));
}

/** Zoom at which a font of `fontUnits` measures `px` CSS pixels. */
export const zoomForFontPx = (px: number, fontUnits: number): number => (fontUnits > 0 ? px / fontUnits : 1);

/**
 * The zoom a "fit" should land on. Fitting a large drawing can leave its labels below the readable floor;
 * rather than silently crop them away, raise the zoom to the floor. A fit larger than `maxZoom` is still capped,
 * so a tiny drawing is not blown up past the point of usefulness.
 */
export function readableFitZoom(zFit: number, maxZoom = 1.4, minPx = MIN_READABLE_PX, fontUnits = FONT_UNITS): number {
  return Math.max(Math.min(zFit, maxZoom), zoomForFontPx(minPx, fontUnits));
}

/** The essential font size (in units) for a level, defaulting to 11. */
function essentialFontUnits(level: RenderedLevel): number {
  const ess = level.labelStats.find((s) => s.class === "NODE_NAME");
  return ess?.fontUnits ?? 11;
}

/** Fit zoom for a bbox in a viewport with `pad` pixels of padding. */
export function fitZoomForBBox(bb: RenderedBox, viewport: Viewport, pad = 40): number {
  const bw = bb.x2 - bb.x1, bh = bb.y2 - bb.y1;
  if (bw <= 0 || bh <= 0) return 1;
  return Math.min((viewport.width - 2 * pad) / bw, (viewport.height - 2 * pad) / bh);
}

/** Choose the finest initial level whose labels fit readable. Pure, no timers (F09-A6). */
export function chooseInitialLevel(candidates: RenderedLevel[], viewport: Viewport, policy: DetailPolicy): { level: number; plan: TransitionPlan } {
  const sorted = [...candidates].sort((a, b) => b.level - a.level); // finest first
  let best: { level: number; plan: TransitionPlan } | null = null;
  for (const c of sorted) {
    const plan = planTransition({
      currentCamera: { zoom: 1, pan: { x: 0, y: 0 } },
      viewport,
      anchor: { entityIds: [], screenPoint: { x: viewport.width / 2, y: viewport.height / 2 }, source: "CENTRE" },
      candidate: c,
      policy,
      kind: "INITIAL_FIT",
    });
    if (!best || plan.minEssentialLabelPx >= policy.targetPx) best = { level: c.level, plan };
  }
  if (best) return best;
  // Fallback: coarsest level with fallback labels.
  const coarsest = candidates.sort((a, b) => a.level - b.level)[0] ?? sorted[0];
  return {
    level: coarsest.level,
    plan: planTransition({
      currentCamera: { zoom: 1, pan: { x: 0, y: 0 } },
      viewport,
      anchor: { entityIds: [], screenPoint: { x: viewport.width / 2, y: viewport.height / 2 }, source: "CENTRE" },
      candidate: coarsest,
      policy,
      kind: "BRING_INTO_VIEW",
    }),
  };
}

/** Candidate-aware level decision (§7.4). Returns the level to switch to, or null to stay. */
export function evaluateCandidateCamera(
  currentPx: number,
  direction: "out" | "in",
  currentLevel: number,
  currentCamera: { zoom: number; pan: { x: number; y: number } },
  viewport: Viewport,
  anchor: SemanticAnchor,
  candidate: RenderedLevel,
  policy: DetailPolicy,
): TransitionPlan | null {
  const plan = planTransition({ currentCamera, viewport, anchor, candidate, policy, kind: direction === "out" ? "SWITCH_COARSER" : "SWITCH_FINER" });
  if (direction === "out") {
    if (plan.minEssentialLabelPx < policy.hardMinPx && candidate.level > 0) {
      // A still-coarser level may be readable: do not commit to an unreadable landing.
      return null;
    }
    return plan;
  }
  // Finer: only take it if the current labels are already large enough *and* the candidate lands readable.
  if (currentPx < policy.expandCandidateMinPx) return null;
  if (plan.minEssentialLabelPx < policy.landingMinPx) return null;
  return plan;
}

/** The single place camera maths lives (§7.5). */
export function planTransition(args: {
  currentCamera: { zoom: number; pan: { x: number; y: number } };
  viewport: Viewport;
  anchor: SemanticAnchor;
  candidate: RenderedLevel;
  policy: DetailPolicy;
  kind: TransitionKind;
  pad?: number;
}): TransitionPlan {
  const { currentCamera, viewport, anchor, candidate, policy, kind, pad = 40 } = args;
  const bb = candidate.bbox;
  const zFit = fitZoomForBBox(bb, viewport, pad);
  const target = zoomForFontPx(policy.targetPx, essentialFontUnits(candidate));
  const floor = zoomForFontPx(policy.landingMinPx, essentialFontUnits(candidate));
  let zoom: number;
  switch (kind) {
    case "SWITCH_COARSER":
      zoom = Math.max(floor, Math.min(target, zFit));
      break;
    case "SWITCH_FINER":
    case "EXPLICIT_LEVEL":
      zoom = target;
      break;
    case "INITIAL_FIT":
    case "BRING_INTO_VIEW":
    default:
      zoom = zFit;
  }
  // Resolve anchor through membership.
  const anchorNodes: AnchorNode[] = candidate.nodes.map((n) => ({ id: n.id, members: n.members, x: n.x, y: n.y }));
  const resolved = resolveAnchor(anchor.entityIds, anchorNodes);
  const resolvedAnchor = resolved ? { renderId: resolved.id, entityCount: resolved.members.length } : null;
  const model = resolved ? { x: resolved.x, y: resolved.y } : { x: (bb.x1 + bb.x2) / 2, y: (bb.y1 + bb.y2) / 2 };
  const screen = resolved ? anchor.screenPoint : { x: viewport.width / 2, y: viewport.height / 2 };
  let pan = panFor(model, screen, zoom);
  if (kind === "SWITCH_COARSER" || kind === "BRING_INTO_VIEW" || kind === "INITIAL_FIT") {
    pan = pullInside(pan, bb, zoom, viewport.width, viewport.height, pad);
  }
  const boxes: Box[] = candidate.nodes.map((n) => ({ x1: n.x * zoom + pan.x - n.width / 2 * zoom, y1: n.y * zoom + pan.y - n.height / 2 * zoom, x2: n.x * zoom + pan.x + n.width / 2 * zoom, y2: n.y * zoom + pan.y + n.height / 2 * zoom }));
  const v = visibility(boxes, viewport.width, viewport.height);
  const drawingCoverage = boxesCoveragePct(boxes, viewport.width, viewport.height);
  const minEssentialLabelPx = Math.min(...candidate.labelStats.filter((s) => s.class === "NODE_NAME").map((s) => s.fontUnits * zoom));
  const unmet: TransitionPlan["unmetConstraints"] = [];
  if (kind !== "BRING_INTO_VIEW" && drawingCoverage < 0.8) unmet.push("COVERAGE_BELOW_TARGET");
  if (minEssentialLabelPx < policy.landingMinPx) unmet.push("LABELS_BELOW_LANDING_MIN");
  if (!resolvedAnchor) unmet.push("ANCHOR_UNRESOLVED");
  return {
    camera: { zoom, pan },
    resolvedAnchor,
    visibleNodeCount: v.inView,
    offscreenNodeCount: v.offscreen,
    drawingCoverage,
    minEssentialLabelPx,
    unmetConstraints: unmet,
  };
}

