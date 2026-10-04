// Layout algorithms for the canvas. Pure functions over geometry; no DOM.
//
//   layered()        Sugiyama, Tagawa & Toda 1981: dummy nodes for long edges, crossing reduction by median/barycenter
//                    sweeps with adjacent transposition (Eades & Wormald 1994), size-aware coordinate assignment by
//                    isotonic regression toward neighbour positions (a simple stand-in for Brandes & Köpf 2002).
//   forceLayout()    Fruchterman & Reingold 1991, seeded from the given positions so levels keep their mental map.
//   separate()       Node-overlap removal in the style of Dwyer, Marriott & Stuckey 2005: alternating x and y
//                    projections that move nodes the least that removes every overlap.
//   orderColumns()   Barycenter ordering inside the fixed columns/lanes a form lays out itself.
//   routeEdges()     Edges that would pass through a node are rerouted along a visibility graph over the node
//                    corners (the basis of Kieffer et al. 2014's connector routing), so no edge crosses a node.
//
// What this does not do: planarization (Hopcroft–Tarjan/Tamassia), multilevel force layout (Walshaw, FM³, sfdp:
// views here are tens of nodes, where single-level FR is enough), or hierarchical edge bundling (Holten 2006).
// Crossings that remain are counted by layoutmetrics.ts and stated, not hidden.
import type { Pos } from "./graph.ts";

export interface Item { id: string; w: number; h: number; x: number; y: number }
export interface Link { from: string; to: string }
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };

// ------------------------------------------------------------------ overlap removal
/** Move nodes the least that leaves `gap` between every pair. Alternates x and y passes, then falls back to pushing apart. */
export function separate(items: Item[], gap = 14, maxIter = 400): void {
  const need = (a: Item, b: Item) => ({ dx: (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x), dy: (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y) });
  for (let it = 0; it < maxIter; it++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      const { dx, dy } = need(a, b);
      if (dx <= 0 || dy <= 0) continue;
      moved = true;
      // Push along the axis that needs the smaller move; identical centres split on a deterministic axis.
      const alongX = it % 2 === 0 ? dx <= dy : dx < dy * 1.5 && dx <= dy;
      if (alongX) { const s = a.x === b.x ? (hash(a.id) < hash(b.id) ? -1 : 1) : Math.sign(a.x - b.x); a.x += s * dx / 2; b.x -= s * dx / 2; }
      else { const s = a.y === b.y ? (hash(a.id) < hash(b.id) ? -1 : 1) : Math.sign(a.y - b.y); a.y += s * dy / 2; b.y -= s * dy / 2; }
    }
    if (!moved) return;
  }
}

// ------------------------------------------------------------------ force-directed (Fruchterman–Reingold)
/** Pull towards the centroid, as a fraction of the ideal edge length per unit of distance. */
const GRAVITY = 0.005;
export function forceLayout(items: Item[], links: Link[], iterations = 220): void {
  const n = items.length;
  if (n < 2) return;
  const byId = new Map(items.map((i) => [i.id, i]));
  // Coincident seeds get a deterministic nudge so repulsion has a direction.
  for (const i of items) { i.x += (hash(i.id) - 0.5) * 6; i.y += (hash(i.id + "y") - 0.5) * 6; }
  const avgW = items.reduce((s, i) => s + i.w, 0) / n, avgH = items.reduce((s, i) => s + i.h, 0) / n;
  const k = Math.sqrt((avgW + 60) * (avgH + 50)) * 1.45; // ideal edge length scales with node size so boxes fit
  const edges = links.filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to);
  let t = k * 2;
  for (let it = 0; it < iterations; it++) {
    const dx = new Map(items.map((i) => [i.id, 0])), dy = new Map(items.map((i) => [i.id, 0]));
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const a = items[i], b = items[j];
      let ex = a.x - b.x, ey = a.y - b.y;
      const d = Math.max(Math.hypot(ex, ey), 0.01);
      const f = (k * k) / d;
      ex /= d; ey /= d;
      dx.set(a.id, dx.get(a.id)! + ex * f); dy.set(a.id, dy.get(a.id)! + ey * f);
      dx.set(b.id, dx.get(b.id)! - ex * f); dy.set(b.id, dy.get(b.id)! - ey * f);
    }
    for (const e of edges) {
      const a = byId.get(e.from)!, b = byId.get(e.to)!;
      let ex = a.x - b.x, ey = a.y - b.y;
      const d = Math.max(Math.hypot(ex, ey), 0.01);
      const f = (d * d) / k;
      ex /= d; ey /= d;
      dx.set(a.id, dx.get(a.id)! - ex * f); dy.set(a.id, dy.get(a.id)! - ey * f);
      dx.set(b.id, dx.get(b.id)! + ex * f); dy.set(b.id, dy.get(b.id)! + ey * f);
    }
    // Gravity: without it nothing holds a node with few or no links, and disconnected nodes drift thousands of units away, so a fit leaves every node a few pixels wide.
    let cx = 0, cy = 0;
    for (const i of items) { cx += i.x; cy += i.y; }
    cx /= n; cy /= n;
    for (const i of items) { dx.set(i.id, dx.get(i.id)! - (i.x - cx) * GRAVITY * k); dy.set(i.id, dy.get(i.id)! - (i.y - cy) * GRAVITY * k); }
    for (const i of items) {
      const vx = dx.get(i.id)!, vy = dy.get(i.id)!, d = Math.max(Math.hypot(vx, vy), 0.01);
      const m = Math.min(d, t);
      i.x += (vx / d) * m; i.y += (vy / d) * m;
    }
    t *= 0.97;
  }
}

