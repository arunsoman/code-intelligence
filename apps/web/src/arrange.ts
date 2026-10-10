// Chooses the layout algorithm for a rendered view and applies it. The algorithm follows the shape of the view:
//   aggregated levels (L0–L3, groups of symbols)      → force-directed + overlap removal
//   forms with a layer per node (failure-space etc.)  → layered (Sugiyama)
//   forms that lay out their own columns/lanes        → keep the structure, order rows by barycenter, remove overlaps
// then every edge that would cross a node is routed around it. Selection, claims and evidence are untouched: only
// positions and edge waypoints change, so provenance is never affected by layout.
import type { ViewSpec } from "@cie/schema";
import { callDepth, forceLayout, geometricCrossings, gutterRoutes, laneGrid, layered, pathClear, orderColumns, marginArcs, orderLanes, routeEdges, separate, wrapColumns, type Item } from "./layout.ts";
import type { Pos, Rendered } from "./graph.ts";
import { measure, nodeSize } from "./layoutmetrics.ts";
import { columnFlow } from "./layout.ts";
import type { ElkNode, ELK } from "elkjs/lib/elk-api.js";

// Automatic topology layouts must not erase time, bands or swim-lane ordering.
const TOPOLOGY_CHARTS = new Set(["S1", "S2", "S3", "S4", "S6", "S9", "S10", "S13", "S15", "S16", "S17", "S21", "S23", "S26", "S27"]);
export function usesElk(r: Rendered, formId?: string, chartId?: string): boolean {
  if (!r.nodes.length || r.groups.some((g) => g.kind === "lane")) return false;
  if (["RaceWindow", "Archaeology", "SemanticDiff", "TransactionJourney"].includes(formId ?? "")) return false;
  return r.nodes.some((n) => n.kind === "agg" || n.kind === "ext") ||
    formId === "SemanticMap" ||
    (formId === "GeneratedChart" && TOPOLOGY_CHARTS.has(chartId ?? ""));
}

/** ELK owns graph geometry; all identities, evidence, grouping and selection stay intact. */
async function arrangeDirection(r: Rendered, engine: Pick<ELK, "layout">, viewport: { width: number; height: number }, direction: "DOWN" | "RIGHT"): Promise<Rendered> {
  if (!r.nodes.length) return r;
  const ids = new Set(r.nodes.map((n) => n.id));
  const ratio = Math.max(0.25, Math.min(4, viewport.width / Math.max(1, viewport.height)));
  const containers = new Map(r.groups.map((g) => [g.id, {
    id: g.id, children: [] as ElkNode[], layoutOptions: { "elk.padding": "[top=44,left=24,bottom=24,right=24]" },
  }]));
  const children: ElkNode[] = [];
  for (const n of r.nodes) {
    const s = nodeSize(n), node = { id: n.id, width: s.w, height: Math.max(46, s.h) };
    (n.parent && containers.has(n.parent) ? containers.get(n.parent)!.children : children).push(node);
  }
  for (const g of r.groups) {
    const container = containers.get(g.id)!;
    (g.parent && containers.has(g.parent) ? containers.get(g.parent)!.children : children).push(container);
  }
  const graph: ElkNode = {
    id: "layout-root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": direction,
      "elk.edgeRouting": "ORTHOGONAL", "elk.randomSeed": "1",
      "elk.hierarchyHandling": "INCLUDE_CHILDREN",
      "elk.separateConnectedComponents": "true", "elk.aspectRatio": String(ratio),
      "elk.layered.compaction.connectedComponents": "true",
      "elk.layered.mergeEdges": "true",
      "elk.spacing.nodeNode": "32", "elk.spacing.componentComponent": "48",
      "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.padding": "[top=24,left=24,bottom=24,right=24]",
    },
    children,
    edges: r.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
  };
  const result = await engine.layout(graph);
  const positions = new Map<string, Pos>(), offsets = new Map<string, Pos>();
  const graphs: ElkNode[] = [];
  const collect = (node: ElkNode, offset: Pos) => {
    offsets.set(node.id, offset); graphs.push(node);
    for (const n of node.children ?? []) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) throw new Error(`ELK did not position ${n.id}`);
      const origin = { x: offset.x + n.x!, y: offset.y + n.y! };
      if (ids.has(n.id)) positions.set(n.id, { x: origin.x + (n.width ?? 0) / 2, y: origin.y + (n.height ?? 0) / 2 });
      collect(n, origin);
    }
  };
  collect(result, { x: 0, y: 0 });
  if (positions.size !== r.nodes.length) throw new Error("ELK returned an incomplete layout");
  const routes = new Map(graphs.flatMap((node) => (node.edges ?? []).map((e) => {
    const offset = offsets.get(e.container ?? node.id) ?? { x: 0, y: 0 };
    return [e.id, (e.sections ?? []).flatMap((s) => [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]).map((p) => ({ x: p.x + offset.x, y: p.y + offset.y }))] as const;
  })));
  return { ...r, nodes: r.nodes.map((n) => ({ ...n, pos: positions.get(n.id)! })), edges: r.edges.map((e) => ({ ...e, via: routes.get(e.id) ?? [] })) };
}

