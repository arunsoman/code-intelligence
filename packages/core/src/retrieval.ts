import { diagnostic, diagnosticsEnabled, bundleDiagnostics } from "./diagnostics.ts";
// Question → bounded, revision-bound evidence bundle (C09 projection + C10/C11 retrieval, keyword/graph only).
import { createHash } from "node:crypto";
import { modelEvidence } from "@cie/model";
import type { ConceptCard, EvidenceBundle, EvidenceRef, Fact, Relationship, ResolvedEvidence, ViewNode } from "@cie/schema";
import { OPEN, type AccessPolicy } from "./access.ts";
import type { Semantic } from "./embeddings.ts";
import { runtimeHotness } from "./hotness.ts";
import { LENSES, protectedTier } from "./context.ts";
import { revisionIndex, scoreEntity, tierOf, WEIGHTS, type SalienceContext, type Scored, type Weights } from "./salience.ts";
import type { Store } from "./store.ts";
import { answerConcepts, navigateHierarchy, overviewSeeds, productionEntities, sourceModule } from "./overview.ts";

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
  truncation?: { budget: number; before: number; after: number; dropped: { entityId: string; label: string }[]; omittedFacts?: number; shortenedExcerpts?: number };
  /** Why each shown element was picked: it matched the words, it is semantically close, a concept card names it, it is a neighbour, ... */
  provenance: Map<string, string[]>;
}
export interface RetrieveOptions {
  scope?: "repository" | "subject";
  /** Use the same compact payload used by the model provider when measuring its budget. */
  forModel?: boolean;
  resolveEvidence?: (ev: EvidenceRef) => ResolvedEvidence;
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
  /** Entity kinds required by a notation chart, added from selected files and relationship partners. */
  requireKinds?: readonly string[];
  /** Kinds that must be included across the repository (for repository-wide ER views). */
  requireAcrossRepositoryKinds?: readonly string[];
}

const symbolKinds = new Set(["function", "method", "class", "interface", "type", "field", "enum", "module", "package", "crate", "workspace", "table", "column", "relation"]);
const estimateTokens = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

