// Six-factor salience (spec §9.2): every score is a sum of named, explainable factors, each with a reason
// and the evidence it rests on. Deterministic: "recency" is relative to the repo's own newest commit, not wall-clock.
import type { ConceptCard, Entity, FactorScore, SalienceFactor, ViewNode } from "@cie/schema";
import type { Store } from "./store.ts";

export type Weights = Record<SalienceFactor, number>;
export const WEIGHTS = {
  map: { TASK_MATCH: 0.4, RECENCY: 0.1, STRUCTURAL_CENTRALITY: 0.15, RUNTIME_HOTNESS: 0, USER_OVERRIDE: 0.1, SEMANTIC_JUDGMENT: 0.25 } as Weights,
  hypothesis: { TASK_MATCH: 0.25, RECENCY: 0.1, STRUCTURAL_CENTRALITY: 0.1, RUNTIME_HOTNESS: 0.4, USER_OVERRIDE: 0.05, SEMANTIC_JUDGMENT: 0.1 } as Weights,
};

export interface SalienceContext {
  store: Store; revision: string; terms: string[]; weights: Weights;
  /** entityId -> position in the stack (0 = top frame). */
  frames?: Map<string, number>;
  pins?: Set<string>; ignored?: Set<string>;
  cards?: ConceptCard[];
  /** Extra task evidence per entity, e.g. a throw site matching the trace's error class (0..1 + reason). */
  taskBoost?: Map<string, { value: number; reason: string; evidenceIds: string[] }>;
  /** Reported exceptions and failing tests (see hotness.ts). */
  hot?: Map<string, { value: number; reason: string; evidenceIds: string[] }>;
  /** Manual, persistent overrides (pin / boost / demote). */
  overrides?: Map<string, "pin" | "boost" | "demote">;
}
export interface Scored { id: string; score: number; tier: ViewNode["tier"]; factors: FactorScore[] }

interface RevisionIndex { degree: Map<string, number>; maxDegree: number; history: Map<string, { commits: number; lastDate: string; evidenceId: string; subject: string; author: string }>; newest: number; neighbors: Map<string, Set<string>> }
const cache = new Map<string, RevisionIndex>();

export function revisionIndex(store: Store, revision: string): RevisionIndex {
  const hit = cache.get(revision);
  if (hit) return hit;
  const degree = new Map<string, number>(), neighbors = new Map<string, Set<string>>();
  for (const r of store.allRelationships(revision)) {
    if (r.kind !== "calls" && r.kind !== "async-flow") continue;
    for (const [a, b] of [[r.from, r.to], [r.to, r.from]]) {
      degree.set(a, (degree.get(a) ?? 0) + 1);
      neighbors.set(a, (neighbors.get(a) ?? new Set()).add(b));
    }
  }
  const history = new Map<string, RevisionIndex["history"] extends Map<any, infer V> ? V : never>();
  let newest = 0;
  for (const f of store.factsByPredicate(revision, "history")) {
    const v = (f.object as any).value;
    const t = Date.parse(v.lastDate) || 0;
    newest = Math.max(newest, t);
    history.set(f.subject.replace(/^file:/, ""), { commits: v.commits, lastDate: v.lastDate, evidenceId: f.evidence[0]?.id ?? "", subject: v.lastSubject, author: v.lastAuthor });
  }
  const idx = { degree, maxDegree: Math.max(1, ...degree.values()), history, newest, neighbors };
  if (cache.size > 20) cache.clear();
  cache.set(revision, idx);
  return idx;
}

const factor = (f: SalienceFactor, raw: number, reason: string, evidenceIds: string[] = []): FactorScore => ({ factor: f, rawValue: raw, normalizedScore: Math.max(0, Math.min(1, raw)), reason, evidenceIds });

export function tierOf(score: number): ViewNode["tier"] {
  return score >= 0.3 ? "CRITICAL" : score >= 0.17 ? "RELEVANT" : score >= 0.05 ? "CONTEXT" : "HIDDEN";
}