// ------------------------------------------------------------------ crossing counting
/** Crossings between two adjacent layers for the given orders (position index per node). */
function layerCrossings(links: [string, string][], posA: Map<string, number>, posB: Map<string, number>): number {
  let c = 0;
  for (let i = 0; i < links.length; i++) for (let j = i + 1; j < links.length; j++) {
    const [a1, b1] = [posA.get(links[i][0])!, posB.get(links[i][1])!], [a2, b2] = [posA.get(links[j][0])!, posB.get(links[j][1])!];
    if ((a1 - a2) * (b1 - b2) < 0) c++;
  }
  return c;
}

// ------------------------------------------------------------------ layered (Sugiyama)
export interface LayeredNode { id: string; layer: number; w: number; h: number; order?: number }
export interface LayeredResult { pos: Map<string, Pos>; via: Map<string, Pos[]>; crossings: number }

/** Isotonic placement: positions closest (least squares) to `want` that keep `sep[i]` between neighbours, in order. */
function place(want: number[], sep: number[]): number[] {
  // Substitute z_i = y_i - offset_i so the spacing constraint becomes monotonicity, then pool adjacent violators.
  const off: number[] = [0];
  for (let i = 1; i < want.length; i++) off[i] = off[i - 1] + sep[i - 1];
  const target = want.map((w, i) => w - off[i]);
  const blocks: { sum: number; n: number }[] = [];
  for (const v of target) {
    blocks.push({ sum: v, n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].sum / blocks[blocks.length - 2].n > blocks[blocks.length - 1].sum / blocks[blocks.length - 1].n) {
      const b = blocks.pop()!, a = blocks.pop()!;
      blocks.push({ sum: a.sum + b.sum, n: a.n + b.n });
    }
  }
  const out: number[] = [];
  for (const b of blocks) for (let i = 0; i < b.n; i++) out.push(b.sum / b.n);
  return out.map((z, i) => z + off[i]);
}