/** Post-process an ELK topology layout to reduce remaining straight-line crossings by barycenter ordering within each layer. */
function refineTopology(r: Rendered): Rendered {
  if (r.nodes.length < 3) return r;
  const items: Item[] = r.nodes.map((n) => ({ id: n.id, ...nodeSize(n), x: n.pos.x, y: n.pos.y }));
  const links = r.edges.filter((e) => !e.ambient).map((e) => ({ from: e.from, to: e.to }));
  const before = items.map((i) => ({ ...i }));
  orderColumns(items, links, { permuteColumns: true });
  separate(items, 14);
  const beforeR = measure({ nodes: before.map((i) => ({ id: i.id, label: "", kind: "node" as const, pos: { x: i.x, y: i.y }, members: [i.id], count: 1, displayMode: "FACT" as const, tier: "CONTEXT" as const, stale: false })), edges: r.edges.filter((e) => !e.ambient).map((e) => ({ ...e, from: e.from, to: e.to })), groups: [] });
  const after = { nodes: items.map((i) => ({ id: i.id, label: "", kind: "node" as const, pos: { x: i.x, y: i.y }, members: [i.id], count: 1, displayMode: "FACT" as const, tier: "CONTEXT" as const, stale: false })), edges: r.edges.filter((e) => !e.ambient).map((e) => ({ ...e })), groups: [] };
  const afterR = measure(after);
  if (afterR.edgeCrossings > beforeR.edgeCrossings || afterR.nodeOverlaps > 0 || afterR.edgeThroughNode > 0) return r;
  const at = new Map(items.map((i) => [i.id, i]));
  return { ...r, nodes: r.nodes.map((n) => { const i = at.get(n.id)!; return { ...n, pos: { x: i.x, y: i.y } }; }) };
}

/** Fit at natural node sizes. Never enlarge a small graph just to fill empty pixels. */
export function viewportFit(r: Rendered, viewport: { width: number; height: number }): number {
  if (!r.nodes.length) return 1;
  const boxes = r.nodes.map(n => { const { w, h } = nodeSize(n); return { x1: n.pos.x - w / 2, x2: n.pos.x + w / 2, y1: n.pos.y - h / 2, y2: n.pos.y + h / 2 }; });
  const points = r.edges.flatMap(e => e.via ?? []);
  const width = Math.max(...boxes.map(b => b.x2), ...points.map(p => p.x)) - Math.min(...boxes.map(b => b.x1), ...points.map(p => p.x)) + 96;
  const height = Math.max(...boxes.map(b => b.y2), ...points.map(p => p.y)) - Math.min(...boxes.map(b => b.y1), ...points.map(p => p.y)) + 96;
  return Math.min(1, Math.max(1, viewport.width) / width, Math.max(1, viewport.height) / height);
}

/** Compare topology orientations using actual resulting bounds, not an aspect threshold. */
export async function arrangeElk(r: Rendered, engine: Pick<ELK, "layout">, viewport: { width: number; height: number }): Promise<Rendered> {
  if (!r.nodes.length) return r;
  const preferred = viewport.width >= viewport.height ? "RIGHT" : "DOWN";
  const directions = [preferred, preferred === "RIGHT" ? "DOWN" : "RIGHT"] as const;
  let best: Rendered | undefined, bestFit = -1, lastError: unknown;
  for (const direction of directions) {
    try {
      const candidate = await arrangeDirection(r, engine, viewport, direction);
      const fit = viewportFit(candidate, viewport);
      // Ignore tiny differences to keep orientation stable across panel resizes.
      if (fit > bestFit * 1.04) { best = candidate; bestFit = fit; }
    } catch (error) { lastError = error; }
  }
  if (!best) throw lastError ?? new Error("No usable graph layout");
  return refineTopology(best);
}

const LARGE_JOURNEY = 14; // beyond this a one-column-per-step sequence is an unreadable strip

// Forms where one kind of link is context, not the answer: drawn faint until a node is selected or focused.
const AMBIENT_FORMS = new Set<string>(["Ownership", "DataLineage"]);

