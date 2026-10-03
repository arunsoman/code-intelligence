// Shared pieces for the visualization forms: the flow graph, evidence for non-code observations, claims, view skeletons.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Claim, DisplayMode, Entity, EvidenceClass, EvidenceRef, FormId, Relationship, ViewNode, ViewSpec } from "@cie/schema";
import { gateClaim, type RawClaim } from "../claims.ts";
import type { RevisionRow, Store } from "../store.ts";

export const FLOW_KINDS = new Set(["calls", "async-flow"]);
export const isCode = (e: Entity | undefined) => !!e && /^(function|method)$/.test(e.kind);
export const short = (id: string) => id.replace(/^[a-z]+:/, "").replace(/^.*#/, "");
export const hash = (...parts: string[]) => createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 12);

export interface Flow { out: Map<string, Relationship[]>; inn: Map<string, Relationship[]>; entities: Map<string, Entity>; byFile: Map<string, Entity[]> }
export function flowGraph(store: Store, rev: string): Flow {
  const out = new Map<string, Relationship[]>(), inn = new Map<string, Relationship[]>();
  for (const r of store.allRelationships(rev)) {
    if (!FLOW_KINDS.has(r.kind) || r.from.startsWith("test:") || r.to.startsWith("test:")) continue;
    out.set(r.from, [...(out.get(r.from) ?? []), r]); inn.set(r.to, [...(inn.get(r.to) ?? []), r]);
  }
  const entities = new Map(store.entities(rev).map((e) => [e.entityId, e]));
  const byFile = new Map<string, Entity[]>();
  for (const e of entities.values()) if (e.kind !== "file") byFile.set(e.file, [...(byFile.get(e.file) ?? []), e]);
  return { out, inn, entities, byFile };
}

