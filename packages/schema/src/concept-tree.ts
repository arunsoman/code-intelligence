// The concept tree: parent concepts, their children, and so on down to a piece of code. Pure, so it can be tested without
// rendering. Two trees, because the analysis really holds two kinds of parent and child:
//   "Where it lives"  — the code's own containment (repository > package > module > class > function), with the concepts
//                       found in each place counted on the way up. The leaf is the function: a piece of code.
//   "What it does"    — shape families (guarded-write, loop-accumulate, ...), the specialisations composed from them
//                       (debit-form, credit-form, transfer-form), the concepts themselves, then the functions that
//                       show them. The leaf is again a piece of code.
//   "Domain view"     — functions grouped by the words their names and paths share (merchant, ledger, fraud, ...), most
//                       distinctive word first, big groups split by the next word. The leaf is again a piece of code.
// Concepts are not related to each other beyond that: the analysis that would find deeper specialisation between
// concepts (NMF/FCA) is a disabled stub, so none of this invents a business taxonomy. The domain view reads vocabulary,
// not meaning: it can only find domains the code actually names.
import type { ConceptHierarchyView, SemanticConcept } from "./index.ts";

/** What to call a concept: the name it was given, or an honest placeholder. A name is a suggestion, never a claim. */
export function conceptTitle(c: Pick<SemanticConcept, "label" | "kind">): string { return c.label?.trim() || `unnamed ${c.kind}`; }

export type TreeKind = "root" | "repo" | "package" | "module" | "class" | "function" | "family" | "variant" | "concept" | "domain" | "more";

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

// ---------------------------------------------------------------- domain view

/** Words that say what a piece of code is made of, not what it is about. Plus a data-driven cut for words that are everywhere in this repository. */
export const GENERIC_WORDS = new Set((
  "service services controller controllers component components module modules handler handlers util utils helper helpers impl base abstract factory manager provider providers index main test tests spec mock mocks stub fixture fixtures " +
  "get set add remove update delete create find list load save init initialize handle process run build make new for the and with from into http https params param data info item items value values result results response responses " +
  "request requests req res dto model models types type config configuration constants constant common shared core app src lib libs packages package apps api web server client clients default internal private public static async await " +
  "function method class object string number array map filter reduce each all any one two not non has can should will does did use using used check validate validation parse format convert transform resolve compute calculate count total " +
  "name names key keys ref refs dist node target generated gen version versions event events action actions state store reducer effect effects guard guards interceptor pipe pipes directive routing router route routes view views page pages " +
  "form forms dialog modal button table row rows column columns cell cells field fields label labels text html css json xml url uri path file files dir folder line lines word words char chars byte bytes bit bits size length offset limit " +
  "next prev previous first last start end begin stop open close read write send receive post put patch fetch call calls invoke execute exec off was were been being have had may might must could would shall on is are " +
  "select selected selector recursive recursively parameter parameters status option options current change changes toggle show hide clear reset refresh submit cancel confirm detail details summary sub super multi"
).split(/\s+/));

/** "SubAccountControllerService" -> ["sub", "account", "controller", "service"]. Short and numeric fragments are dropped. */
export function splitIdentifier(s: string): string[] {
  return (s.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? []).map((t) => t.toLowerCase()).filter((t) => t.length >= 3 && !/^\d+$/.test(t));
}
/** "sub" + "agent" -> "subagent": a trusted prefix joins the word it modifies, so it can be filed under that word instead of being a word itself. */
export function joinAffixes(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i], next = words[i + 1];
    if (AFFIX_LIST.includes(w) && next && next.length >= 4) { out.push(w + next); i++; } else out.push(w);
  }
  return out;
}
const AFFIX_LIST = ["sub", "super", "multi"];
/** Crude singularising so "merchants" and "merchant" are one word. Not linguistics. */
export function stemWord(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 5 && /(sses|ches|shes|xes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 4 && t.endsWith("s") && !/(ss|us|is)$/.test(t)) return t.slice(0, -1);
  return t;
}
/** A compound like "submerchant" belongs under "merchant". Only these prefixes are trusted, so "address" is never filed under "dress". */
const AFFIXES = AFFIX_LIST;
const titleCase = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const baseName = (p: string) => p.split("/").pop() ?? p;

