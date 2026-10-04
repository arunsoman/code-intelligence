// C09 fact graph and projection query engine: bounded, deterministic, access-aware questions about the call graph.
//   project      what is reachable from some roots, in a direction, within a depth and a node budget
//   findPath     the shortest chain between two entities, never through anything the caller may not see
//   dependents   who reaches an entity (the reverse of project)
//   cycles       strongly connected components of size > 1 (a cycle is reported, never looped on)
// Every answer says what it could not do: cut by depth, cut by the node budget, or hidden by access policy (as a count,
// never by name). The same graph always gives the same projection and the same hash, however it was stored.
import { createHash } from "node:crypto";
import type { Entity, Relationship } from "@cie/schema";
import { OPEN, type AccessPolicy } from "./access.ts";
import type { Store } from "./store.ts";

export const DEFAULT_KINDS = ["calls", "async-flow"];
export const LIMITS = { maxDepth: 12, maxNodes: 2000 };
export type Direction = "out" | "in" | "both";
export interface GraphOpts { kinds?: string[]; access?: AccessPolicy; maxDepth?: number; maxNodes?: number; direction?: Direction }

export interface Projection {
  revision: string; roots: string[]; direction: Direction; kinds: string[];
  nodes: { id: string; name: string; kind: string; file: string; depth: number }[];
  edges: { id: string; from: string; to: string; kind: string; evidenceIds: string[] }[];
  truncated: { byDepth: boolean; byNodes: boolean };
  /** Entities and edges left out because the caller may not see them: how many, never which. */
  omittedByAccess: number;
  cycles: string[][];
  hash: string;
}

const hashOf = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
const cap = (n: number | undefined, max: number, dflt: number) => Math.max(0, Math.min(n ?? dflt, max));

interface Adj { out: Map<string, Relationship[]>; inn: Map<string, Relationship[]>; ents: Map<string, Entity> }
function adjacency(store: Store, rev: string, kinds: string[]): Adj {
  const out = new Map<string, Relationship[]>(), inn = new Map<string, Relationship[]>();
  const ks = new Set(kinds);
  for (const r of store.allRelationships(rev)) {
    if (!ks.has(r.kind)) continue;
    (out.get(r.from) ?? out.set(r.from, []).get(r.from)!).push(r);
    (inn.get(r.to) ?? inn.set(r.to, []).get(r.to)!).push(r);
  }
  // Stored order is an accident of insertion; sort so every traversal is the same everywhere.
  for (const m of [out, inn]) for (const l of m.values()) l.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { out, inn, ents: new Map(store.entities(rev).map((e) => [e.entityId, e])) };
}
const hidden = (a: AccessPolicy, ents: Map<string, Entity>, id: string) => a.deniedEntity(id, (x) => ents.get(x)?.file);

