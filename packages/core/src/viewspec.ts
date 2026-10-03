// C19 slice: compile a SemanticMap ViewSpec. Deterministic substrate (FACT) is separated from
// model-derived abstraction (INFERENCE); ungrounded model output is dropped and reported as a gap.
import { createHash } from "node:crypto";
import type { Claim, EvidenceBundle, RepresentationOutput, ViewEdge, ViewGroup, ViewNode, ViewSpec } from "@cie/schema";
import { gateClaim } from "./claims.ts";
import type { ModelRunRef } from "@cie/schema";
import type { Store } from "./store.ts";
import type { Scored } from "./salience.ts";

const LEGEND: ViewSpec["legend"] = [
  { label: "Fact", displayMode: "FACT", description: "Statically parsed or resolved from source; click to see the exact span." },
  { label: "Inference", displayMode: "INFERENCE", description: "Derived by the model from cited evidence; not proven." },
  { label: "Fog", displayMode: "FOG", description: "Has calls static analysis could not resolve (dynamic or external)." },
];

export interface CompileInput {
  question: string; bundle: EvidenceBundle; tiers: Map<string, ViewNode["tier"]>; scored?: Map<string, Scored>;
  representation?: RepresentationOutput; run?: ModelRunRef; version?: number; diagnostics?: string[]; store?: Store; systemName?: string;
}

