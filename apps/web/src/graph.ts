// Pure view logic for the canvas (no DOM): layouts, semantic-zoom aggregation, verdict application.
// Kept separate so it can be unit-tested under node and so identity rules are enforced in one place.
import type { Claim, DisplayMode, ViewEdge, ViewNode, ViewSpec } from "@cie/schema";

export const LEVELS = [
  { n: 0, name: "System", hint: "the whole system and what it depends on" },
  { n: 1, name: "Domains", hint: "intermediate abstractions proposed over the concepts" },
  { n: 2, name: "Concepts", hint: "groups by responsibility" },
  { n: 3, name: "Files", hint: "one node per file" },
  { n: 4, name: "Key symbols", hint: "the most relevant symbols" },
  { n: 5, name: "All symbols", hint: "everything retrieved" },
  { n: 6, name: "Detail", hint: "roles, notes and edge labels; double-click for code" },
] as const;
export const MAX_LEVEL = 6;
export const DEFAULT_LEVEL = 5;

// Relative zoom (current / zoom-at-fit); fit-to-screen is 1.0 = level 5. ENTER[i] is the zoom needed to move up
// into level i+1 from below, LEAVE[i] the zoom below which level i+1 is left. LEAVE < ENTER, so the view never
// oscillates around a boundary.
const ENTER = [0.14, 0.26, 0.4, 0.62, 0.97, 1.6];
const LEAVE = [0.12, 0.23, 0.36, 0.56, 0.9, 1.45];
export function nextLevel(current: number, rel: number): number {
  let l = current;
  while (l < MAX_LEVEL && rel >= ENTER[l]) l++;
  while (l > 0 && rel < LEAVE[l - 1]) l--;
  return l;
}
/** A representative relative zoom for a level, used when a level is chosen explicitly. */
export const zoomForLevel = (level: number) => [0.08, 0.2, 0.32, 0.5, 0.8, 1.0, 2.0][level];

const SYNTHETIC = new Set(["failure-site", "symptom", "state"]);

// ------------------------------------------------------------------ verdicts → what is shown
/** Identity of a matrix cell for staleness and selection. */
export const cellKey = (c: { row: string; col: string }) => `cell:${c.row}|${c.col}`;
export interface Effective { view: ViewSpec; stale: Set<string>; bounded?: Bounded }
/** Most elements a view draws, and most that are drawn as foreground (CRITICAL/RELEVANT). Beyond that the rest is context or left out, and the view says so. */
export const MAX_ELEMENTS = 2000, MAX_FOREGROUND = 50;
export interface Bounded { total: number; shown: number; foreground: number; demoted: number; dropped: number }
const TIER_ORDER = { CRITICAL: 3, RELEVANT: 2, CONTEXT: 1, HIDDEN: 0 } as const;
const isProtected = (n: ViewNode) => (n.factors?.find((f) => f.factor === "RUNTIME_HOTNESS")?.normalizedScore ?? 0) >= 0.5 || (n.factors?.find((f) => f.factor === "USER_OVERRIDE")?.normalizedScore ?? 0) >= 1;
/**
 * Deterministic bounding: rank by tier, then score, then id. At most MAX_FOREGROUND nodes keep a foreground tier (the rest become
 * context, not hidden), except safety facts, which are never demoted; at most MAX_ELEMENTS are drawn at all. Edges follow their nodes.
 */