export function layered(nodes: LayeredNode[], links: Link[], opts: { gapX?: number; gapY?: number; sweeps?: number } = {}): LayeredResult {
  const gapX = opts.gapX ?? 90, gapY = opts.gapY ?? 26, sweeps = opts.sweeps ?? 28;
  const layerIds = [...new Set(nodes.map((n) => n.layer))].sort((a, b) => a - b);
  const idx = new Map(layerIds.map((l, i) => [l, i]));
  type V = { id: string; li: number; w: number; h: number; dummy?: boolean };
  const verts = new Map<string, V>(nodes.map((n) => [n.id, { id: n.id, li: idx.get(n.layer)!, w: n.w, h: n.h }]));
  // Forward edges only shape the layering; same-layer and backward edges are routed afterwards.
  const segs: [string, string][] = [];
  const chains = new Map<string, string[]>();
  for (const l of links) {
    const a = verts.get(l.from), b = verts.get(l.to);
    if (!a || !b || b.li <= a.li) continue;
    const chain = [l.from];
    for (let li = a.li + 1; li < b.li; li++) { const id = `~${l.from}\u0001${l.to}@${li}`; verts.set(id, { id, li, w: 6, h: 6, dummy: true }); chain.push(id); }
    chain.push(l.to);
    chains.set(`${l.from}\u0001${l.to}`, chain);
    for (let i = 0; i + 1 < chain.length; i++) segs.push([chain[i], chain[i + 1]]);
  }
  const layers: string[][] = layerIds.map(() => []);
  const seedOrder = new Map(nodes.map((n, i) => [n.id, n.order ?? i]));
  for (const v of [...verts.values()].sort((a, b) => (seedOrder.get(a.id) ?? 1e6) - (seedOrder.get(b.id) ?? 1e6) || a.id.localeCompare(b.id))) layers[v.li].push(v.id);
  const up = new Map<string, string[]>(), down = new Map<string, string[]>();
  for (const [a, b] of segs) { down.set(a, [...(down.get(a) ?? []), b]); up.set(b, [...(up.get(b) ?? []), a]); }
  const posOf = () => new Map(layers.flatMap((L) => L.map((id, i) => [id, i] as [string, number])));
  const total = () => { const p = posOf(); let c = 0; for (let i = 0; i + 1 < layers.length; i++) c += layerCrossings(segs.filter(([a, b]) => verts.get(a)!.li === i && verts.get(b)!.li === i + 1), p, p); return c; };
  const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  let best = layers.map((L) => [...L]), bestC = total();
  for (let s = 0; s < sweeps && bestC > 0; s++) {
    const downward = s % 2 === 0;
    const order = downward ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse();
    for (const li of order) {
      const p = posOf(), nb = downward ? up : down;
      const key = new Map(layers[li].map((id, i) => { const ns = (nb.get(id) ?? []).map((x) => p.get(x)!); return [id, ns.length ? (s % 4 < 2 ? median(ns) : ns.reduce((a, b) => a + b, 0) / ns.length) : i] as [string, number]; }));
      layers[li].sort((a, b) => key.get(a)! - key.get(b)! || layers[li].indexOf(a) - layers[li].indexOf(b));
      // Transpose: swap adjacent pairs while that removes a crossing.
      for (let pass = 0, improved = true; improved && pass < 6; pass++) {
        improved = false;
        for (let i = 0; i + 1 < layers[li].length; i++) {
          const before = total();
          [layers[li][i], layers[li][i + 1]] = [layers[li][i + 1], layers[li][i]];
          if (total() < before) improved = true; else [layers[li][i], layers[li][i + 1]] = [layers[li][i + 1], layers[li][i]];
        }
      }
    }
    const c = total();
    if (c < bestC) { bestC = c; best = layers.map((L) => [...L]); }
  }
  for (let i = 0; i < layers.length; i++) layers[i] = best[i];

  // Coordinates. x by layer (widest node in each), y by isotonic regression toward neighbour centres.
  const xOf: number[] = [];
  const maxW = layers.map((L) => Math.max(...L.map((id) => verts.get(id)!.w), 0));
  layers.forEach((_, i) => { xOf[i] = i === 0 ? 0 : xOf[i - 1] + maxW[i - 1] / 2 + gapX + maxW[i] / 2; });
  const y = new Map<string, number>();
  for (const L of layers) { let cur = 0; for (const id of L) { const v = verts.get(id)!; y.set(id, cur + v.h / 2); cur += v.h + gapY; } }
  const sepFor = (L: string[]) => L.slice(1).map((id, i) => (verts.get(L[i])!.h + verts.get(id)!.h) / 2 + (verts.get(id)!.dummy || verts.get(L[i])!.dummy ? gapY / 2 : gapY));
  for (let s = 0; s < 12; s++) {
    const downward = s % 2 === 0;
    const order = downward ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).slice(0, -1).reverse();
    for (const li of order) {
      const L = layers[li], nb = downward ? up : down;
      const want = L.map((id) => { const ns = nb.get(id) ?? []; return ns.length ? ns.reduce((a, x) => a + y.get(x)!, 0) / ns.length : y.get(id)!; });
      const placed = place(want, sepFor(L));
      L.forEach((id, i) => y.set(id, placed[i]));
    }
  }
  const all = [...y.values()];
  const mid = (Math.min(...all) + Math.max(...all)) / 2;
  const pos = new Map<string, Pos>();
  for (const n of nodes) pos.set(n.id, { x: xOf[verts.get(n.id)!.li], y: y.get(n.id)! - mid });
  const via = new Map<string, Pos[]>();
  for (const [k, chain] of chains) if (chain.length > 2) via.set(k, chain.slice(1, -1).map((id) => ({ x: xOf[verts.get(id)!.li], y: y.get(id)! - mid })));
  return { pos, via, crossings: bestC };
}