/** Breadth-first reach with parent pointers; `viaAsync` is true if any edge on the way is an async hand-off. */
export function reach(starts: string[], adj: Map<string, Relationship[]>, next: (r: Relationship) => string, maxDepth: number, cap: number) {
  const info = new Map<string, { depth: number; parent?: { id: string; rel: Relationship }; viaAsync: boolean }>();
  starts.forEach((s) => info.set(s, { depth: 0, viaAsync: false }));
  const q = [...starts];
  while (q.length && info.size < cap) {
    const cur = q.shift()!, ci = info.get(cur)!;
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
export function pathTo(info: ReturnType<typeof reach>, id: string): { ids: string[]; rels: Relationship[] } {
  const ids = [id], rels: Relationship[] = [];
  for (let c = info.get(id); c?.parent; c = info.get(c.parent.id)) { ids.unshift(c.parent.id); rels.unshift(c.parent.rel); }
  return { ids, rels };
}

/** Evidence for an observation that is not a span of source (git history, ownership files, reports, derived measures). */
export function observation(store: Store, rev: string, key: string, cls: EvidenceClass, file: string, locator: string, observedAt = new Date().toISOString(), kind: "DocumentLocation" | "RuntimeLocation" = "DocumentLocation"): EvidenceRef {
  const e: EvidenceRef = {
    id: "ev:" + hash(rev, key, cls), sourceId: file,
    location: kind === "RuntimeLocation" ? { kind, backendHandle: "reported", deploymentId: "local", start: observedAt, end: observedAt, locator } : { kind, documentId: file, version: observedAt, locator },
    class: cls, observedAt, accessScopeId: "local", state: "CURRENT",
  };
  store.putEvidence(rev, e);
  return e;
}

/** A pipeline-authored claim: five gates, evidence resolved from this revision's store. */
export function claimOf(store: Store, rev: string, raw: RawClaim): Claim {
  const c = gateClaim(raw, { id: "forms", revision: rev, evidence: [], entities: [], relationships: [], facts: [], coverage: [], unresolved: [], tokenEstimate: 0 }, { store, trusted: true });
  store.putClaim(c);
  return c;
}

export function readSource(rev: RevisionRow, rel: string): string | null { try { return readFileSync(resolve(rev.repoRoot, rel), "utf8"); } catch { return null; } }

export const containsEvidence = (store: Store, rev: string, id: string): string[] =>
  store.relationshipsFor(rev, id).filter((r) => r.kind === "contains" && r.to === id).flatMap((r) => r.evidence.map((e) => e.id));

export const fogCount = (store: Store, rev: string, id: string) => store.factsFor(rev, id).filter((f) => f.resolution === "UNRESOLVED" && f.predicate === "calls").length;

export interface BaseOpts { rev: RevisionRow; form: FormId; question: string; caption: string; reason: string; kind: string; legend?: ViewSpec["legend"]; level?: number }
export const LEGEND: Record<string, ViewSpec["legend"][number]> = {
  FACT: { label: "Fact", displayMode: "FACT", description: "Statically proven or recorded; click for the exact source." },
  INFERENCE: { label: "Inference", displayMode: "INFERENCE", description: "Derived from cited evidence; not proven." },
  HYPOTHESIS: { label: "Hypothesis", displayMode: "HYPOTHESIS", description: "Plausible but cannot be proven from the code alone." },
  FOG: { label: "Fog", displayMode: "FOG", description: "Static analysis could not resolve some of it." },
};
export function baseView(o: BaseOpts): ViewSpec {
  const id = `view:${o.kind}:` + hash(o.rev.id, o.question);
  return {
    id, version: 1, revision: o.rev.id, taskId: "task:" + id, formId: o.form, caption: o.caption, question: o.question, level: o.level ?? 5,
    nodes: [], edges: [], groups: [], legend: o.legend ?? [LEGEND.FACT, LEGEND.INFERENCE, LEGEND.HYPOTHESIS, LEGEND.FOG], cameraPolicy: { behavior: "PRESERVE" }, gaps: [],
    formReason: o.reason, hidden: [], meta: { kind: o.kind },
  };
}
export function emptyForm(o: BaseOpts, why: string): { view: ViewSpec; claims: Claim[] } {
  const v = baseView({ ...o, caption: why });
  return { view: v, claims: [] };
}
export const nodeBase = (e: Entity, over: Partial<ViewNode> & Pick<ViewNode, "id" | "evidenceIds">): ViewNode => ({
  entityRefs: [e.entityId], label: e.name, kind: e.kind, file: e.file, claimIds: [], tier: "RELEVANT", displayMode: "FACT" as DisplayMode, unresolvedCalls: 0, ...over,
});

/** Left-to-right layering for nodes that did not set their own position: depth from the nodes nothing points to. */
export function autoLayout(v: ViewSpec, colW = 230, rowH = 74) {
  const ids = new Set(v.nodes.filter((n) => !n.pos).map((n) => n.id));
  const incoming = new Map<string, string[]>(), outgoing = new Map<string, string[]>();
  for (const e of v.edges) if (ids.has(e.fromNodeId) && ids.has(e.toNodeId)) { incoming.set(e.toNodeId, [...(incoming.get(e.toNodeId) ?? []), e.fromNodeId]); outgoing.set(e.fromNodeId, [...(outgoing.get(e.fromNodeId) ?? []), e.toNodeId]); }
  const depth = new Map<string, number>();
  const roots = [...ids].filter((id) => !(incoming.get(id)?.length));
  const q = (roots.length ? roots : [...ids].slice(0, 1)).map((id) => { depth.set(id, 0); return id; });
  while (q.length) { const c = q.shift()!; for (const n of outgoing.get(c) ?? []) if (!depth.has(n)) { depth.set(n, depth.get(c)! + 1); q.push(n); } }
  const col = new Map<number, number>();
  for (const n of v.nodes) if (!n.pos) { const d = depth.get(n.id) ?? 0; const r = col.get(d) ?? 0; col.set(d, r + 1); n.pos = { x: d * colW, y: r * rowH }; }
}
