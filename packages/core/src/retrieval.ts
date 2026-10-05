// Question → bounded, revision-bound evidence bundle (C09 projection + C10/C11 retrieval, keyword/graph only).
import { createHash } from "node:crypto";
import type { ConceptCard, EvidenceBundle, EvidenceRef, Fact, Relationship, ViewNode } from "@cie/schema";
import { OPEN, type AccessPolicy } from "./access.ts";
import type { Semantic } from "./embeddings.ts";
import { runtimeHotness } from "./hotness.ts";
import { LENSES, protectedTier } from "./context.ts";
import { revisionIndex, scoreEntity, tierOf, WEIGHTS, type SalienceContext, type Scored, type Weights } from "./salience.ts";
import type { Store } from "./store.ts";

const STOP = new Set(["show", "how", "does", "the", "what", "why", "work", "works", "working", "can", "could", "would", "and", "for", "are", "this", "that", "with", "from", "everything", "about", "me", "all", "is", "do", "of", "in", "to", "a", "an", "it", "my", "which", "give", "overview", "whole", "tell", "explain", "describe", "list", "find"]);
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
  /** Matches the caller may not see: how many, never which. */
  inaccessible: number;
  /** Set when the evidence was cut to fit a token budget: what it was, what it became, and what was dropped. */
  truncation?: { budget: number; before: number; after: number; dropped: { entityId: string; label: string }[] };
  /** Why each shown element was picked: it matched the words, it is semantically close, a concept card names it, it is a neighbour, ... */
  provenance: Map<string, string[]>;
}
export interface RetrieveOptions {
  /** Persona lens id (see context.ts): re-weights factors, never hides safety facts. */
  lens?: string;
  overview?: boolean; maxNodes?: number; weights?: Weights; frames?: Map<string, number>; pins?: Set<string>; ignored?: Set<string>;
  cards?: ConceptCard[]; taskBoost?: SalienceContext["taskBoost"]; extraSeeds?: string[];
  /** Entities semantically close to the question (see embeddings.ts); they feed the same factor as exact name matches. */
  semantic?: Map<string, Semantic>;
  /** What the caller may see. Denied entities are left out of everything, and counted. */
  access?: AccessPolicy;
  /** Cut the evidence to this many estimated tokens, lowest-ranked first, and say so. */
  tokenBudget?: number;
}

const symbolKinds = new Set(["function", "method", "class", "interface", "type"]);
const estimateTokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

function assemble(store: Store, revision: string, entityIds: string[], notes: string[], includeDefectSemantics = true): EvidenceBundle {
  const idSet = new Set(entityIds);
  const entities = store.entitiesById(revision, entityIds);
  // Pull in the containing file entities so `contains` evidence resolves.
  const files = [...new Set(entities.map((e) => e.file))].map((f) => `file:${f}`);
  for (const f of store.entitiesById(revision, files)) if (!idSet.has(f.entityId)) { entities.push(f); idSet.add(f.entityId); }

  const rels = new Map<string, Relationship>();
  const facts = new Map<string, Fact>();
  for (const id of idSet) {
    for (const r of store.relationshipsFor(revision, id)) if (idSet.has(r.from) && idSet.has(r.to)) rels.set(r.id, r);
    for (const f of store.factsFor(revision, id)) if (includeDefectSemantics || !f.predicate.startsWith("defect.")) facts.set(f.id, f);
  }
  const evidence = new Map<string, EvidenceRef>();
  for (const r of rels.values()) for (const e of r.evidence) evidence.set(e.id, e);
  for (const f of facts.values()) for (const e of f.evidence) evidence.set(e.id, e);

  const unresolved = [...facts.values()].filter((f) => f.resolution === "UNRESOLVED");
  const bundle: EvidenceBundle = {
    id: `bundle:${createHash("sha256").update(revision + [...idSet].sort().join("|")).digest("hex").slice(0, 16)}`,
    revision, evidence: [...evidence.values()], entities, relationships: [...rels.values()], facts: [...facts.values()],
    coverage: ["TypeScript, Java, Go, Python, Rust and Nirdosha v2 static analysis (tree-sitter)", ...notes],
    unresolved: unresolved.length ? [`${unresolved.length} call(s) could not be statically resolved`] : [],
    tokenEstimate: 0,
  };
  bundle.tokenEstimate = estimateTokens(bundle);
  return bundle;
}

