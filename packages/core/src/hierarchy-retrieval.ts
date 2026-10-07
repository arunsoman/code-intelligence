// Hierarchy-first retrieval (PROTOTYPE, for measurement): pick the part of the codebase a question is about from the concept
// hierarchy's readable names, then rank the functions inside it, so the evidence bundle sent to a model can be small.
//
// Pure over a ConceptHierarchyView: no store, no model, no network. It ranks function entities; building the evidence bundle and
// applying the caller's access policy are separate steps (selection must be filtered by access BEFORE bundling; `bundleFor` does not).
//
// Two modes, so an experiment can tell whether the hierarchy adds anything over plain search:
//   "flat"       ranks every function by field-weighted word overlap with the question (name, class, concept names, domain path,
//                package name, file path). No grouping.
//   "two-stage"  first scores the Domain view's groups by their labels and keeps the few most specific matches, then ranks the
//                functions inside those groups first (a membership bonus), the rest after by the same lexical score.
//
// Nothing here is calibrated. Weights are starting points; the benchmark (scripts/hierarchy-retrieval-bench.ts) is what says whether
// they help, and on which questions they do not.
import type { ConceptHierarchyView } from "@cie/schema";
import { buildDomainTree, conceptTitle, splitIdentifier, stemWord, type TreeNode } from "@cie/schema/concept-tree";
import { queryTerms } from "./retrieval.ts";

export type RetrievalMode = "flat" | "two-stage";
export interface RankedFunction { entityId: string; file: string; score: number; why: string[] }
export interface HierarchyRanking { terms: string[]; groups: string[]; ranked: RankedFunction[] }

const FIELD_WEIGHT = { name: 3, cls: 2, concept: 2, domain: 2, pkg: 1.5, file: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;
interface Doc { entityId: string; file: string; fields: Record<Field, Set<string>> }

const words = (s: string): string[] => splitIdentifier(s).map(stemWord);
const wordSet = (...parts: string[]): Set<string> => new Set(parts.flatMap(words));
/** Exact match after singularising, or a shared prefix of at least five letters ("authent" finds "authentication"). */
const matches = (term: string, token: string) => token === term || (term.length >= 5 && token.length >= 5 && (token.startsWith(term) || term.startsWith(token)));

export class HierarchyIndex {
  readonly docs: Doc[] = [];
  private readonly groups: { node: TreeNode; tokens: Set<string>; leaves: string[]; depth: number; parents: string[] }[] = [];
  private readonly df = new Map<string, number>();

  constructor(view: ConceptHierarchyView) {
    const tree = buildDomainTree(view, { onlyWithConcepts: false });
    if (!tree) return;
    const concepts = new Map<string, string[]>();
    for (const c of view.concepts) for (const m of c.members) concepts.set(m, [...(concepts.get(m) ?? []), conceptTitle(c), c.kind]);
    const byId = new Map(view.arch.map((n) => [n.id, n]));
    const pkgOf = new Map<string, string>();
    for (const n of view.arch) {
      if (n.kind !== "function" || !n.memberEntityIds[0]) continue;
      let cur = n.parent ? byId.get(n.parent) : undefined, guard = 0;
      while (cur && guard++ < 64 && cur.kind !== "package") cur = cur.parent ? byId.get(cur.parent) : undefined;
      pkgOf.set(n.memberEntityIds[0], cur?.kind === "package" ? cur.name : "");
    }
    const docOf = new Map<string, Doc>();
    const walk = (n: TreeNode, trail: TreeNode[]): string[] => {
      if (n.kind === "function" && n.entityId) {
        const id = n.entityId, file = /^[a-z]+:([^#]+)/.exec(id)?.[1] ?? "";
        const full = id.includes("#") ? id.slice(id.lastIndexOf("#") + 1) : n.label;
        const dot = full.lastIndexOf(".");
        const doc: Doc = { entityId: id, file, fields: {
          name: wordSet(dot > 0 ? full.slice(dot + 1) : full), cls: wordSet(dot > 0 ? full.slice(0, dot) : ""), concept: wordSet(...(concepts.get(id) ?? [])),
          domain: wordSet(...trail.filter((t) => t.kind === "domain").map((t) => t.label)), pkg: wordSet(pkgOf.get(id) ?? ""), file: wordSet(file),
        } };
        docOf.set(id, doc); this.docs.push(doc);
        for (const tok of new Set((Object.keys(FIELD_WEIGHT) as Field[]).flatMap((f) => [...doc.fields[f]]))) this.df.set(tok, (this.df.get(tok) ?? 0) + 1);
        return [id];
      }
      const leaves = n.children.flatMap((c) => walk(c, [...trail, n]));
      if (n.kind === "domain") this.groups.push({ node: n, tokens: wordSet(n.label), leaves, depth: trail.length, parents: trail.map((t) => t.id) });
      return leaves;
    };
    walk(tree, []);
  }

  private idf(token: string): number { return Math.log(1 + this.docs.length / (1 + (this.df.get(token) ?? 0))); }

  private score(doc: Doc, terms: string[]): { score: number; why: string[] } {
    let score = 0; const why: string[] = [];
    for (const t of terms) {
      let best = 0, bestField: Field | null = null;
      for (const f of Object.keys(FIELD_WEIGHT) as Field[]) {
        for (const tok of doc.fields[f]) if (matches(t, tok)) { const w = FIELD_WEIGHT[f] * this.idf(tok); if (w > best) { best = w; bestField = f; } break; }
      }
      if (bestField) { score += best; why.push(`${t} in ${bestField}`); }
    }
    return { score, why };
  }

  rank(question: string, o: { mode?: RetrievalMode; groups?: number } = {}): HierarchyRanking {
    const terms = [...new Set(queryTerms(question).map(stemWord))];
    if (!terms.length || !this.docs.length) return { terms, groups: [], ranked: [] };
    const mode = o.mode ?? "two-stage";
    // Stage 1: which groups does the question name? Keep the most specific few; a group and its ancestor are not both kept.
    const chosen: typeof this.groups = [];
    if (mode === "two-stage") {
      const scored = this.groups.map((g) => ({ g, s: terms.reduce((n, t) => n + ([...g.tokens].some((tok) => matches(t, tok)) ? this.idf(t) : 0), 0) })).filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s || b.g.depth - a.g.depth || a.g.node.id.localeCompare(b.g.node.id));
      for (const { g } of scored) {
        if (chosen.length >= (o.groups ?? 3)) break;
        if (chosen.some((c) => c.parents.includes(g.node.id) || g.parents.includes(c.node.id))) continue;
        chosen.push(g);
      }
    }
    const inGroup = new Set(chosen.flatMap((g) => g.leaves));
    // Being inside a group the question names is worth about one good name match; a function that matches the words itself still outranks a bystander.
    const bonus = 1.5 * Math.max(...terms.map((t) => this.idf(t)));
    const ranked: RankedFunction[] = this.docs.map((d) => {
      const { score, why } = this.score(d, terms);
      const member = inGroup.has(d.entityId);
      return { entityId: d.entityId, file: d.file, score: score + (member ? bonus : 0), why: member ? [...why, "in a matching group"] : why };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score || a.entityId.localeCompare(b.entityId));
    return { terms, groups: chosen.map((g) => g.node.label), ranked };
  }
}