export function scoreEntity(e: Entity, ctx: SalienceContext): Scored {
  const idx = revisionIndex(ctx.store, ctx.revision);
  const name = e.name.toLowerCase(), path = e.file.toLowerCase();
  const factors: FactorScore[] = [];

  const hits = ctx.terms.filter((t) => name.includes(t) || path.includes(t));
  const nameHits = ctx.terms.filter((t) => name.includes(t)).length;
  let task = Math.min(1, (nameHits * 2 + (hits.length - nameHits)) / 3);
  let taskReason = hits.length ? `matches question term(s): ${hits.join(", ")}` : "no question term in its name or path";
  let taskEv: string[] = [];
  const boost = ctx.taskBoost?.get(e.entityId);
  if (boost && boost.value > task) { task = boost.value; taskReason = boost.reason; taskEv = boost.evidenceIds; }
  factors.push(factor("TASK_MATCH", task, taskReason, taskEv));

  const h = idx.history.get(e.file);
  if (h && idx.newest) {
    const days = (idx.newest - (Date.parse(h.lastDate) || 0)) / 86_400_000;
    factors.push(factor("RECENCY", Math.exp(-days / 30), `${e.file} last changed ${h.lastDate.slice(0, 10)} by ${h.author} ("${h.subject}"); ${h.commits} commit(s)`, h.evidenceId ? [h.evidenceId] : []));
  } else factors.push(factor("RECENCY", 0, "no git history for this file"));

  const deg = idx.degree.get(e.entityId) ?? 0;
  factors.push(factor("STRUCTURAL_CENTRALITY", deg / idx.maxDegree, `${deg} call/async link(s); busiest element has ${idx.maxDegree}`));

  const pos = ctx.frames?.get(e.entityId);
  const hot = ctx.hot?.get(e.entityId);
  const stackHot = pos !== undefined ? { v: Math.max(0.3, 1 - pos * 0.15), why: pos === 0 ? "top frame of the pasted stack trace" : `stack frame #${pos + 1} of the pasted trace`, ev: [] as string[] } : null;
  if (stackHot && (!hot || stackHot.v >= hot.value)) factors.push(factor("RUNTIME_HOTNESS", stackHot.v, stackHot.why, stackHot.ev));
  else if (hot) factors.push(factor("RUNTIME_HOTNESS", hot.value, hot.reason, hot.evidenceIds));
  else if (ctx.frames && [...(idx.neighbors.get(e.entityId) ?? [])].some((n) => ctx.frames!.has(n))) factors.push(factor("RUNTIME_HOTNESS", 0.2, "adjacent to a stack frame in the pasted trace"));
  else factors.push(factor("RUNTIME_HOTNESS", 0, ctx.frames ? "not on or next to the stack" : "no exception or failing test points here"));

  const mode = ctx.overrides?.get(e.entityId) ?? (ctx.pins?.has(e.entityId) ? "pin" : undefined);
  factors.push(factor("USER_OVERRIDE", mode === "pin" ? 1 : mode === "boost" ? 0.7 : 0,
    mode === "pin" ? "pinned by you: always shown" : mode === "boost" ? "boosted by you" : mode === "demote" ? "demoted by you: ranked lower" : "no pin or override"));

  const cardHits = (ctx.cards ?? []).filter((c) => c.members.includes(e.entityId) && ctx.terms.some((t) => (c.title + " " + c.summary).toLowerCase().includes(t)));
  factors.push(factor("SEMANTIC_JUDGMENT", Math.min(1, cardHits.length / 2), cardHits.length ? `member of concept card(s): ${cardHits.map((c) => `"${c.title}"`).join(", ")}` : "in no concept card relevant to the question", cardHits.flatMap((c) => c.evidenceIds).slice(0, 3)));

  const wsum = Object.values(ctx.weights).reduce((a, b) => a + b, 0) || 1;
  const base = factors.reduce((s, f) => s + f.normalizedScore * ctx.weights[f.factor], 0) / wsum;
  const demoted = mode === "demote";
  const score = ctx.ignored?.has(e.entityId) ? 0 : demoted ? base * 0.3 : base;
  // A pin is a manual override of the tier itself: it is shown as CRITICAL regardless of the computed score.
  const tier: ViewNode["tier"] = ctx.ignored?.has(e.entityId) ? "HIDDEN" : mode === "pin" ? "CRITICAL" : tierOf(score);
  return { id: e.entityId, score: mode === "pin" ? Math.max(score, 0.6) : score, tier, factors };
}