export interface DomainOptions {
  onlyWithConcepts?: boolean;
  /** Smallest group worth a name. Defaults to 2 for a small repository, 3 otherwise. */
  minCluster?: number;
  /** A group bigger than this is split by its next most distinctive word. */
  splitAbove?: number;
  maxDepth?: number;
}
interface DomainFn { id: string; entityId: string; name: string; file: string; pkg: string; concepts: SemanticConcept[]; w: Map<string, number> }

export function buildDomainTree(view: ConceptHierarchyView, o: DomainOptions = {}): TreeNode | null {
  const only = o.onlyWithConcepts ?? true;
  const concepts = new Map(view.concepts.map((c) => [c.id, c]));
  const at = new Map<string, SemanticConcept[]>();
  for (const l of view.links) { const c = concepts.get(l.conceptId); if (c) at.set(l.archNodeId, [...(at.get(l.archNodeId) ?? []), c]); }
  const byId = new Map(view.arch.map((n) => [n.id, n]));
  const pkgOf = (id: string): string => { let cur = byId.get(id)?.parent ? byId.get(byId.get(id)!.parent!) : undefined, guard = 0; while (cur && guard++ < 64) { if (cur.kind === "package") return cur.name; cur = cur.parent ? byId.get(cur.parent) : undefined; } return ""; };

  // One record per function: the words in its path, its class and its own name.
  const fns: DomainFn[] = [];
  for (const n of view.arch) {
    if (n.kind !== "function") continue;
    const entityId = n.memberEntityIds[0];
    if (!entityId) continue;
    const cs = [...new Map((at.get(n.id) ?? []).map((c) => [c.id, c])).values()];
    if (only && cs.length === 0) continue;
    const file = /^[a-z]+:([^#]+)/.exec(entityId)?.[1] ?? "";
    const full = entityId.includes("#") ? entityId.slice(entityId.lastIndexOf("#") + 1) : n.name;
    const dot = full.lastIndexOf("."), cls = dot > 0 ? full.slice(0, dot) : "", method = dot > 0 ? full.slice(dot + 1) : full;
    const w = new Map<string, number>();
    const add = (raw: string, weight: number) => { const t = stemWord(raw); if (GENERIC_WORDS.has(raw) || GENERIC_WORDS.has(t) || t.length < 3) return; w.set(t, Math.min(2, (w.get(t) ?? 0) + weight)); };
    for (const t of joinAffixes(splitIdentifier(baseName(file).replace(/\.[^.]+$/, "").replace(/\.[^.]+$/, "")))) add(t, 1);
    for (const d of file.split("/").slice(0, -1)) for (const t of new Set(joinAffixes(splitIdentifier(d)))) add(t, 0.5);
    for (const t of joinAffixes(splitIdentifier(cls))) add(t, 1);
    for (const t of joinAffixes(splitIdentifier(method))) add(t, 1);
    fns.push({ id: n.id, entityId, name: n.name, file, pkg: pkgOf(n.id), concepts: cs, w });
  }
  if (fns.length === 0) return null;

  const N = fns.length;
  const minCluster = o.minCluster ?? (N < 60 ? 2 : 3), splitAbove = o.splitAbove ?? 30, maxDepth = o.maxDepth ?? 4;
  const df = new Map<string, number>();
  for (const f of fns) for (const t of f.w.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  // A word in a quarter of all functions says nothing about which part of the product it is. (Skipped for tiny repositories, where everything is common.)
  const capped = (t: string) => N >= 40 && (df.get(t) ?? 0) / N > 0.25;

  const leaf = (f: DomainFn): TreeNode => ({
    id: `fn:${f.id}`, kind: "function", label: f.name, sub: `${baseName(f.file)} · ${f.concepts.length ? [...new Set(f.concepts.map((c) => c.kind))].join(", ") : "no concept"}`,
    count: f.concepts.length, badges: countKinds(f.concepts), children: [], entityId: f.entityId,
  });

  // Group `group` by the most distinctive word each function still has. Returns the named groups and the functions no word fits.
  const split = (group: DomainFn[], used: ReadonlySet<string>, path: string[], depth: number): { nodes: TreeNode[]; rest: DomainFn[] } => {
    const local = new Map<string, number>();
    for (const f of group) for (const t of f.w.keys()) if (!used.has(t) && !capped(t)) local.set(t, (local.get(t) ?? 0) + 1);
    let allowed = new Set([...local].filter(([, n]) => n >= minCluster && n < group.length).map(([t]) => t));
    let assigned = new Map<string, DomainFn[]>(), rest: DomainFn[] = [];
    for (let pass = 0; pass < 6; pass++) {
      assigned = new Map(); rest = [];
      for (const f of group) {
        let best: string | null = null, bestScore = -Infinity;
        // Coarse first: a word that covers many functions, and comes from the file or class name, names the group; finer words split it later.
        for (const t of f.w.keys()) { if (!allowed.has(t)) continue; const sc = (f.w.get(t) ?? 0) * (1 + Math.log(local.get(t) ?? 1)); if (sc > bestScore || (sc === bestScore && best !== null && t < best)) { best = t; bestScore = sc; } }
        if (best === null) rest.push(f); else assigned.set(best, [...(assigned.get(best) ?? []), f]);
      }
      const small = [...assigned].filter(([, g]) => g.length < minCluster).map(([t]) => t);
      if (small.length === 0) break;
      allowed = new Set([...allowed].filter((t) => !small.includes(t)));
    }
    const terms = [...assigned.keys()].sort((a, b) => assigned.get(b)!.length - assigned.get(a)!.length || a.localeCompare(b));
    const nodeFor = (term: string, members: DomainFn[], nested: TreeNode[]): TreeNode => {
      const here = [...path, term];
      const inner = members.length > splitAbove && depth < maxDepth ? split(members, new Set([...used, term]), here, depth + 1) : { nodes: [] as TreeNode[], rest: members };
      return { id: `domain:${here.join(">")}`, kind: "domain", label: titleCase(term), sub: "", count: 0, badges: [], children: [...inner.nodes, ...nested, ...inner.rest.map(leaf)] };
    };
    // "submerchant" is filed under "merchant" when both exist at this level.
    const nestedUnder = new Map<string, string[]>();
    for (const t of terms) for (const a of AFFIXES) { const base = t.startsWith(a) ? t.slice(a.length) : ""; if (base.length >= 4 && assigned.has(base)) { nestedUnder.set(base, [...(nestedUnder.get(base) ?? []), t]); break; } }
    const nestedTerms = new Set([...nestedUnder.values()].flat());
    const nodes = terms.filter((t) => !nestedTerms.has(t)).map((t) => nodeFor(t, assigned.get(t)!, (nestedUnder.get(t) ?? []).map((c) => nodeFor(c, assigned.get(c)!, []))));
    return { nodes, rest };
  };

  const top = split(fns, new Set(), [], 0);
  const topNodes = [...top.nodes];
  if (top.rest.length) topNodes.push({ id: "domain:other", kind: "domain", label: "Other", sub: "", count: 0, badges: [], children: top.rest.map(leaf) });

  // Roll the functions and concepts up, once each, and describe each group in words.
  const leafFn = new Map(fns.map((f) => [`fn:${f.id}`, f]));
  const finish = (n: TreeNode): { fns: DomainFn[]; concepts: Map<string, SemanticConcept> } => {
    if (n.kind === "function") { const f = leafFn.get(n.id)!; return { fns: [f], concepts: new Map(f.concepts.map((c) => [c.id, c])) }; }
    const fs: DomainFn[] = [], cs = new Map<string, SemanticConcept>();
    for (const c of n.children) { const r = finish(c); fs.push(...r.fns); for (const [k, v] of r.concepts) cs.set(k, v); }
    const pk = new Map<string, number>();
    for (const f of fs) if (f.pkg) pk.set(f.pkg, (pk.get(f.pkg) ?? 0) + 1);
    const top1 = [...pk].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    n.count = cs.size; n.badges = countKinds([...cs.values()]);
    n.sub = `${plural(fs.length, "function")}${top1 && top1[1] / fs.length >= 0.6 && top1[0] !== "root" ? ` · mainly ${top1[0]}` : ""}`;
    n.children.sort((a, b) => (a.kind === "function" ? 1 : 0) - (b.kind === "function" ? 1 : 0) || (a.id === "domain:other" ? 1 : 0) - (b.id === "domain:other" ? 1 : 0) || b.count - a.count || a.label.localeCompare(b.label));
    return { fns: fs, concepts: cs };
  };
  const root: TreeNode = { id: "root:domain", kind: "root", label: "Domains", sub: "", count: 0, badges: [], children: topNodes };
  finish(root);
  root.sub = plural(N, "function");
  return root;
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
