// CausalGraph: "what could make X fail" (failure mode) and "why could <field> become wrong" (invariant mode).
// Everything shown is derived from stored facts; links that cross an async hand-off are claims that go through
// the gates, so they surface as hypotheses with an explicit counter-argument rather than as plain facts.
import { createHash } from "node:crypto";
import type { Claim, Entity, Fact, Relationship, ViewEdge, ViewNode, ViewSpec } from "@cie/schema";
import { gateClaim } from "../claims.ts";
import { retrieveForQuestion } from "../retrieval.ts";
import { queryTerms } from "../retrieval.ts";
import type { RevisionRow, Store } from "../store.ts";

const LEGEND: ViewSpec["legend"] = [
  { label: "Fact", displayMode: "FACT", description: "Statically proven (a call, a throw, a write); click for the exact line." },
  { label: "Inference", displayMode: "INFERENCE", description: "A conclusion drawn from cited evidence." },
  { label: "Hypothesis", displayMode: "HYPOTHESIS", description: "Plausible but cannot be proven statically, e.g. it crosses an async hand-off." },
  { label: "Fog", displayMode: "FOG", description: "Has calls static analysis could not resolve." },
];
const FLOW = new Set(["calls", "async-flow"]);

interface Graph { out: Map<string, Relationship[]>; inn: Map<string, Relationship[]>; entities: Map<string, Entity> }

function graphOf(store: Store, rev: string): Graph {
  const out = new Map<string, Relationship[]>(), inn = new Map<string, Relationship[]>();
  for (const r of store.allRelationships(rev)) {
    if (!FLOW.has(r.kind) || r.from.startsWith("test:") || r.to.startsWith("test:")) continue;
    out.set(r.from, [...(out.get(r.from) ?? []), r]);
    inn.set(r.to, [...(inn.get(r.to) ?? []), r]);
  }
  return { out, inn, entities: new Map(store.entities(rev).map((e) => [e.entityId, e])) };
}

/** BFS with parent edges; `viaAsync` is true if any edge on the shortest path is an async hand-off. */
function bfs(starts: string[], adj: Map<string, Relationship[]>, next: (r: Relationship) => string, maxDepth: number, cap: number) {
  const info = new Map<string, { depth: number; parent?: { id: string; rel: Relationship }; viaAsync: boolean }>();
  starts.forEach((s) => info.set(s, { depth: 0, viaAsync: false }));
  const q = [...starts];
  while (q.length && info.size < cap) {
    const cur = q.shift()!;
    const ci = info.get(cur)!;
    if (ci.depth >= maxDepth) continue;
    for (const r of adj.get(cur) ?? []) {
      const n = next(r);
      if (info.has(n) || info.size >= cap) continue;
      info.set(n, { depth: ci.depth + 1, parent: { id: cur, rel: r }, viaAsync: ci.viaAsync || r.kind === "async-flow" });
      q.push(n);
    }
  }
  return info;
}

const val = (f: Fact) => String((f.object as { value?: unknown }).value ?? "");
const nodeId = (id: string) => `n:${id}`;
const emptyView = (rev: RevisionRow, question: string, kind: "failure" | "invariant", why: string, reason: string): { view: ViewSpec; claims: Claim[] } => ({
  claims: [],
  view: {
    id: "view:causal:" + createHash("sha256").update(rev.id + question).digest("hex").slice(0, 10), version: 1, revision: rev.id, taskId: "task", formId: "CausalGraph",
    caption: why, question, level: 5, nodes: [], edges: [], groups: [], legend: LEGEND, cameraPolicy: { behavior: "PRESERVE" }, gaps: [], formReason: reason, hidden: [], meta: { kind },
  },
});