// ------------------------------------------------------------------ forms whose columns are layers
/**
 * Decides whether a form that lays out its own columns is really a layered graph: at least two columns and most
 * edges running between different columns. Returns the layered input (edges oriented left to right, since only forward
 * edges shape a layering) plus which edges were reversed so their waypoints can be flipped back.
 */
export function columnFlow(items: Item[], links: Link[], tol = 60): { nodes: LayeredNode[]; links: Link[]; reversed: Map<string, string> } | null {
  const xs = [...new Set(items.map((i) => Math.round(i.x)))].sort((a, b) => a - b);
  const clusters: number[] = [];
  for (const x of xs) if (!clusters.length || x - clusters[clusters.length - 1] > tol) clusters.push(x);
  if (clusters.length < 2) return null;
  const layerOf = (i: Item) => { let k = 0; for (let c = 0; c < clusters.length; c++) if (Math.round(i.x) >= clusters[c]) k = c; return k; };
  const byId = new Map(items.map((i) => [i.id, i]));
  const live = links.filter((l) => byId.has(l.from) && byId.has(l.to) && l.from !== l.to);
  if (!live.length) return null;
  const across = live.filter((l) => layerOf(byId.get(l.from)!) !== layerOf(byId.get(l.to)!)).length;
  if (across / live.length < 0.6) return null;
  const reversed = new Map<string, string>();
  const oriented = live.map((l) => {
    const a = layerOf(byId.get(l.from)!), b = layerOf(byId.get(l.to)!);
    if (a <= b) return l;
    reversed.set(`${l.to}\u0001${l.from}`, `${l.from}\u0001${l.to}`);
    return { from: l.to, to: l.from };
  });
  const sorted = [...items].sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
  return { nodes: sorted.map((i, n) => ({ id: i.id, layer: layerOf(i), w: i.w, h: i.h, order: n })), links: oriented, reversed };
}

// ------------------------------------------------------------------ large swim-lane sequences
/**
 * A one-column-per-step sequence stops being readable past a dozen steps. Keep the swim lanes (rows) but put steps in
 * columns by call depth instead of call order, stacking steps that share a lane and depth in their original order.
 */
export function callDepth(items: Item[], links: Link[]): Map<string, number> {
  const order = [...items].sort((a, b) => a.x - b.x || a.y - b.y);
  const first = order[0];
  const out = new Map<string, string[]>();
  for (const l of links) out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const it of order) if (!links.some((l) => l.to === it.id)) { depth.set(it.id, 0); queue.push(it.id); }
  if (!queue.length && first) { depth.set(first.id, 0); queue.push(first.id); }
  while (queue.length) { const id = queue.shift()!; for (const to of out.get(id) ?? []) if (!depth.has(to)) { depth.set(to, depth.get(id)! + 1); queue.push(to); } }
  const maxD = Math.max(0, ...depth.values());
  for (const it of order) if (!depth.has(it.id)) depth.set(it.id, maxD + 1);
  return depth;
}

export function laneGrid(items: Item[], laneOf: Map<string, string>, links: Link[], pitchX = 40, pitchY = 18): void {
  const order = [...items].sort((a, b) => a.x - b.x || a.y - b.y);
  const depth = callDepth(items, links);
  const lanes = [...new Set(order.map((i) => laneOf.get(i.id) ?? ""))];
  const cell = new Map<string, Item[]>();
  for (const it of order) { const k = `${laneOf.get(it.id) ?? ""}|${depth.get(it.id)}`; cell.set(k, [...(cell.get(k) ?? []), it]); }
  const depths = [...new Set(depth.values())].sort((a, b) => a - b);
  const colW = depths.map((d) => Math.max(...items.filter((i) => depth.get(i.id) === d).map((i) => i.w)));
  const colX: number[] = [];
  depths.forEach((_, n) => { colX[n] = n === 0 ? 0 : colX[n - 1] + colW[n - 1] / 2 + pitchX + colW[n] / 2; });
  const band = lanes.map((l) => Math.max(1, ...depths.map((d) => (cell.get(`${l}|${d}`) ?? []).length)));
  const rowH = Math.max(...items.map((i) => i.h)) + pitchY;
  let y = 0;
  lanes.forEach((l, li) => {
    for (const [di, d] of depths.entries()) (cell.get(`${l}|${d}`) ?? []).forEach((it, n) => { it.x = colX[di]; it.y = y + n * rowH; });
    y += band[li] * rowH + 40;
  });
}