export function boundView(view: ViewSpec, max = MAX_ELEMENTS, maxFg = MAX_FOREGROUND): { view: ViewSpec; bounded?: Bounded } {
  const fg = view.nodes.filter((n) => TIER_ORDER[n.tier] >= 2).length;
  if (view.nodes.length <= max && fg <= maxFg) return { view };
  const ranked = [...view.nodes].sort((a, b) => TIER_ORDER[b.tier] - TIER_ORDER[a.tier] || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id));
  let kept = 0, demoted = 0;
  const nodes: ViewNode[] = [];
  const keep = new Set<string>();
  for (const n of ranked) {
    if (nodes.length >= max && !isProtected(n)) continue;
    let out = n;
    if (TIER_ORDER[n.tier] >= 2) { if (kept < maxFg || isProtected(n)) kept++; else { out = { ...n, tier: "CONTEXT" }; demoted++; } }
    nodes.push(out); keep.add(n.id);
  }
  const order = new Map(view.nodes.map((n, i) => [n.id, i]));
  nodes.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  const edges = view.edges.filter((e) => keep.has(e.fromNodeId) && keep.has(e.toNodeId));
  const dropped = view.nodes.length - nodes.length;
  const note = `This view is bounded: ${nodes.length} of ${view.nodes.length} elements are drawn${dropped ? ` (${dropped} lowest-ranked left out)` : ""}, ${kept} in the foreground${demoted ? ` and ${demoted} more shown only as context` : ""}. Ask about a part to see it.`;
  return { view: { ...view, nodes, edges, gaps: [...view.gaps, note] }, bounded: { total: view.nodes.length, shown: nodes.length, foreground: kept, demoted, dropped } };
}
export function effectiveView(view: ViewSpec, claims: Record<string, Claim>): Effective {
  const stale = new Set<string>();
  const dropNodes = new Set<string>();
  const nodes: ViewNode[] = [];
  for (const n of view.nodes) {
    const c = n.claimIds[0] ? claims[n.claimIds[0]] : undefined;
    const claimBacked = !!c && (n.role === "failure-site" || n.role === "writer" || n.role === "suspect");
    if (claimBacked && c!.displayMode === "HIDDEN") { dropNodes.add(n.id); continue; }
    if (claimBacked && c!.state === "STALE") stale.add(n.id);
    nodes.push(claimBacked && n.displayMode !== "FOG" ? { ...n, displayMode: c!.displayMode } : n);
  }
  const edges: ViewEdge[] = [];
  for (const e of view.edges) {
    if (dropNodes.has(e.fromNodeId) || dropNodes.has(e.toNodeId)) continue;
    const c = e.claimId ? claims[e.claimId] : undefined;
    if (c && c.displayMode === "HIDDEN") continue;
    if (c && c.state === "STALE") stale.add(e.id);
    edges.push(c && e.displayMode !== "FACT" ? { ...e, displayMode: c.displayMode } : e);
  }
  // A matrix is a second drawing of the same claims: a refuted claim removes its cells, a stale one marks them.
  let matrix = view.matrix;
  if (matrix) {
    const cells = [];
    for (const cell of matrix.cells) {
      const c = cell.claimId ? claims[cell.claimId] : undefined;
      if (c && c.displayMode === "HIDDEN") continue;
      if (c && c.state === "STALE") stale.add(cellKey(cell));
      cells.push(c && cell.displayMode !== "FACT" ? { ...cell, displayMode: c.displayMode } : cell);
    }
    matrix = { ...matrix, cells };
  }
  const b = boundView({ ...view, nodes, edges, ...(matrix ? { matrix } : {}) });
  return { view: b.view, stale, ...(b.bounded ? { bounded: b.bounded } : {}) };
}

// ------------------------------------------------------------------ layouts
export type Pos = { x: number; y: number };
const COL = 260, ROW = 46;

