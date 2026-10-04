// Chooses the layout algorithm for a rendered view and applies it. The algorithm follows the shape of the view:
//   aggregated levels (L0–L3, groups of symbols)      → force-directed + overlap removal
//   forms with a layer per node (failure-space etc.)  → layered (Sugiyama)
//   forms that lay out their own columns/lanes        → keep the structure, order rows by barycenter, remove overlaps
// then every edge that would cross a node is routed around it. Selection, claims and evidence are untouched: only
// positions and edge waypoints change, so provenance is never affected by layout.
import type { ViewSpec } from "@cie/schema";
import { callDepth, forceLayout, laneGrid, layered, pathClear, orderColumns, marginArcs, orderLanes, routeEdges, separate, wrapColumns, type Item } from "./layout.ts";
import type { Pos, Rendered } from "./graph.ts";
import { nodeSize } from "./layoutmetrics.ts";
import { columnFlow } from "./layout.ts";

const LARGE_JOURNEY = 14; // beyond this a one-column-per-step sequence is an unreadable strip

// Forms where one kind of link is context, not the answer: drawn faint until a node is selected or focused.
const AMBIENT_FORMS = new Set<string>(["Ownership"]);

export function arrange(r: Rendered, view: ViewSpec, level: number): Rendered {
  if (r.nodes.length === 0) return r;
  const items: Item[] = r.nodes.map((n) => ({ id: n.id, ...nodeSize(n), x: n.pos.x, y: n.pos.y }));
  const links = r.edges.map((e) => ({ from: e.from, to: e.to }));
  const aggregated = r.nodes.some((n) => n.kind === "agg" || n.kind === "ext");
  const layeredForm = !aggregated && view.nodes.some((n) => n.layer != null) && !view.nodes.every((n) => n.pos);
  const hasFileGroups = !aggregated && view.groups.some((g) => g.kind === "file");
  let via = new Map<string, Pos[]>();

  if (aggregated) {
    forceLayout(items, links);
    separate(items, 28);
  } else if (layeredForm) {
    const ranked = [...r.nodes].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.label.localeCompare(b.label));
    const res = layered(ranked.map((n, i) => ({ id: n.id, layer: n.node?.layer ?? 0, ...nodeSize(n), order: i })), links);
    for (const it of items) { const p = res.pos.get(it.id); if (p) { it.x = p.x; it.y = p.y; } }
    via = res.via;
    separate(items, 12); // same-layer neighbours already clear; this only guards ghost/ext nodes
  } else {
    const laneOf = new Map<string, string>();
    for (const g of view.groups) if (g.kind === "lane") for (const c of g.childNodeIds) laneOf.set(c, g.id);
    const flow = !hasFileGroups && laneOf.size === 0 && view.formId !== "Ownership" ? columnFlow(items, links) : null;
    if (flow) {
      // Columns that edges flow across are layers of a layered graph: full Sugiyama, columns become layers.
      const res = layered(flow.nodes, flow.links);
      for (const it of items) { const p = res.pos.get(it.id); if (p) { it.x = p.x; it.y = p.y; } }
      via = new Map([...res.via].map(([k, v]) => [k, v]));
      for (const [k, rev] of flow.reversed) if (via.has(k)) { via.set(rev, [...via.get(k)!].reverse()); via.delete(k); }
    } else if (laneOf.size > 0 && items.length > LARGE_JOURNEY && view.formId === "TransactionJourney") {
      if (new Set(laneOf.values()).size === 1) {
        // One lane: the sequence is just a call graph, so lay it out as one, layered by call depth.
        const depth = callDepth(items, links);
        const ranked = [...items].sort((p, q) => p.x - q.x || p.y - q.y);
        const res = layered(ranked.map((it, n) => ({ id: it.id, layer: depth.get(it.id) ?? 0, w: it.w, h: it.h, order: n })), links);
        for (const it of items) { const p = res.pos.get(it.id); if (p) { it.x = p.x; it.y = p.y; } }
        via = res.via;
      } else laneGrid(items, laneOf, links);
    } else if (!hasFileGroups && laneOf.size === 0) { wrapColumns(items); orderColumns(items, links); }
    else if (laneOf.size > 0) orderLanes(items, laneOf, links);
    separate(items, 14);
  }
  const key = (e: { from: string; to: string }) => `${e.from}\u0001${e.to}`;
  const keyed = r.edges.map((e) => ({ from: e.from, to: e.to, key: key(e) }));
  const arcs = aggregated ? new Map<string, Pos[]>() : marginArcs(items, keyed);
  // Waypoints from the layered pass are kept only where they clear every node; the rest go to the router.
  const given = new Map([...via, ...arcs]);
  for (const [k, v] of [...given]) { const [f, t] = k.split("\u0001"); if (!pathClear(items, f, t, v)) given.delete(k); }
  const routes = routeEdges(items, keyed, 12, given);
  const at = new Map(items.map((i) => [i.id, i]));
  return {
    ...r,
    nodes: r.nodes.map((n) => { const i = at.get(n.id)!; return { ...n, pos: { x: i.x, y: i.y } }; }),
    edges: r.edges.map((e) => { const v = routes.get(key(e)); const ambient = AMBIENT_FORMS.has(view.formId) && e.kind === "imports"; return { ...e, ...(v && v.length ? { via: v } : {}), ...(ambient ? { ambient: true } : {}) }; }),
  };
}
