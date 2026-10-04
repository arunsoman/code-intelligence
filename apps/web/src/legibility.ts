// When should a map change its level of detail, and where should the camera be afterwards? Decided by what a person can read, not by how far
// the wheel has turned: the on-screen size of a label is the label's size in the drawing times the camera zoom, and below about 10 px it cannot be read.
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