export function basePositions(view: ViewSpec): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  // Forms with their own layout (swim lanes, timelines, two-axis maps, before/after) carry explicit positions.
  if (view.nodes.length > 0 && view.nodes.every((n) => n.pos)) { for (const n of view.nodes) pos.set(n.id, { ...n.pos! }); return pos; }
  if (view.formId === "SemanticMap") {
    // Concept groups are columns (wrapped), file groups stack in a column, symbols stack in a file.
    const fileGroups = view.groups.filter((g) => g.kind === "file" && g.childNodeIds.length);
    const groupById = new Map(view.groups.map((g) => [g.id, g]));
    // A column is a concept; columns of the same domain sit together.
    const colOf = (id: string) => { const concept = groupById.get(id)?.parentGroupId ?? ""; const cluster = groupById.get(concept)?.parentGroupId ?? ""; return `${cluster}|${concept}`; };
    const cols = [...new Set(fileGroups.map((g) => colOf(g.id)))].sort();
    const PER_ROW = 3;
    const height = new Map<number, number>();
    for (const g of fileGroups) { const c = cols.indexOf(colOf(g.id)); height.set(c, (height.get(c) ?? 0) + 40 + g.childNodeIds.length * ROW + 50); }
    const rowOffset: number[] = [];
    for (let r = 0, y = 0; r * PER_ROW < cols.length; r++) {
      rowOffset[r] = y;
      y += Math.max(0, ...cols.slice(r * PER_ROW, r * PER_ROW + PER_ROW).map((_, i) => height.get(r * PER_ROW + i) ?? 0)) + 60;
    }
    const yByCol = new Map<number, number>();
    for (const g of fileGroups) {
      const c = cols.indexOf(colOf(g.id));
      let y = (yByCol.get(c) ?? rowOffset[Math.floor(c / PER_ROW)]) + 40;
      for (const id of g.childNodeIds) { pos.set(id, { x: (c % PER_ROW) * COL, y }); y += ROW; }
      yByCol.set(c, y + 50);
    }
    // Anything not in a file group (should not happen) goes to the right.
    let extra = 0;
    for (const n of view.nodes) if (!pos.has(n.id)) pos.set(n.id, { x: 3 * COL, y: 40 + extra++ * ROW });
    return pos;
  }
  // Layered forms: left to right by `layer`; within a layer ordered by rank then label, centred vertically.
  const layers = new Map<number, ViewNode[]>();
  for (const n of view.nodes) layers.set(n.layer ?? 0, [...(layers.get(n.layer ?? 0) ?? []), n]);
  for (const [layer, ns] of layers) {
    ns.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.label.localeCompare(b.label));
    ns.forEach((n, i) => pos.set(n.id, { x: layer * (COL - 20), y: (i - (ns.length - 1) / 2) * (ROW + 18) }));
  }
  return pos;
}

// ------------------------------------------------------------------ semantic zoom
export interface RenderNode {
  id: string; label: string; kind: "node" | "agg" | "ext"; evidenceIds?: string[]; members: string[]; count: number; displayMode: DisplayMode;
  tier: ViewNode["tier"]; pos: Pos; node?: ViewNode; role?: string; parent?: string; rank?: number; stale: boolean; inTx?: boolean;
}
export interface RenderEdge { id: string; kind?: string; from: string; to: string; displayMode: DisplayMode; label: string; count: number; edgeIds: string[]; evidenceIds: string[]; stale: boolean; ghost?: boolean; ret?: boolean; via?: Pos[]; ambient?: boolean }
export interface Rendered { nodes: RenderNode[]; edges: RenderEdge[]; groups: { id: string; label: string; kind: "file" | "concept" | "cluster" | "lane" | "region"; parent?: string }[] }

const MODE_RANK: Record<DisplayMode, number> = { HIDDEN: 0, FACT: 1, INFERENCE: 2, FOG: 3, HYPOTHESIS: 4 };
const TIER_RANK = { HIDDEN: 0, CONTEXT: 1, RELEVANT: 2, CRITICAL: 3 } as const;
const dirOf = (file: string) => file.split("/").slice(0, -1).join("/") || ".";
const aggregable = (n: ViewNode) => !!n.file && !(n.role && SYNTHETIC.has(n.role));