export function compileView(inp: CompileInput): { view: ViewSpec; claims: Claim[] } {
  const { bundle, tiers } = inp;
  const gaps: string[] = [...(inp.diagnostics ?? []), ...bundle.unresolved];
  const symbols = bundle.entities.filter((e) => e.kind !== "file");
  const nodeId = (entityId: string) => `n:${entityId}`;
  const containsEv = new Map<string, string[]>();
  for (const r of bundle.relationships) if (r.kind === "contains") containsEv.set(r.to, r.evidence.map((e) => e.id));
  const unresolvedBy = new Map<string, number>();
  for (const f of bundle.facts) if (f.resolution === "UNRESOLVED" && f.predicate === "calls") unresolvedBy.set(f.subject, (unresolvedBy.get(f.subject) ?? 0) + 1);

  const nodes: ViewNode[] = symbols.map((s) => ({
    id: nodeId(s.entityId), entityRefs: [s.entityId], label: s.name, kind: s.kind, file: s.file, claimIds: [],
    evidenceIds: containsEv.get(s.entityId) ?? [], tier: tiers.get(s.entityId) ?? "CONTEXT",
    displayMode: (unresolvedBy.get(s.entityId) ?? 0) > 0 ? "FOG" : "FACT", unresolvedCalls: unresolvedBy.get(s.entityId) ?? 0,
    score: inp.scored?.get(s.entityId)?.score, factors: inp.scored?.get(s.entityId)?.factors, role: "symbol",
  }));
  const present = new Set(symbols.map((s) => s.entityId));

  const edges: ViewEdge[] = bundle.relationships
    .filter((r) => r.kind === "calls" && present.has(r.from) && present.has(r.to))
    .map((r) => ({ id: `e:${r.id}`, fromNodeId: nodeId(r.from), toNodeId: nodeId(r.to), kind: "calls", relationshipId: r.id, evidenceIds: r.evidence.map((e) => e.id), displayMode: "FACT" as const }));

  // Inferred edges: each becomes a claim and must pass grounding before it is drawn.
  const claims: Claim[] = [];
  let dropped = 0;
  for (const ie of inp.representation?.inferredEdges ?? []) {
    if (!present.has(ie.from) || !present.has(ie.to)) { dropped++; continue; }
    const claim = gateClaim({ assertion: `${ie.from} reaches ${ie.to}. ${ie.rationale}`, claimClass: "inferred-reachability", evidenceIds: ie.evidenceIds, rationaleSummary: ie.rationale, structure: ie.viaEntityIds ? { kind: "path", entityIds: [ie.from, ...ie.viaEntityIds, ie.to] } : undefined }, bundle, { run: inp.run, store: inp.store });
    claims.push(claim);
    if (claim.displayMode === "HIDDEN") { dropped++; continue; }
    const from = nodeId(ie.from), to = nodeId(ie.to);
    edges.push({ id: `e:inf:${claim.draft.id}`, fromNodeId: from, toNodeId: to, kind: "reaches", claimId: claim.draft.id, evidenceIds: ie.evidenceIds, displayMode: "INFERENCE", label: "reaches" });
    for (const n of nodes) if (n.id === from || n.id === to) n.claimIds.push(claim.draft.id);
  }
  if (dropped) gaps.push(`${dropped} model-proposed edge(s) dropped: ungrounded or referencing unknown elements`);

  // Groups: file groups are deterministic (FACT); concept groups come from the model (INFERENCE) and need grounding.
  const groups: ViewGroup[] = [];
  const files = [...new Set(symbols.map((s) => s.file))].sort();
  const fileGroupId = (f: string) => `g:file:${f}`;
  for (const f of files) {
    const kids = nodes.filter((n) => n.file === f).map((n) => n.id);
    groups.push({ id: fileGroupId(f), label: f.split("/").slice(-2).join("/"), kind: "file", childNodeIds: kids, level: 3, evidenceIds: [], displayMode: "FACT" });
  }
  for (const g of inp.representation?.groups ?? []) {
    const members = g.memberEntityIds.filter((m) => present.has(m));
    const claim = gateClaim({ assertion: `Group "${g.label}": ${g.rationale}`, claimClass: "concept-group", evidenceIds: g.evidenceIds, rationaleSummary: g.rationale }, bundle, { run: inp.run, store: inp.store });
    claims.push(claim);
    if (claim.displayMode === "HIDDEN" || members.length === 0) { gaps.push(`concept group "${g.label}" dropped: ${claim.displayMode === "HIDDEN" ? "ungrounded" : "no members in view"}`); continue; }
    const gid = `g:concept:${g.label}`;
    const memberFiles = [...new Set(symbols.filter((s) => members.includes(s.entityId)).map((s) => s.file))];
    groups.push({ id: gid, label: g.label, kind: "concept", childNodeIds: members.map(nodeId), level: 2, evidenceIds: g.evidenceIds, displayMode: "INFERENCE" });
    for (const f of memberFiles) { const fg = groups.find((x) => x.id === fileGroupId(f)); if (fg && !fg.parentGroupId) fg.parentGroupId = gid; }
  }

  // Intermediate abstraction: groups the model tagged with the same domain become a cluster. Each cluster is a
  // claim that must be grounded in the evidence of its member groups, so an invented domain cannot appear unsupported.
  const byCluster = new Map<string, ViewGroup[]>();
  const clusterOfGroup = new Map<string, string>();
  for (const g of inp.representation?.groups ?? []) if (g.cluster?.trim()) clusterOfGroup.set(g.label, g.cluster.trim());
  for (const g of groups.filter((x) => x.kind === "concept")) { const c = clusterOfGroup.get(g.label); if (c) byCluster.set(c, [...(byCluster.get(c) ?? []), g]); }
  if (byCluster.size >= 2) {
    for (const [label, members] of byCluster) {
      const evidenceIds = [...new Set(members.flatMap((m) => m.evidenceIds))].slice(0, 50);
      const claim = gateClaim({ assertion: `Domain "${label}" groups: ${members.map((m) => m.label).join(", ")}.`, claimClass: "domain-cluster", evidenceIds, rationaleSummary: "A model-proposed intermediate abstraction over concept groups." }, bundle, { run: inp.run, store: inp.store });
      claims.push(claim);
      if (claim.displayMode === "HIDDEN") { gaps.push(`domain "${label}" dropped: ungrounded`); continue; }
      const cid = `g:cluster:${label}`;
      groups.push({ id: cid, label, kind: "cluster", childNodeIds: [...new Set(members.flatMap((m) => m.childNodeIds))], level: 1, evidenceIds, displayMode: "INFERENCE" });
      for (const m of members) m.parentGroupId = cid;
    }
  }

  // Level 0: the system as one thing, with what it depends on outside itself.
  const fileIds = new Set(bundle.entities.filter((e) => e.kind === "file").map((e) => e.entityId));
  const ext = new Map<string, { files: Set<string>; ev: Set<string> }>();
  for (const f of bundle.facts) if (f.predicate === "imports_external" && fileIds.has(f.subject)) {
    const name = String((f.object as { value?: unknown }).value ?? "");
    const base = name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0];
    const e = ext.get(base) ?? { files: new Set(), ev: new Set() };
    e.files.add(f.subject); f.evidence.forEach((x) => e.ev.add(x.id)); ext.set(base, e);
  }
  const system: ViewSpec["system"] = {
    name: inp.systemName ?? "system", files: fileIds.size, symbols: symbols.length,
    externals: [...ext].map(([name, v]) => ({ name, files: v.files.size, evidenceIds: [...v.ev].slice(0, 6) })).sort((a, b) => b.files - a.files || a.name.localeCompare(b.name)).slice(0, 12),
  };

  const empty = nodes.length === 0;
  const caption = empty
    ? "Nothing in this repository matches that question. Try naming a feature or module — the map stays empty rather than guessing."
    : inp.representation?.caption ?? `${nodes.length} symbols relevant to "${inp.question}".`;
  const id = "view:" + createHash("sha256").update(bundle.id + inp.question).digest("hex").slice(0, 12);
  return {
    claims,
    view: {
      id, version: inp.version ?? 1, revision: bundle.revision, taskId: "task:" + id, formId: "SemanticMap", caption, question: inp.question,
      level: 5, nodes, edges, groups, legend: LEGEND, cameraPolicy: { behavior: "PRESERVE" }, gaps, system,
    },
  };
}
