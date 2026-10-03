// Question → bounded, revision-bound evidence bundle (C09 projection + C10/C11 retrieval, keyword/graph only).
import { createHash } from "node:crypto";
import type { ConceptCard, EvidenceBundle, EvidenceRef, Fact, Relationship, ViewNode } from "@cie/schema";
import { runtimeHotness } from "./hotness.ts";
import { revisionIndex, scoreEntity, WEIGHTS, type SalienceContext, type Scored, type Weights } from "./salience.ts";
import type { Store } from "./store.ts";

const STOP = new Set(["show", "how", "does", "the", "what", "why", "work", "works", "working", "can", "could", "would", "and", "for", "are", "this", "that", "with", "from", "everything", "about", "me", "all", "is", "do", "of", "in", "to", "a", "an", "it", "my", "which"]);
// Crude suffix stripping so "authentication" matches `auth/`. Heuristic, not linguistics.
const SUFFIXES = ["entication", "orization", "ication", "ization", "ation", "ments", "ment", "ing", "ion", "ers", "er", "ed", "es", "s"];

export function queryTerms(q: string): string[] {
  const out = new Set<string>();
  for (const w of q.toLowerCase().match(/[a-z][a-z0-9]+/g) ?? []) {
    if (w.length < 3 || STOP.has(w)) continue;
    out.add(w);
    for (const s of SUFFIXES) if (w.endsWith(s) && w.length - s.length >= 4) { out.add(w.slice(0, -s.length)); break; }
  }
  return [...out];
}

export interface Retrieval {
  bundle: EvidenceBundle;
  tiers: Map<string, ViewNode["tier"]>;
  scored: Map<string, Scored>;
  terms: string[];
  /** Candidates that matched but were left out, with the reason; powers "why is this hidden?". */
  hidden: { entityId: string; label: string; reason: string }[];
}
export interface RetrieveOptions {
  maxNodes?: number; weights?: Weights; frames?: Map<string, number>; pins?: Set<string>; ignored?: Set<string>;
  cards?: ConceptCard[]; taskBoost?: SalienceContext["taskBoost"]; extraSeeds?: string[];
}

const symbolKinds = new Set(["function", "method", "class", "interface", "type"]);
const estimateTokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

function assemble(store: Store, revision: string, entityIds: string[], notes: string[]): EvidenceBundle {
  const idSet = new Set(entityIds);
  const entities = store.entitiesById(revision, entityIds);
  // Pull in the containing file entities so `contains` evidence resolves.
  const files = [...new Set(entities.map((e) => e.file))].map((f) => `file:${f}`);
  for (const f of store.entitiesById(revision, files)) if (!idSet.has(f.entityId)) { entities.push(f); idSet.add(f.entityId); }

  const rels = new Map<string, Relationship>();
  const facts = new Map<string, Fact>();
  for (const id of idSet) {
    for (const r of store.relationshipsFor(revision, id)) if (idSet.has(r.from) && idSet.has(r.to)) rels.set(r.id, r);
    for (const f of store.factsFor(revision, id)) facts.set(f.id, f);
  }
  const evidence = new Map<string, EvidenceRef>();
  for (const r of rels.values()) for (const e of r.evidence) evidence.set(e.id, e);
  for (const f of facts.values()) for (const e of f.evidence) evidence.set(e.id, e);

  const unresolved = [...facts.values()].filter((f) => f.resolution === "UNRESOLVED");
  const bundle: EvidenceBundle = {
    id: `bundle:${createHash("sha256").update(revision + [...idSet].sort().join("|")).digest("hex").slice(0, 16)}`,
    revision, evidence: [...evidence.values()], entities, relationships: [...rels.values()], facts: [...facts.values()],
    coverage: ["TypeScript static analysis (tree-sitter)", ...notes],
    unresolved: unresolved.length ? [`${unresolved.length} call(s) could not be statically resolved`] : [],
    tokenEstimate: 0,
  };
  bundle.tokenEstimate = estimateTokens(bundle);
  return bundle;
}