// ------------------------------------------------------------------ wrapping tall columns
/**
 * A column with more than `maxRows` nodes becomes several side-by-side sub-columns (a column of 36 files is a strip
 * no zoom can read). Columns to its right shift over so nothing collides. Row order inside is left to orderColumns.
 */
export function wrapColumns(items: Item[], maxRows = 12, gap = 40): boolean {
  const cols = new Map<number, Item[]>();
  for (const i of items) cols.set(Math.round(i.x), [...(cols.get(Math.round(i.x)) ?? []), i]);
  if (![...cols.values()].some((L) => L.length > maxRows)) return false;
  const keys = [...cols.keys()].sort((a, b) => a - b);
  const width = (L: Item[]) => Math.max(...L.map((i) => i.w));
  let cursor = -Infinity;
  let prevOrigin = keys[0], prevRight = 0, shift = 0;
  for (const k of keys) {
    const L = cols.get(k)!.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    const w = width(L), parts = Math.ceil(L.length / maxRows), rows = Math.ceil(L.length / parts);
    const ys = L.slice(0, rows).map((i) => i.y);
    const left = cursor === -Infinity ? k : Math.max(k + shift, prevRight + gap + w / 2);
    L.forEach((it, n) => { const part = Math.floor(n / rows); it.x = left + part * (w + gap); it.y = ys[n % rows] ?? it.y; });
    shift = left - k; prevRight = left + (parts - 1) * (w + gap) + w / 2; prevOrigin = k; cursor = left;
  }
  void prevOrigin;
  return true;
}

// ------------------------------------------------------------------ ordering inside fixed columns / lanes
/** Straight-line crossings between links at the items' current centres; links sharing an end do not count. */
export function geometricCrossings(items: Item[], links: Link[]): number {
  const byId = new Map(items.map((i) => [i.id, i]));
  const segs = links.map((l) => [byId.get(l.from), byId.get(l.to)] as const).filter((s): s is readonly [Item, Item] => !!s[0] && !!s[1] && s[0] !== s[1]);
  let c = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const [a, b] = segs[i], [p, q] = segs[j];
    if (a === p || a === q || b === p || b === q) continue;
    if (crosses([a.x, a.y], [b.x, b.y], [p.x, p.y], [q.x, q.y])) c++;
  }
  return c;
}

const swapPos = (a: Item, b: Item, other: "x" | "y") => { const t = a[other]; a[other] = b[other]; b[other] = t; };

/**
 * A form that lays out its own columns keeps each node's column; the rows inside a column are free, so they are
 * ordered by median sweeps over the edges (Eades & Wormald) and then improved by swapping any two rows in a column
 * while that lowers the real crossing count. With `permuteColumns` whole columns may trade places too (owner
 * columns have no left-to-right meaning; trust zones do).
 */