function assemble(store: Store, revision: string, entityIds: string[], notes: string[], includeDefectSemantics = true, model?: RetrieveOptions): EvidenceBundle {
  const idSet = new Set(entityIds);
  const entities = store.entitiesById(revision, entityIds);
  // Pull in the containing file entities so `contains` evidence resolves.
  const files = [...new Set(entities.map((e) => e.file))].map((f) => `file:${f}`);
  for (const f of store.entitiesById(revision, files)) if (!idSet.has(f.entityId)) { entities.push(f); idSet.add(f.entityId); }

  const rels = new Map<string, Relationship>();
  const facts = new Map<string, Fact>();
  for (const id of idSet) {
    for (const r of store.relationshipsFor(revision, id)) if (idSet.has(r.from) && idSet.has(r.to)) rels.set(r.id, r);
    for (const f of store.factsFor(revision, id)) {
      if (!includeDefectSemantics && f.predicate.startsWith("defect.")) continue;
      if (model && (f.predicate === "history" || (!entityIds.includes(id) && ["calls", "reads", "writes", "throws", "defect.semantic-event.v1"].includes(f.predicate)))) continue;
      facts.set(f.id, f);
    }
  }
  let stale = 0, oversizedFacts = 0;
  if (model) {
    const revisionRow = store.revision(revision)!;
    const states = new Map<string, boolean>();
    const current = (ev: EvidenceRef) => {
      if (ev.state !== "CURRENT") return false;
      if (!model.resolveEvidence) return true;
      const span = (ev.location as { span?: { sourceId: string; contentHash: string } }).span;
      const key = span ? `${span.sourceId}|${span.contentHash}` : ev.id;
      if (!states.has(key)) states.set(key, model.resolveEvidence(ev).state === "CURRENT");
      return states.get(key)!;
    };
    for (const [id, rel] of rels) {
      const evidence = rel.evidence.filter(current).slice(0, 2);
      if (evidence.length) rels.set(id, { ...rel, evidence }); else rels.delete(id);
    }
    for (const [id, fact] of facts) {
      // Large analysis objects are not necessary to explain code. Retain typed declarations intact.
      if (JSON.stringify(fact.object).length > 2400 && !/(?:signature|table|column|schema|metric|condition|framework_role)/.test(fact.predicate)) { facts.delete(id); oversizedFacts++; continue; }
      const evidence = fact.evidence.filter(current).slice(0, 2);
      if (evidence.length) facts.set(id, { ...fact, evidence }); else facts.delete(id);
    }
    const excerpts: Fact[] = [];
    const perFile = new Map<string, number>();
    if (model.resolveEvidence) for (const entity of entities.filter((e) => entityIds.includes(e.entityId))) {
      if (excerpts.length >= 24 || (perFile.get(entity.file) ?? 0) >= 2) continue;
      const span = entity.spans[0];
      if (!span) continue;
      const ev: EvidenceRef = { id: `model-source:${createHash("sha256").update(`${revision}|${entity.entityId}|${span.contentHash}`).digest("hex").slice(0, 20)}`,
        sourceId: entity.file, location: { kind: "CodeLocation", span }, class: "STATIC_PARSED", observedAt: revisionRow.createdAt, accessScopeId: revisionRow.repoRoot, state: "CURRENT" };
      if (!current(ev)) { stale++; continue; }
      const source = model.resolveEvidence(ev);
      if (!source.snippet) continue;
      if (entity.file.endsWith(".rs")) {
        const prefix = model.resolveEvidence({ ...ev, location: { kind: "CodeLocation", span: { ...span, startByte: Math.max(0, span.startByte - 180), endByteExclusive: span.startByte } } });
        if (/#\[(?:[\w:]+::)?test(?:\([^\]]*\))?\]\s*(?:#\[[^\]]+\]\s*)*$/.test(prefix.snippet)) continue;
      }
      store.putEvidence(revision, ev);
      perFile.set(entity.file, (perFile.get(entity.file) ?? 0) + 1);
      const snippet = source.snippet.length > 1800 ? `${source.snippet.slice(0, 1000)}\n/* excerpt shortened */\n${source.snippet.slice(-700)}` : source.snippet;
      excerpts.push({ id: `model-excerpt:${entity.entityId}`, subject: entity.entityId, predicate: "source_excerpt", object: { kind: "source", value: snippet }, evidence: [ev], resolution: "PARSED" });
    }
    // Attach only concepts whose members have current implementation excerpts in this sample.
    // A structural label (especially a fallback name) guides interpretation, never establishes behavior.
    const sourceBySubject = new Map(excerpts.map((f) => [f.subject, f]));
    const concepts: Fact[] = answerConcepts(store, revision)
      .filter((c) => c.members.every((id) => sourceBySubject.has(id)))
      .sort((a, b) => Number(["capability", "workflow"].includes(b.kind)) - Number(["capability", "workflow"].includes(a.kind)) || b.members.length - a.members.length || a.id.localeCompare(b.id))
      .slice(0, 12).map((c) => ({ id: `model-concept:${c.id}`, subject: c.members[0]!, predicate: "concept_guidance",
        object: { kind: "concept", value: c }, resolution: "PARSED" as const,
        evidence: [...new Map(c.members.flatMap((id) => sourceBySubject.get(id)!.evidence).map((ev) => [ev.id, ev])).values()],
      }));
    const retained = [...facts.values()].slice(0, Math.max(0, 400 - excerpts.length - concepts.length));
    oversizedFacts += facts.size - retained.length;
    facts.clear();
    for (const fact of [...excerpts, ...concepts, ...retained]) facts.set(fact.id, fact);
  }
  const evidence = new Map<string, EvidenceRef>();
  for (const r of rels.values()) for (const e of r.evidence) evidence.set(e.id, e);
  for (const f of facts.values()) for (const e of f.evidence) evidence.set(e.id, e);

  const unresolved = [...facts.values()].filter((f) => f.resolution === "UNRESOLVED");
  const bundle: EvidenceBundle = {
    id: `bundle:${createHash("sha256").update(revision + [...idSet].sort().join("|")).digest("hex").slice(0, 16)}`,
    revision, evidence: [...evidence.values()], entities, relationships: [...rels.values()], facts: [...facts.values()],
    coverage: ["TypeScript, Java, Go, Python, Rust and Nirdosha v2 static analysis (tree-sitter)", ...notes],
    unresolved: [...(unresolved.length ? [`${unresolved.length} call(s) could not be statically resolved`] : []), ...(stale ? [`${stale} selected source excerpt(s) were stale or unavailable; re-index to include changed code.`] : [])],
    tokenEstimate: 0,
  };
  if (oversizedFacts) bundle.coverage.push(`${oversizedFacts} oversized or excess analysis fact(s) omitted from the model context.`);
  if (model) {
    bundle.coverage.push("Answer evidence is a bounded source sample; missing information here does not establish absence from the repository.");
    if (model.scope === "repository") bundle.coverage.push("Production-source module coverage; tests, fixtures, documentation and generated code excluded.");
    refreshModelBundle(bundle);
  } else bundle.tokenEstimate = estimateTokens(bundle);
  return bundle;
}

function refreshModelBundle(bundle: EvidenceBundle) {
  bundle.evidence = [...new Map([...bundle.relationships, ...bundle.facts].flatMap((item) => item.evidence).map((ev) => [ev.id, ev])).values()];
  const payload = modelEvidence({ purpose: "CHART", bundle });
  bundle.tokenEstimate = estimateTokens(payload);
  bundle.id = `bundle:model-v2:${createHash("sha256").update(bundle.revision + JSON.stringify(payload)).digest("hex").slice(0, 20)}`;
}

function reduceModelDetail(bundle: EvidenceBundle, budget: number) {
  const before = bundle.facts.length;
  let shortenedExcerpts = 0;
  const optional = bundle.facts.filter((f) => f.predicate !== "source_excerpt" && !/(?:signature|table|column|schema|metric|condition|framework_role)/.test(f.predicate))
    .sort((a, b) => estimateTokens(b) - estimateTokens(a));
  for (const fact of optional) {
    if (bundle.tokenEstimate <= budget) break;
    bundle.facts = bundle.facts.filter((f) => f.id !== fact.id); refreshModelBundle(bundle);
  }
  if (bundle.tokenEstimate > budget) for (const fact of bundle.facts.filter((f) => f.predicate === "source_excerpt")) {
    const value = String(fact.object.value);
    if (value.length > 600) { fact.object = { ...fact.object, value: `${value.slice(0, 600)}\n/* excerpt shortened */` }; shortenedExcerpts++; }
  }
  refreshModelBundle(bundle);
  return { omittedFacts: before - bundle.facts.length, shortenedExcerpts };
}

export function bundleFor(store: Store, revision: string, entityIds: string[], notes: string[] = [], options: { includeDefectSemantics?: boolean } = {}): EvidenceBundle {
  return assemble(store, revision, entityIds, notes, options.includeDefectSemantics ?? true);
}

export function retrieveForQuestion(store: Store, revision: string, question: string, opts: RetrieveOptions = {}): Retrieval {
  if (opts.forModel && answerConcepts(store, revision).length) {
    const hierarchy = navigateHierarchy(store, revision, question, opts.scope === "repository" || opts.overview ? [] : opts.extraSeeds);
    opts = { ...opts, extraSeeds: [...new Set([...(opts.pins ?? []), ...hierarchy.seeds])] };
    diagnostic("retrieval.hierarchy", { revision, hierarchyLevel: hierarchy.level, conceptIds: hierarchy.conceptIds, seeds: hierarchy.seeds, nodes: hierarchy.nodes });
  }
  if (opts.scope === "repository") opts = { ...opts, overview: true, extraSeeds: opts.extraSeeds ?? overviewSeeds(store, revision) };
  const started = performance.now();
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
  const symbols = (opts.scope === "repository" ? productionEntities(allEntities) : allEntities).filter((e) => symbolKinds.has(e.kind));
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
  // A pin ("it will always be shown") or an explicit seed (the subject of this view, or what a chat answer
  // relied on) must survive being outranked by an unrelated flood of ordinary keyword matches — the cap and the
  // weak-match floor below are both for THOSE, never for a caller-named entity. Access and "ignore" still apply:
  // being named does not override either. Guaranteed entities go first, in their own score order, so when there
  // are more of them than maxNodes the strongest still wins; everything else fills whatever capacity is left.
  const guaranteed = (id: string) => overrides.get(id) === "pin" || (opts.extraSeeds ?? []).includes(id);
  const [first, rest] = [candidates.filter((c) => guaranteed(c.id)), candidates.filter((c) => !guaranteed(c.id))];
  for (const c of [...first, ...rest]) {
    const label = byId.get(c.id)!.name;
    // A denied match is counted and dropped before anything else can mention it: not in the picks, not in "why hidden".
    if (isDenied(c.id)) { inaccessible++; continue; }
    if (opts.ignored?.has(c.id)) { hidden.push({ entityId: c.id, label, reason: "you asked to ignore it" }); continue; }
    if (!guaranteed(c.id) && picked.length >= maxNodes) { hidden.push({ entityId: c.id, label, reason: `matched, but ranked below the top ${maxNodes}` }); continue; }
    if (c.tier === "HIDDEN" && !guaranteed(c.id)) { hidden.push({ entityId: c.id, label, reason: "matched weakly; relevance below the display threshold" }); continue; }
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
  const build = (ids: string[], coverage: string[]) => assemble(store, revision, ids, coverage, !opts.forModel, opts.forModel ? opts : undefined);
  let bundle = build(picked, notes);

  // Cut to the evidence budget, lowest-ranked first (pinned and critical last), and keep the list of what went.
  let truncation: Retrieval["truncation"];
  if (opts.tokenBudget && bundle.tokenEstimate > opts.tokenBudget) {
    const before = bundle.tokenEstimate;
    const reduced = opts.forModel ? reduceModelDetail(bundle, opts.tokenBudget) : {};
    // A pin or an explicit seed is exempt from the maxNodes cutoff above for the same reason it must not be the
    // first thing a token squeeze throws away: it is not a weak match to be weighed against stronger ones, it is
    // the thing the caller named.
    const rank = (id: string) => (guaranteed(id) ? 3 : scored.get(id)!.tier === "CRITICAL" ? 2 : scored.get(id)!.tier === "RELEVANT" ? 1 : 0);
    const order = [...picked].sort((a, b) => rank(a) - rank(b) || scored.get(a)!.score - scored.get(b)!.score || a.localeCompare(b));
    const dropped: { entityId: string; label: string }[] = [];
    let keep = new Set(picked);
    while (bundle.tokenEstimate > opts.tokenBudget && keep.size > 1) {
      const step = Math.max(1, Math.floor(keep.size * 0.1));
      const modules = new Map<string, number>();
      for (const id of keep) { const module = sourceModule(byId.get(id)!.file); modules.set(module, (modules.get(module) ?? 0) + 1); }
      const removable = order.filter((x) => keep.has(x));
      if (opts.forModel && opts.scope === "repository") removable.sort((a, b) => Number((modules.get(sourceModule(byId.get(a)!.file)) ?? 0) <= 1) - Number((modules.get(sourceModule(byId.get(b)!.file)) ?? 0) <= 1));
      for (const id of removable.slice(0, step)) { keep.delete(id); dropped.push({ entityId: id, label: byId.get(id)!.name }); hidden.push({ entityId: id, label: byId.get(id)!.name, reason: "dropped to fit the evidence budget for the model" }); }
      bundle = build(picked.filter((x) => keep.has(x)), [...notes, `evidence cut to fit ~${opts.tokenBudget} tokens`]);
      if (opts.forModel) reduceModelDetail(bundle, opts.tokenBudget);
    }
    for (const d of dropped) provenance.delete(d.entityId);
    truncation = { budget: opts.tokenBudget, before, after: bundle.tokenEstimate, dropped, ...reduced };
    picked.splice(0, picked.length, ...picked.filter((x) => keep.has(x)));
  }
  // Notation charts need complete class members and both ends of their UML relations.
  // Add these after ordinary retrieval and token trimming, with the same access and ignore checks.
  if (opts.requireKinds?.length || opts.requireAcrossRepositoryKinds?.length) {
    const kinds = new Set(opts.requireKinds);
    const acrossRepository = new Set(opts.requireAcrossRepositoryKinds);
    const pickedSet = new Set(picked);
    const pickedFiles = new Set(picked.map((id) => fileOf.get(id)).filter((f): f is string => !!f));
    const topUp: string[] = [];
    for (const e of symbols) {
      if (pickedSet.has(e.entityId) || !kinds.has(e.kind)) continue;
      if (isDenied(e.entityId) || opts.ignored?.has(e.entityId)) continue;
      if (pickedFiles.has(e.file) || acrossRepository.has(e.kind)) { topUp.push(e.entityId); pickedSet.add(e.entityId); }
    }
    for (const id of [...pickedSet]) {
      for (const r of store.relationshipsFor(revision, id)) {
        if (!["extends", "implements", "association", "foreign_key", "persistence_association"].includes(r.kind)) continue;
        const nb = r.from === id ? r.to : r.from;
        const e = byId.get(nb);
        if (e && kinds.has(e.kind) && !pickedSet.has(nb) && !isDenied(nb) && !opts.ignored?.has(nb)) {
          topUp.push(nb); pickedSet.add(nb);
        }
      }
    }
    for (const id of topUp.slice(0, opts.forModel && opts.scope === "repository" ? Math.max(0, maxNodes - picked.length) : 160)) {
      const candidate = build([...picked, id], [...notes, "chart notation kinds included"]);
      if (opts.tokenBudget && candidate.tokenEstimate > opts.tokenBudget) {
        const entity = byId.get(id)!;
        hidden.push({ entityId: id, label: entity.name, reason: "left out to keep the required chart evidence within the token budget" });
        continue;
      }
      picked.push(id);
      note(id, "chart notation kinds");
      bundle = candidate;
    }
  }
  const tiers = new Map<string, ViewNode["tier"]>();
  for (const id of picked) {
    // Chart-specific retrieval can add required notation entities after normal ranking.
    // They have not passed through the scorer, so retain them as context instead of
    // dereferencing a missing score (and crashing explicit chart requests).
    const t = scored.get(id)?.tier ?? "CONTEXT";
    tiers.set(id, opts.overview && (opts.extraSeeds ?? []).includes(id) && (t === "HIDDEN" || t === "CONTEXT") ? "RELEVANT" : t === "HIDDEN" ? "CONTEXT" : t); // neighbours are shown as context even when their own score is low
  }
  if (diagnosticsEnabled()) {
    diagnostic("retrieval.complete", { revision, question, elapsedMs: performance.now() - started, terms, overview: !!opts.overview, maxNodes, tokenBudget: opts.tokenBudget, lens: opts.lens, extraSeeds: opts.extraSeeds, pins: [...(opts.pins ?? [])], indexedEntities: allEntities.length, indexedSymbols: symbols.length, inaccessible, truncation: truncation ? { ...truncation, dropped: truncation.dropped.filter((d) => !isDenied(d.entityId)) } : undefined, hidden: hidden.filter((h) => !isDenied(h.entityId)), bundle: bundleDiagnostics(bundle) });
    const visibleScores = [...scored.values()].filter((sc) => !isDenied(sc.id));
    for (let offset = 0; offset < visibleScores.length; offset += 100) diagnostic("retrieval.candidates", { revision, offset, total: visibleScores.length, candidates: visibleScores.slice(offset, offset + 100).map((sc) => ({ id: sc.id, name: byId.get(sc.id)?.name, file: byId.get(sc.id)?.file, score: sc.score, tier: sc.tier, factors: sc.factors, selected: picked.includes(sc.id), provenance: provenance.get(sc.id) })) });
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