export function render(view: ViewSpec, level: number, pos: Map<string, Pos>, stale: Set<string> = new Set()): Rendered {
  const conceptOf = new Map<string, { id: string; label: string }>();
  const clusterOf = new Map<string, { id: string; label: string }>();
  for (const g of view.groups) {
    if (g.kind === "concept") for (const id of g.childNodeIds) conceptOf.set(id, { id: g.id, label: g.label });
    if (g.kind === "cluster") for (const id of g.childNodeIds) clusterOf.set(id, { id: g.id, label: g.label });
  }
  const keyOf = (n: ViewNode): { key: string; label: string } | null => {
    if (!aggregable(n) || level >= 4) return null;
    if (level === 0) return { key: "system", label: view.system?.name ?? "system" };
    if (level === 3) return { key: `file:${n.file}`, label: n.file.split("/").slice(-2).join("/") };
    // Levels 1 and 2 fall back gracefully: domain → concept → directory.
    const c = level === 1 ? clusterOf.get(n.id) ?? conceptOf.get(n.id) : conceptOf.get(n.id);
    return c ? { key: c.id, label: c.label } : { key: `dir:${dirOf(n.file)}`, label: dirOf(n.file) };
  };

  // Level 4 keeps what matters; CONTEXT-tier symbols reappear at level 5.
  const visible = view.nodes.filter((n) => !(level === 4 && n.role === "symbol" && n.tier === "CONTEXT"));
  const idOf = new Map<string, string>();
  const nodes: RenderNode[] = [];
  const aggs = new Map<string, RenderNode>();
  for (const n of visible) {
    const k = keyOf(n);
    if (!k) {
      const p = pos.get(n.id) ?? { x: 0, y: 0 };
      idOf.set(n.id, n.id);
      nodes.push({ id: n.id, label: n.rank ? `#${n.rank} ${n.label}${n.hypothesisState === "SUPPORTED" ? " ✓" : ""}` : n.label, kind: "node", members: [n.id], count: 1, displayMode: n.displayMode, tier: n.tier, pos: p, node: n, role: n.role, rank: n.rank, stale: stale.has(n.id) });
      continue;
    }
    const id = `agg:${k.key}`;
    idOf.set(n.id, id);
    const a = aggs.get(id);
    const p = pos.get(n.id) ?? { x: 0, y: 0 };
    if (!a) {
      const r: RenderNode = { id, label: k.label, kind: "agg", members: [n.id], count: 1, displayMode: n.displayMode, tier: n.tier, pos: { ...p }, stale: stale.has(n.id) };
      aggs.set(id, r); nodes.push(r);
    } else {
      a.members.push(n.id); a.count++;
      a.pos = { x: (a.pos.x * (a.count - 1) + p.x) / a.count, y: (a.pos.y * (a.count - 1) + p.y) / a.count };
      if (MODE_RANK[n.displayMode] > MODE_RANK[a.displayMode]) a.displayMode = n.displayMode;
      if (TIER_RANK[n.tier] > TIER_RANK[a.tier]) a.tier = n.tier;
      a.stale = a.stale || stale.has(n.id);
    }
  }
  for (const a of aggs.values()) a.label = `${a.label} (${a.count})`;

  // Level 0 also shows what the system depends on, placed around it.
  const extEdges: RenderEdge[] = [];
  const sys = aggs.get("agg:system");
  if (level === 0 && sys && view.system?.externals.length) {
    const ex = view.system.externals.slice(0, 8);
    ex.forEach((e, i) => {
      const ang = (i / ex.length) * Math.PI * 2 - Math.PI / 2;
      const id = `ext:${e.name}`;
      nodes.push({ id, label: `${e.name} (${e.files})`, kind: "ext", members: [], count: e.files, displayMode: "FACT", tier: "CONTEXT", pos: { x: sys.pos.x + Math.cos(ang) * 330, y: sys.pos.y + Math.sin(ang) * 230 }, role: "external", stale: false, evidenceIds: e.evidenceIds });
      extEdges.push({ id: `exte:${e.name}`, kind: "depends-on", from: sys.id, to: id, displayMode: "FACT", label: "", count: 1, edgeIds: [], evidenceIds: e.evidenceIds, stale: false });
    });
  }

  const merged = new Map<string, RenderEdge>();
  for (const e of view.edges) {
    const from = idOf.get(e.fromNodeId), to = idOf.get(e.toNodeId);
    if (!from || !to || from === to) continue;
    const aggregated = from.startsWith("agg:") || to.startsWith("agg:");
    const key = aggregated ? `${from}>${to}:${e.displayMode}` : e.id;
    const cur = merged.get(key);
    if (cur) { cur.ghost = cur.ghost || e.ghost; cur.ret = cur.ret || e.style === "return"; cur.count++; cur.edgeIds.push(e.id); cur.evidenceIds = [...new Set([...cur.evidenceIds, ...e.evidenceIds])].slice(0, 30); cur.stale = cur.stale || stale.has(e.id); }
    else merged.set(key, { id: aggregated ? `agge:${key}` : e.id, kind: aggregated ? "" : e.kind, from, to, displayMode: e.displayMode, label: e.label ?? "", count: 1, edgeIds: [e.id], evidenceIds: e.evidenceIds.slice(0, 30), stale: stale.has(e.id), ghost: e.ghost, ret: e.style === "return" });
  }
  const edges = [...[...merged.values()].map((e) => (e.count > 1 ? { ...e, label: `${e.count}` } : e)), ...extEdges];
  // Compound groups only exist when symbols are shown individually.
  const groups = level >= 4 ? view.groups.filter((g) => g.childNodeIds.some((c) => idOf.get(c) === c)).map((g) => ({ id: g.id, label: g.label, kind: g.kind, parent: g.parentGroupId })) : [];
  // Brackets that cannot be a parent (a node already sits in a lane) are shown as a flag on the node.
  const bracketed = new Set(view.groups.filter((g) => g.kind === "region" && /transaction/.test(g.label)).flatMap((g) => g.childNodeIds));
  for (const n of nodes) if (bracketed.has(n.id)) n.inTx = true;
  if (level >= 4) {
    // A node has one parent: its file when the form groups by file; otherwise its lane, else its region (wall, owner, zone).
    const parentOf = new Map<string, string>();
    for (const kind of ["region", "lane", "file"] as const) for (const g of view.groups) if (g.kind === kind) for (const c of g.childNodeIds) parentOf.set(c, g.id);
    for (const n of nodes) if (n.kind === "node" && parentOf.has(n.id)) n.parent = parentOf.get(n.id);
  }
  return { nodes, edges, groups };
}