export function buildFailureGraph(store: Store, rev: RevisionRef, question: string): { view: ViewSpec; claims: Claim[] } {
  // The failure words describe the question, not the subject: strip them so "fail" does not match every *FailedError class.
  const subject = question.replace(/\b(fail\w*|cause\w*|error\w*|break\w*|crash\w*|reject\w*|declin\w*|everything|anything|could|can|might|show|me)\b/gi, " ");
  const r = retrieveForQuestion(store, rev.id, subject, { maxNodes: 60 });
  const g = graphOf(store, rev.id);
  const seeds = [...r.scored.values()]
    .filter((s) => s.factors.find((f) => f.factor === "TASK_MATCH")!.normalizedScore > 0 && g.entities.has(s.id) && /^(function|method)$/.test(g.entities.get(s.id)!.kind))
    .sort((a, b) => b.score - a.score);
  const seedSet = new Set(seeds.map((s) => s.id));
  const roots = seeds.filter((s) => !(g.inn.get(s.id) ?? []).some((rel) => seedSet.has(rel.from))).slice(0, 3).map((s) => s.id);
  if (roots.length === 0) return emptyView(rev, question, "failure", "I can't tell which operation you mean. Name a feature, e.g. “payment”, and I'll map what can make it fail.", "Failure question, but nothing in the code matches it.");

  const reach = bfs(roots, g.out, (x) => x.to, 6, 80);
  const throwsAt = new Map<string, Fact[]>();
  for (const f of store.factsByPredicate(rev.id, "throws")) if (reach.has(f.subject)) throwsAt.set(f.subject, [...(throwsAt.get(f.subject) ?? []), f]);

  // Keep only nodes on a path from a root to a failure site.
  // Roots are kept only through a failure site, so an operation that cannot fail does not appear.
  const keep = new Set<string>();
  for (const id of throwsAt.keys()) for (let c: string | undefined = id; c; c = reach.get(c)?.parent?.id) keep.add(c);
  if (keep.size === 0) return emptyView(rev, question, "failure", `I found “${roots.map((x) => g.entities.get(x)!.name).join(", ")}” but no throw site is reachable from it by static calls. If it fails dynamically, paste the stack trace and I'll investigate.`, "Failure question; the operation has no statically reachable failure site.");
  const keptEdges = [...keep].flatMap((id) => (g.out.get(id) ?? []).filter((x) => keep.has(x.to)));

  const unresolvedBy = new Map<string, number>();
  for (const id of keep) for (const f of store.factsFor(rev.id, id)) if (f.resolution === "UNRESOLVED" && f.predicate === "calls") unresolvedBy.set(id, (unresolvedBy.get(id) ?? 0) + 1);
  const containsEv = new Map<string, string[]>();
  for (const id of keep) for (const x of store.relationshipsFor(rev.id, id)) if (x.kind === "contains" && x.to === id) containsEv.set(id, x.evidence.map((e) => e.id));

  const nodes: ViewNode[] = [], edges: ViewEdge[] = [], claims: Claim[] = [];
  const bundleEv = new Set<string>();
  const ent = (id: string) => g.entities.get(id)!;
  for (const id of keep) {
    const e = ent(id), ri = reach.get(id)!;
    nodes.push({
      id: nodeId(id), entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds: [], evidenceIds: containsEv.get(id) ?? [],
      tier: reach.get(id)!.depth === 0 ? "CRITICAL" : "RELEVANT", displayMode: (unresolvedBy.get(id) ?? 0) > 0 ? "FOG" : "FACT", unresolvedCalls: unresolvedBy.get(id) ?? 0,
      role: reach.get(id)!.depth === 0 ? "operation" : "step", layer: ri.depth, notes: ri.viaAsync ? ["Reached only through an asynchronous hand-off."] : [],
    });
  }
  for (const rel of keptEdges) {
    edges.push({ id: `e:${rel.id}`, fromNodeId: nodeId(rel.from), toNodeId: nodeId(rel.to), kind: rel.kind, relationshipId: rel.id, evidenceIds: rel.evidence.map((e) => e.id), displayMode: rel.kind === "async-flow" ? "HYPOTHESIS" : "FACT", label: rel.label });
  }

  const pathTo = (id: string) => { const p: Relationship[] = []; for (let c = reach.get(id); c?.parent; c = reach.get(c.parent.id)) p.unshift(c.parent.rel); return p; };
  const entityPath = (id: string) => { const ids = [id]; for (let c = reach.get(id); c?.parent; c = reach.get(c.parent.id)) ids.unshift(c.parent.id); return ids; };
  const asyncClaimByEdge = new Map<string, string>();
  let modes = 0, asyncModes = 0;
  for (const [fn, facts] of throwsAt) {
    const ri = reach.get(fn)!;
    const chain = pathTo(fn);
    const root = entityPath(fn)[0];
    for (const cls of [...new Set(facts.map(val))]) {
      const ff = facts.filter((f) => val(f) === cls);
      const evidenceIds = [...new Set([...ff.flatMap((f) => f.evidence.map((e) => e.id)), ...chain.flatMap((c) => c.evidence.map((e) => e.id))])];
      const names = entityPath(fn).map((x) => ent(x).name).join(" → ");
      const claim = gateClaim({
        assertion: `${ent(root).name} can fail with ${cls}: ${names}.`, claimClass: "failure-mode", evidenceIds,
        rationaleSummary: `${cls} is thrown in ${ent(fn).name}; a ${chain.length}-hop static path reaches it from ${ent(root).name}${ri.viaAsync ? ", crossing an async hand-off" : ""}.`,
        structure: { kind: "path", entityIds: entityPath(fn) },
      }, { id: "causal", revision: rev.id, evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 }, { store, trusted: true });
      claims.push(claim);
      modes++; if (ri.viaAsync) asyncModes++;
      const fid = `n:fail:${fn}:${cls}`;
      nodes.push({
        id: fid, entityRefs: [fn], label: cls, kind: "failure", file: ent(fn).file, claimIds: [claim.draft.id], evidenceIds: ff.flatMap((f) => f.evidence.map((e) => e.id)),
        tier: "CRITICAL", displayMode: claim.displayMode === "HIDDEN" ? "HYPOTHESIS" : claim.displayMode, unresolvedCalls: 0, role: "failure-site", layer: ri.depth + 1,
        notes: [ri.viaAsync ? "Non-obvious: only reachable through an async hand-off, so the original caller never sees it." : "Directly reachable by static calls.", `Thrown in ${ent(fn).name}.`],
      });
      // The throw itself is a static fact; the claim (reachability from the operation) lives on the failure node, and edges to a hidden node go with it.
      edges.push({ id: `e:raises:${fn}:${cls}`, fromNodeId: nodeId(fn), toNodeId: fid, kind: "raises", evidenceIds: ff.flatMap((f) => f.evidence.map((e) => e.id)), displayMode: "FACT", label: "throws" });
      for (const c of chain) if (c.kind === "async-flow") asyncClaimByEdge.set(c.id, claim.draft.id);
    }
  }
  // Async edges inherit the claim of the first failure that depends on them, so clicking the edge shows the counter-argument.
  for (const e of edges) { const c = e.relationshipId && asyncClaimByEdge.get(e.relationshipId); if (c) e.claimId = c; }
  void bundleEv;

  const gaps: string[] = [];
  const fog = [...unresolvedBy.values()].reduce((a, b) => a + b, 0);
  if (fog) gaps.push(`${fog} call(s) on these paths could not be statically resolved; there may be failure modes not shown.`);
  if (modes === 0) gaps.push("No throw sites are reachable from this operation by static calls.");
  const id = "view:causal:" + createHash("sha256").update(rev.id + question).digest("hex").slice(0, 10);
  return {
    claims,
    view: {
      id, version: 1, revision: rev.id, taskId: "task:" + id, formId: "CausalGraph", question, level: 5, nodes, edges, groups: [], legend: LEGEND, cameraPolicy: { behavior: "PRESERVE" }, gaps,
      caption: `${modes} way(s) “${roots.filter((x) => keep.has(x)).map((x) => ent(x).name).join(", ")}” can fail${asyncModes ? `, ${asyncModes} of them only through an async hand-off` : ""}. Left to right: operation → … → failure site.`,
      formReason: "You asked what can make something fail, so this is a cause graph: failure sites reachable from the operation, each with its evidence.",
      hidden: r.hidden, meta: { kind: "failure" },
    },
  };
}

