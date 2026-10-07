// The concept tree: parent concepts, their children, and so on down to a piece of code. Pure, so it can be tested without
// rendering. Two trees, because the analysis really holds two kinds of parent and child:
//   "Where it lives"  — the code's own containment (repository > package > module > class > function), with the concepts
//                       found in each place counted on the way up. The leaf is the function: a piece of code.
//   "What it does"    — shape families (guarded-write, loop-accumulate, ...), the specialisations composed from them
//                       (debit-form, credit-form, transfer-form), the concepts themselves, then the functions that
//                       show them. The leaf is again a piece of code.
// Concepts are not related to each other beyond that: the analysis that would find deeper specialisation between
// concepts (NMF/FCA) is a disabled stub, so this never invents a business taxonomy.
import type { ConceptHierarchyView, SemanticConcept } from "@cie/schema";
import { conceptTitle } from "./concept-hierarchy-view.ts";

export type TreeKind = "root" | "repo" | "package" | "module" | "class" | "function" | "family" | "variant" | "concept" | "more";

export interface TreeNode {
  id: string;
  kind: TreeKind;
  label: string;
  /** One line that says what the node is, in words, so the kind never rests on colour alone. */
  sub: string;
  /** Concepts at or below this node, counted once each. */
  count: number;
  /** The same concepts by shape. */
  badges: { kind: string; count: number }[];
  children: TreeNode[];
  /** A code element: for a function node this is the leaf that can be read. */
  entityId?: string;
  conceptId?: string;
}

const countKinds = (concepts: SemanticConcept[]): { kind: string; count: number }[] => {
  const by = new Map<string, number>();
  for (const c of concepts) by.set(c.kind, (by.get(c.kind) ?? 0) + 1);
  return [...by].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
};
const byCountThenName = (a: TreeNode, b: TreeNode) => b.count - a.count || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------- where it lives