export function bundleFor(store: Store, revision: string, entityIds: string[], notes: string[] = [], options: { includeDefectSemantics?: boolean } = {}): EvidenceBundle {
  return assemble(store, revision, entityIds, notes, options.includeDefectSemantics ?? true);
}

export function retrieveForQuestion(store: Store, revision: string, question: string, opts: RetrieveOptions = {}): Retrieval {
  const maxNodes = opts.maxNodes ?? 40;
  const terms = queryTerms(question);
  const rev = store.revision(revision);
  const access = opts.access ?? OPEN;
  const overrides = rev ? store.overrides(rev.repoRoot) : new Map();
  const hot = rev ? runtimeHotness(store, rev) : new Map();
  // Semantic closeness joins exact name matches in one factor: a hit is a hit, however it was found.
  let taskBoost = opts.taskBoost;
  if (opts.semantic?.size) {
    taskBoost = new Map(taskBoost ?? []);
    for (const [id, sem] of opts.semantic) { const cur = taskBoost.get(id); if (!cur || sem.value > cur.value) taskBoost.set(id, { value: sem.value, reason: sem.reason, evidenceIds: [] }); }
  }
  const ctx: SalienceContext = { store, revision, terms, weights: opts.weights ?? (opts.lens && LENSES[opts.lens] ? LENSES[opts.lens].weights : WEIGHTS.map), frames: opts.frames, pins: opts.pins, ignored: opts.ignored, cards: opts.cards ?? store.concepts(revision), taskBoost, hot, overrides };
  const allEntities = store.entities(revision);
  const fileOf = new Map(allEntities.map((e) => [e.entityId, e.file]));
  const isDenied = (id: string) => access.deniedEntity(id, (x) => fileOf.get(x));
  const symbols = allEntities.filter((e) => symbolKinds.has(e.kind));
  const scored = new Map(symbols.map((e) => [e.entityId, scoreEntity(e, ctx)]));
  const byId = new Map(symbols.map((e) => [e.entityId, e]));
  if (opts.lens && opts.lens !== "default") for (const sc of scored.values()) { const p = protectedTier(sc.tier, sc.factors); if (p.protectedBy) { sc.tier = p.tier; sc.factors.push({ factor: "USER_OVERRIDE", rawValue: 0, normalizedScore: 0, reason: `kept visible under the ${opts.lens} lens: ${p.protectedBy}`, evidenceIds: [] }); } }
  const factor = (id: string, f: string) => scored.get(id)!.factors.find((x) => x.factor === f)!.normalizedScore;

  // Two cheap checks on whether a name match is the real thing. Code that nothing calls and that calls nothing, matched only by
  // its name, is weaker evidence than a connected cluster of matches; and code under legacy / docs / examples paths is rarely what a
  // question about how the system works means. Both lower the score and say why; neither hides anything, and a pin overrides them.
  {
    const idx0 = revisionIndex(store, revision);
    const comp = new Map<string, number>(); const size = new Map<number, number>(); let cid = 0;
    for (const e of symbols) {
      if (comp.has(e.entityId)) continue;
      const stack = [e.entityId]; comp.set(e.entityId, cid); let n = 0;
      while (stack.length) { const x = stack.pop()!; n++; for (const y of idx0.neighbors.get(x) ?? []) if (!comp.has(y)) { comp.set(y, cid); stack.push(y); } }
      size.set(cid, n); cid++;
    }
    const seeds = [...scored.values()].filter((sc) => factor(sc.id, "TASK_MATCH") > 0);
    const connectedSeedExists = seeds.some((sc) => (size.get(comp.get(sc.id) ?? -1) ?? 1) >= 3);
    const NONPROD = /(^|\/)(legacy|deprecated|archive|old|docs?|examples?|samples?|fixtures?|__mocks__|vendor|third_party)(\/|$)/i;
    for (const sc of seeds) {
      if (overrides.get(sc.id) === "pin") continue;
      const e = byId.get(sc.id)!; const n = size.get(comp.get(sc.id) ?? -1) ?? 1;
      let mult = 1; const why: string[] = [];
      if (connectedSeedExists && n === 1) { mult *= 0.55; why.push("isolated: nothing calls it and it calls nothing, so a name match alone counts for less"); }
      else if (connectedSeedExists && n === 2) { mult *= 0.8; why.push("part of only a two-element cluster"); }
      if (NONPROD.test(e.file)) { mult *= 0.7; why.push("under a legacy / docs / examples path"); }
      if (mult < 1) {
        sc.score *= mult; sc.tier = tierOf(sc.score);
        const f = sc.factors.find((x) => x.factor === "TASK_MATCH")!; f.reason = `${f.reason}; ${why.join("; ")} (score × ${mult.toFixed(2)})`;
      }
    }
  }
  const hidden: Retrieval["hidden"] = [];
  const provenance = new Map<string, string[]>();
  const note = (id: string, why: string) => provenance.set(id, [...new Set([...(provenance.get(id) ?? []), why])]);
  const isSeed = (id: string) => overrides.get(id) === "pin" || factor(id, "TASK_MATCH") > 0 || factor(id, "SEMANTIC_JUDGMENT") > 0 || (opts.frames?.has(id) ?? false) || (opts.extraSeeds ?? []).includes(id);
  const candidates = [...scored.values()].filter((s) => isSeed(s.id)).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  if (opts.overview) {
    const order = new Map((opts.extraSeeds ?? []).map((id, i) => [id, i]));
    candidates.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || b.score - a.score || a.id.localeCompare(b.id));
  }
  const picked: string[] = [];
  let inaccessible = 0;
  for (const c of candidates) {
    const label = byId.get(c.id)!.name;
    // A denied match is counted and dropped before anything else can mention it: not in the picks, not in "why hidden".
    if (isDenied(c.id)) { inaccessible++; continue; }
    if (opts.ignored?.has(c.id)) { hidden.push({ entityId: c.id, label, reason: "you asked to ignore it" }); continue; }
    if (picked.length >= maxNodes) { hidden.push({ entityId: c.id, label, reason: `matched, but ranked below the top ${maxNodes}` }); continue; }
    if (c.tier === "HIDDEN" && !(opts.extraSeeds ?? []).includes(c.id)) { hidden.push({ entityId: c.id, label, reason: "matched weakly; relevance below the display threshold" }); continue; }
    picked.push(c.id);
    const e = byId.get(c.id)!, nm = e.name.toLowerCase(), pth = e.file.toLowerCase();
    if (terms.some((t) => nm.includes(t) || pth.includes(t))) note(c.id, "lexical");
    if (opts.semantic?.has(c.id)) note(c.id, "semantic");
    if (factor(c.id, "SEMANTIC_JUDGMENT") > 0) note(c.id, "concept");
    if (opts.frames?.has(c.id)) note(c.id, "stack");
    if (overrides.get(c.id) === "pin") note(c.id, "pinned");
    if ((opts.extraSeeds ?? []).includes(c.id)) note(c.id, "selected");
  }
  // One hop along calls / async hand-offs, best-scored neighbours first, to give seeds their context.
  const idx = revisionIndex(store, revision);
  const inPicked = new Set(picked);
  const neighbours = new Map<string, number>();
  for (const id of picked) for (const n of idx.neighbors.get(id) ?? []) if (!inPicked.has(n) && scored.has(n) && !opts.ignored?.has(n)) { if (isDenied(n)) { inaccessible++; continue; } neighbours.set(n, Math.max(neighbours.get(n) ?? 0, scored.get(n)!.score)); }
  for (const [n] of [...neighbours].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (picked.length >= maxNodes) { hidden.push({ entityId: n, label: byId.get(n)!.name, reason: `direct neighbour of a shown element, cut by the ${maxNodes}-node cap` }); continue; }
    picked.push(n); note(n, "graph neighbour");
  }
  const notes = terms.length ? [`matched on terms: ${terms.join(", ")}`] : ["no searchable terms in question"];
  if (opts.semantic?.size) notes.push(`${opts.semantic.size} element(s) were also found by semantic similarity`);
  let bundle = assemble(store, revision, picked, notes);

  // Cut to the evidence budget, lowest-ranked first (pinned and critical last), and keep the list of what went.
  let truncation: Retrieval["truncation"];
  if (opts.tokenBudget && bundle.tokenEstimate > opts.tokenBudget) {
    const before = bundle.tokenEstimate;
    const rank = (id: string) => (overrides.get(id) === "pin" ? 3 : scored.get(id)!.tier === "CRITICAL" ? 2 : scored.get(id)!.tier === "RELEVANT" ? 1 : 0);
    const order = [...picked].sort((a, b) => rank(a) - rank(b) || scored.get(a)!.score - scored.get(b)!.score || a.localeCompare(b));
    const dropped: { entityId: string; label: string }[] = [];
    let keep = new Set(picked);
    while (bundle.tokenEstimate > opts.tokenBudget && keep.size > 1) {
      const step = Math.max(1, Math.floor(keep.size * 0.1));
      for (const id of order.filter((x) => keep.has(x)).slice(0, step)) { keep.delete(id); dropped.push({ entityId: id, label: byId.get(id)!.name }); hidden.push({ entityId: id, label: byId.get(id)!.name, reason: "dropped to fit the evidence budget for the model" }); }
      bundle = assemble(store, revision, picked.filter((x) => keep.has(x)), [...notes, `evidence cut to fit ~${opts.tokenBudget} tokens`]);
    }
    for (const d of dropped) provenance.delete(d.entityId);
    truncation = { budget: opts.tokenBudget, before, after: bundle.tokenEstimate, dropped };
    picked.splice(0, picked.length, ...picked.filter((x) => keep.has(x)));
  }
  const tiers = new Map<string, ViewNode["tier"]>();
  for (const id of picked) {
    const t = scored.get(id)!.tier;
    tiers.set(id, opts.overview && (opts.extraSeeds ?? []).includes(id) && (t === "HIDDEN" || t === "CONTEXT") ? "RELEVANT" : t === "HIDDEN" ? "CONTEXT" : t); // neighbours are shown as context even when their own score is low
  }
  return { bundle, tiers, scored, terms, hidden, inaccessible, truncation, provenance };
}

/** Neighbourhood around explicit entities, for "why are these connected?". */
export function retrieveAround(store: Store, revision: string, ids: string[], hops = 3, cap = 120, access: AccessPolicy = OPEN): EvidenceBundle {
  const seen = new Set(ids);
  const fileOf = new Map(store.entities(revision).map((e) => [e.entityId, e.file]));
  let frontier = [...ids];
  for (let h = 0; h < hops; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const r of store.relationshipsFor(revision, id)) {
        if (r.kind === "contains") continue;
        for (const o of [r.from, r.to]) if (!seen.has(o) && seen.size < cap && !access.deniedEntity(o, (x) => fileOf.get(x))) { seen.add(o); next.push(o); }
      }
    }
    frontier = next;
  }
  return assemble(store, revision, [...seen], [`${hops}-hop neighbourhood of selection`]);
}