/** Reachability from `roots`, breadth-first, bounded. A node that is reached twice is visited once (cycles terminate). */
export function project(store: Store, rev: string, roots: string[], o: GraphOpts = {}): Projection {
  const kinds = o.kinds ?? DEFAULT_KINDS, access = o.access ?? OPEN, direction = o.direction ?? "out";
  const maxDepth = cap(o.maxDepth, LIMITS.maxDepth, 4), maxNodes = Math.max(1, Math.min(o.maxNodes ?? 400, LIMITS.maxNodes));
  const g = adjacency(store, rev, kinds);
  const depth = new Map<string, number>(); const edges = new Map<string, Relationship>();
  let omitted = 0, byDepth = false, byNodes = false;
  const start = [...new Set(roots)].filter((r) => g.ents.has(r)).sort();
  for (const r of start) { if (hidden(access, g.ents, r)) { omitted++; continue; } depth.set(r, 0); }
  let frontier = [...depth.keys()];
  for (let d = 0; frontier.length; d++) {
    if (d >= maxDepth) { byDepth = frontier.some((id) => step(id).some((r) => { const o2 = r.from === id ? r.to : r.from; return !depth.has(o2) && !hidden(access, g.ents, o2); })); break; }
    const next: string[] = [];
    for (const id of frontier) for (const r of step(id)) {
      const other = r.from === id ? r.to : r.from;
      if (hidden(access, g.ents, other)) { omitted++; continue; }
      if (!depth.has(other)) { if (depth.size >= maxNodes) { byNodes = true; continue; } depth.set(other, d + 1); next.push(other); }
      if (depth.has(other)) edges.set(r.id, r);
    }
    frontier = next.sort();
  }
  function step(id: string): Relationship[] { return direction === "out" ? g.out.get(id) ?? [] : direction === "in" ? g.inn.get(id) ?? [] : [...(g.out.get(id) ?? []), ...(g.inn.get(id) ?? [])]; }
  const nodes = [...depth].map(([id, dep]) => { const e = g.ents.get(id)!; return { id, name: e.name, kind: e.kind, file: e.file, depth: dep }; }).sort((a, b) => a.id.localeCompare(b.id));
  const es = [...edges.values()].filter((r) => depth.has(r.from) && depth.has(r.to)).map((r) => ({ id: r.id, from: r.from, to: r.to, kind: r.kind, evidenceIds: r.evidence.map((e) => e.id).sort() })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  const cycles = sccs(nodes.map((n) => n.id), es.map((e) => [e.from, e.to] as [string, string]));
  const body = { revision: rev, roots: start, direction, kinds, nodes: nodes.map((n) => [n.id, n.depth]), edges: es.map((e) => [e.from, e.to, e.kind]), truncated: { byDepth, byNodes }, omittedByAccess: omitted };
  return { revision: rev, roots: start, direction, kinds, nodes, edges: es, truncated: { byDepth, byNodes }, omittedByAccess: omitted, cycles, hash: hashOf(body) };
}

export interface PathResult {
  found: boolean; path: string[]; edges: Relationship[]; hops: number;
  /** A route exists but only through entities the caller may not see. Says so; names nothing. */
  hiddenRouteExists: boolean;
  truncated: { byDepth: boolean; byNodes: boolean }; visited: number;
}
/** Shortest path by hop count (ties broken by id order, so the answer is stable). Never traverses a denied entity. */
export function findPath(store: Store, rev: string, from: string, to: string, o: GraphOpts = {}): PathResult {
  const kinds = o.kinds ?? DEFAULT_KINDS, access = o.access ?? OPEN;
  const maxDepth = cap(o.maxDepth, LIMITS.maxDepth, 6), maxNodes = Math.max(1, Math.min(o.maxNodes ?? 1000, LIMITS.maxNodes));
  const g = adjacency(store, rev, kinds);
  const run = (acc: AccessPolicy): PathResult => {
    if (!g.ents.has(from) || !g.ents.has(to) || hidden(acc, g.ents, from) || hidden(acc, g.ents, to)) return { found: false, path: [], edges: [], hops: 0, hiddenRouteExists: false, truncated: { byDepth: false, byNodes: false }, visited: 0 };
    if (from === to) return { found: true, path: [from], edges: [], hops: 0, hiddenRouteExists: false, truncated: { byDepth: false, byNodes: false }, visited: 1 };
    const prev = new Map<string, Relationship>(); const seen = new Set([from]); let frontier = [from]; let byDepth = false, byNodes = false;
    for (let d = 0; frontier.length; d++) {
      if (d >= maxDepth) { byDepth = frontier.some((id) => (g.out.get(id) ?? []).some((r) => !seen.has(r.to) && !hidden(acc, g.ents, r.to))); break; }
      const next: string[] = [];
      for (const id of frontier) for (const r of g.out.get(id) ?? []) {
        if (seen.has(r.to) || hidden(acc, g.ents, r.to)) continue;
        if (seen.size >= maxNodes) { byNodes = true; continue; }
        seen.add(r.to); prev.set(r.to, r);
        if (r.to === to) { const edges: Relationship[] = []; for (let c: Relationship | undefined = prev.get(to); c; c = prev.get(c.from)) edges.unshift(c); return { found: true, path: [from, ...edges.map((e) => e.to)], edges, hops: edges.length, hiddenRouteExists: false, truncated: { byDepth, byNodes }, visited: seen.size }; }
        next.push(r.to);
      }
      frontier = next.sort();
    }
    return { found: false, path: [], edges: [], hops: 0, hiddenRouteExists: false, truncated: { byDepth, byNodes }, visited: seen.size };
  };
  const visible = run(access);
  if (visible.found || access === OPEN) return visible;
  return { ...visible, hiddenRouteExists: run(OPEN).found };
}

/** Everything that reaches `id` within `depth` hops, with how far away each is. */
export function dependents(store: Store, rev: string, id: string, o: GraphOpts = {}): Projection { return project(store, rev, [id], { ...o, direction: "in" }); }

/** Tarjan's strongly connected components, iterative (no recursion limit on deep graphs). Only components that are cycles are returned. */
export function sccs(nodes: string[], edges: [string, string][]): string[][] {
  const adj = new Map<string, string[]>(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) adj.get(a)?.push(b);
  for (const l of adj.values()) l.sort();
  const index = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = []; const out: string[][] = []; let i = 0;
  for (const root of [...nodes].sort()) {
    if (index.has(root)) continue;
    const work: { v: string; k: number }[] = [{ v: root, k: 0 }];
    index.set(root, i); low.set(root, i); i++; stack.push(root); on.add(root);
    while (work.length) {
      const f = work[work.length - 1]; const ns = adj.get(f.v) ?? [];
      if (f.k < ns.length) {
        const w = ns[f.k++];
        if (!index.has(w)) { index.set(w, i); low.set(w, i); i++; stack.push(w); on.add(w); work.push({ v: w, k: 0 }); }
        else if (on.has(w)) low.set(f.v, Math.min(low.get(f.v)!, index.get(w)!));
      } else {
        if (low.get(f.v) === index.get(f.v)) { const comp: string[] = []; let w: string; do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== f.v); if (comp.length > 1 || (adj.get(f.v) ?? []).includes(f.v)) out.push(comp.sort()); }
        work.pop();
        if (work.length) { const p = work[work.length - 1].v; low.set(p, Math.min(low.get(p)!, low.get(f.v)!)); }
      }
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]));
}

export function cycles(store: Store, rev: string, o: GraphOpts = {}): string[][] {
  const g = adjacency(store, rev, o.kinds ?? DEFAULT_KINDS); const access = o.access ?? OPEN;
  const ids = [...g.ents.keys()].filter((id) => !hidden(access, g.ents, id));
  const edges: [string, string][] = []; for (const l of g.out.values()) for (const r of l) if (!hidden(access, g.ents, r.from) && !hidden(access, g.ents, r.to)) edges.push([r.from, r.to]);
  return sccs(ids, edges);
}
