// Layout quality measured, not eyeballed: node overlaps, edges drawn through unrelated nodes, edge crossings.
// Pure geometry over a Rendered view; edges are straight segments between node centres clipped to boxes, which is
// how an edge reads when it has no waypoints (waypoints from the layered layout are honoured when present).
import type { Pos, RenderEdge, RenderNode, Rendered } from "./graph.ts";

export interface Box { x1: number; y1: number; x2: number; y2: number }
export type Sizer = (n: RenderNode) => { w: number; h: number };

/** Node sizes mirror the stylesheet in Canvas.tsx (width/height per role); a test keeps the two from drifting. */
export const SIZES: Record<string, [number, number]> = {
  "failure-site": [170, 40], symptom: [190, 46], state: [130, 44], gate: [150, 64], policy: [150, 64], decision: [150, 54],
  hazard: [160, 44], race: [160, 44], unprotected: [160, 44], consequence: [160, 44], gap: [160, 44],
  event: [190, 52], commit: [190, 52], constraint: [190, 52], behavior: [200, 52], concept: [200, 52],
  "c4-person": [170, 46], "c4-system": [220, 60],
  table: [210, 56], package: [180, 46], module: [170, 44], crate: [170, 44], component: [180, 46], participant: [180, 46],
  interface: [170, 44], factory: [170, 44], process: [170, 56], "data-store": [150, 48],
  "external-entity": [160, 36], "external-system": [160, 36],
  writer: [170, 44], poller: [170, 44], consumer: [170, 44], "outbox-store": [150, 48], "dead-letter": [150, 44],
};
export const nodeSize: Sizer = (n) => {
  if (n.role?.startsWith("activity-")) return n.role === "activity-decision" ? { w: 240, h: 120 } : { w: 220, h: 72 };
  if (n.role?.startsWith("lifecycle-")) return { w: 220, h: 72 };
  if (n.role === "er-entity") {
    const notes = n.node?.notes?.length ?? 0;
    return { w: 320, h: 68 + (Math.min(12,notes) + (notes > 12 ? 1 : 0)) * 20 };
  }
  if (n.kind === "agg") return { w: 190, h: 44 };
  if (n.kind === "ext") return { w: 150, h: 30 };
  if (["uml-class", "uml-abstract", "uml-interface", "uml-enum"].includes(n.role ?? "")) {
    const notes = n.node?.notes?.length ?? 0;
    const lines = 2 + Math.min(8, notes) + (notes > 8 ? 1 : 0);
    return { w: 270, h: 76 + (lines - 1) * 18 };
  }
  const s = n.role ? SIZES[n.role] : undefined;
  if (s) return { w: s[0], h: s[1] };
  return { w: 150, h: n.node?.badge || n.label.includes("\n") ? 44 : 28 };
};

export const boxOf = (p: Pos, s: { w: number; h: number }, pad = 0): Box => ({ x1: p.x - s.w / 2 - pad, y1: p.y - s.h / 2 - pad, x2: p.x + s.w / 2 + pad, y2: p.y + s.h / 2 + pad });
const overlaps = (a: Box, b: Box) => a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

type Pt = [number, number];
const ccw = (a: Pt, b: Pt, c: Pt) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
function segCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = ccw(a, b, c), d2 = ccw(a, b, d), d3 = ccw(c, d, a), d4 = ccw(c, d, b);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
function segHitsBox(a: Pt, b: Pt, bx: Box): boolean {
  const inside = (p: Pt) => p[0] > bx.x1 && p[0] < bx.x2 && p[1] > bx.y1 && p[1] < bx.y2;
  if (inside(a) || inside(b)) return true;
  const c: Pt[] = [[bx.x1, bx.y1], [bx.x2, bx.y1], [bx.x2, bx.y2], [bx.x1, bx.y2]];
  return segCross(a, b, c[0], c[1]) || segCross(a, b, c[1], c[2]) || segCross(a, b, c[2], c[3]) || segCross(a, b, c[3], c[0]);
}

/** The polyline an edge is drawn along: centre to centre through any waypoints, shrunk off its own end boxes. */
export function polyline(e: RenderEdge & { via?: Pos[] }, pos: Map<string, Pos>, boxes: Map<string, Box>): Pt[] | null {
  const a = pos.get(e.from), b = pos.get(e.to);
  if (!a || !b) return null;
  const pts: Pt[] = [[a.x, a.y], ...(e.via ?? []).map((p): Pt => [p.x, p.y]), [b.x, b.y]];
  // Trim the ends to the node borders so an edge is not charged for touching its own endpoints.
  const trim = (from: Pt, to: Pt, bx: Box): Pt => {
    const dx = to[0] - from[0], dy = to[1] - from[1];
    if (dx === 0 && dy === 0) return from;
    const tx = dx ? Math.min(...[(bx.x1 - from[0]) / dx, (bx.x2 - from[0]) / dx].filter((t) => t > 0), 1) : 1;
    const ty = dy ? Math.min(...[(bx.y1 - from[1]) / dy, (bx.y2 - from[1]) / dy].filter((t) => t > 0), 1) : 1;
    const t = Math.min(tx, ty);
    return [from[0] + dx * t, from[1] + dy * t];
  };
  const fb = boxes.get(e.from), tb = boxes.get(e.to);
  if (fb) pts[0] = trim(pts[0], pts[1], fb);
  if (tb) pts[pts.length - 1] = trim(pts[pts.length - 1], pts[pts.length - 2], tb);
  return pts;
}

export interface LayoutReport { nodes: number; edges: number; ambientEdges: number; nodeOverlaps: number; edgeThroughNode: number; edgeCrossings: number; detail: string[] }