export function orderColumns(items: Item[], links: Link[], opts: { permuteColumns?: boolean; sweeps?: number } = {}): void {
  const cols = new Map<number, Item[]>();
  for (const i of items) cols.set(Math.round(i.x), [...(cols.get(Math.round(i.x)) ?? []), i]);
  if (cols.size < 2 && items.length < 3) return;
  const slots = new Map<number, number[]>();
  for (const [c, L] of cols) { L.sort((a, b) => a.y - b.y || a.id.localeCompare(b.id)); slots.set(c, L.map((i) => i.y)); }
  const keys = [...cols.keys()].sort((a, b) => a - b);
  const adj = new Map<string, string[]>();
  for (const l of links) { adj.set(l.from, [...(adj.get(l.from) ?? []), l.to]); adj.set(l.to, [...(adj.get(l.to) ?? []), l.from]); }
  const byId = new Map(items.map((i) => [i.id, i]));
  const apply = () => { for (const [c, L] of cols) L.forEach((it, i) => { it.y = slots.get(c)![i]; }); };
  apply();
  let bestC = geometricCrossings(items, links);
  const snapshot = () => new Map(items.map((i) => [i.id, [i.x, i.y] as [number, number]]));
  let best = snapshot();
  const restore = (m: Map<string, [number, number]>) => { for (const i of items) { const p = m.get(i.id)!; i.x = p[0]; i.y = p[1]; } };
  for (let s = 0; s < (opts.sweeps ?? 24) && bestC > 0; s++) {
    for (const c of s % 2 === 0 ? keys : [...keys].reverse()) {
      const L = cols.get(c)!;
      const key = new Map(L.map((it) => { const ns = (adj.get(it.id) ?? []).map((id) => byId.get(id)!).filter((n) => Math.round(n.x) !== c).map((n) => n.y); const sorted = ns.sort((a, b) => a - b); const m = sorted.length >> 1; return [it.id, sorted.length ? (sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2) : it.y] as [string, number]; }));
      L.sort((a, b) => key.get(a.id)! - key.get(b.id)! || a.id.localeCompare(b.id));
      L.forEach((it, i) => { it.y = slots.get(c)![i]; });
    }
    const now = geometricCrossings(items, links);
    if (now < bestC) { bestC = now; best = snapshot(); }
  }
  restore(best);
  // Re-sync column lists to the restored order.
  for (const [c, L] of cols) { L.sort((a, b) => a.y - b.y); void c; }
  // Swap search: any two rows in the same column, accepted only if crossings drop. Bounded so large views stay fast.
  if (items.length <= 70) {
    for (let pass = 0, improved = true; improved && pass < 8; pass++) {
      improved = false;
      for (const L of cols.values()) for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
        swapPos(L[i], L[j], "y");
        const now = geometricCrossings(items, links);
        if (now < bestC) { bestC = now; improved = true; [L[i], L[j]] = [L[j], L[i]]; } else swapPos(L[i], L[j], "y");
      }
    }
  }
  if (opts.permuteColumns && cols.size > 1 && items.length <= 70) {
    for (let pass = 0, improved = true; improved && pass < 4; pass++) {
      improved = false;
      for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
        const A = cols.get(keys[i])!, B = cols.get(keys[j])!, xa = keys[i], xb = keys[j];
        const ax = A.map((it) => it.x), bx = B.map((it) => it.x);
        for (const it of A) it.x = bx[0] ?? xb; for (const it of B) it.x = ax[0] ?? xa;
        const now = geometricCrossings(items, links);
        if (now < bestC) { bestC = now; improved = true; cols.set(keys[i], B); cols.set(keys[j], A); } else { A.forEach((it, k) => { it.x = ax[k]; }); B.forEach((it, k) => { it.x = bx[k]; }); }
      }
    }
  }
}

/**
 * Swim-lane forms: each lane is a unit (its nodes keep their order along the lane, which is call order). The order of
 * the lanes themselves has no meaning, so lanes are permuted to cut crossings by swapping whole lanes.
 */
export function orderLanes(items: Item[], laneOf: Map<string, string>, links: Link[], pinFirst = true): void {
  const lanes = new Map<string, Item[]>();
  for (const i of items) { const l = laneOf.get(i.id); if (l) lanes.set(l, [...(lanes.get(l) ?? []), i]); }
  if (lanes.size < 3 || items.length > 70) return;
  const ys = new Map([...lanes].map(([l, L]) => [l, L.reduce((a, i) => a + i.y, 0) / L.length]));
  const order = [...lanes.keys()].sort((a, b) => ys.get(a)! - ys.get(b)! || a.localeCompare(b));
  const dy = new Map<string, Map<string, number>>(); // node offset within its lane
  for (const [l, L] of lanes) dy.set(l, new Map(L.map((i) => [i.id, i.y - ys.get(l)!])));
  const slotY = order.map((l) => ys.get(l)!);
  const place = (ord: string[]) => ord.forEach((l, k) => { for (const i of lanes.get(l)!) i.y = slotY[k] + dy.get(l)!.get(i.id)!; });
  let cur = [...order];
  place(cur);
  let bestC = geometricCrossings(items, links);
  for (let pass = 0, improved = true; improved && pass < 6; pass++) {
    improved = false;
    for (let i = pinFirst ? 1 : 0; i < cur.length; i++) for (let j = i + 1; j < cur.length; j++) {
      const trial = [...cur]; [trial[i], trial[j]] = [trial[j], trial[i]];
      place(trial);
      const now = geometricCrossings(items, links);
      if (now < bestC) { bestC = now; cur = trial; improved = true; }
    }
    place(cur);
  }
  place(cur);
}