type RevisionRef = RevisionRow;

export function buildInvariantGraph(store: Store, rev: RevisionRow, question: string): { view: ViewSpec; claims: Claim[] } {
  const terms = queryTerms(question);
  const writes = store.factsByPredicate(rev.id, "writes");
  const byField = new Map<string, Fact[]>();
  for (const f of writes) byField.set(val(f), [...(byField.get(val(f)) ?? []), f]);
  const g = graphOf(store, rev.id);
  const candidates = [...byField].filter(([field, fs]) => terms.some((t) => field.toLowerCase().includes(t)) && fs.some((f) => g.entities.has(f.subject)))
    .sort((a, b) => new Set(b[1].map((f) => f.subject)).size - new Set(a[1].map((f) => f.subject)).size);
  if (candidates.length === 0) return emptyView(rev, question, "invariant", "I can't tell which piece of state you mean. Name a field, e.g. “balance”, and I'll map everything that writes it.", "Invariant question, but no written field matches it.");
  const [field, fieldFacts] = candidates[0];

  const writers = [...new Set(fieldFacts.map((f) => f.subject))].filter((id) => g.entities.has(id));
  const txBy = new Set(store.factsByPredicate(rev.id, "uses_transaction").map((f) => f.subject));
  const writeEv = (id: string) => fieldFacts.filter((f) => f.subject === id).flatMap((f) => f.evidence.map((e) => e.id));
  const up = bfs(writers, g.inn, (x) => x.from, 3, 60);
  const maxD = Math.max(...[...up.values()].map((v) => v.depth));
  const ent = (id: string) => g.entities.get(id)!;

  const nodes: ViewNode[] = [], edges: ViewEdge[] = [], claims: Claim[] = [];
  const unresolvedBy = new Map<string, number>();
  for (const id of up.keys()) for (const f of store.factsFor(rev.id, id)) if (f.resolution === "UNRESOLVED" && f.predicate === "calls") unresolvedBy.set(id, (unresolvedBy.get(id) ?? 0) + 1);
  const fieldNodeId = `n:field:${field}`;
  const tested = (id: string) => store.relationshipsFor(rev.id, id).some((x) => x.kind === "calls" && x.to === id && x.from.startsWith("test:"));
  const contains = (id: string) => store.relationshipsFor(rev.id, id).filter((x) => x.kind === "contains" && x.to === id).flatMap((x) => x.evidence.map((e) => e.id));

  let risky = 0, asyncWriters = 0;
  for (const [id, info] of up) {
    const isWriter = writers.includes(id);
    const e = ent(id);
    const notes: string[] = [];
    let claimIds: string[] = [];
    let display: ViewNode["displayMode"] = (unresolvedBy.get(id) ?? 0) > 0 ? "FOG" : "FACT";
    if (isWriter) {
      const inTx = txBy.has(id);
      // Best caller path "entry → … → writer": walk each BFS leaf's parent pointers (which lead toward the writer),
      // preferring paths that cross an async hand-off (the non-obvious ones), then longer ones.
      const entityPath: string[] = [id], rels: Relationship[] = [];
      {
        const reachUp = bfs([id], g.inn, (x) => x.from, 3, 40);
        let best: { ids: string[]; rels: Relationship[]; score: number } | null = null;
        for (const [leaf, li] of reachUp) {
          if (leaf === id) continue;
          const ids = [leaf], rs: Relationship[] = [];
          for (let c = li; c.parent; c = reachUp.get(c.parent.id)!) { rs.push(c.parent.rel); ids.push(c.parent.id); }
          const score = rs.filter((x) => x.kind === "async-flow").length * 10 + rs.length;
          if (!best || score > best.score) best = { ids, rels: rs, score };
        }
        if (best) { entityPath.splice(0, entityPath.length, ...best.ids); rels.push(...best.rels); }
      }
      const viaAsync = rels.some((x) => x.kind === "async-flow");
      if (!inTx) { risky++; notes.push("Writes outside a transaction."); } else notes.push("Writes inside a transaction.");
      if (viaAsync) { asyncWriters++; notes.push("Reached through an asynchronous hand-off."); }
      if (!tested(id)) notes.push("No test directly exercises it.");
      const claim = gateClaim({
        assertion: `${e.name} writes ${field}${inTx ? " inside a transaction" : " outside any transaction"}${viaAsync ? ", reached via an async hand-off" : ""}.`,
        claimClass: "invariant-risk", evidenceIds: [...new Set([...writeEv(id), ...rels.flatMap((x) => x.evidence.map((ev) => ev.id))])],
        rationaleSummary: inTx ? `Transactional writers can still race with the ${field} writers that are not.` : `A non-transactional write can interleave with transactional ones and leave ${field} inconsistent.`,
        structure: entityPath.length > 1 ? { kind: "path", entityIds: entityPath } : undefined,
      }, { id: "causal", revision: rev.id, evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 }, { store, trusted: true });
      claims.push(claim);
      claimIds = [claim.draft.id];
      display = claim.displayMode === "HIDDEN" ? "HYPOTHESIS" : !inTx || viaAsync ? (claim.displayMode === "INFERENCE" && !viaAsync ? "INFERENCE" : claim.displayMode) : "FACT";
    }
    nodes.push({
      id: nodeId(id), entityRefs: [id], label: e.name, kind: e.kind, file: e.file, claimIds, evidenceIds: isWriter ? writeEv(id) : contains(id),
      tier: isWriter ? "CRITICAL" : "RELEVANT", displayMode: display, unresolvedCalls: unresolvedBy.get(id) ?? 0, role: isWriter ? "writer" : "path", layer: maxD - info.depth, notes,
    });
    if (info.parent) {
      const rel = info.parent.rel;
      if (!edges.some((x) => x.relationshipId === rel.id)) edges.push({ id: `e:${rel.id}`, fromNodeId: nodeId(rel.from), toNodeId: nodeId(rel.to), kind: rel.kind, relationshipId: rel.id, evidenceIds: rel.evidence.map((x) => x.id), displayMode: rel.kind === "async-flow" ? "HYPOTHESIS" : "FACT", label: rel.label });
    }
  }
  nodes.push({ id: fieldNodeId, entityRefs: [], label: field, kind: "state", file: "", claimIds: [], evidenceIds: fieldFacts.flatMap((f) => f.evidence.map((e) => e.id)).slice(0, 12), tier: "CRITICAL", displayMode: "FACT", unresolvedCalls: 0, role: "state", layer: maxD + 1, notes: [`${writers.length} function(s) write this field.`] });
  for (const w of writers) edges.push({ id: `e:writes:${w}:${field}`, fromNodeId: nodeId(w), toNodeId: fieldNodeId, kind: "writes", evidenceIds: writeEv(w), displayMode: "FACT", label: "writes" });
  // Async edges carry the claim of the writer that depends on them, so clicking the edge shows the counter-argument.
  for (const c of claims) {
    const path = c.draft.structure?.entityIds ?? [];
    for (const e of edges) if (e.kind === "async-flow" && !e.claimId && path.includes(e.fromNodeId.slice(2)) && path.includes(e.toNodeId.slice(2))) e.claimId = c.draft.id;
  }

  const card = store.concepts(rev.id).find((c) => c.kind === "invariant" && c.title.toLowerCase().includes(field.toLowerCase()));
  const gaps: string[] = [];
  const fog = [...unresolvedBy.values()].reduce((a, b) => a + b, 0);
  if (fog) gaps.push(`${fog} call(s) around these writers could not be statically resolved; there may be more writers.`);
  gaps.push("Static analysis cannot show runtime ordering; races are hypotheses until observed.");
  const id = "view:causal:" + createHash("sha256").update(rev.id + question).digest("hex").slice(0, 10);
  return {
    claims,
    view: {
      id, version: 1, revision: rev.id, taskId: "task:" + id, formId: "CausalGraph", question, level: 5, nodes, edges, groups: [], legend: LEGEND, cameraPolicy: { behavior: "PRESERVE" }, gaps,
      caption: `“${field}” is written by ${writers.length} function(s); ${risky} write outside a transaction${asyncWriters ? `, ${asyncWriters} reached through async hand-offs` : ""}.${card ? ` Concept: ${card.summary}` : ""}`,
      formReason: "You asked why a value could become incorrect, so this maps every writer of that field, whether it is transactional, and the paths (including async ones) that reach it.",
      hidden: [], meta: { kind: "invariant", field },
    },
  };
}