/** The containment tree with concepts rolled up. By default only places that hold a concept are drawn. */
export function buildStructureTree(view: ConceptHierarchyView, o: { onlyWithConcepts?: boolean } = {}): TreeNode | null {
  const only = o.onlyWithConcepts ?? true;
  const concepts = new Map(view.concepts.map((c) => [c.id, c]));
  const at = new Map<string, Set<string>>();
  for (const l of view.links) {
    if (!concepts.has(l.conceptId)) continue;
    const s = at.get(l.archNodeId) ?? new Set<string>();
    s.add(l.conceptId); at.set(l.archNodeId, s);
  }
  const byId = new Map(view.arch.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const build = (id: string, isRoot: boolean): TreeNode | null => {
    const n = byId.get(id);
    if (!n || seen.has(id)) return null;
    seen.add(id);
    const here = [...(at.get(id) ?? [])].map((c) => concepts.get(c)!).filter(Boolean);
    const children = n.children.map((c) => build(c, false)).filter((c): c is TreeNode => c !== null).sort(byCountThenName);
    if (only && !isRoot && here.length === 0 && children.length === 0) return null;
    const sub = n.kind === "function" ? (here.length ? [...new Set(here.map((c) => c.kind))].join(", ") : "no concept") : `${n.kind} · ${plural(here.length, "concept")}`;
    return {
      id, kind: n.kind, label: n.name, sub, count: here.length, badges: countKinds(here), children,
      ...(n.kind === "function" || n.kind === "class" ? { entityId: n.memberEntityIds[0] } : {}),
    };
  };
  const roots = view.arch.filter((n) => !n.parent || !byId.has(n.parent)).map((n) => build(n.id, true)).filter((n): n is TreeNode => n !== null);
  if (roots.length === 0) return null;
  if (roots.length === 1) return roots[0];
  // The architecture builder always makes one repository root, so this is an edge case; a concept spanning two roots would be counted in each.
  const merged = new Map<string, number>();
  for (const r of roots) for (const bd of r.badges) merged.set(bd.kind, (merged.get(bd.kind) ?? 0) + bd.count);
  const badges = [...merged].map(([kind, count]) => ({ kind, count })).sort((x, y) => y.count - x.count || x.kind.localeCompare(y.kind));
  return { id: "root:structure", kind: "root", label: "Repository", sub: `${roots.length} roots`, count: roots.reduce((n, r) => n + r.count, 0), badges, children: roots.sort(byCountThenName) };
}

// ---------------------------------------------------------------- what it does

/** Composed shapes and the plain shape they specialise. Read from the concept's own record, not guessed from its name. */
const COMPOSED_FAMILY: Record<string, string> = { "debit-form": "guarded-write", "credit-form": "guarded-write", "transfer-form": "guarded-write", "leak-candidate": "resource-acquire-release" };
export function familyOf(c: Pick<SemanticConcept, "kind" | "features" | "compositionRule">): { family: string; variant: string | null } {
  if (!c.compositionRule) return { family: c.kind, variant: null };
  const motif = Object.keys(c.features ?? {}).find((k) => k.startsWith("motif:"))?.slice("motif:".length);
  return { family: motif ?? COMPOSED_FAMILY[c.kind] ?? c.kind, variant: c.kind };
}
const entityName = (id: string) => { const h = id.lastIndexOf("#"); return h >= 0 ? id.slice(h + 1) : id.replace(/^[a-z]+:/, "").split("/").pop() ?? id; };
const entityFile = (id: string) => { const m = /^[a-z]+:([^#]+)/.exec(id); return m ? m[1] : ""; };

export function buildMeaningTree(view: ConceptHierarchyView): TreeNode | null {
  if (view.concepts.length === 0) return null;
  const families = new Map<string, { plain: SemanticConcept[]; variants: Map<string, SemanticConcept[]> }>();
  for (const c of view.concepts) {
    const { family, variant } = familyOf(c);
    const f: { plain: SemanticConcept[]; variants: Map<string, SemanticConcept[]> } = families.get(family) ?? { plain: [], variants: new Map<string, SemanticConcept[]>() };
    if (variant) f.variants.set(variant, [...(f.variants.get(variant) ?? []), c]); else f.plain.push(c);
    families.set(family, f);
  }
  const conceptNode = (c: SemanticConcept): TreeNode => ({
    id: c.id, kind: "concept", label: conceptTitle(c), sub: `${c.soundness.tier} · ${plural(c.members.length, "function")}`, count: 1, badges: [{ kind: c.kind, count: 1 }], conceptId: c.id,
    children: c.members.map((m): TreeNode => ({ id: `${c.id}>${m}`, kind: "function", label: entityName(m), sub: entityFile(m), count: 0, badges: [], children: [], entityId: m })),
  });
  const familyNodes: TreeNode[] = [...families].map(([family, f]): TreeNode => {
    const variants = [...f.variants].map(([kind, cs]): TreeNode => ({
      id: `variant:${family}:${kind}`, kind: "variant", label: kind, sub: `composed from ${family} · ${plural(cs.length, "concept")}`, count: cs.length, badges: [{ kind, count: cs.length }],
      children: cs.map(conceptNode).sort(byCountThenName),
    }));
    const plain = f.plain.map(conceptNode);
    const all = [...f.plain, ...[...f.variants.values()].flat()];
    return { id: `family:${family}`, kind: "family", label: family, sub: `shape · ${plural(all.length, "concept")}`, count: all.length, badges: countKinds(all), children: [...variants.sort(byCountThenName), ...plain.sort(byCountThenName)] };
  }).sort(byCountThenName);
  return { id: "root:meaning", kind: "root", label: "All concepts", sub: plural(view.concepts.length, "concept"), count: view.concepts.length, badges: countKinds(view.concepts), children: familyNodes };
}

/** The concepts a piece of code takes part in. */
export function conceptsOfEntity(view: ConceptHierarchyView, entityId: string): SemanticConcept[] {
  return view.concepts.filter((c) => c.members.includes(entityId));
}

// ---------------------------------------------------------------- what is drawn

export interface VNode { id: string; node: TreeNode; depth: number; children: VNode[]; expandable: boolean; expanded: boolean; /** A "N more" stub: the node it pages. */ moreFor?: string; hidden?: number }
export const PAGE = 40;

/** Only what is open is drawn, a page of children at a time, so a repository with thousands of concepts stays readable. */
export function visibleTree(root: TreeNode, expanded: ReadonlySet<string>, limits: ReadonlyMap<string, number> = new Map(), page = PAGE): VNode {
  const walk = (n: TreeNode, depth: number): VNode => {
    const expandable = n.children.length > 0;
    const open = expandable && expanded.has(n.id);
    const children: VNode[] = [];
    if (open) {
      const cap = limits.get(n.id) ?? page;
      for (const c of n.children.slice(0, cap)) children.push(walk(c, depth + 1));
      const rest = n.children.length - cap;
      if (rest > 0) children.push({ id: `more:${n.id}`, depth: depth + 1, children: [], expandable: false, expanded: false, moreFor: n.id, hidden: rest, node: { id: `more:${n.id}`, kind: "more", label: `${rest} more…`, sub: "show the next page", count: 0, badges: [], children: [] } });
    }
    return { id: n.id, node: n, depth, children, expandable, expanded: open };
  };
  return walk(root, 0);
}
/** Open every node above `depth`, so the first picture is the top of the tree, not all of it. */
export function defaultExpanded(root: TreeNode, depth: number): Set<string> {
  const out = new Set<string>();
  const walk = (n: TreeNode, d: number) => { if (d < depth && n.children.length) { out.add(n.id); for (const c of n.children) walk(c, d + 1); } };
  walk(root, 0);
  return out;
}
/** The nodes to open so every match is visible, and the matches themselves. */
export function matchesFor(root: TreeNode, query: string, cap = 200): { open: Set<string>; matches: Set<string> } {
  const q = query.trim().toLowerCase();
  const open = new Set<string>(), matches = new Set<string>();
  if (!q) return { open, matches };
  const walk = (n: TreeNode, trail: string[]): void => {
    if (matches.size >= cap) return;
    if (n.label.toLowerCase().includes(q) || n.sub.toLowerCase().includes(q)) { matches.add(n.id); for (const t of trail) open.add(t); }
    for (const c of n.children) walk(c, [...trail, n.id]);
  };
  walk(root, []);
  return { open, matches };
}

// ---------------------------------------------------------------- layout

export interface LayoutOptions { nodeW: number; nodeH: number; colGap: number; rowGap: number; pad: number }
export const DEFAULT_LAYOUT: LayoutOptions = { nodeW: 270, nodeH: 38, colGap: 48, rowGap: 10, pad: 16 };
export interface PNode { v: VNode; x: number; y: number }
export interface PLink { id: string; from: string; to: string; d: string }
export interface Layout { nodes: PNode[]; links: PLink[]; width: number; height: number }

/** Left to right: depth is the column, each leaf takes the next row, and a parent sits at the middle of its children. No two nodes overlap. */
export function layoutTree(root: VNode, o: LayoutOptions = DEFAULT_LAYOUT): Layout {
  const nodes: PNode[] = [], pos = new Map<string, PNode>();
  let row = 0;
  const place = (v: VNode): number => {
    const y = v.children.length === 0 ? row++ : (() => { const ys = v.children.map(place); return (ys[0] + ys[ys.length - 1]) / 2; })();
    const p: PNode = { v, x: o.pad + v.depth * (o.nodeW + o.colGap), y: o.pad + y * (o.nodeH + o.rowGap) };
    nodes.push(p); pos.set(v.id, p);
    return y;
  };
  place(root);
  const links: PLink[] = [];
  for (const p of nodes) for (const c of p.v.children) {
    const q = pos.get(c.id)!;
    const x1 = p.x + o.nodeW, y1 = p.y + o.nodeH / 2, x2 = q.x, y2 = q.y + o.nodeH / 2, xm = (x1 + x2) / 2;
    links.push({ id: `${p.v.id}->${c.id}`, from: p.v.id, to: c.id, d: `M${x1},${y1} C${xm},${y1} ${xm},${y2} ${x2},${y2}` });
  }
  const maxDepth = Math.max(...nodes.map((n) => n.v.depth));
  return { nodes, links, width: o.pad * 2 + (maxDepth + 1) * o.nodeW + maxDepth * o.colGap, height: o.pad * 2 + Math.max(row, 1) * o.nodeH + Math.max(row - 1, 0) * o.rowGap };
}

export const clip = (s: string, max: number) => (s.length <= max ? s : s.slice(0, Math.max(1, max - 1)) + "…");

export const ZOOMS = [0.6, 0.8, 1, 1.25, 1.5];
/** The index of the largest zoom at which a drawing this wide fits the space, or of the smallest zoom if none does. */
export const zoomToFit = (width: number, avail: number): number => { let best = 0; ZOOMS.forEach((z, i) => { if (width * z <= avail) best = i; }); return best; };