/** Selection is by symbol identity; an aggregate counts as selected when any member is. */
export function selectedAggregates(r: Rendered, selection: string[]): Set<string> {
  const s = new Set(selection);
  return new Set(r.nodes.filter((n) => n.members.some((m) => s.has(m))).map((n) => n.id));
}

// ------------------------------------------------------------------ keyboard navigation and text alternatives
export type Dir = "left" | "right" | "up" | "down";
const MODE_WORD: Record<DisplayMode, string> = { FACT: "fact", INFERENCE: "inference", HYPOTHESIS: "hypothesis", FOG: "fog, some calls unresolved", HIDDEN: "hidden" };
export const modeWord = (m: DisplayMode) => MODE_WORD[m];

/** The nearest node in a direction, preferring ones roughly in line (a 60° cone), then any in that half-plane; wraps nowhere. */
export function nextByDirection(items: { id: string; x: number; y: number }[], currentId: string | null, dir: Dir): string | null {
  if (items.length === 0) return null;
  const cur = items.find((i) => i.id === currentId);
  if (!cur) return [...items].sort((a, b) => a.x - b.x || a.y - b.y)[0].id;
  const v = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[dir];
  let best: { id: string; score: number } | null = null;
  for (const i of items) {
    if (i.id === cur.id) continue;
    const dx = i.x - cur.x, dy = i.y - cur.y;
    const along = dx * v[0] + dy * v[1];
    if (along <= 0) continue;
    const dist = Math.hypot(dx, dy);
    const cos = along / dist;
    const score = dist * (cos >= 0.5 ? 1 : 4 - cos * 4); // out-of-cone candidates are penalised, never excluded
    if (!best || score < best.score) best = { id: i.id, score };
  }
  return best?.id ?? null;
}

export function describeNode(n: RenderNode, r: Rendered, selected: boolean): string {
  const out = r.edges.filter((e) => e.from === n.id).length, inn = r.edges.filter((e) => e.to === n.id).length;
  const what = n.kind === "agg" ? `group of ${n.count}` : n.kind === "ext" ? "external dependency" : n.role ?? n.node?.kind ?? "element";
  const stale = n.stale ? ", stale" : "";
  return `${n.label}, ${what}, ${modeWord(n.displayMode)}${stale}, ${out} outgoing and ${inn} incoming link${out + inn === 1 ? "" : "s"}, ${selected ? "selected" : "not selected"}`;
}