export function arrange(r: Rendered, view: ViewSpec, level: number, deferTopology = false): Rendered {
  if (r.nodes.length === 0) return r;
  // The browser sends these graphs to ELK's worker rather than also running a force simulation here.
  if (deferTopology && usesElk(r, view.formId, typeof view.params?.chartId === "string" ? view.params.chartId : undefined)) {
    return AMBIENT_FORMS.has(view.formId) ? { ...r, edges: r.edges.map((e) => e.kind === "imports" ? { ...e, ambient: true } : e) } : r;
  }
  const items: Item[] = r.nodes.map((n) => ({ id: n.id, ...nodeSize(n), x: n.pos.x, y: n.pos.y }));
  const links = r.edges.map((e) => ({ from: e.from, to: e.to }));
  const aggregated = r.nodes.some((n) => n.kind === "agg" || n.kind === "ext");
  const layeredForm = !aggregated && view.nodes.some((n) => n.layer != null) && !view.nodes.every((n) => n.pos);
  const hasFileGroups = !aggregated && view.groups.some((g) => g.kind === "file");
  const laneOf = new Map<string, string>();
  for (const g of view.groups) if (g.kind === "lane") for (const c of g.childNodeIds) laneOf.set(c, g.id);
  let via = new Map<string, Pos[]>();

  if (view.activity && laneOf.size > 0) {
    laneGrid(items, laneOf, links);
    separate(items, 14);
  } else if (view.formId === "GeneratedChart") {
    // The chart plan supplies explicit column/row positions for its chosen notation.
    // Running columnFlow here used to replace those positions with a generic call-graph
    // layout, which erased the model's requested layout (including ER and state charts).
    if (view.params?.chartId === "generic" && laneOf.size === 0 && links.length) {
      const depth = callDepth(items, links);
      const orders = [
        (a: Item, b: Item) => a.x - b.x || a.y - b.y,
        (a: Item, b: Item) => a.y - b.y || a.id.localeCompare(b.id),
        (a: Item, b: Item) => a.id.localeCompare(b.id),
        (a: Item, b: Item) => (depth.get(b.id) ?? 0) - (depth.get(a.id) ?? 0) || a.id.localeCompare(b.id),
      ];
      let bestC = Infinity, bestPos = new Map<string, Pos>(), bestVia = new Map<string, Pos[]>();
      for (const sort of orders) {
        const ranked = [...items].sort(sort);
        const res = layered(ranked.map((it, n) => ({ id: it.id, layer: depth.get(it.id) ?? 0, w: it.w, h: it.h, order: n })), links);
        const probe = items.map((i) => ({ ...i }));
        for (const it of probe) { const p = res.pos.get(it.id); if (p) { it.x = p.x; it.y = p.y; } }
        orderColumns(probe, links, { permuteColumns: true });
        separate(probe, 14);
        const c = geometricCrossings(probe, links);
        if (c < bestC) { bestC = c; bestPos = res.pos; bestVia = res.via; }
      }
      for (const it of items) { const p = bestPos.get(it.id); if (p) { it.x = p.x; it.y = p.y; } }
      via = bestVia;
    }
    separate(items, 14);
  } else if (aggregated) {
    forceLayout(items, links);
    separate(items, 28);
  } else if (layeredForm) {
    const ranked = [...r.nodes].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.label.localeCompare(b.label));
    const res = layered(ranked.map((n, i) => ({ id: n.id, layer: n.node?.layer ?? 0, ...nodeSize(n), order: i })), links);
    for (const it of items) { const p = res.pos.get(it.id); if (p) { it.x = p.x; it.y = p.y; } }
    via = res.via;
    separate(items, 12); // same-layer neighbours already clear; this only guards ghost/ext nodes
  } else {
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
  // Edges that cross swim lanes run along the gutter between the columns, not diagonally over another lane.
  if (!aggregated && laneOf.size > 0) via = new Map([...via, ...gutterRoutes(items, laneOf, links)]);
  const arcs = aggregated ? new Map<string, Pos[]>() : marginArcs(items, keyed);
  // Waypoints from the layered pass are kept only where they clear every node; the rest go to the router.
  const given = new Map([...via, ...arcs]);
  for (const [k, v] of [...given]) { const [f, t] = k.split("\u0001"); if (!pathClear(items, f, t, v)) given.delete(k); }
  const routes = routeEdges(items, keyed, 12, given);
  const at = new Map(items.map((i) => [i.id, i]));
  return {
    ...r,
    nodes: r.nodes.map((n) => { const i = at.get(n.id)!; return { ...n, pos: { x: i.x, y: i.y } }; }),
    edges: r.edges.map((e) => {
      const fallback = e.via && pathClear(items, e.from, e.to, e.via) ? e.via : undefined;
      const v = routes.get(key(e)) ?? fallback;
      const ambient = (AMBIENT_FORMS.has(view.formId) && e.kind === "imports") || (view.formId === "SemanticMap" && e.kind === "reaches");
      const { via: _previousRoute, ...edge } = e;
      return { ...edge, ...(v && v.length ? { via: v } : {}), ...(ambient ? { ambient: true } : {}) };
    }),
  };
}