// ------------------------------------------------------------------ edge routing around nodes
type Pt = [number, number];
const ccw = (a: Pt, b: Pt, c: Pt) => (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0]);
const crosses = (a: Pt, b: Pt, c: Pt, d: Pt) => { const d1 = ccw(a, b, c), d2 = ccw(a, b, d), d3 = ccw(c, d, a), d4 = ccw(c, d, b); return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)); };
/** True when the segment passes through the open interior of the box (touching an edge or corner is allowed). */
function hits(a: Pt, b: Pt, bx: { x1: number; y1: number; x2: number; y2: number }): boolean {
  const e = 0.5, x1 = bx.x1 + e, y1 = bx.y1 + e, x2 = bx.x2 - e, y2 = bx.y2 - e;
  // A segment whose bounding box misses the interior entirely cannot enter it: this is the common case and skips the geometry.
  if (Math.max(a[0], b[0]) <= x1 || Math.min(a[0], b[0]) >= x2 || Math.max(a[1], b[1]) <= y1 || Math.min(a[1], b[1]) >= y2) return false;
  const inside = (p: Pt) => p[0] > x1 && p[0] < x2 && p[1] > y1 && p[1] < y2;
  if (inside(a) || inside(b)) return true;
  // Midpoint test catches a segment that runs along the shrunk interior without crossing a side.
  if (inside([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])) return true;
  return crosses(a, b, [x1, y1], [x2, y1]) || crosses(a, b, [x2, y1], [x2, y2]) || crosses(a, b, [x2, y2], [x1, y2]) || crosses(a, b, [x1, y2], [x1, y1]);
}

/**
 * Links between two nodes on the same column (or the same row) would run straight through the nodes between them.
 * They are drawn as C-shaped arcs in the margin instead, on whichever side crosses fewer earlier arcs, with deeper
 * arcs for longer spans so nested arcs never cross. Returns waypoints per link key.
 */
export function marginArcs(items: Item[], links: { from: string; to: string; key: string }[], pad = 26, step = 14): Map<string, Pos[]> {
  const out = new Map<string, Pos[]>();
  const byId = new Map(items.map((i) => [i.id, i]));
  const boxes = new Map(items.map((i) => [i, { x1: i.x - i.w / 2, y1: i.y - i.h / 2, x2: i.x + i.w / 2, y2: i.y + i.h / 2 }]));
  const box = (i: Item) => boxes.get(i)!;
  for (const vertical of [true, false]) {
    const near = (a: number, b: number) => Math.abs(a - b) < 1;
    const cand = links.map((l) => ({ l, a: byId.get(l.from), b: byId.get(l.to) }))
      .filter((c): c is { l: typeof c.l; a: Item; b: Item } => !!c.a && !!c.b && c.a !== c.b && (vertical ? near(c.a.x, c.b.x) : near(c.a.y, c.b.y)))
      .filter((c) => items.some((o) => o !== c.a && o !== c.b && hits([c.a.x, c.a.y], [c.b.x, c.b.y], box(o))))
      .sort((p, q) => (vertical ? Math.abs(p.a.y - p.b.y) - Math.abs(q.a.y - q.b.y) : Math.abs(p.a.x - p.b.x) - Math.abs(q.a.x - q.b.x)));
    const placed: { side: number; lo: number; hi: number; level: number; line: number }[] = [];
    for (const c of cand) {
      const lo = vertical ? Math.min(c.a.y, c.b.y) : Math.min(c.a.x, c.b.x), hi = vertical ? Math.max(c.a.y, c.b.y) : Math.max(c.a.x, c.b.x);
      const line = vertical ? c.a.x : c.a.y;
      const half = (vertical ? Math.max(c.a.w, c.b.w) : Math.max(c.a.h, c.b.h)) / 2;
      let bestSide = 1, bestCost = Infinity, bestLevel = 0;
      for (const side of [1, -1]) {
        // Arcs on this side whose span overlaps ours: the new arc must sit outside any it contains and inside none it only partly overlaps.
        const sameSide = placed.filter((q) => q.side === side && q.line === line && q.lo < hi && lo < q.hi);
        const partial = sameSide.filter((q) => !(q.lo <= lo && hi <= q.hi) && !(lo <= q.lo && q.hi <= hi)).length;
        const level = sameSide.length ? Math.max(...sameSide.map((q) => q.level)) + 1 : 0;
        // Links leaving the rows the arc spans, on the arc's side, would be crossed by it: prefer the quieter side.
        const crossed = links.reduce((n, o) => {
          const p = byId.get(o.from), q = byId.get(o.to);
          if (!p || !q) return n;
          for (const [mine, theirs] of [[p, q], [q, p]] as const) {
            const row = vertical ? mine.y : mine.x, col = vertical ? mine.x : mine.y, tcol = vertical ? theirs.x : theirs.y;
            if (col === line && row > lo && row < hi && Math.sign(tcol - col) === side && Math.abs(tcol - col) > 1) return n + 1;
          }
          return n;
        }, 0);
        const cost = partial * 100 + level + crossed * 20;
        if (cost < bestCost) { bestCost = cost; bestSide = side; bestLevel = level; }
      }
      placed.push({ side: bestSide, lo, hi, level: bestLevel, line });
      const off = bestSide * (half + pad + bestLevel * step);
      const way: Pos[] = vertical ? [{ x: c.a.x + off, y: c.a.y }, { x: c.a.x + off, y: c.b.y }] : [{ x: c.a.x, y: c.a.y + off }, { x: c.b.x, y: c.a.y + off }];
      // An arc is kept only if it clears every other node; otherwise the visibility router handles this link.
      const pts: Pt[] = [[c.a.x, c.a.y], ...way.map((w): Pt => [w.x, w.y]), [c.b.x, c.b.y]];
      const clear = items.every((o) => o === c.a || o === c.b || pts.slice(1).every((p, k) => !hits(pts[k], p, box(o))));
      if (clear) out.set(c.l.key, way); else placed.pop();
    }
  }
  return out;
}