export function measure(r: Rendered & { edges: (RenderEdge & { via?: Pos[]; ambient?: boolean })[] }, size: Sizer = nodeSize, gap = 4): LayoutReport {
  const pos = new Map(r.nodes.map((n) => [n.id, n.pos]));
  const boxes = new Map(r.nodes.map((n) => [n.id, boxOf(n.pos, size(n))]));
  const detail: string[] = [];
  let nodeOverlaps = 0;
  const ids = r.nodes.map((n) => n.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (overlaps(boxOf(r.nodes[i].pos, size(r.nodes[i]), gap / 2), boxOf(r.nodes[j].pos, size(r.nodes[j]), gap / 2))) { nodeOverlaps++; if (detail.length < 6) detail.push(`overlap: ${r.nodes[i].label} / ${r.nodes[j].label}`); }
  }
  const lines = r.edges.filter((e) => !e.ambient).map((e) => ({ e, pts: polyline(e, pos, boxes) })).filter((l): l is { e: typeof l.e; pts: Pt[] } => !!l.pts);
  let edgeThroughNode = 0;
  for (const { e, pts } of lines) for (const n of r.nodes) {
    if (n.id === e.from || n.id === e.to) continue;
    const bx = boxes.get(n.id)!;
    let hit = false;
    for (let i = 0; i + 1 < pts.length && !hit; i++) hit = segHitsBox(pts[i], pts[i + 1], bx);
    if (hit) { edgeThroughNode++; if (detail.length < 12) detail.push(`edge through node: ${e.from} → ${e.to} over ${n.label}`); }
  }
  let edgeCrossings = 0;
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i], b = lines[j];
    if (a.e.from === b.e.from || a.e.from === b.e.to || a.e.to === b.e.from || a.e.to === b.e.to) continue; // sharing an end is not a crossing
    let x = false;
    for (let p = 0; p + 1 < a.pts.length && !x; p++) for (let q = 0; q + 1 < b.pts.length && !x; q++) x = segCross(a.pts[p], a.pts[p + 1], b.pts[q], b.pts[q + 1]);
    if (x) edgeCrossings++;
  }
  return { nodes: r.nodes.length, edges: lines.length, ambientEdges: r.edges.length - lines.length, nodeOverlaps, edgeThroughNode, edgeCrossings, detail };
}

/** The point halfway along a polyline, by arc length: where an edge's label is drawn. */
export function pointAtHalf(pts: Pt[]): Pt {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i++) total += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
  let want = total / 2;
  for (let i = 0; i + 1 < pts.length; i++) {
    const seg = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (seg >= want) { const t = seg ? want / seg : 0; return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]; }
    want -= seg;
  }
  return pts[pts.length - 1] ?? [0, 0];
}

/** Approximate on-screen width of a label, in the units of the canvas stylesheet (`fontUnits` per glyph average). */
export const labelWidth = (text: string, fontUnits: number): number => Math.max(...text.split("\n").map((l) => l.length), 0) * fontUnits * 0.62;

/**
 * Legibility, measured: an edge label whose box is crossed by a different edge (the reading is obscured even
 * though the label is drawn on top), and a node label that cannot fit inside its box even when wrapped.
 */
export interface LegibilityReport { edgeLabelCollisions: number; truncatedLabels: number; detail: string[] }
export function measureLegibility(r: Rendered & { edges: (RenderEdge & { via?: Pos[]; ambient?: boolean })[] }, size: Sizer = nodeSize, nodeFont = 11, edgeFont = 9, pad = 3): LegibilityReport {
  const pos = new Map(r.nodes.map((n) => [n.id, n.pos]));
  const boxes = new Map(r.nodes.map((n) => [n.id, boxOf(n.pos, size(n))]));
  const lines = r.edges.filter((e) => !e.ambient).map((e) => ({ e, pts: polyline(e, pos, boxes) })).filter((l): l is { e: typeof l.e; pts: Pt[] } => !!l.pts);
  const detail: string[] = [];
  let edgeLabelCollisions = 0;
  for (const { e, pts } of lines) {
    if (!e.label || !e.label.trim()) continue;
    const mid = pointAtHalf(pts);
    const w = labelWidth(e.label, edgeFont) + 2 * pad, h = edgeFont * 1.3 + 2 * pad;
    const lb: Box = { x1: mid[0] - w / 2, y1: mid[1] - h / 2, x2: mid[0] + w / 2, y2: mid[1] + h / 2 };
    for (const other of lines) {
      if (other.e.id === e.id) continue;
      if (other.e.from === e.from || other.e.from === e.to || other.e.to === e.from || other.e.to === e.to) continue; // sharing an end is not an overlap
      let hit = false;
      for (let i = 0; i + 1 < other.pts.length && !hit; i++) hit = segHitsBox(other.pts[i], other.pts[i + 1], lb);
      if (hit) { edgeLabelCollisions++; if (detail.length < 8) detail.push(`edge label “${e.label}” under ${other.e.from} → ${other.e.to}`); break; }
    }
  }
  let truncatedLabels = 0;
  for (const n of r.nodes) {
    if (n.kind !== "node") continue;
    const s = size(n);
    const maxChars = Math.max(1, Math.floor((s.w - 10) / (nodeFont * 0.62)));
    // `text-wrap: wrap` breaks at spaces and, within `text-max-width`, inside a long word too.
    const wrapped = n.label.split("\n").reduce((acc, line) => acc + Math.max(1, Math.ceil(line.length / maxChars)), 0);
    const fits = wrapped * nodeFont * 1.25 <= s.h - 4;
    if (!fits) { truncatedLabels++; if (detail.length < 12) detail.push(`label does not fit: ${n.label}`); }
  }
  return { edgeLabelCollisions, truncatedLabels, detail };
}