export function bundleFor(store: Store, revision: string, entityIds: string[], notes: string[] = []): EvidenceBundle {
  return assemble(store, revision, entityIds, notes);
}

export function retrieveForQuestion(store: Store, revision: string, question: string, opts: RetrieveOptions = {}): Retrieval {
  const maxNodes = opts.maxNodes ?? 40;
  const terms = queryTerms(question);
  const rev = store.revision(revision);
  const overrides = rev ? store.overrides(rev.repoRoot) : new Map();
  const hot = rev ? runtimeHotness(store, rev) : new Map();
  const ctx: SalienceContext = { store, revision, terms, weights: opts.weights ?? WEIGHTS.map, frames: opts.frames, pins: opts.pins, ignored: opts.ignored, cards: opts.cards ?? store.concepts(revision), taskBoost: opts.taskBoost, hot, overrides };
  const symbols = store.entities(revision).filter((e) => symbolKinds.has(e.kind));
  const scored = new Map(symbols.map((e) => [e.entityId, scoreEntity(e, ctx)]));
  const byId = new Map(symbols.map((e) => [e.entityId, e]));
  const factor = (id: string, f: string) => scored.get(id)!.factors.find((x) => x.factor === f)!.normalizedScore;

  const hidden: Retrieval["hidden"] = [];
  const isSeed = (id: string) => overrides.get(id) === "pin" || factor(id, "TASK_MATCH") > 0 || factor(id, "SEMANTIC_JUDGMENT") > 0 || (opts.frames?.has(id) ?? false) || (opts.extraSeeds ?? []).includes(id);
  const candidates = [...scored.values()].filter((s) => isSeed(s.id)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const picked: string[] = [];
  for (const c of candidates) {
    const label = byId.get(c.id)!.name;
    if (opts.ignored?.has(c.id)) { hidden.push({ entityId: c.id, label, reason: "you asked to ignore it" }); continue; }
    if (picked.length >= maxNodes) { hidden.push({ entityId: c.id, label, reason: `matched, but ranked below the top ${maxNodes}` }); continue; }
    if (c.tier === "HIDDEN") { hidden.push({ entityId: c.id, label, reason: "matched weakly; relevance below the display threshold" }); continue; }
    picked.push(c.id);
  }
  // One hop along calls / async hand-offs, best-scored neighbours first, to give seeds their context.
  const idx = revisionIndex(store, revision);
  const inPicked = new Set(picked);
  const neighbours = new Map<string, number>();
  for (const id of picked) for (const n of idx.neighbors.get(id) ?? []) if (!inPicked.has(n) && scored.has(n) && !opts.ignored?.has(n)) neighbours.set(n, Math.max(neighbours.get(n) ?? 0, scored.get(n)!.score));
  for (const [n] of [...neighbours].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (picked.length >= maxNodes) { hidden.push({ entityId: n, label: byId.get(n)!.name, reason: `direct neighbour of a shown element, cut by the ${maxNodes}-node cap` }); continue; }
    picked.push(n);
  }
  const tiers = new Map<string, ViewNode["tier"]>();
  for (const id of picked) {
    const t = scored.get(id)!.tier;
    tiers.set(id, t === "HIDDEN" ? "CONTEXT" : t); // neighbours are shown as context even when their own score is low
  }
  const notes = terms.length ? [`matched on terms: ${terms.join(", ")}`] : ["no searchable terms in question"];
  return { bundle: assemble(store, revision, picked, notes), tiers, scored, terms, hidden };
}

/** Neighbourhood around explicit entities, for "why are these connected?". */
export function retrieveAround(store: Store, revision: string, ids: string[], hops = 3, cap = 120): EvidenceBundle {
  const seen = new Set(ids);
  let frontier = [...ids];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const r of store.relationshipsFor(revision, id)) {
        if (r.kind === "contains") continue;
        for (const o of [r.from, r.to]) if (!seen.has(o) && seen.size < cap) { seen.add(o); next.push(o); }
      }
    }
    frontier = next;
  }
  return assemble(store, revision, [...seen], [`${hops}-hop neighbourhood of selection`]);
}