/**
 * For each link whose straight line crosses another node, find the shortest polyline around the nodes through the
 * corners of their padded boxes. Returns waypoints per `from>to` key. Links with a clear straight line get none.
 */
/** True when the polyline from → via… → to clears every other node. */
export function pathClear(items: Item[], from: string, to: string, via: Pos[]): boolean {
  const a = items.find((i) => i.id === from), b = items.find((i) => i.id === to);
  if (!a || !b) return true;
  const pts: Pt[] = [[a.x, a.y], ...via.map((p): Pt => [p.x, p.y]), [b.x, b.y]];
  return items.every((o) => o === a || o === b || pts.slice(1).every((p, k) => !hits(pts[k], p, { x1: o.x - o.w / 2 - 4, y1: o.y - o.h / 2 - 4, x2: o.x + o.w / 2 + 4, y2: o.y + o.h / 2 + 4 })));
}

export function routeEdges(items: Item[], links: { from: string; to: string; key: string }[], pad = 12, existing: Map<string, Pos[]> = new Map()): Map<string, Pos[]> {
  const out = new Map<string, Pos[]>(existing);
  const byId = new Map(items.map((i) => [i.id, i]));
  const box = (i: Item, p = 0) => ({ x1: i.x - i.w / 2 - p, y1: i.y - i.h / 2 - p, x2: i.x + i.w / 2 + p, y2: i.y + i.h / 2 + p });
  if (items.length > 160) return out; // beyond this the straight edges are kept and the metric says so
  for (const l of links) {
    if (out.has(l.key)) continue;
    const a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b || a === b) continue;
    const obstacles = items.filter((i) => i !== a && i !== b);
    const s: Pt = [a.x, a.y], t: Pt = [b.x, b.y];
    if (!obstacles.some((o) => hits(s, t, box(o)))) continue;
    // Only obstacles near the detour matter; cull the rest to keep the graph small.
    const lo: Pt = [Math.min(s[0], t[0]) - 400, Math.min(s[1], t[1]) - 400], hi: Pt = [Math.max(s[0], t[0]) + 400, Math.max(s[1], t[1]) + 400];
    const near = obstacles.filter((o) => o.x > lo[0] && o.x < hi[0] && o.y > lo[1] && o.y < hi[1]);
    const verts: Pt[] = [s, t];
    for (const o of near) { const p = box(o, pad); verts.push([p.x1, p.y1], [p.x2, p.y1], [p.x2, p.y2], [p.x1, p.y2]); }
    const free = (p: Pt, q: Pt) => !near.some((o) => hits(p, q, box(o, 2))); // a 2px margin: a path that merely grazes a corner is not clear
    const dist = verts.map(() => Infinity), prev = verts.map(() => -1), done = verts.map(() => false);
    dist[0] = 0;
    for (;;) {
      let u = -1;
      for (let i = 0; i < verts.length; i++) if (!done[i] && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] === Infinity || u === 1) break;
      done[u] = true;
      for (let v = 0; v < verts.length; v++) {
        if (done[v]) continue;
        const d = dist[u] + Math.hypot(verts[u][0] - verts[v][0], verts[u][1] - verts[v][1]) + 6; // small per-bend cost keeps routes plain
        if (d < dist[v] && free(verts[u], verts[v])) { dist[v] = d; prev[v] = u; }
      }
    }
    if (prev[1] < 0) continue;
    const path: Pos[] = [];
    for (let v = prev[1]; v > 0; v = prev[v]) path.unshift({ x: verts[v][0], y: verts[v][1] });
    if (path.length) out.set(l.key, path);
  }
  return out;
}