/** A plain-text rendering of the map, so nothing in the picture is available only to people who can see it. */
export function outline(r: Rendered): { id: string; text: string; links: string[] }[] {
  const label = new Map(r.nodes.map((n) => [n.id, n.label]));
  return [...r.nodes].sort((a, b) => a.pos.x - b.pos.x || a.pos.y - b.pos.y).map((n) => ({
    id: n.id,
    text: `${n.label} — ${n.kind === "agg" ? `group of ${n.count}` : n.kind === "ext" ? "external dependency" : n.role ?? n.node?.kind ?? "element"}, ${modeWord(n.displayMode)}${n.stale ? ", stale" : ""}`,
    links: [
      ...r.edges.filter((e) => e.from === n.id).map((e) => `${e.kind && e.kind !== "depends-on" ? e.kind : "→"} ${label.get(e.to) ?? e.to} (${modeWord(e.displayMode)}${e.count > 1 ? `, ${e.count} links` : ""})`),
      ...r.edges.filter((e) => e.to === n.id).map((e) => `from ${label.get(e.from) ?? e.from} (${modeWord(e.displayMode)})`),
    ],
  }));
}

// ------------------------------------------------------------------ terrain (V16): a squarified treemap
export interface Rect { x: number; y: number; w: number; h: number }
/** Squarified treemap (Bruls, Huizing, van Wijk): rectangles with areas proportional to `values`, as close to square as possible. */
export function squarify(values: number[], box: Rect): Rect[] {
  const total = values.reduce((a, b) => a + b, 0);
  const out: Rect[] = new Array(values.length);
  if (!values.length || total <= 0) return values.map(() => ({ ...box, w: 0, h: 0 }));
  const scale = (box.w * box.h) / total;
  const order = values.map((v, i) => ({ i, a: v * scale })).sort((p, q) => q.a - p.a);
  let { x, y, w, h } = box;
  let row: { i: number; a: number }[] = [];
  const worst = (r: { a: number }[], side: number) => { const s = r.reduce((n, c) => n + c.a, 0); const mx = Math.max(...r.map((c) => c.a)), mn = Math.min(...r.map((c) => c.a)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
  const layout = (r: { i: number; a: number }[]) => {
    const s = r.reduce((n, c) => n + c.a, 0);
    if (w >= h) { const rw = s / h; let cy = y; for (const c of r) { const ch = c.a / rw; out[c.i] = { x, y: cy, w: rw, h: ch }; cy += ch; } x += rw; w -= rw; }
    else { const rh = s / w; let cx = x; for (const c of r) { const cw = c.a / rh; out[c.i] = { x: cx, y, w: cw, h: rh }; cx += cw; } y += rh; h -= rh; }
  };
  for (const item of order) {
    const side = Math.min(w, h);
    if (row.length === 0 || worst([...row, item], side) <= worst(row, side)) row.push(item);
    else { layout(row); row = [item]; }
  }
  if (row.length) layout(row);
  return out;
}

/** Composite risk from factor values (0..1) and weights; missing factors count as neutral. */
export function composite(factors: Record<string, number>, weights: Record<string, number>): number {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (sum <= 0) return 0;
  return Object.entries(weights).reduce((n, [k, w]) => n + w * (factors[k] ?? 0.5), 0) / sum;
}

/**
 * Waypoints → Cytoscape `segments` parameters: each waypoint as a fraction along source→target and a signed
 * perpendicular distance from that line (positive = Cytoscape's "left" normal, (-dy, dx)/|d|).
 */
export function viaToSegments(from: Pos, to: Pos, via: Pos[]): { weights: number[]; distances: number[] } | null {
  const dx = to.x - from.x, dy = to.y - from.y, len2 = dx * dx + dy * dy;
  if (len2 < 1) return null;
  const len = Math.sqrt(len2);
  return {
    weights: via.map((p) => ((p.x - from.x) * dx + (p.y - from.y) * dy) / len2),
    distances: via.map((p) => ((p.x - from.x) * -dy + (p.y - from.y) * dx) / len),
  };
}
